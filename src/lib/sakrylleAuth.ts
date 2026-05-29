// Sakrylle OAuth 2.0 Authorization Code + PKCE flow.
// 与 sub.sakrylle.com 的 /oauth/authorize、/oauth/token 端点对接。
// 详见 docs/OAUTH_V2_INTEGRATION.md (§3, §5, §9)。
// v2 canonical scopes: profile:read account:balance:read models:read images:create responses:create offline_access
// Legacy v1 aliases (image_generation, balance:read) remain accepted during the deprecation window.

import i18n from './i18n'
import { readRuntimeEnv } from './runtimeEnv'

const OAUTH_BASE = readRuntimeEnv(import.meta.env.VITE_SAKRYLLE_OAUTH_BASE) || 'https://sub.sakrylle.com'
const CLIENT_ID = readRuntimeEnv(import.meta.env.VITE_SAKRYLLE_OAUTH_CLIENT_ID) || 'sakrylle-image-playground'
// v2 canonical scopes — ONE token grants access to both Images API and Responses API.
// offline_access is required to receive a refresh token.
// profile:read enables /v1/me user info endpoint.
const SCOPE = 'profile:read account:balance:read models:read images:create responses:create offline_access'

const AUTH_STORAGE_KEY = 'sakrylle-image-playground.auth'
const PKCE_VERIFIER_KEY = 'sakrylle-image-playground.pkce-verifier'
const PKCE_STATE_KEY = 'sakrylle-image-playground.pkce-state'

const REFRESH_LEAD_TIME_MS = 60_000
const DEFAULT_TOKEN_TTL_SECONDS = 86_400

export interface SakrylleAuthToken {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
  /** Absolute expiry of the refresh token family (epoch ms). Rotation does NOT extend this. */
  refreshTokenExpiresAt?: number
  /** Additional tokens for other groups (from OAuth multi-group authorization) */
  additionalTokens?: Array<{
    accessToken: string
    expiresAt: number
    scope?: string
    group?: { id: number; name: string }
  }>
  /** Primary token's group info */
  group?: { id: number; name: string }
}

interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  /** Seconds until the refresh token family expires (family-anchored, not rolling). */
  refresh_token_expires_in?: number
  scope?: string
  group?: { id: number; name: string }
  additional_tokens?: Array<{
    access_token: string
    expires_in?: number
    scope?: string
    group?: { id: number; name: string }
  }>
}

export function getRedirectUri(): string {
  if (typeof window === 'undefined') return 'https://image.sakrylle.com/oauth/callback'
  return `${window.location.origin}/oauth/callback`
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function generatePkceVerifier(): Promise<string> {
  const random = new Uint8Array(32)
  crypto.getRandomValues(random)
  return base64UrlEncode(random.buffer)
}

async function pkceChallengeFromVerifier(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(digest)
}

function generateState(): string {
  const random = new Uint8Array(16)
  crypto.getRandomValues(random)
  return base64UrlEncode(random.buffer)
}

function tokenFromPayload(
  payload: OAuthTokenResponse,
  opts: { requireRefresh: boolean; previousScope?: string; previousRefreshTokenExpiresAt?: number },
): SakrylleAuthToken {
  // docs §2.1 — authorization_code grant must return refresh_token.
  // docs §2.4 — refresh_token must rotate on every refresh. If the server
  // omits it, that is a protocol violation: keeping the old value will be
  // revoked on the next call. Surface as terminal error.
  if (opts.requireRefresh && !payload.refresh_token) {
    throw new Error('OAuth refresh_token rotation missing — terminal')
  }

  // v2 §5: refresh_token_expires_in is family-anchored (inherits original grant's absolute expiry).
  // On initial grant: compute from now + refresh_token_expires_in.
  // On rotation: server echoes the remaining TTL of the original family — use it.
  // If the server omits it on rotation, fall back to the previous stored value.
  let refreshTokenExpiresAt: number | undefined
  if (payload.refresh_token_expires_in != null) {
    refreshTokenExpiresAt = Date.now() + payload.refresh_token_expires_in * 1000
  } else if (opts.previousRefreshTokenExpiresAt != null) {
    refreshTokenExpiresAt = opts.previousRefreshTokenExpiresAt
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (payload.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000,
    scope: payload.scope ?? opts.previousScope,
    refreshTokenExpiresAt,
    group: payload.group,
    additionalTokens: payload.additional_tokens?.map((t) => ({
      accessToken: t.access_token,
      expiresAt: Date.now() + (t.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000,
      scope: t.scope,
      group: t.group,
    })),
  }
}

export async function beginLogin(): Promise<void> {
  const verifier = await generatePkceVerifier()
  const challenge = await pkceChallengeFromVerifier(verifier)
  const state = generateState()
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier)
  sessionStorage.setItem(PKCE_STATE_KEY, state)

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  window.location.href = `${OAUTH_BASE}/oauth/authorize?${params.toString()}`
}

export async function handleCallback(searchParams: URLSearchParams): Promise<SakrylleAuthToken> {
  const oauthError = searchParams.get('error')
  if (oauthError) {
    const desc = searchParams.get('error_description') || oauthError
    throw new Error(desc)
  }

  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const expectedState = sessionStorage.getItem(PKCE_STATE_KEY)
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY)
  sessionStorage.removeItem(PKCE_STATE_KEY)
  sessionStorage.removeItem(PKCE_VERIFIER_KEY)

  if (!code) throw new Error(i18n.t('errors.oauthMissingCode'))
  if (!state || state !== expectedState) throw new Error(i18n.t('errors.oauthStateMismatch'))
  if (!verifier) throw new Error(i18n.t('errors.oauthMissingVerifier'))

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
    client_id: CLIENT_ID,
    code_verifier: verifier,
  })
  const response = await fetch(`${OAUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(i18n.t('errors.oauthExchangeFailed', {
      status: response.status,
      detail: message ? ` ${message}` : '',
    }))
  }
  const payload = await response.json() as OAuthTokenResponse
  // docs §2.1 — authorization_code grant must return refresh_token.
  const token = tokenFromPayload(payload, { requireRefresh: true })
  saveToken(token)
  return token
}

export function getStoredToken(): SakrylleAuthToken | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SakrylleAuthToken
    if (!parsed?.accessToken) return null
    return parsed
  } catch {
    return null
  }
}

function saveToken(token: SakrylleAuthToken) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(token))
}

export function logout(): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(AUTH_STORAGE_KEY)
  window.sessionStorage.removeItem(PKCE_VERIFIER_KEY)
  window.sessionStorage.removeItem(PKCE_STATE_KEY)
}

// RFC 7009 token revocation — docs §9.
// Returns silently on any error (server returns 200 even for unknown tokens).
async function revokeToken(token: string, hint: 'refresh_token' | 'access_token'): Promise<void> {
  try {
    const body = new URLSearchParams({
      token,
      token_type_hint: hint,
      client_id: CLIENT_ID,
    })
    await fetch(`${OAUTH_BASE}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch {
    // Revocation is best-effort; network errors must not block logout.
  }
}

// Revoke the stored refresh token (preferred) then clear local state.
// Fire-and-forget: UI should not wait for the network call.
export function logoutAndRevoke(): void {
  const token = getStoredToken()
  logout()
  if (token?.refreshToken) {
    void revokeToken(token.refreshToken, 'refresh_token')
  }
}

async function performRefresh(token: SakrylleAuthToken): Promise<SakrylleAuthToken | null> {
  if (!token.refreshToken) {
    logout()
    return null
  }

  // v2 §5: family-anchored expiry — if the refresh token family has expired,
  // force re-auth instead of attempting a refresh that will fail with reuse detection.
  if (token.refreshTokenExpiresAt != null && Date.now() >= token.refreshTokenExpiresAt) {
    logout()
    return null
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
      client_id: CLIENT_ID,
    })
    const response = await fetch(`${OAUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!response.ok) throw new Error(`refresh_token 失败 HTTP ${response.status}`)
    const payload = await response.json() as OAuthTokenResponse
    // docs §2.4 — strict rotation: tokenFromPayload throws if refresh_token
    // is missing. Any error here is terminal per §4.3.
    // Pass previousRefreshTokenExpiresAt so family expiry is preserved across rotations.
    const next = tokenFromPayload(payload, {
      requireRefresh: true,
      previousScope: token.scope,
      previousRefreshTokenExpiresAt: token.refreshTokenExpiresAt,
    })
    saveToken(next)
    return next
  } catch {
    logout()
    return null
  }
}

// Refresh only when the access token is within REFRESH_LEAD_TIME_MS of expiry.
export async function refreshIfNeeded(): Promise<SakrylleAuthToken | null> {
  const token = getStoredToken()
  if (!token) return null
  if (Date.now() < token.expiresAt - REFRESH_LEAD_TIME_MS) return token
  return performRefresh(token)
}

// Force a refresh regardless of expiry — used when /v1/* returns OAuth-shell
// 401 invalid_token. Caller is responsible for deduping concurrent calls.
export async function forceRefreshToken(): Promise<SakrylleAuthToken | null> {
  const token = getStoredToken()
  if (!token) return null
  return performRefresh(token)
}
