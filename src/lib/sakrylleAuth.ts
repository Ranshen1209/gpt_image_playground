// Sakrylle OAuth 2.0 Authorization Code + PKCE flow.
// 与 Sakrylle OAuth provider 的 /oauth/authorize、/oauth/token 端点对接。
// 详见 docs/OAUTH_V2_INTEGRATION.md (§3, §5, §9)。
// v2 canonical scopes: profile:read account:balance:read models:read images:create responses:create offline_access
// Legacy v1 aliases (image_generation, balance:read) remain accepted during the deprecation window.

import i18n from './i18n'
import { getDiscoveryEndpoints } from './sakrylleOidcDiscovery'
import { readRuntimeEnv } from './runtimeEnv'

const OAUTH_BASE = readRuntimeEnv(import.meta.env.VITE_SAKRYLLE_OAUTH_BASE) || 'https://oidc1.sakrylle.com'
const CLIENT_ID = readRuntimeEnv(import.meta.env.VITE_SAKRYLLE_OAUTH_CLIENT_ID) || 'sakrylle-image-playground'

/** Feature flag: when 'true', enable OIDC (openid scope + id_token + Discovery). Default false. */
export const OIDC_ENABLED = readRuntimeEnv(import.meta.env.VITE_SAKRYLLE_OIDC_ENABLED) === 'true'

// v2 canonical scopes — ONE token grants access to both Images API and Responses API.
// offline_access is required to receive a refresh token.
// profile:read enables /v1/me user info endpoint.
// account:read enables allowed_groups, current_group in /v1/me (needed for group selection).
// chat.completions:create is required by the streaming chat/completions image path
// (default for Sakrylle since v0.10.3) — distinct from images:create.
const V2_SCOPES = 'profile:read account:read account:balance:read models:read images:create responses:create chat.completions:create offline_access'
const OIDC_SCOPES = 'openid profile email'
const SCOPE = OIDC_ENABLED ? `${OIDC_SCOPES} ${V2_SCOPES}` : V2_SCOPES

const AUTH_STORAGE_KEY = 'sakrylle-image-playground.auth'
const PKCE_VERIFIER_KEY = 'sakrylle-image-playground.pkce-verifier'
const PKCE_STATE_KEY = 'sakrylle-image-playground.pkce-state'
const NONCE_KEY = 'sakrylle-image-playground.oidc-nonce'

const REFRESH_LEAD_TIME_MS = 60_000
const DEFAULT_TOKEN_TTL_SECONDS = 86_400

export interface IdTokenClaims {
  sub: string
  name?: string
  email?: string
  email_verified?: boolean
  preferred_username?: string
  nonce?: string
  iss?: string
  aud?: string | string[]
  exp?: number
}

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
  /** OIDC id_token (raw JWT string). Only present when OIDC_ENABLED and server returns it. */
  idToken?: string
  /** Decoded id_token payload claims. Only present when id_token was successfully parsed. */
  idTokenClaims?: IdTokenClaims
}

interface OAuthGroupPayload {
  id?: number | string
  group_id?: number | string
  name?: string
  group_name?: string
  title?: string
}

interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  /** Seconds until the refresh token family expires (family-anchored, not rolling). */
  refresh_token_expires_in?: number
  scope?: string
  group?: OAuthGroupPayload
  additional_tokens?: Array<{
    access_token: string
    expires_in?: number
    scope?: string
    group?: OAuthGroupPayload
  }>
  /** OIDC id_token — only present when scope includes 'openid'. */
  id_token?: string
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

function generateNonce(): string {
  const random = new Uint8Array(16)
  crypto.getRandomValues(random)
  return base64UrlEncode(random.buffer)
}

/** Decode id_token JWT payload (base64url) without signature verification. */
function decodeIdTokenPayload(idToken: string): IdTokenClaims | null {
  try {
    const parts = idToken.split('.')
    if (parts.length !== 3) return null
    const raw = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
    const claims = JSON.parse(raw) as IdTokenClaims
    if (!claims.sub || !claims.iss) return null
    if (claims.exp && Date.now() / 1000 >= claims.exp) return null
    // aud check: may be string or string[]
    if (claims.aud) {
      const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
      if (!auds.includes(CLIENT_ID)) return null
    }
    return claims
  } catch {
    return null
  }
}

function parseGroupId(group: OAuthGroupPayload | { id?: number; name?: string } | undefined): number | undefined {
  const rawId = group?.id ?? (group as OAuthGroupPayload | undefined)?.group_id
  const id = typeof rawId === 'number' ? rawId : Number(rawId)
  return Number.isFinite(id) && id > 0 ? id : undefined
}

function parseGroupName(group: OAuthGroupPayload | { name?: string } | undefined): string | undefined {
  const rawName = group?.name ?? (group as OAuthGroupPayload | undefined)?.group_name ?? (group as OAuthGroupPayload | undefined)?.title
  if (typeof rawName !== 'string') return undefined
  const name = rawName.trim()
  return name ? name : undefined
}

function collectPreviousGroups(token?: SakrylleAuthToken): Map<number, { id: number; name: string }> {
  const groups = new Map<number, { id: number; name: string }>()
  const addGroup = (group: { id?: number; name?: string } | undefined) => {
    const id = parseGroupId(group)
    const name = parseGroupName(group)
    if (id && name) groups.set(id, { id, name })
  }
  addGroup(token?.group)
  token?.additionalTokens?.forEach((item) => addGroup(item.group))
  return groups
}

function normalizeTokenGroup(
  group: OAuthGroupPayload | undefined,
  previousGroups: Map<number, { id: number; name: string }>,
): { id: number; name: string } | undefined {
  const id = parseGroupId(group)
  if (!id) return undefined
  return {
    id,
    name: parseGroupName(group) ?? previousGroups.get(id)?.name ?? `Group ${id}`,
  }
}

function mergeAdditionalTokens(
  payloadTokens: OAuthTokenResponse['additional_tokens'],
  previousToken: SakrylleAuthToken | undefined,
  previousGroups: Map<number, { id: number; name: string }>,
  nextPrimaryGroup: { id: number; name: string } | undefined,
): SakrylleAuthToken['additionalTokens'] {
  const merged: NonNullable<SakrylleAuthToken['additionalTokens']> = []
  const seenGroupIds = new Set<number>()
  const now = Date.now()

  const addToken = (token: NonNullable<SakrylleAuthToken['additionalTokens']>[number]) => {
    const groupId = parseGroupId(token.group)
    if (!groupId || groupId === nextPrimaryGroup?.id || seenGroupIds.has(groupId)) return
    if (token.expiresAt <= now) return
    seenGroupIds.add(groupId)
    merged.push(token)
  }

  payloadTokens?.forEach((token) => addToken({
    accessToken: token.access_token,
    expiresAt: Date.now() + (token.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000,
    scope: token.scope,
    group: normalizeTokenGroup(token.group, previousGroups),
  }))

  if (previousToken?.group) {
    addToken({
      accessToken: previousToken.accessToken,
      expiresAt: previousToken.expiresAt,
      scope: previousToken.scope,
      group: previousToken.group,
    })
  }
  previousToken?.additionalTokens?.forEach(addToken)

  return merged.length ? merged : undefined
}

function tokenFromPayload(
  payload: OAuthTokenResponse,
  opts: {
    requireRefresh: boolean
    previousScope?: string
    previousRefreshTokenExpiresAt?: number
    previousToken?: SakrylleAuthToken
    requestedGroupId?: number
  },
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

  const previousGroups = collectPreviousGroups(opts.previousToken)
  const requestedGroup = opts.requestedGroupId
    ? {
        id: opts.requestedGroupId,
        name: previousGroups.get(opts.requestedGroupId)?.name ?? `Group ${opts.requestedGroupId}`,
      }
    : undefined
  const normalizedGroup = normalizeTokenGroup(payload.group, previousGroups)
    ?? requestedGroup
    ?? (payload.group ? undefined : opts.previousToken?.group)
  const normalizedAdditionalTokens = mergeAdditionalTokens(
    payload.additional_tokens,
    opts.previousToken,
    previousGroups,
    normalizedGroup,
  )

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (payload.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000,
    scope: payload.scope ?? opts.previousScope,
    refreshTokenExpiresAt,
    group: normalizedGroup,
    additionalTokens: normalizedAdditionalTokens,
  }
}

export async function beginLogin(): Promise<void> {
  const verifier = await generatePkceVerifier()
  const challenge = await pkceChallengeFromVerifier(verifier)
  const state = generateState()
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier)
  sessionStorage.setItem(PKCE_STATE_KEY, state)

  let authorizationEndpoint = `${OAUTH_BASE}/oauth/authorize`
  if (OIDC_ENABLED) {
    const discovery = await getDiscoveryEndpoints()
    authorizationEndpoint = discovery.authorizationEndpoint
    const nonce = generateNonce()
    sessionStorage.setItem(NONCE_KEY, nonce)
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  if (OIDC_ENABLED) {
    const nonce = sessionStorage.getItem(NONCE_KEY)
    if (nonce) params.set('nonce', nonce)
  }
  window.location.href = `${authorizationEndpoint}?${params.toString()}`
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
  let tokenEndpoint = `${OAUTH_BASE}/oauth/token`
  if (OIDC_ENABLED) {
    const discovery = await getDiscoveryEndpoints()
    tokenEndpoint = discovery.tokenEndpoint
  }
  const response = await fetch(tokenEndpoint, {
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

  // OIDC: parse id_token and verify nonce
  if (OIDC_ENABLED && payload.id_token) {
    const claims = decodeIdTokenPayload(payload.id_token)
    if (claims) {
      const expectedNonce = sessionStorage.getItem(NONCE_KEY)
      if (expectedNonce && claims.nonce !== expectedNonce) {
        console.warn('OIDC nonce mismatch — falling back to /v1/me for identity')
      } else {
        token.idToken = payload.id_token
        token.idTokenClaims = claims
      }
    } else {
      console.warn('OIDC id_token decode failed — falling back to /v1/me for identity')
    }
  }
  sessionStorage.removeItem(NONCE_KEY)

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
  window.sessionStorage.removeItem(NONCE_KEY)
}

// RFC 7009 token revocation — docs §9.
// Returns silently on any error (server returns 200 even for unknown tokens).
async function revokeToken(token: string, hint: 'refresh_token' | 'access_token'): Promise<void> {
  try {
    let revocationEndpoint = `${OAUTH_BASE}/oauth/revoke`
    if (OIDC_ENABLED) {
      const discovery = await getDiscoveryEndpoints()
      revocationEndpoint = discovery.revocationEndpoint
    }
    const body = new URLSearchParams({
      token,
      token_type_hint: hint,
      client_id: CLIENT_ID,
    })
    await fetch(revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch {
    // Revocation is best-effort; network errors must not block logout.
  }
}

// Revoke the stored refresh token (preferred) then clear local state.
// When OIDC_ENABLED and an id_token is available, RP-Initiated Logout redirects
// to the IdP end_session_endpoint after clearing local state. The redirect path
// does not also revoke here; IdP session logout/token-family handling is owned
// by the provider contract. Fallback paths still perform best-effort revoke.
export async function logoutAndRevoke(): Promise<void> {
  const token = getStoredToken()

  // OIDC RP-Initiated Logout: redirect to IdP end_session_endpoint
  if (OIDC_ENABLED && token?.idToken) {
    try {
      const discovery = await getDiscoveryEndpoints()
      if (discovery.endSessionEndpoint) {
        const postLogoutUri = getRedirectUri().replace('/oauth/callback', '/')
        const url = `${discovery.endSessionEndpoint}?id_token_hint=${encodeURIComponent(token.idToken)}&post_logout_redirect_uri=${encodeURIComponent(postLogoutUri)}`
        logout()
        window.location.href = url
        return
      }
    } catch {
      // Discovery failed — fall through to local logout + revoke
    }
  }

  logout()
  if (token?.refreshToken) {
    await revokeToken(token.refreshToken, 'refresh_token')
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
    let tokenEndpoint = `${OAUTH_BASE}/oauth/token`
    if (OIDC_ENABLED) {
      const discovery = await getDiscoveryEndpoints()
      tokenEndpoint = discovery.tokenEndpoint
    }
    const response = await fetch(tokenEndpoint, {
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
      previousToken: token,
    })
    // OIDC: if server returns a new id_token on refresh, update claims.
    // Otherwise preserve existing claims (identity doesn't change on refresh).
    if (OIDC_ENABLED && payload.id_token) {
      const claims = decodeIdTokenPayload(payload.id_token)
      if (claims) {
        next.idToken = payload.id_token
        next.idTokenClaims = claims
      }
    } else if (token.idToken) {
      // Preserve existing id_token across refresh
      next.idToken = token.idToken
      next.idTokenClaims = token.idTokenClaims
    }
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

// Refresh token with a specific group_id to switch the token's bound group.
// docs §5: group_id must be in allowed_groups_snapshot recorded at consent time.
export async function refreshWithGroupId(groupId: number): Promise<SakrylleAuthToken | null> {
  const token = getStoredToken()
  if (!token?.refreshToken) return null

  if (token.refreshTokenExpiresAt != null && Date.now() >= token.refreshTokenExpiresAt) {
    logout()
    return null
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
      client_id: CLIENT_ID,
      group_id: String(groupId),
    })
    let tokenEndpoint = `${OAUTH_BASE}/oauth/token`
    if (OIDC_ENABLED) {
      const discovery = await getDiscoveryEndpoints()
      tokenEndpoint = discovery.tokenEndpoint
    }
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!response.ok) throw new Error(`refresh with group_id failed HTTP ${response.status}`)
    const payload = await response.json() as OAuthTokenResponse
    const next = tokenFromPayload(payload, {
      requireRefresh: true,
      previousScope: token.scope,
      previousRefreshTokenExpiresAt: token.refreshTokenExpiresAt,
      previousToken: token,
      requestedGroupId: groupId,
    })
    saveToken(next)
    return next
  } catch {
    return null
  }
}
