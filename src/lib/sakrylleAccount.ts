// Sakrylle 账户余额 + 模型列表拉取。
// 详见 docs/OAUTH_CLIENT_INTEGRATION.md (§3.1, §6.3)。

import { forceRefreshToken, getStoredToken, logout, refreshIfNeeded } from './sakrylleAuth'
import { readRuntimeEnv } from './runtimeEnv'

const SAKRYLLE_API_BASE = readRuntimeEnv(import.meta.env.VITE_SAKRYLLE_PLATFORM_API)
  || readRuntimeEnv(import.meta.env.VITE_DEFAULT_API_URL)
  || 'https://api.sakrylle.com/v1'

export interface SakrylleBalance {
  userId: number
  username: string
  creditRemaining: number
  currencyDisplay: 'CNY' | 'USD'
  rateMultiplier: number
  groupId: number
  groupName: string
  allowImageGeneration: boolean
}

export interface SakrylleModel {
  id: string
  ownedBy: string
  allowImageGeneration: boolean
  billingMode?: 'per_request' | 'per_token'
  perRequestPriceUsd?: number
}

interface BalancePayload {
  user_id: number
  username: string
  credit_remaining: number
  currency_display?: 'CNY' | 'USD'
  rate_multiplier?: number
  group_id: number
  group_name: string
  allow_image_generation?: boolean
}

interface ModelsPayload {
  data?: Array<{
    id: string
    owned_by?: string
    allow_image_generation?: boolean
    billing_mode?: 'per_request' | 'per_token'
    per_request_price_usd?: number
  }>
}

// Deduped force-refresh per docs/OAUTH_CLIENT_INTEGRATION.md §6.3 — multiple in-flight
// 401s collapse into a single rotation call so we never burn a refresh_token twice.
let refreshInFlight: Promise<boolean> | null = null

async function dedupedForceRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  const p = (async () => {
    try {
      const next = await forceRefreshToken()
      return Boolean(next)
    } catch {
      return false
    }
  })()
  refreshInFlight = p
  void p.finally(() => {
    if (refreshInFlight === p) refreshInFlight = null
  })
  return p
}

async function isOAuthInvalidToken(response: Response): Promise<boolean> {
  if (response.status !== 401) return false
  try {
    const body = await response.clone().json() as { error?: string }
    return body?.error === 'invalid_token'
  } catch {
    return false
  }
}

function buildUrl(path: string): string {
  return `${SAKRYLLE_API_BASE.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function buildRequestInit(token: string, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return { ...init, headers, cache: init?.cache ?? 'no-store' }
}

// Authed fetch with auto-refresh on OAuth-shell 401 (docs §3 + §4.3 + §6.3).
// Single retry: refresh failure or post-retry 401 → terminal logout.
async function authedFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const initialToken = await refreshIfNeeded() ?? getStoredToken()
  if (!initialToken) return null

  const url = buildUrl(path)
  const firstResponse = await fetch(url, buildRequestInit(initialToken.accessToken, init))

  if (!(await isOAuthInvalidToken(firstResponse))) {
    return firstResponse
  }

  const refreshed = await dedupedForceRefresh()
  if (!refreshed) {
    logout()
    return firstResponse
  }

  const nextToken = getStoredToken()
  if (!nextToken) {
    logout()
    return firstResponse
  }

  const retried = await fetch(url, buildRequestInit(nextToken.accessToken, init))
  if (await isOAuthInvalidToken(retried)) {
    logout()
  }
  return retried
}

export async function fetchBalance(): Promise<SakrylleBalance | null> {
  const response = await authedFetch('account/balance')
  if (!response || !response.ok) return null
  try {
    const payload = await response.json() as BalancePayload
    return {
      userId: payload.user_id,
      username: payload.username,
      creditRemaining: payload.credit_remaining,
      currencyDisplay: payload.currency_display ?? 'CNY',
      rateMultiplier: payload.rate_multiplier ?? 1,
      groupId: payload.group_id,
      groupName: payload.group_name,
      allowImageGeneration: payload.allow_image_generation ?? false,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'parse error'
    console.warn('Sakrylle balance parse failed:', message)
    return null
  }
}

export async function fetchModels(): Promise<SakrylleModel[]> {
  const response = await authedFetch('models')
  if (!response || !response.ok) return []
  try {
    const payload = await response.json() as ModelsPayload
    return (payload.data ?? [])
      .filter((item) => item?.id && item.allow_image_generation === true)
      .map((item) => ({
        id: item.id,
        ownedBy: item.owned_by ?? 'sakrylle',
        allowImageGeneration: true,
        billingMode: item.billing_mode,
        perRequestPriceUsd: item.per_request_price_usd,
      }))
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'parse error'
    console.warn('Sakrylle models parse failed:', message)
    return []
  }
}

// Render a balance with the symbol Sakrylle returned for this user.
// docs §3.1 — currency_display drives symbol; the numeric value is NOT FX-converted.
export function formatBalance(amount: number, currency: 'CNY' | 'USD' = 'CNY'): string {
  const symbol = currency === 'USD' ? '$' : '￥'
  return `${symbol}${amount.toFixed(2)}`
}

/**
 * @deprecated Use `formatBalance(amount, currencyDisplay)` instead. Retained for
 * smooth migration; will be removed once all call sites move to formatBalance.
 */
export function formatCny(amount: number): string {
  return formatBalance(amount, 'CNY')
}
