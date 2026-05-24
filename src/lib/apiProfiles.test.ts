import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGES_MODEL,
  DEFAULT_OPENAI_PROFILE_ID,
  DEFAULT_SETTINGS,
  createDefaultOpenAIProfile,
  findEquivalentApiProfile,
  mergeImportedSettings,
  normalizeSettings,
} from './apiProfiles'

describe('mergeImportedSettings', () => {
  it('replaces the default OpenAI profile with legacy imported settings when current settings are untouched', () => {
    const merged = mergeImportedSettings(DEFAULT_SETTINGS, {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'imported-key',
      model: 'imported-model',
      timeout: 120,
      apiMode: 'responses',
      codexCli: true,
      apiProxy: true,
    })

    expect(merged.profiles).toHaveLength(1)
    expect(merged.activeProfileId).toBe(DEFAULT_OPENAI_PROFILE_ID)
    expect(merged.profiles[0]).toMatchObject({
      id: DEFAULT_OPENAI_PROFILE_ID,
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'imported-key',
      model: 'imported-model',
      timeout: 120,
      apiMode: 'responses',
      codexCli: true,
      apiProxy: true,
    })
  })

  it('replaces the default provider list with imported profiles when current settings are untouched', () => {
    const merged = mergeImportedSettings(DEFAULT_SETTINGS, {
      profiles: [
        {
          id: 'imported-openai-a',
          name: 'Imported OpenAI A',
          provider: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'openai-key-a',
          model: DEFAULT_IMAGES_MODEL,
          timeout: 300,
          apiMode: 'images',
          codexCli: false,
          apiProxy: false,
        },
        {
          id: 'imported-openai-b',
          name: 'Imported OpenAI B',
          provider: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'openai-key-b',
          model: DEFAULT_IMAGES_MODEL,
          timeout: 300,
          apiMode: 'images',
          codexCli: false,
          apiProxy: false,
        },
      ],
      activeProfileId: 'imported-openai-b',
    })

    expect(merged.profiles.map((profile) => profile.id)).toEqual(['imported-openai-a', 'imported-openai-b'])
    expect(merged.activeProfileId).toBe('imported-openai-b')
  })

  it('deduplicates imported profiles when replacing untouched default settings', () => {
    const merged = mergeImportedSettings(DEFAULT_SETTINGS, {
      profiles: [
        {
          id: 'imported-openai-a',
          name: 'Imported OpenAI A',
          provider: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'openai-key',
          model: DEFAULT_IMAGES_MODEL,
          timeout: 300,
          apiMode: 'images',
          codexCli: false,
          apiProxy: false,
        },
        {
          id: 'imported-openai-b',
          name: 'Imported OpenAI B',
          provider: 'openai',
          baseUrl: 'https://api.example.com/v1/',
          apiKey: 'openai-key',
          model: DEFAULT_IMAGES_MODEL,
          timeout: 600,
          apiMode: 'images',
          codexCli: true,
          apiProxy: true,
        },
      ],
      activeProfileId: 'imported-openai-b',
    })

    expect(merged.profiles).toHaveLength(1)
    expect(merged.profiles[0].id).toBe('imported-openai-a')
    expect(merged.activeProfileId).toBe('imported-openai-a')
  })

  it('appends imported legacy settings as a new profile when current settings are customized', () => {
    const current = mergeImportedSettings(DEFAULT_SETTINGS, {
      baseUrl: 'https://current.example.com/v1',
      apiKey: 'current-key',
      model: 'current-model',
    })
    const merged = mergeImportedSettings(current, {
      baseUrl: 'https://imported.example.com/v1',
      apiKey: 'imported-key',
      model: 'imported-model',
    })

    expect(merged.profiles).toHaveLength(2)
    expect(merged.activeProfileId).toBe(DEFAULT_OPENAI_PROFILE_ID)
    expect(merged.profiles[0]).toMatchObject({ apiKey: 'current-key', model: 'current-model' })
    expect(merged.profiles[1]).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://imported.example.com/v1',
      apiKey: 'imported-key',
      model: 'imported-model',
    })
    expect(merged.profiles[1].id).not.toBe(DEFAULT_OPENAI_PROFILE_ID)
  })

  it('skips imported profiles that already exist in current customized settings', () => {
    const current = mergeImportedSettings(DEFAULT_SETTINGS, {
      baseUrl: 'https://current.example.com/v1',
      apiKey: 'current-key',
      model: 'current-model',
    })
    const merged = mergeImportedSettings(current, {
      profiles: [
        {
          id: 'duplicate-openai',
          name: 'Duplicate OpenAI',
          provider: 'openai',
          baseUrl: 'https://current.example.com/v1/',
          apiKey: 'current-key',
          model: 'current-model',
          timeout: 600,
          apiMode: 'images',
          codexCli: true,
          apiProxy: true,
        },
        {
          id: 'new-openai',
          name: 'New OpenAI',
          provider: 'openai',
          baseUrl: 'https://imported.example.com/v1',
          apiKey: 'imported-key',
          model: DEFAULT_IMAGES_MODEL,
          timeout: 300,
          apiMode: 'images',
          codexCli: false,
          apiProxy: false,
        },
      ],
    })

    expect(merged.profiles).toHaveLength(2)
    expect(merged.profiles[0]).toMatchObject({ apiKey: 'current-key', model: 'current-model' })
    expect(merged.profiles[1]).toMatchObject({ provider: 'openai', apiKey: 'imported-key' })
  })

  it('reuses an existing keyed profile when importing the same profile without an API key', () => {
    const current = mergeImportedSettings(DEFAULT_SETTINGS, {
      profiles: [{
        id: 'existing-openai',
        name: 'Existing',
        provider: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'existing-key',
        model: 'custom-model',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
      activeProfileId: 'existing-openai',
    })
    const importedProfile = createDefaultOpenAIProfile({
      id: 'imported-openai',
      name: 'Imported',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
      model: 'custom-model',
    })
    const imported = normalizeSettings({
      profiles: [importedProfile],
      activeProfileId: importedProfile.id,
    })
    const merged = mergeImportedSettings(current, imported)
    const match = findEquivalentApiProfile(merged, imported.profiles[0])

    expect(merged.profiles).toHaveLength(1)
    expect(match?.id).toBe('existing-openai')
  })

  it('rejects markdown-corrupted profile fields when importing', () => {
    expect(() => mergeImportedSettings(DEFAULT_SETTINGS, {
      profiles: [{
        id: 'malformed',
        name: 'Malformed',
        provider: 'openai',
        baseUrl: '[https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
    })).toThrow('JSON 包含 Markdown 链接')
  })
})

describe('default profile', () => {
  it('enables streaming by default and preserves partial image count', () => {
    expect(createDefaultOpenAIProfile().streamImages).toBe(true)
    expect(createDefaultOpenAIProfile().streamPartialImages).toBe(1)
    expect(DEFAULT_SETTINGS.streamImages).toBe(true)
    expect(DEFAULT_SETTINGS.streamPartialImages).toBe(1)
    expect(DEFAULT_SETTINGS.profiles[0].streamImages).toBe(true)
    expect(DEFAULT_SETTINGS.profiles[0].streamPartialImages).toBe(1)

    const normalized = normalizeSettings({
      profiles: [
        createDefaultOpenAIProfile({ streamImages: false, streamPartialImages: 3 }),
      ],
    })

    expect(normalized.streamImages).toBe(false)
    expect(normalized.streamPartialImages).toBe(3)
    expect(normalized.profiles[0].streamImages).toBe(false)
    expect(normalized.profiles[0].streamPartialImages).toBe(3)

    const clamped = normalizeSettings({
      profiles: [
        createDefaultOpenAIProfile({ streamPartialImages: 8 }),
      ],
    })

    expect(clamped.profiles[0].streamPartialImages).toBe(3)
  })

  it('enables Agent submit auto scroll by default', () => {
    expect(DEFAULT_SETTINGS.agentScrollToBottomAfterSubmit).toBe(true)
    expect(normalizeSettings({}).agentScrollToBottomAfterSubmit).toBe(true)
    expect(normalizeSettings({ agentScrollToBottomAfterSubmit: false }).agentScrollToBottomAfterSubmit).toBe(false)
  })

  it('falls back to Sakrylle API URL when no override is set', () => {
    expect(createDefaultOpenAIProfile().baseUrl).toBe('https://api.sakrylle.com/v1')
    expect(DEFAULT_SETTINGS.baseUrl).toBe('https://api.sakrylle.com/v1')
  })
})
