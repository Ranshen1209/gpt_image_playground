// Sakrylle OAuth 2.0 Authorization Code + PKCE flow.
// 与 sub.sakrylle.com 的 /oauth/authorize、/oauth/token 端点对接。
// 详见 docs/SAKRYLLE_API_SPEC.md。

import { readRuntimeEnv } from './runtimeEnv'

const OAUTH_BASE = readRuntimeEnv(import.meta.env.VITE_SAKRYLLE_OAUTH_BASE) || 'https://sub.sakrylle.com'
const CLIENT_ID = readRuntimeEnv(import.meta.env.VITE_SAKRYLLE_OAUTH_CLIENT_ID) || 'sakrylle-image-playground'
const SCOPE = 'image_generation balance:read models:read'

const AUTH_STORAGE_KEY = 'sakrylle-image-playground.auth'
const PKCE_VERIFIER_KEY = 'sakrylle-image-playground.pkce-verifier'
const PKCE_STATE_KEY = 'sakrylle-image-playground.pkce-state'
const ENDPOINT_AVAILABLE_CACHE_KEY = 'sakrylle-image-playground.oauth-available'
const ENDPOINT_AVAILABLE_TTL_MS = 5 * 60 * 1000

export interface SakrylleAuthToken {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
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
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const expectedState = sessionStorage.getItem(PKCE_STATE_KEY)
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY)
  sessionStorage.removeItem(PKCE_STATE_KEY)
  sessionStorage.removeItem(PKCE_VERIFIER_KEY)

  if (!code) throw new Error('OAuth 回调缺少授权码')
  if (!state || state !== expectedState) throw new Error('OAuth state 不匹配，可能存在 CSRF 风险')
  if (!verifier) throw new Error('找不到 PKCE verifier，请重新登录')

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
    throw new Error(`换取 access_token 失败：HTTP ${response.status}${message ? ` ${message}` : ''}`)
  }
  const payload = await response.json() as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    scope?: string
  }
  const token: SakrylleAuthToken = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (payload.expires_in ?? 86400) * 1000,
    scope: payload.scope,
  }
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

export async function refreshIfNeeded(): Promise<SakrylleAuthToken | null> {
  const token = getStoredToken()
  if (!token) return null
  if (Date.now() < token.expiresAt - 60_000) return token
  if (!token.refreshToken) {
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
    const payload = await response.json() as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      scope?: string
    }
    const next: SakrylleAuthToken = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? token.refreshToken,
      expiresAt: Date.now() + (payload.expires_in ?? 86400) * 1000,
      scope: payload.scope ?? token.scope,
    }
    saveToken(next)
    return next
  } catch {
    logout()
    return null
  }
}

interface EndpointAvailabilityCache {
  available: boolean
  checkedAt: number
}

export async function isOAuthEndpointAvailable(): Promise<boolean> {
  if (typeof window === 'undefined') return false
  const cached = readEndpointCache()
  if (cached && Date.now() - cached.checkedAt < ENDPOINT_AVAILABLE_TTL_MS) {
    return cached.available
  }

  let available = false
  try {
    const response = await fetch(`${OAUTH_BASE}/oauth/authorize`, { method: 'HEAD', mode: 'cors' })
    available = response.ok || response.status === 405 || response.status === 400
  } catch {
    available = false
  }

  writeEndpointCache({ available, checkedAt: Date.now() })
  return available
}

function readEndpointCache(): EndpointAvailabilityCache | null {
  try {
    const raw = window.sessionStorage.getItem(ENDPOINT_AVAILABLE_CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as EndpointAvailabilityCache
  } catch {
    return null
  }
}

function writeEndpointCache(cache: EndpointAvailabilityCache) {
  try {
    window.sessionStorage.setItem(ENDPOINT_AVAILABLE_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // ignore
  }
}
