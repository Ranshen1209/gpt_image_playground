// OAuth Bearer fallback for image API requests.
//
// 当用户登录了 Sakrylle OAuth 但没配 API Key 时，自动用 access_token 调
// /v1/images/* 和 /v1/responses。仅适用于 Sakrylle 官方 baseUrl —— 其它服务商
// (fal.ai、自定义 HTTP) 仍然要求显式 apiKey。

import type { ApiProfile } from '../types'
import { getStoredToken, refreshIfNeeded } from './sakrylleAuth'
import { getSelectedGroups } from './groupSelection'
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
  if (!isSakrylleBaseUrl(profile.baseUrl)) return false

  const token = getStoredToken()
  if (!token) return false

  // Check if any token (primary or additional) supports the requested apiMode
  const allTokens = [
    { scope: token.scope ?? '', accessToken: token.accessToken },
    ...(token.additionalTokens ?? []).map(t => ({ scope: t.scope ?? '', accessToken: t.accessToken }))
  ]

  if (profile.apiMode === 'images') {
    return allTokens.some(t => t.scope.includes('images:create') || t.scope.includes('image_generation'))
  }
  if (profile.apiMode === 'responses') {
    return allTokens.some(t => t.scope.includes('responses:create'))
  }

  return false
}

// Returns the Bearer token string to use in Authorization header.
// Prefers profile.apiKey; falls back to a refreshed OAuth access_token.
// For multi-token scenarios, selects the token matching the profile's apiMode.
// Prioritizes user's selected group if available.
// Throws if neither is available — caller (image API) treats as auth error.
export async function resolveBearerToken(profile: ApiProfile): Promise<string> {
  const explicit = profile.apiKey.trim()
  if (explicit) return explicit
  if (!canUseOAuthForProfile(profile)) {
    throw new Error('missing_credentials')
  }
  const token = (await refreshIfNeeded()) ?? getStoredToken()
  if (!token) throw new Error('missing_credentials')

  // Select the appropriate token based on apiMode
  const allTokens = [
    { scope: token.scope ?? '', accessToken: token.accessToken, groupId: token.group?.id },
    ...(token.additionalTokens ?? []).map(t => ({ scope: t.scope ?? '', accessToken: t.accessToken, groupId: t.group?.id }))
  ]

  // Get user's selected group for this apiMode
  const selectedGroups = getSelectedGroups()
  const selectedGroupId = profile.apiMode === 'images' ? selectedGroups.images : selectedGroups.responses

  let selectedToken: string | undefined

  if (profile.apiMode === 'images') {
    const matchingTokens = allTokens.filter(t =>
      t.scope.includes('images:create') || t.scope.includes('image_generation')
    )
    // Prefer user's selected group, fallback to first match
    selectedToken = selectedGroupId
      ? matchingTokens.find(t => t.groupId === selectedGroupId)?.accessToken
      : matchingTokens[0]?.accessToken
  } else if (profile.apiMode === 'responses') {
    const matchingTokens = allTokens.filter(t =>
      t.scope.includes('responses:create')
    )
    // Prefer user's selected group, fallback to first match
    selectedToken = selectedGroupId
      ? matchingTokens.find(t => t.groupId === selectedGroupId)?.accessToken
      : matchingTokens[0]?.accessToken
  }

  if (!selectedToken) throw new Error('missing_credentials')
  return selectedToken
}
