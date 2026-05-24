import { describe, expect, it } from 'vitest'
import {
  createDefaultOpenAIProfile,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from './apiProfiles'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './urlSettings'

describe('URL settings params', () => {
  it('creates and activates a new OpenAI profile for legacy URL params', () => {
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiKey=test-key')),
    })

    expect(next.profiles).toHaveLength(2)
    expect(next.activeProfileId).not.toBe(current.activeProfileId)
    expect(next.profiles.find((profile) => profile.id === next.activeProfileId)).toMatchObject({
      name: 'URL 参数配置',
      provider: 'openai',
      apiKey: 'test-key',
      model: DEFAULT_IMAGES_MODEL,
    })
  })

  it('uses model from URL params for OpenAI profiles', () => {
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiKey=test-key&model=custom-image-model')),
    })

    expect(next.profiles.find((profile) => profile.id === next.activeProfileId)).toMatchObject({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'custom-image-model',
      apiMode: 'images',
    })
  })

  it('does not create a duplicate profile for matching legacy URL params', () => {
    const existingProfile = createDefaultOpenAIProfile({
      id: 'existing-openai',
      name: 'Existing OpenAI',
      apiKey: 'test-key',
    })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [createDefaultOpenAIProfile(), existingProfile],
      activeProfileId: DEFAULT_SETTINGS.activeProfileId,
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiKey=test-key')),
    })

    expect(next.profiles).toHaveLength(2)
    expect(next.activeProfileId).toBe(existingProfile.id)
  })

  it('creates a separate profile when URL streaming options differ', () => {
    const existingProfile = createDefaultOpenAIProfile({
      id: 'existing-openai',
      name: 'Existing OpenAI',
      apiKey: 'test-key',
      streamImages: true,
      streamPartialImages: 0,
    })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [createDefaultOpenAIProfile(), existingProfile],
      activeProfileId: DEFAULT_SETTINGS.activeProfileId,
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiKey=test-key&streamImages=true&streamPartialImages=3')),
    })
    const activeProfile = next.profiles.find((profile) => profile.id === next.activeProfileId)

    expect(next.profiles).toHaveLength(3)
    expect(next.activeProfileId).not.toBe(existingProfile.id)
    expect(activeProfile).toMatchObject({
      provider: 'openai',
      apiKey: 'test-key',
      streamImages: true,
      streamPartialImages: 3,
    })
  })

  it('clears known URL setting params without touching unrelated params', () => {
    const params = new URLSearchParams('apiKey=test-key&model=test-model&streamImages=false&streamPartialImages=3&foo=bar')

    expect(hasUrlSettingParams(params)).toBe(true)
    clearUrlSettingParams(params)

    expect(params.toString()).toBe('foo=bar')
  })

  it('ignores apiUrl and settings params (third-party endpoints not allowed)', () => {
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://evil.example.com/v1&settings={"profiles":[]}'))

    expect(next).toEqual({})
  })
})
