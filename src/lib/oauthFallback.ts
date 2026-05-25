// OAuth Bearer fallback for image API requests.
//
// 当用户登录了 Sakrylle OAuth 但没配 API Key 时，自动用 access_token 调
// /v1/images/* 和 /v1/responses。仅适用于 Sakrylle 官方 baseUrl —— 其它服务商
// (fal.ai、自定义 HTTP) 仍然要求显式 apiKey。

import type { ApiProfile } from '../types'
import { getStoredToken, refreshIfNeeded } from './sakrylleAuth'
import { readRuntimeEnv } from './runtimeEnv'

const SAKRYLLE_API_BASE = (readRuntimeEnv(import.meta.env.VITE_SAKRYLLE_PLATFORM_API)
  || readRuntimeEnv(import.meta.env.VITE_DEFAULT_API_URL)
  || 'https://api.sakrylle.com/v1').replace(/\/+$/, '')

function isSakrylleBaseUrl(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, '') === SAKRYLLE_API_BASE
}

// Synchronous gate: true means an empty apiKey is OK, the request will run
// under the OAuth token instead. False means the profile genuinely needs a key.
export function canUseOAuthForProfile(profile: ApiProfile): boolean {
  if (profile.provider !== 'openai') return false
  // OAuth token 只支持 Images API（绑定到 GPT-Image group）
  // Responses API 需要 GPT-Pro/Plus group 的手动 key
  if (profile.apiMode !== 'images') return false
  if (!isSakrylleBaseUrl(profile.baseUrl)) return false
  return Boolean(getStoredToken())
}

// Returns the Bearer token string to use in Authorization header.
// Prefers profile.apiKey; falls back to a refreshed OAuth access_token.
// Throws if neither is available — caller (image API) treats as auth error.
export async function resolveBearerToken(profile: ApiProfile): Promise<string> {
  const explicit = profile.apiKey.trim()
  if (explicit) return explicit
  if (!canUseOAuthForProfile(profile)) {
    throw new Error('missing_credentials')
  }
  const token = (await refreshIfNeeded()) ?? getStoredToken()
  if (!token) throw new Error('missing_credentials')
  return token.accessToken
}
