import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_IMAGES_MODEL,
  DEFAULT_OPENAI_PROFILE_ID,
  DEFAULT_RESPONSES_MODEL,
  DEFAULT_SETTINGS,
  createDefaultOpenAIProfile,
  findEquivalentApiProfile,
  getActiveApiProfile,
  importCustomProviderDefinitionFromJson,
  importCustomProviderSettingsFromJson,
  mergeImportedSettings,
  normalizeApiProfile,
  normalizeSettings,
  switchApiProfileProvider,
  validateApiProfile,
} from './apiProfiles'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('validateApiProfile', () => {
  it('allows empty API URL when API proxy is enabled and available', () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')

    expect(validateApiProfile(createDefaultOpenAIProfile({
      baseUrl: '',
      apiKey: 'test-key',
      apiProxy: true,
    }))).toBeNull()
  })

  it('still requires API URL when API proxy is unavailable', () => {
    expect(validateApiProfile(createDefaultOpenAIProfile({
      baseUrl: '',
      apiKey: 'test-key',
      apiProxy: true,
    }))).toBe('缺少 API URL')
  })
})

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

describe('custom providers', () => {
  it('normalizes custom provider definitions and keeps custom profiles', () => {
    const settings = normalizeSettings({
      customProviders: [{
        id: 'custom-async',
        name: 'Custom Async',
        template: 'openai-compatible-async',
        generationPath: '/v1/images/generations',
        editPath: '/v1/images/edits',
        taskPath: '/v1/images/tasks/{task_id}',
      }],
      profiles: [{
        id: 'profile-custom',
        name: 'Custom Profile',
        provider: 'custom-async',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'key',
        model: 'model',
        timeout: 60,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
      activeProfileId: 'profile-custom',
    })

    expect(settings.customProviders[0]).toMatchObject({
      id: 'custom-async',
      template: 'http-image',
      submit: {
        path: 'images/generations',
        query: { async: 'true' },
        taskIdPath: 'data',
      },
      editSubmit: {
        path: 'images/edits',
        query: { async: 'true' },
        taskIdPath: 'data',
      },
      poll: {
        path: 'images/tasks/{task_id}',
      },
    })
    expect(settings.profiles[0].provider).toBe('custom-async')
  })

  it('normalizes an Apimart-style task manifest', () => {
    const provider = importCustomProviderDefinitionFromJson(JSON.stringify({
      name: 'Apimart GPT-Image-2',
      template: 'http-image',
      submit: {
        path: '/v1/images/generations',
        method: 'POST',
        contentType: 'json',
        body: {
          model: '$profile.model',
          prompt: '$prompt',
          n: '$params.n',
          size: '$params.size',
          resolution: '2k',
          image_urls: '$inputImages.dataUrls',
        },
        taskIdPath: 'data.0.task_id',
      },
      poll: {
        path: '/v1/tasks/{task_id}',
        method: 'GET',
        query: { language: 'zh' },
        statusPath: 'data.status',
        successValues: ['completed'],
        failureValues: ['failed', 'cancelled'],
        result: {
          imageUrlPaths: ['data.result.images.*.url.*'],
        },
      },
    }))

    expect(provider).toMatchObject({
      template: 'http-image',
      submit: {
        path: 'images/generations',
        taskIdPath: 'data.0.task_id',
      },
      poll: {
        path: 'tasks/{task_id}',
        query: { language: 'zh' },
        successValues: ['completed'],
        result: {
          imageUrlPaths: ['data.result.images.*.url.*'],
        },
      },
    })
  })

  it('imports wrapped custom provider settings with profiles', () => {
    const imported = importCustomProviderSettingsFromJson(JSON.stringify({
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
        name: 'Custom JSON',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        model: 'custom-model',
        apiMode: 'images',
      }],
    }))

    expect(imported.customProviders[0]).toMatchObject({ id: 'custom-json', name: 'Custom JSON' })
    expect(imported.profiles[0]).toMatchObject({
      name: 'Custom JSON',
      provider: 'custom-json',
      baseUrl: 'https://custom.example.com/v1',
      apiKey: '',
      model: 'custom-model',
      apiMode: 'images',
    })
  })

  it('imports wrapped custom provider settings from a json code block', () => {
    const imported = importCustomProviderSettingsFromJson(`\`\`\`json
{"customProviders":[{"id":"custom-json","name":"Custom JSON","submit":{"path":"images/generations","method":"POST","contentType":"json","body":{"model":"$profile.model","prompt":"$prompt"},"result":{"imageUrlPaths":["data.result.images.*.url.*"],"b64JsonPaths":[]}}}],"profiles":[{"name":"Custom JSON","provider":"custom-json","baseUrl":"https://custom.example.com/v1","model":"custom-model","apiMode":"images"}]}
\`\`\``)

    expect(imported.customProviders[0]).toMatchObject({ id: 'custom-json' })
    expect(imported.customProviders[0].submit.result).toMatchObject({
      imageUrlPaths: ['data.result.images.*.url.*'],
    })
    expect(imported.profiles[0]).toMatchObject({
      provider: 'custom-json',
      baseUrl: 'https://custom.example.com/v1',
    })
  })

  it('rejects markdown-corrupted profile fields when importing wrapped settings', () => {
    expect(() => importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [{
        id: 'custom-apimart',
        name: 'APIMart',
        submit: { path: 'images/generations' },
      }],
      profiles: [{
        name: 'APIMart',
        provider: 'custom-apimart',
        baseUrl: '[https://api.apimart.ai/v1',
        model: 'gpt-image-2-official',
        apiMode: 'images](https://api.apimart.ai/v1%22,%22model%22:%22gpt-image-2-official%22,%22apiMode%22:%22images)',
      }],
    }))).toThrow('JSON 包含 Markdown 链接')
  })

  it('defaults streaming on for OpenAI in all modes and preserves partial image count', () => {
    expect(createDefaultOpenAIProfile().streamImages).toBe(true)
    expect(createDefaultOpenAIProfile({ apiMode: 'responses' }).streamImages).toBe(true)
    expect(createDefaultOpenAIProfile().streamPartialImages).toBe(1)
    expect(DEFAULT_SETTINGS.streamImages).toBe(true)
    expect(DEFAULT_SETTINGS.streamPartialImages).toBe(1)
    expect(DEFAULT_SETTINGS.profiles[0].streamImages).toBe(true)
    expect(DEFAULT_SETTINGS.profiles[0].streamPartialImages).toBe(1)
    expect(normalizeSettings({ apiMode: 'responses' }).streamImages).toBe(true)

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

  it('normalizes custom providers to Images API mode', () => {
    const settings = normalizeSettings({
      customProviders: [{ id: 'custom-json', name: 'Custom JSON', submit: { path: 'images/generations' } }],
      profiles: [{
        id: 'custom-profile',
        name: 'Custom Profile',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'custom-key',
        model: 'custom-model',
        apiMode: 'responses',
        streamImages: true,
      }],
    })

    expect(settings.profiles[0]).toMatchObject({
      provider: 'custom-json',
      apiMode: 'images',
      streamImages: false,
    })
  })

  it('keeps provider order usable when custom providers are added after manual sorting', () => {
    const settings = normalizeSettings({
      providerOrder: ['fal', 'openai'],
      customProviders: [
        { id: 'custom-alpha', name: '示例服务商 A', submit: { path: 'images/generations' } },
        { id: 'custom-beta', name: '示例服务商 B', submit: { path: 'images/generations' } },
      ],
    })

    expect(settings.providerOrder).toEqual(['openai', 'custom-alpha', 'custom-beta'])
  })

  it('drops removed fal profile connection data when migrating to OpenAI-compatible provider', () => {
    const settings = normalizeSettings({
      profiles: [{
        id: 'legacy-fal',
        name: 'Legacy fal',
        provider: 'fal',
        baseUrl: 'https://removed-provider.example',
        apiKey: 'legacy-key',
        model: 'openai/gpt-image-2',
        apiMode: 'images',
      }],
    })

    expect(settings.profiles[0]).toMatchObject({
      id: 'legacy-fal',
      provider: 'openai',
      baseUrl: DEFAULT_SETTINGS.baseUrl,
      apiKey: '',
      model: DEFAULT_IMAGES_MODEL,
      apiMode: 'images',
    })
  })

  it('keeps active custom providers in Images API mode when legacy apiMode is responses', () => {
    const settings = normalizeSettings({
      apiMode: 'responses',
      customProviders: [{ id: 'custom-json', name: 'Custom JSON', submit: { path: 'images/generations' } }],
      activeProfileId: 'custom-profile',
      profiles: [{
        id: 'custom-profile',
        name: 'Custom Profile',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'custom-key',
        model: 'custom-model',
      }],
    })

    const activeProfile = getActiveApiProfile({ ...settings, apiMode: 'responses', streamImages: true })
    expect(activeProfile.apiMode).toBe('images')
    expect(activeProfile.streamImages).toBe(false)
  })

  it('keeps non-OpenAI providers in Images API mode when switching providers', () => {
    const provider = { id: 'custom-json', name: 'Custom JSON', submit: { path: 'images/generations' } }
    const openaiProfile = createDefaultOpenAIProfile({ apiMode: 'responses', streamImages: true })

    const customProfile = switchApiProfileProvider(openaiProfile, provider.id, provider)

    expect(customProfile).toMatchObject({ provider: provider.id, apiMode: 'images', streamImages: false })
  })

  it('enables Agent submit auto scroll by default', () => {
    expect(DEFAULT_SETTINGS.agentScrollToBottomAfterSubmit).toBe(true)
    expect(normalizeSettings({}).agentScrollToBottomAfterSubmit).toBe(true)
    expect(normalizeSettings({ agentScrollToBottomAfterSubmit: false }).agentScrollToBottomAfterSubmit).toBe(false)
  })

  it('enables Agent math formatting prompt by default', () => {
    expect(DEFAULT_SETTINGS.agentMathFormattingPrompt).toBe(true)
    expect(normalizeSettings({}).agentMathFormattingPrompt).toBe(true)
    expect(normalizeSettings({ agentMathFormattingPrompt: false }).agentMathFormattingPrompt).toBe(false)
  })

  it('disables prompt rewrite allowance by default', () => {
    expect(DEFAULT_SETTINGS.allowPromptRewrite).toBe(false)
    expect(normalizeSettings({}).allowPromptRewrite).toBe(false)
    expect(normalizeSettings({ allowPromptRewrite: true }).allowPromptRewrite).toBe(true)
  })

  it('preserves the selected Agent image generation profile', () => {
    const imageProfile = createDefaultOpenAIProfile({
      id: 'image-profile',
      apiMode: 'images',
      model: DEFAULT_IMAGES_MODEL,
    })
    const responsesProfile = createDefaultOpenAIProfile({
      id: 'responses-profile',
      apiMode: 'responses',
      model: DEFAULT_RESPONSES_MODEL,
      imageProfileId: imageProfile.id,
    })
    const settings = normalizeSettings({
      profiles: [responsesProfile, imageProfile],
      activeProfileId: responsesProfile.id,
    })

    expect(settings.profiles[0].imageProfileId).toBe(imageProfile.id)
    expect(getActiveApiProfile(settings).imageProfileId).toBe(imageProfile.id)
  })

  it('preserves the Responses API model separately from the Images API model', () => {
    const settings = normalizeSettings({
      profiles: [
        createDefaultOpenAIProfile({
          model: DEFAULT_IMAGES_MODEL,
          responsesModel: 'gpt-5.3-codex',
        }),
      ],
    })

    expect(settings.profiles[0].model).toBe(DEFAULT_IMAGES_MODEL)
    expect(settings.profiles[0].responsesModel).toBe('gpt-5.3-codex')
    expect(getActiveApiProfile(settings).responsesModel).toBe('gpt-5.3-codex')
  })

  it('defaults the Responses API model to gpt-5.5', () => {
    expect(createDefaultOpenAIProfile().responsesModel).toBe(DEFAULT_RESPONSES_MODEL)
    expect(normalizeSettings({}).profiles[0].responsesModel).toBe(DEFAULT_RESPONSES_MODEL)
    expect(getActiveApiProfile({}).responsesModel).toBe(DEFAULT_RESPONSES_MODEL)
  })

  it('falls back to Sakrylle API URL when no override is set', () => {
    expect(createDefaultOpenAIProfile().baseUrl).toBe('https://api.sakrylle.com/v1')
    expect(DEFAULT_SETTINGS.baseUrl).toBe('https://api.sakrylle.com/v1')
  })
})

describe('streamChatCompletionsImage', () => {
  it('defaults to true on a fresh profile', () => {
    const profile = createDefaultOpenAIProfile()
    expect(profile.streamChatCompletionsImage).toBe(true)
  })

  it('fills default true for a legacy profile missing the field', () => {
    const normalized = normalizeApiProfile({ id: 'x', name: 'legacy', baseUrl: 'https://api.sakrylle.com/v1' })
    expect(normalized.streamChatCompletionsImage).toBe(true)
  })

  it('preserves an explicit false', () => {
    const normalized = normalizeApiProfile({ streamChatCompletionsImage: false })
    expect(normalized.streamChatCompletionsImage).toBe(false)
  })
})
