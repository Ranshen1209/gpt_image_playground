import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./sakrylleAuth', () => {
  const state: {
    token: { accessToken: string; refreshToken: string; expiresAt: number; scope?: string } | null
  } = { token: null }

  return {
    __esModule: true,
    __setToken(value: typeof state.token) {
      state.token = value
    },
    __getToken() {
      return state.token
    },
    getStoredToken: () => state.token,
    refreshIfNeeded: vi.fn(async () => state.token),
    forceRefreshToken: vi.fn(async () => state.token),
    logout: vi.fn(() => {
      state.token = null
    }),
  }
})

import { fetchBalance, formatBalance, formatCny } from './sakrylleAccount'
import * as sakrylleAuth from './sakrylleAuth'

const authMock = sakrylleAuth as typeof sakrylleAuth & {
  __setToken: (token: { accessToken: string; refreshToken: string; expiresAt: number; scope?: string } | null) => void
  __getToken: () => { accessToken: string; refreshToken: string; expiresAt: number; scope?: string } | null
}

function seedToken(accessToken = 'sk_oauth_test_access'): void {
  authMock.__setToken({
    accessToken,
    refreshToken: 'rt_test_refresh',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scope: 'image_generation balance:read models:read',
  })
}

describe('formatBalance', () => {
  it('renders CNY by default with the ￥ symbol', () => {
    expect(formatBalance(12.34)).toBe('￥12.34')
    expect(formatBalance(12.34, 'CNY')).toBe('￥12.34')
  })

  it('renders USD with the $ symbol', () => {
    expect(formatBalance(12.34, 'USD')).toBe('$12.34')
  })

  it('rounds to two decimal places', () => {
    expect(formatBalance(0.1 + 0.2, 'CNY')).toBe('￥0.30')
    expect(formatBalance(99.999, 'USD')).toBe('$100.00')
  })

  it('formatCny is preserved as a thin alias around formatBalance', () => {
    expect(formatCny(7.5)).toBe(formatBalance(7.5, 'CNY'))
  })
})

describe('fetchBalance', () => {
  beforeEach(() => {
    seedToken()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    authMock.__setToken(null)
  })

  it('parses the docs §3.1 schema into the SakrylleBalance shape', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          user_id: 123,
          username: 'alice',
          credit_remaining: 12.34,
          currency_display: 'CNY',
          rate_multiplier: 1.0,
          group_id: 5,
          group_name: 'GPT-Image',
          allow_image_generation: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const balance = await fetchBalance()

    expect(balance).toEqual({
      userId: 123,
      username: 'alice',
      creditRemaining: 12.34,
      currencyDisplay: 'CNY',
      rateMultiplier: 1.0,
      groupId: 5,
      groupName: 'GPT-Image',
      allowImageGeneration: true,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/account\/balance$/)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk_oauth_test_access')
  })

  it('defaults missing optional fields per docs §3.1 (CNY, allowImageGeneration false)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          user_id: 7,
          username: 'bob',
          credit_remaining: 0,
          group_id: 5,
          group_name: 'GPT-Image',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const balance = await fetchBalance()

    expect(balance).toMatchObject({
      userId: 7,
      currencyDisplay: 'CNY',
      rateMultiplier: 1,
      allowImageGeneration: false,
    })
  })

  it('returns null when no token is stored', async () => {
    authMock.__setToken(null)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    expect(await fetchBalance()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('triggers a single force-refresh + retry on OAuth invalid_token 401', async () => {
    const forceRefreshSpy = vi.mocked(sakrylleAuth.forceRefreshToken).mockImplementation(async () => {
      authMock.__setToken({
        accessToken: 'sk_oauth_rotated',
        refreshToken: 'rt_rotated',
        expiresAt: Date.now() + 60 * 60 * 1000,
        scope: 'image_generation balance:read models:read',
      })
      return authMock.__getToken()
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'invalid_token', error_description: 'expired' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user_id: 1,
            username: 'alice',
            credit_remaining: 5,
            currency_display: 'USD',
            group_id: 5,
            group_name: 'GPT-Image',
            allow_image_generation: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    const balance = await fetchBalance()

    expect(balance).toMatchObject({ creditRemaining: 5, currencyDisplay: 'USD' })
    expect(forceRefreshSpy).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const retryHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers)
    expect(retryHeaders.get('Authorization')).toBe('Bearer sk_oauth_rotated')
  })

  it('logs out and throws when refresh fails after OAuth 401 (terminal path)', async () => {
    const logoutSpy = vi.mocked(sakrylleAuth.logout)
    vi.mocked(sakrylleAuth.forceRefreshToken).mockResolvedValue(null)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'invalid_token' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await expect(fetchBalance()).rejects.toThrow('oauth_logged_out')
    expect(logoutSpy).toHaveBeenCalled()
  })
})
