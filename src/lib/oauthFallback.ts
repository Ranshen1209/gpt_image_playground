// OAuth Bearer fallback for image API requests.
//
// 当用户登录了 Sakrylle OAuth 但没配 API Key 时，自动用 access_token 调
// /v1/images/* 和 /v1/responses。仅适用于 Sakrylle 官方 baseUrl；自定义 HTTP
// 服务商仍然要求显式 apiKey。

import type { ApiProfile } from '../types'
import { ensureSelectedGroupId, getGroupAccessToken } from './groupSelection'
import { getStoredToken, refreshIfNeeded, refreshWithGroupId, type SakrylleAuthToken } from './sakrylleAuth'
import { readRuntimeEnv } from './runtimeEnv'

const SAKRYLLE_API_BASE = (readRuntimeEnv(import.meta.env.VITE_SAKRYLLE_PLATFORM_API)
  || readRuntimeEnv(import.meta.env.VITE_DEFAULT_API_URL)
  || 'https://api.sakrylle.com/v1').replace(/\/+$/, '')

function isSakrylleBaseUrl(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, '') === SAKRYLLE_API_BASE
}

export function canUseOAuthForProfile(profile: ApiProfile): boolean {
  if (profile.provider !== 'openai') return false
  if (!isSakrylleBaseUrl(profile.baseUrl)) return false

  const token = getStoredToken()
  if (!token) return false

  const scope = token.scope ?? ''
  if (profile.apiMode === 'responses') return scope.includes('responses:create')
  // The streaming chat/completions image path is an implementation detail for
  // Sakrylle Images mode. Existing and canonical OAuth grants use images:create.
  if (profile.streamChatCompletionsImage === true) {
    return scope.includes('images:create') ||
      scope.includes('image_generation') ||
      scope.includes('chat.completions:create')
  }
  return scope.includes('images:create') || scope.includes('image_generation')
}

function scopeIncludes(scope: string | undefined, value: string): boolean {
  return (scope ?? '').split(/\s+/).includes(value)
}

function tokenAllowsChatCompletions(scope: string | undefined): boolean {
  return scopeIncludes(scope, 'chat.completions:create')
}

function findTokenRecordInAuthSnapshot(
  token: SakrylleAuthToken,
  groupId: number,
): Pick<SakrylleAuthToken, 'accessToken' | 'scope'> | undefined {
  if (token.group?.id === groupId) return token
  return token.additionalTokens?.find((item) => item.group?.id === groupId)
}

function findTokenInAuthSnapshot(token: SakrylleAuthToken, groupId: number): string | undefined {
  if (token.group?.id === groupId) return token.accessToken
  return token.additionalTokens?.find((item) => item.group?.id === groupId)?.accessToken
}

export async function canUseChatCompletionsImagePath(profile: ApiProfile): Promise<boolean> {
  if (profile.apiKey.trim()) return true
  if (profile.provider !== 'openai' || !isSakrylleBaseUrl(profile.baseUrl)) return false

  const token = (await refreshIfNeeded()) ?? getStoredToken()
  if (!token) return false

  const groupId = await ensureSelectedGroupId('images')
  if (groupId == null) return tokenAllowsChatCompletions(token.scope)

  const latestToken = getStoredToken() ?? token
  const exactToken = findTokenRecordInAuthSnapshot(latestToken, groupId)
  return tokenAllowsChatCompletions(exactToken?.scope)
}

// Returns the Bearer token for Authorization header.
// Prefers profile.apiKey; falls back to the OAuth token selected for this API mode.
export async function resolveBearerToken(profile: ApiProfile): Promise<string> {
  const explicit = profile.apiKey.trim()
  if (explicit) return explicit
  if (!canUseOAuthForProfile(profile)) {
    throw new Error('missing_credentials')
  }
  const token = (await refreshIfNeeded()) ?? getStoredToken()
  if (!token) throw new Error('missing_credentials')
  const groupId = await ensureSelectedGroupId(profile.apiMode)
  if (profile.apiMode === 'responses' && groupId == null) {
    throw new Error('missing_credentials')
  }
  if (groupId == null) return token.accessToken

  const exactToken = getGroupAccessToken(groupId, { allowFallback: false })
  if (exactToken) return exactToken

  const refreshedForGroup = await refreshWithGroupId(groupId)
  const refreshedExactToken = getGroupAccessToken(groupId, { allowFallback: false })
  if (refreshedExactToken) return refreshedExactToken
  const refreshedSnapshotToken = refreshedForGroup ? findTokenInAuthSnapshot(refreshedForGroup, groupId) : undefined
  if (refreshedSnapshotToken) return refreshedSnapshotToken
  throw new Error('missing_credentials')
}
