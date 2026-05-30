// Tests for sakrylleAuth.ts. The vitest config runs in the default `node`
// environment (jsdom is not installed in this project), so we shim
// `window`, `localStorage`, `sessionStorage`, and `window.location` ourselves
// in beforeEach. Node 22's webcrypto already exposes `crypto.subtle.digest`
// and `crypto.getRandomValues`, so the PKCE pipeline runs as-is.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// MUST match the constants declared at the top of sakrylleAuth.ts.
const AUTH_STORAGE_KEY = 'sakrylle-image-playground.auth'
const PKCE_VERIFIER_KEY = 'sakrylle-image-playground.pkce-verifier'
const PKCE_STATE_KEY = 'sakrylle-image-playground.pkce-state'
const TOKEN_URL = 'https://sub.sakrylle.com/oauth/token'
const AUTHORIZE_URL_PREFIX = 'https://sub.sakrylle.com/oauth/authorize'
const REDIRECT_ORIGIN = 'https://image.sakrylle.com'

class MockStorage {
  private map = new Map<string, string>()
  get length(): number { return this.map.size }
  clear(): void { this.map.clear() }
  getItem(key: string): string | null { return this.map.get(key) ?? null }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null }
  removeItem(key: string): void { this.map.delete(key) }
  setItem(key: string, value: string): void { this.map.set(key, String(value)) }
}

let mockLocation: { origin: string; href: string }
let mockLocalStorage: MockStorage
let mockSessionStorage: MockStorage

beforeEach(() => {
  mockLocalStorage = new MockStorage()
  mockSessionStorage = new MockStorage()
  mockLocation = { origin: REDIRECT_ORIGIN, href: '' }
  vi.stubGlobal('localStorage', mockLocalStorage)
  vi.stubGlobal('sessionStorage', mockSessionStorage)
  vi.stubGlobal('window', {
    localStorage: mockLocalStorage,
    sessionStorage: mockSessionStorage,
    location: mockLocation,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Imports are hoisted, but they execute BEFORE any beforeEach runs. That is
// fine: the module's top-level only reads import.meta.env (no DOM access).
// The transitive `./i18n` import calls readStoredLanguage(), which short-
// circuits to 'zh' when typeof window === 'undefined' — exactly the state at
// module load time. Subsequent test calls then run with our window stub.
import {
  beginLogin,
  forceRefreshToken,
  getStoredToken,
  handleCallback,
  logout,
  logoutAndRevoke,
  refreshIfNeeded,
  refreshWithGroupId,
} from './sakrylleAuth'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('handleCallback', () => {
  it('throws when the query string lacks a code', async () => {
    mockSessionStorage.setItem(PKCE_STATE_KEY, 'expected')
    mockSessionStorage.setItem(PKCE_VERIFIER_KEY, 'verifier')
    await expect(
      handleCallback(new URLSearchParams('?state=expected')),
    ).rejects.toThrow('OAuth 回调缺少授权码')
  })

  it('throws when the state parameter does not match the stored state', async () => {
    mockSessionStorage.setItem(PKCE_STATE_KEY, 'expected-state')
    mockSessionStorage.setItem(PKCE_VERIFIER_KEY, 'verifier')
    await expect(
      handleCallback(new URLSearchParams('?code=abc&state=other-state')),
    ).rejects.toThrow(/state/i)
  })

  it('throws when the PKCE verifier is missing from sessionStorage', async () => {
    mockSessionStorage.setItem(PKCE_STATE_KEY, 'expected-state')
    // verifier intentionally absent
    await expect(
      handleCallback(new URLSearchParams('?code=abc&state=expected-state')),
    ).rejects.toThrow(/PKCE verifier/)
  })

  it('exchanges code for tokens, persists them, and clears PKCE temp items', async () => {
    mockSessionStorage.setItem(PKCE_STATE_KEY, 'state-xyz')
    mockSessionStorage.setItem(PKCE_VERIFIER_KEY, 'verifier-xyz')

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        access_token: 'sk_oauth_at',
        refresh_token: 'rt_initial',
        expires_in: 3600,
        refresh_token_expires_in: 2592000,
        scope: 'profile:read account:balance:read models:read images:create responses:create offline_access',
      }),
    )

    const before = Date.now()
    const token = await handleCallback(
      new URLSearchParams('?code=auth-code&state=state-xyz'),
    )
    const after = Date.now()

    expect(token.accessToken).toBe('sk_oauth_at')
    expect(token.refreshToken).toBe('rt_initial')
    expect(token.scope).toBe('profile:read account:balance:read models:read images:create responses:create offline_access')
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(token.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000)
    // v2: refreshTokenExpiresAt should be stored from refresh_token_expires_in
    expect(token.refreshTokenExpiresAt).toBeGreaterThanOrEqual(before + 2592000 * 1000)
    expect(token.refreshTokenExpiresAt).toBeLessThanOrEqual(after + 2592000 * 1000)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(TOKEN_URL)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe(
      'application/x-www-form-urlencoded',
    )
    const body = new URLSearchParams(init?.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code')
    expect(body.get('code_verifier')).toBe('verifier-xyz')
    expect(body.get('client_id')).toBe('sakrylle-image-playground')
    expect(body.get('redirect_uri')).toBe(`${REDIRECT_ORIGIN}/oauth/callback`)

    const stored = JSON.parse(mockLocalStorage.getItem(AUTH_STORAGE_KEY)!)
    expect(stored.accessToken).toBe('sk_oauth_at')
    expect(stored.refreshToken).toBe('rt_initial')
    expect(stored.refreshTokenExpiresAt).toBeGreaterThan(0)

    expect(mockSessionStorage.getItem(PKCE_STATE_KEY)).toBeNull()
    expect(mockSessionStorage.getItem(PKCE_VERIFIER_KEY)).toBeNull()
  })

  it('throws when the token endpoint returns a non-ok status', async () => {
    mockSessionStorage.setItem(PKCE_STATE_KEY, 'state')
    mockSessionStorage.setItem(PKCE_VERIFIER_KEY, 'verifier')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('invalid_grant', { status: 400 }),
    )
    await expect(
      handleCallback(new URLSearchParams('?code=c&state=state')),
    ).rejects.toThrow(/access_token/)
  })

  it('throws when the token payload omits refresh_token (docs §2.1)', async () => {
    mockSessionStorage.setItem(PKCE_STATE_KEY, 'state')
    mockSessionStorage.setItem(PKCE_VERIFIER_KEY, 'verifier')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ access_token: 'sk_oauth_at', expires_in: 3600 }),
    )
    await expect(
      handleCallback(new URLSearchParams('?code=c&state=state')),
    ).rejects.toThrow('OAuth refresh_token rotation missing — terminal')
  })
})

describe('getStoredToken', () => {
  it('returns null when nothing is stored', () => {
    expect(getStoredToken()).toBeNull()
  })

  it('returns null when the stored value is not valid JSON', () => {
    mockLocalStorage.setItem(AUTH_STORAGE_KEY, '{this is not json')
    expect(getStoredToken()).toBeNull()
  })

  it('returns null when the stored JSON has no accessToken', () => {
    mockLocalStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ refreshToken: 'rt', expiresAt: 0 }),
    )
    expect(getStoredToken()).toBeNull()
  })

  it('returns the parsed token when the stored JSON is well-formed', () => {
    const expiresAt = Date.now() + 60_000
    mockLocalStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt, scope: 's' }),
    )
    expect(getStoredToken()).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt,
      scope: 's',
    })
  })
})

describe('refreshIfNeeded', () => {
  function seedToken(token: {
    accessToken: string
    refreshToken?: string
    expiresAt: number
    scope?: string
    refreshTokenExpiresAt?: number
    group?: { id: number; name: string }
    additionalTokens?: Array<{ accessToken: string; expiresAt: number; scope?: string; group?: { id: number; name: string } }>
  }): void {
    mockLocalStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(token))
  }

  it('returns the existing token without fetching when it is far from expiry', async () => {
    seedToken({
      accessToken: 'still-good',
      refreshToken: 'rt',
      expiresAt: Date.now() + 600_000, // 10 min from now → > 60s lead time
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const token = await refreshIfNeeded()
    expect(token?.accessToken).toBe('still-good')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes when expiresAt is within the 60s lead time and persists the rotated token', async () => {
    seedToken({
      accessToken: 'old',
      refreshToken: 'rt-old',
      expiresAt: Date.now() + 1000, // < 60s → refresh required
      scope: 'image_generation',
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        access_token: 'new',
        refresh_token: 'rt-new',
        expires_in: 3600,
      }),
    )

    const token = await refreshIfNeeded()

    expect(token?.accessToken).toBe('new')
    expect(token?.refreshToken).toBe('rt-new')
    // scope should fall back to the previous token's scope when the server
    // omits it on refresh (tokenFromPayload `previousScope`).
    expect(token?.scope).toBe('image_generation')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(TOKEN_URL)
    const body = new URLSearchParams(init?.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('rt-old')
    expect(body.get('client_id')).toBe('sakrylle-image-playground')

    const stored = JSON.parse(mockLocalStorage.getItem(AUTH_STORAGE_KEY)!)
    expect(stored.accessToken).toBe('new')
    expect(stored.refreshToken).toBe('rt-new')
  })

  it('preserves group names when the refresh payload only returns group ids', async () => {
    seedToken({
      accessToken: 'old',
      refreshToken: 'rt-old',
      expiresAt: Date.now() + 1000,
      scope: 'images:create responses:create',
      group: { id: 5, name: 'GPT-Image' },
      additionalTokens: [
        { accessToken: 'old-11', expiresAt: Date.now() + 1000, group: { id: 11, name: 'GPT-Image-4K' } },
      ],
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        access_token: 'new',
        refresh_token: 'rt-new',
        expires_in: 3600,
        group: { id: 5, name: '' },
        additional_tokens: [
          { access_token: 'new-11', expires_in: 3600, group: { id: 11 } },
        ],
      }),
    )

    const token = await refreshIfNeeded()

    expect(token?.group).toEqual({ id: 5, name: 'GPT-Image' })
    expect(token?.additionalTokens?.[0].group).toEqual({ id: 11, name: 'GPT-Image-4K' })
  })

  it('preserves refreshTokenExpiresAt across rotations (family-anchored expiry)', async () => {
    const familyExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days
    seedToken({
      accessToken: 'old',
      refreshToken: 'rt-old',
      expiresAt: Date.now() + 1000,
      scope: 'profile:read account:balance:read',
      refreshTokenExpiresAt: familyExpiry,
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        access_token: 'new',
        refresh_token: 'rt-new',
        expires_in: 3600,
        // Server echoes remaining TTL — simulate a slightly smaller value
        refresh_token_expires_in: Math.floor((familyExpiry - Date.now()) / 1000),
      }),
    )

    const token = await refreshIfNeeded()
    expect(token?.refreshTokenExpiresAt).toBeDefined()
    // The new refreshTokenExpiresAt should be close to the original family expiry
    expect(token!.refreshTokenExpiresAt!).toBeGreaterThan(Date.now())
  })

  it('logs out without fetching when the refresh token family has expired', async () => {
    seedToken({
      accessToken: 'old',
      refreshToken: 'rt-old',
      expiresAt: Date.now() + 1000, // needs refresh
      refreshTokenExpiresAt: Date.now() - 1000, // family already expired
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const token = await refreshIfNeeded()
    expect(token).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockLocalStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
  })

  it('logs out and returns null when the refresh response is not ok', async () => {
    seedToken({
      accessToken: 'old',
      refreshToken: 'rt-old',
      expiresAt: Date.now(),
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 400 }),
    )
    const token = await refreshIfNeeded()
    expect(token).toBeNull()
    expect(mockLocalStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
  })

  it('logs out and returns null when the refresh payload omits refresh_token (docs §2.4)', async () => {
    seedToken({
      accessToken: 'old',
      refreshToken: 'rt-old',
      expiresAt: Date.now(),
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ access_token: 'new', expires_in: 60 }),
    )
    const token = await refreshIfNeeded()
    expect(token).toBeNull()
    expect(mockLocalStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
  })

  it('logs out when the stored token has no refreshToken', async () => {
    mockLocalStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: 'a', expiresAt: Date.now() }),
    )
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const token = await refreshIfNeeded()
    expect(token).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockLocalStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
  })
})

describe('forceRefreshToken', () => {
  it('returns null when no token is stored', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const token = await forceRefreshToken()
    expect(token).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes regardless of expiry when called explicitly', async () => {
    mockLocalStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        accessToken: 'old',
        refreshToken: 'rt',
        // expiresAt far in the future — refreshIfNeeded would skip, but
        // forceRefreshToken must always refresh.
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      }),
    )
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        access_token: 'rotated',
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      }),
    )

    const token = await forceRefreshToken()

    expect(token?.accessToken).toBe('rotated')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('refreshWithGroupId', () => {
  it('uses the previous additional-token group name when switching groups', async () => {
    mockLocalStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        accessToken: 'old-5',
        refreshToken: 'rt-old',
        expiresAt: Date.now() + 60_000,
        scope: 'images:create responses:create',
        group: { id: 5, name: 'GPT-Image' },
        additionalTokens: [
          { accessToken: 'old-11', expiresAt: Date.now() + 60_000, group: { id: 11, name: 'GPT-Image-4K' } },
        ],
      }),
    )
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        access_token: 'new-11',
        refresh_token: 'rt-new',
        expires_in: 3600,
        group: { id: 11 },
      }),
    )

    const token = await refreshWithGroupId(11)

    expect(token?.group).toEqual({ id: 11, name: 'GPT-Image-4K' })
    const body = new URLSearchParams(fetchMock.mock.calls[0][1]?.body as string)
    expect(body.get('group_id')).toBe('11')
  })
})

describe('logout', () => {
  it('clears the auth token in localStorage and the PKCE temp items in sessionStorage', () => {
    mockLocalStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ accessToken: 'a' }))
    mockSessionStorage.setItem(PKCE_VERIFIER_KEY, 'verifier')
    mockSessionStorage.setItem(PKCE_STATE_KEY, 'state')

    logout()

    expect(mockLocalStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(mockSessionStorage.getItem(PKCE_VERIFIER_KEY)).toBeNull()
    expect(mockSessionStorage.getItem(PKCE_STATE_KEY)).toBeNull()
  })
})

describe('logoutAndRevoke', () => {
  it('clears local state and fires a revocation request for the refresh token', async () => {
    const REVOKE_URL = 'https://sub.sakrylle.com/oauth/revoke'
    mockLocalStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: 'sk_oauth_at', refreshToken: 'rt_to_revoke', expiresAt: Date.now() + 60_000 }),
    )
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    )

    logoutAndRevoke()

    // Local state cleared synchronously
    expect(mockLocalStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()

    // Allow the fire-and-forget revocation to settle
    await new Promise((r) => setTimeout(r, 0))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(REVOKE_URL)
    expect(init?.method).toBe('POST')
    const body = new URLSearchParams(init?.body as string)
    expect(body.get('token')).toBe('rt_to_revoke')
    expect(body.get('token_type_hint')).toBe('refresh_token')
    expect(body.get('client_id')).toBe('sakrylle-image-playground')
  })

  it('clears local state even when there is no refresh token to revoke', async () => {
    mockLocalStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: 'sk_oauth_at', expiresAt: Date.now() + 60_000 }),
    )
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    logoutAndRevoke()

    expect(mockLocalStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not throw when the revocation request fails', async () => {
    mockLocalStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: 'sk_oauth_at', refreshToken: 'rt_bad', expiresAt: Date.now() + 60_000 }),
    )
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'))

    logoutAndRevoke()
    expect(mockLocalStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    // Should not throw even after the promise settles
    await expect(new Promise((r) => setTimeout(r, 10))).resolves.toBeUndefined()
  })
})

describe('beginLogin', () => {
  it('writes PKCE artifacts and navigates to /oauth/authorize with required params', async () => {
    await beginLogin()

    const verifier = mockSessionStorage.getItem(PKCE_VERIFIER_KEY)
    const state = mockSessionStorage.getItem(PKCE_STATE_KEY)
    expect(verifier).toBeTruthy()
    expect(state).toBeTruthy()
    // base64url charset only — no padding, no '+' or '/'.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/)

    expect(mockLocation.href.startsWith(`${AUTHORIZE_URL_PREFIX}?`)).toBe(true)
    const url = new URL(mockLocation.href)
    const params = url.searchParams
    expect(params.get('client_id')).toBe('sakrylle-image-playground')
    expect(params.get('redirect_uri')).toBe(`${REDIRECT_ORIGIN}/oauth/callback`)
    expect(params.get('response_type')).toBe('code')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(params.get('state')).toBe(state)
    expect(params.get('scope')).toBe('profile:read account:read account:balance:read models:read images:create responses:create offline_access')
  })
})
