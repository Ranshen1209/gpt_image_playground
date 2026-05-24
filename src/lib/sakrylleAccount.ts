// Sakrylle 账户余额 + 模型列表拉取。
// 详见 docs/SAKRYLLE_API_SPEC.md。

import { getStoredToken, refreshIfNeeded } from './sakrylleAuth'
import { readRuntimeEnv } from './runtimeEnv'

const SAKRYLLE_API_BASE = readRuntimeEnv(import.meta.env.VITE_DEFAULT_API_URL) || 'https://api.sakrylle.com/v1'

export interface SakrylleBalance {
  userId: string
  username: string
  creditRemainingCny: number
  creditRemainingUsd: number
  currencyDisplay: 'CNY' | 'USD'
  groupId: number
  groupName: string
}

export interface SakrylleModel {
  id: string
  ownedBy: string
  allowImageGeneration: boolean
  billingMode?: 'per_request' | 'per_token'
  perRequestPriceUsd?: number
}

async function authedFetch(path: string): Promise<Response | null> {
  const token = await refreshIfNeeded() ?? getStoredToken()
  if (!token) return null
  return fetch(`${SAKRYLLE_API_BASE.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, {
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
    },
    cache: 'no-store',
  })
}

export async function fetchBalance(): Promise<SakrylleBalance | null> {
  const response = await authedFetch('account/balance')
  if (!response || !response.ok) return null
  try {
    const payload = await response.json() as {
      user_id: string
      username: string
      credit_remaining_cny: number
      credit_remaining_usd: number
      currency_display?: 'CNY' | 'USD'
      group_id: number
      group_name: string
    }
    return {
      userId: payload.user_id,
      username: payload.username,
      creditRemainingCny: payload.credit_remaining_cny,
      creditRemainingUsd: payload.credit_remaining_usd,
      currencyDisplay: payload.currency_display ?? 'CNY',
      groupId: payload.group_id,
      groupName: payload.group_name,
    }
  } catch {
    return null
  }
}

export async function fetchModels(): Promise<SakrylleModel[]> {
  const response = await authedFetch('models')
  if (!response || !response.ok) return []
  try {
    const payload = await response.json() as {
      data?: Array<{
        id: string
        owned_by?: string
        allow_image_generation?: boolean
        billing_mode?: 'per_request' | 'per_token'
        per_request_price_usd?: number
      }>
    }
    return (payload.data ?? [])
      .filter((item) => item?.id && item.allow_image_generation !== false)
      .map((item) => ({
        id: item.id,
        ownedBy: item.owned_by ?? 'sakrylle',
        allowImageGeneration: item.allow_image_generation ?? true,
        billingMode: item.billing_mode,
        perRequestPriceUsd: item.per_request_price_usd,
      }))
  } catch {
    return []
  }
}

export function formatCny(amount: number): string {
  return `￥${amount.toFixed(2)}`
}
