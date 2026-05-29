import { describe, it, expect, beforeEach, vi } from 'vitest'
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

describe('oauthFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

    it('returns false for responses mode without responses:create scope', () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(false)
    })

    it('returns false for images mode without images scope', () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'responses:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(false)
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

    it('returns false when additionalTokens exist but none match', () => {
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
      expect(canUseOAuthForProfile(profile)).toBe(false)
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
        scope: 'images:create',
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
  })
})
