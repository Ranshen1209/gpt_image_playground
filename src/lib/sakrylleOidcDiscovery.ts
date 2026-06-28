// OIDC Discovery — fetches /.well-known/openid-configuration from the Sakrylle IdP.
// Cached in memory with a TTL. Falls back to hardcoded endpoints on failure.
// See docs/06-oidc-rp-integration-guide.md §3 for the full discovery response spec.

import { readRuntimeEnv } from './runtimeEnv'

const OIDC_ISSUER = readRuntimeEnv(import.meta.env.VITE_SAKRYLLE_OIDC_ISSUER) || 'https://oidc1.sakrylle.com'
const ISSUER = OIDC_ISSUER

const DISCOVERY_TTL_MS = 60 * 60 * 1000 // 1 hour
const FETCH_TIMEOUT_MS = 10_000

export interface DiscoveryEndpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string
  endSessionEndpoint: string
  revocationEndpoint: string
  jwksUri: string
  issuer: string
}

interface CachedEntry {
  endpoints: DiscoveryEndpoints
  fetchedAt: number
}

let cache: CachedEntry | null = null

function hardcodedEndpoints(): DiscoveryEndpoints {
  return {
    authorizationEndpoint: `${OIDC_ISSUER}/oauth/authorize`,
    tokenEndpoint: `${OIDC_ISSUER}/oauth/token`,
    userinfoEndpoint: `${OIDC_ISSUER}/v1/me`,
    endSessionEndpoint: `${OIDC_ISSUER}/oauth/logout`,
    revocationEndpoint: `${OIDC_ISSUER}/oauth/revoke`,
    jwksUri: `${OIDC_ISSUER}/.well-known/jwks.json`,
    issuer: ISSUER,
  }
}

interface RawDiscovery {
  issuer?: string
  authorization_endpoint?: string
  token_endpoint?: string
  userinfo_endpoint?: string
  end_session_endpoint?: string
  revocation_endpoint?: string
  jwks_uri?: string
}

function parseDiscovery(raw: RawDiscovery, origin: string): DiscoveryEndpoints | null {
  // issuer must match expected value
  if (!raw.issuer || raw.issuer !== ISSUER) return null

  const authz = raw.authorization_endpoint
  const token = raw.token_endpoint
  if (!authz || !token) return null

  // All endpoints must be same-origin as issuer for security
  const endpoints = [authz, token, raw.userinfo_endpoint, raw.end_session_endpoint, raw.revocation_endpoint, raw.jwks_uri]
  for (const ep of endpoints) {
    if (ep) {
      try {
        if (new URL(ep).origin !== origin) return null
      } catch {
        return null
      }
    }
  }

  return {
    authorizationEndpoint: authz,
    tokenEndpoint: token,
    userinfoEndpoint: raw.userinfo_endpoint || `${OIDC_ISSUER}/v1/me`,
    endSessionEndpoint: raw.end_session_endpoint || `${OIDC_ISSUER}/oauth/logout`,
    revocationEndpoint: raw.revocation_endpoint || `${OIDC_ISSUER}/oauth/revoke`,
    jwksUri: raw.jwks_uri || `${OIDC_ISSUER}/.well-known/jwks.json`,
    issuer: raw.issuer,
  }
}

async function fetchDiscovery(): Promise<DiscoveryEndpoints | null> {
  const url = `${OIDC_ISSUER}/.well-known/openid-configuration`
  const expectedOrigin = new URL(OIDC_ISSUER).origin

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
    })
    clearTimeout(timeout)

    if (!response.ok) return null

    const raw = (await response.json()) as RawDiscovery
    return parseDiscovery(raw, expectedOrigin)
  } catch {
    return null
  }
}

/**
 * Get OIDC discovery endpoints. Returns cached result if fresh (< TTL).
 * On failure (network, timeout, invalid response, issuer mismatch), falls back
 * to hardcoded endpoints derived from OIDC_ISSUER.
 */
export async function getDiscoveryEndpoints(): Promise<DiscoveryEndpoints> {
  // Return cache if fresh
  if (cache && Date.now() - cache.fetchedAt < DISCOVERY_TTL_MS) {
    return cache.endpoints
  }

  const endpoints = await fetchDiscovery()
  if (endpoints) {
    cache = { endpoints, fetchedAt: Date.now() }
    return endpoints
  }

  // Fail-safe: return hardcoded endpoints
  return hardcodedEndpoints()
}

/** Reset cache — for testing only. */
export function _resetDiscoveryCache(): void {
  cache = null
}
