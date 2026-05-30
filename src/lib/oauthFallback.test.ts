import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { canUseOAuthForProfile, resolveBearerToken } from './oauthFallback'
import type { ApiProfile } from '../types'
import * as sakrylleAuth from './sakrylleAuth'

vi.mock('./sakrylleAuth', () => ({
  getStoredToken: vi.fn(),
  refreshIfNeeded: vi.fn(),
}))

vi.mock('./runtimeEnv', () => ({
  readRuntimeEnv: (val: string | undefined) => val,
}))

const SAKRYLLE_BASE = 'https://api.sakrylle.com/v1'

function createProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: 'test',
    name: 'Test',
    provider: 'openai',
    baseUrl: SAKRYLLE_BASE,
    apiKey: '',
    model: 'gpt-image-2',
    timeout: 120,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    ...overrides,
  }
}

function createMockStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
  }
}

describe('oauthFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('canUseOAuthForProfile', () => {
    it('returns false when provider is not openai', () => {
      const profile = createProfile({ provider: 'openai' as any })
      profile.provider = 'fal' as any
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(false)
    })

    it('returns false when baseUrl is not Sakrylle', () => {
      const profile = createProfile({ baseUrl: 'https://api.openai.com/v1' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(false)
    })

    it('returns false when no token is stored', () => {
      const profile = createProfile()
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue(null)
      expect(canUseOAuthForProfile(profile)).toBe(false)
    })

    it('returns true for images mode with images:create scope', () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('returns true for images mode with legacy image_generation scope', () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'image_generation balance:read',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('returns true for responses mode with responses:create scope', () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'responses:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('returns true regardless of apiMode when token has images:create scope', () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('returns true regardless of apiMode when token has responses:create scope', () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'responses:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('handles missing scope field gracefully', () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
      })
      expect(canUseOAuthForProfile(profile)).toBe(false)
    })

    it('returns true when primary token scope contains responses:create', () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'sk_oauth_responses',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('returns true when primary token has relevant scope even with unrelated additionalTokens', () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'sk_oauth_images',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
        additionalTokens: [
          {
            accessToken: 'sk_oauth_other',
            expiresAt: Date.now() + 3600000,
            scope: 'other:scope',
          },
        ],
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })
  })

  describe('resolveBearerToken', () => {
    it('returns explicit apiKey when present', async () => {
      const profile = createProfile({ apiKey: 'sk-explicit' })
      const token = await resolveBearerToken(profile)
      expect(token).toBe('sk-explicit')
      expect(sakrylleAuth.refreshIfNeeded).not.toHaveBeenCalled()
    })

    it('returns OAuth token when apiKey is empty and OAuth is available', async () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'sk_oauth_abc',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue({
        accessToken: 'sk_oauth_abc',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      const token = await resolveBearerToken(profile)
      expect(token).toBe('sk_oauth_abc')
    })

    it('throws when apiKey is empty and OAuth is not available', async () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'balance:read',
      })
      await expect(resolveBearerToken(profile)).rejects.toThrow('missing_credentials')
    })

    it('throws when no token exists', async () => {
      const profile = createProfile()
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue(null)
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue(null)
      await expect(resolveBearerToken(profile)).rejects.toThrow('missing_credentials')
    })

    it('returns primary token when it has responses:create scope', async () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'sk_oauth_responses',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
      })
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue({
        accessToken: 'sk_oauth_responses',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
      })
      const token = await resolveBearerToken(profile)
      expect(token).toBe('sk_oauth_responses')
    })

    it('uses primary token when it matches', async () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'sk_oauth_images',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
        additionalTokens: [
          {
            accessToken: 'sk_oauth_responses',
            expiresAt: Date.now() + 3600000,
            scope: 'responses:create',
          },
        ],
      })
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue({
        accessToken: 'sk_oauth_images',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
        additionalTokens: [
          {
            accessToken: 'sk_oauth_responses',
            expiresAt: Date.now() + 3600000,
            scope: 'responses:create',
          },
        ],
      })
      const token = await resolveBearerToken(profile)
      expect(token).toBe('sk_oauth_images')
    })

    it('returns the token for the selected API-mode group', async () => {
      vi.stubGlobal('localStorage', createMockStorage())
      localStorage.setItem('sakrylle-image-playground.selected-groups', JSON.stringify({ images: 9 }))
      const profile = createProfile({ apiMode: 'images' })
      const oauthToken = {
        accessToken: 'sk_oauth_group5',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
        group: { id: 5, name: 'GPT-Image' },
        additionalTokens: [
          {
            accessToken: 'sk_oauth_group9_4k',
            expiresAt: Date.now() + 3600000,
            scope: 'images:create',
            group: { id: 9, name: 'GPT-Image-4K' },
          },
        ],
      }
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue(oauthToken)
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue(oauthToken)

      const token = await resolveBearerToken(profile)

      expect(token).toBe('sk_oauth_group9_4k')
    })
  })
})
