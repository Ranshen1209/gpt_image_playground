import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultOpenAIProfile,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from './apiProfiles'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './urlSettings'

afterEach(() => {
  vi.unstubAllEnvs()
})

async function importDefaultConfigOnlyUrlSettings() {
  vi.resetModules()
  vi.stubEnv('VITE_SHOW_DEFAULT_CONFIG_ONLY', 'true')
  vi.stubEnv('VITE_DEFAULT_API_URL', 'https://default.example.com/v1')
  return import('./urlSettings')
}

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

  it('patches the active profile instead of creating a new one when only default config is shown', async () => {
    const { buildSettingsFromUrlParams } = await importDefaultConfigOnlyUrlSettings()
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1&apiKey=test-key&model=custom-model&profileName=导入配置&apiMode=responses')),
    })

    expect(next.profiles).toHaveLength(1)
    expect(next.customProviders).toHaveLength(0)
    expect(next.activeProfileId).toBe(current.activeProfileId)
    expect(next.profiles[0]).toMatchObject({
      id: current.activeProfileId,
      provider: 'openai',
      name: '导入配置',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'custom-model',
      apiMode: 'responses',
    })
  })

  it('ignores imported custom providers and non-default provider profiles when only default config is shown', async () => {
    const { buildSettingsFromUrlParams } = await importDefaultConfigOnlyUrlSettings()
    const importedSettings = {
      customProviders: [{
        id: 'custom-json',
        name: 'Custom JSON',
        submit: {
          path: 'images/generations',
          method: 'POST',
          contentType: 'json',
          body: { model: '$profile.model', prompt: '$prompt' },
          result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: [] },
        },
      }],
      profiles: [{
        id: 'custom-profile',
        name: 'Custom Profile',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'custom-key',
        model: 'custom-model',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
    }
    const params = new URLSearchParams()
    params.set('settings', JSON.stringify(importedSettings))

    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, params),
    })

    expect(next.profiles).toHaveLength(1)
    expect(next.customProviders).toHaveLength(0)
    expect(next.activeProfileId).toBe(current.activeProfileId)
    expect(next.profiles[0]).toMatchObject({
      provider: 'openai',
      baseUrl: current.profiles[0].baseUrl,
      apiKey: current.profiles[0].apiKey,
      model: current.profiles[0].model,
    })
  })

  it('patches from a matching imported profile without importing custom providers when only default config is shown', async () => {
    const { buildSettingsFromUrlParams } = await importDefaultConfigOnlyUrlSettings()
    const importedSettings = {
      customProviders: [{
        id: 'custom-json',
        name: 'Custom JSON',
        submit: {
          path: 'images/generations',
          method: 'POST',
          contentType: 'json',
          body: { model: '$profile.model', prompt: '$prompt' },
          result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: [] },
        },
      }],
      profiles: [{
        id: 'custom-profile',
        name: 'Custom Profile',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'custom-key',
        model: 'custom-model',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }, {
        id: 'openai-profile',
        name: 'OpenAI Profile',
        provider: 'openai',
        baseUrl: 'https://openai.example.com/v1',
        apiKey: 'openai-key',
        model: 'openai-model',
        timeout: 120,
        apiMode: 'responses',
        codexCli: true,
        apiProxy: true,
      }],
    }
    const params = new URLSearchParams()
    params.set('settings', JSON.stringify(importedSettings))

    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, params),
    })

    expect(next.profiles).toHaveLength(1)
    expect(next.customProviders).toHaveLength(0)
    expect(next.activeProfileId).toBe(current.activeProfileId)
    expect(next.profiles[0]).toMatchObject({
      id: current.activeProfileId,
      provider: 'openai',
      name: 'OpenAI Profile',
      baseUrl: 'https://openai.example.com/v1',
      apiKey: 'openai-key',
      model: 'openai-model',
      timeout: 120,
      apiMode: 'responses',
      codexCli: true,
      apiProxy: true,
    })
  })

  it('does not switch away from the default custom provider when only default config is shown', async () => {
    const { buildSettingsFromUrlParams } = await importDefaultConfigOnlyUrlSettings()
    const customProvider = {
      id: 'custom-default',
      name: 'Custom Default',
      submit: {
        path: 'images/generations',
        method: 'POST' as const,
        contentType: 'json' as const,
        body: { model: '$profile.model', prompt: '$prompt' },
        result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: [] },
      },
    }
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: [customProvider],
      profiles: [{
        ...createDefaultOpenAIProfile({ id: 'custom-default-profile' }),
        name: 'Custom Default Profile',
        provider: customProvider.id,
        baseUrl: 'https://custom-default.example.com/v1',
        apiKey: 'custom-default-key',
        model: 'custom-default-model',
      }],
      activeProfileId: 'custom-default-profile',
    })
    const params = new URLSearchParams()
    params.set('settings', JSON.stringify({
      customProviders: [{
        id: 'another-custom',
        name: 'Another Custom',
        submit: customProvider.submit,
      }],
      profiles: [{
        id: 'openai-profile',
        name: 'Ignored OpenAI',
        provider: 'openai',
        baseUrl: 'https://openai.example.com/v1',
        apiKey: 'openai-key',
        model: 'openai-model',
        timeout: 120,
        apiMode: 'responses',
        codexCli: true,
        apiProxy: true,
      }, {
        id: 'matching-custom-profile',
        name: 'Patched Custom Default',
        provider: customProvider.id,
        baseUrl: 'https://patched-custom.example.com/v1',
        apiKey: 'patched-custom-key',
        model: 'patched-custom-model',
        timeout: 240,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
    }))

    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, params),
    })

    expect(next.customProviders).toHaveLength(1)
    expect(next.customProviders[0].id).toBe(customProvider.id)
    expect(next.profiles).toHaveLength(1)
    expect(next.activeProfileId).toBe(current.activeProfileId)
    expect(next.profiles[0]).toMatchObject({
      id: current.activeProfileId,
      provider: customProvider.id,
      name: 'Patched Custom Default',
      baseUrl: 'https://patched-custom.example.com/v1',
      apiKey: 'patched-custom-key',
      model: 'patched-custom-model',
      timeout: 240,
      apiMode: 'images',
    })
  })
})
