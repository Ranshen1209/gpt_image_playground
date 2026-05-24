import type { ApiMode, AppSettings } from '../types'
import {
  createDefaultOpenAIProfile,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_RESPONSES_MODEL,
  normalizeSettings,
  normalizeStreamPartialImages,
} from './apiProfiles'

const URL_SETTING_KEYS = ['apiKey', 'apiMode', 'model', 'streamImages', 'streamPartialImages']

function getProfileDedupKey(profile: Pick<AppSettings['profiles'][number], 'provider' | 'baseUrl' | 'apiKey' | 'model' | 'apiMode' | 'streamImages' | 'streamPartialImages'>) {
  return JSON.stringify([
    profile.provider,
    profile.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
    profile.apiKey.trim(),
    profile.model.trim(),
    profile.apiMode,
    profile.streamImages === true,
    profile.streamPartialImages ?? 0,
  ])
}

function createUrlProfileId(usedIds: Set<string>) {
  let id = `openai-url-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  while (usedIds.has(id)) {
    id = `openai-url-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  }
  return id
}

export function hasUrlSettingParams(searchParams: URLSearchParams) {
  return URL_SETTING_KEYS.some((key) => searchParams.has(key))
}

export function clearUrlSettingParams(searchParams: URLSearchParams) {
  for (const key of URL_SETTING_KEYS) searchParams.delete(key)
}

export function buildSettingsFromUrlParams(currentSettings: Partial<AppSettings> | unknown, searchParams: URLSearchParams): Partial<AppSettings> {
  const apiKeyParam = searchParams.get('apiKey')
  const apiModeParam = searchParams.get('apiMode')
  const modelParam = searchParams.get('model')
  const streamImagesParam = searchParams.get('streamImages')
  const streamPartialImagesParam = searchParams.get('streamPartialImages')
  const apiMode: ApiMode | undefined = apiModeParam === 'images' || apiModeParam === 'responses' ? apiModeParam : undefined

  const hasLegacyOpenAIParams = apiKeyParam !== null || apiMode !== undefined || modelParam !== null || streamImagesParam !== null || streamPartialImagesParam !== null
  if (!hasLegacyOpenAIParams) return {}

  const settings = normalizeSettings(currentSettings)
  const profileApiMode = apiMode ?? 'images'
  const profile = createDefaultOpenAIProfile({
    id: createUrlProfileId(new Set(settings.profiles.map((item) => item.id))),
    name: 'URL 参数配置',
    apiMode: profileApiMode,
    model: profileApiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL,
  })
  if (apiKeyParam !== null) profile.apiKey = apiKeyParam.trim()
  if (modelParam !== null && modelParam.trim()) profile.model = modelParam.trim()
  if (streamImagesParam !== null) profile.streamImages = streamImagesParam.trim().toLowerCase() === 'true'
  if (streamPartialImagesParam !== null) profile.streamPartialImages = normalizeStreamPartialImages(streamPartialImagesParam)

  const existingProfile = settings.profiles.find((item) => getProfileDedupKey(item) === getProfileDedupKey(profile))
  if (existingProfile) {
    return normalizeSettings({ ...settings, activeProfileId: existingProfile.id })
  }

  return normalizeSettings({
    ...settings,
    profiles: [...settings.profiles, profile],
    activeProfileId: profile.id,
  })
}
