import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./runtimeEnv', () => ({
  readRuntimeEnv: (val: string | undefined) => String(val ?? '').trim(),
}))

import { _resetDiscoveryCache, getDiscoveryEndpoints } from './sakrylleOidcDiscovery'

const MOCK_DISCOVERY = {
  issuer: 'https://oidc1.sakrylle.com',
  authorization_endpoint: 'https://oidc1.sakrylle.com/oauth/authorize',
  token_endpoint: 'https://oidc1.sakrylle.com/oauth/token',
  userinfo_endpoint: 'https://oidc1.sakrylle.com/userinfo',
  end_session_endpoint: 'https://oidc1.sakrylle.com/oauth/logout',
  revocation_endpoint: 'https://oidc1.sakrylle.com/oauth/revoke',
  jwks_uri: 'https://oidc1.sakrylle.com/.well-known/jwks.json',
}

describe('getDiscoveryEndpoints', () => {
  beforeEach(() => {
    _resetDiscoveryCache()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    _resetDiscoveryCache()
    vi.restoreAllMocks()
  })

  it('returns parsed endpoints on successful fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MOCK_DISCOVERY), { status: 200 }),
    )

    const endpoints = await getDiscoveryEndpoints()

    expect(endpoints.authorizationEndpoint).toBe('https://oidc1.sakrylle.com/oauth/authorize')
    expect(endpoints.tokenEndpoint).toBe('https://oidc1.sakrylle.com/oauth/token')
    expect(endpoints.userinfoEndpoint).toBe('https://oidc1.sakrylle.com/userinfo')
    expect(endpoints.endSessionEndpoint).toBe('https://oidc1.sakrylle.com/oauth/logout')
    expect(endpoints.revocationEndpoint).toBe('https://oidc1.sakrylle.com/oauth/revoke')
    expect(endpoints.jwksUri).toBe('https://oidc1.sakrylle.com/.well-known/jwks.json')
    expect(endpoints.issuer).toBe('https://oidc1.sakrylle.com')
  })

  it('caches the result and does not re-fetch within TTL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MOCK_DISCOVERY), { status: 200 }),
    )

    await getDiscoveryEndpoints()
    await getDiscoveryEndpoints()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to hardcoded endpoints on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'))

    const endpoints = await getDiscoveryEndpoints()

    expect(endpoints.authorizationEndpoint).toBe('https://oidc1.sakrylle.com/oauth/authorize')
    expect(endpoints.tokenEndpoint).toBe('https://oidc1.sakrylle.com/oauth/token')
    expect(endpoints.issuer).toBe('https://oidc1.sakrylle.com')
  })

  it('falls back to hardcoded endpoints on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404 }),
    )

    const endpoints = await getDiscoveryEndpoints()

    expect(endpoints.authorizationEndpoint).toBe('https://oidc1.sakrylle.com/oauth/authorize')
  })

  it('falls back when issuer does not match', async () => {
    const badDiscovery = { ...MOCK_DISCOVERY, issuer: 'https://evil.com' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(badDiscovery), { status: 200 }),
    )

    const endpoints = await getDiscoveryEndpoints()

    // Should fall back to hardcoded
    expect(endpoints.issuer).toBe('https://oidc1.sakrylle.com')
  })

  it('falls back when authorization_endpoint is missing', async () => {
    const { authorization_endpoint, ...partial } = MOCK_DISCOVERY
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(partial), { status: 200 }),
    )

    const endpoints = await getDiscoveryEndpoints()

    expect(endpoints.authorizationEndpoint).toBe('https://oidc1.sakrylle.com/oauth/authorize')
  })

  it('falls back when endpoint origin does not match issuer', async () => {
    const badDiscovery = {
      ...MOCK_DISCOVERY,
      token_endpoint: 'https://evil.com/oauth/token',
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(badDiscovery), { status: 200 }),
    )

    const endpoints = await getDiscoveryEndpoints()

    expect(endpoints.tokenEndpoint).toBe('https://oidc1.sakrylle.com/oauth/token')
  })

  it('falls back on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      new Promise((_, reject) => setTimeout(() => reject(new Error('abort')), 15_000)),
    )

    const endpoints = await getDiscoveryEndpoints()

    expect(endpoints.authorizationEndpoint).toBe('https://oidc1.sakrylle.com/oauth/authorize')
  }, 20_000)
})
