import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS } from './apiProfiles'
import { callAgentConversationTitleApi, callAgentResponsesApi, callBatchImageSingle } from './agentApi'

describe('callAgentResponsesApi', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('streams Agent text and requests configured partial images', async () => {
    const streamBody = [
      'data: {"type":"response.output_text.delta","delta":"Hel"}',
      '',
      'data: {"type":"response.output_text.delta","delta":"lo"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]},{"type":"image_generation_call","id":"ig_1","result":"ZmluYWw=","size":"1024x1024"}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const textDeltas: string[] = []
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      apiMode: 'responses',
      streamImages: true,
      streamPartialImages: 2,
    })

    const result = await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
      onTextDelta: (delta) => textDeltas.push(delta),
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.stream).toBe(true)
    expect(body.tools[0].partial_images).toBe(2)
    expect(textDeltas).toEqual(['Hel', 'lo'])
    expect(result).toMatchObject({
      responseId: 'resp_1',
      text: 'Hello',
      images: [{ toolCallId: 'ig_1', dataUrl: 'data:image/png;base64,ZmluYWw=' }],
    })
  })

  it('passes mask data to the Agent image tool', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'OK' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      apiMode: 'responses',
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'edit' }] }],
      maskDataUrl: 'data:image/png;base64,bWFzaw==',
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.tools[0].input_image_mask).toEqual({ image_url: 'data:image/png;base64,bWFzaw==' })
  })

  it('uses app-managed image generation for Sakrylle Agent requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: '你好！' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'chat-key',
      apiMode: 'responses',
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.stream).toBeUndefined()
    expect(body.instructions).toContain('app executes the actual image request through its configured Images API profile')
    expect(body.tools.some((tool: { type?: string }) => tool.type === 'image_generation')).toBe(false)
    expect(body.tools.find((tool: { name?: string }) => tool.name === 'generate_image_batch')?.description).toContain('including a single image')
  })

  it('does not route app-managed Agent chat through the upstream image_generation tool on temporary service errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Service temporarily unavailable' },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'chat-key',
      apiMode: 'responses',
    })

    await expect(callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
    })).rejects.toThrow()

    const responseCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/responses'))
    expect(responseCalls.length).toBeGreaterThan(0)
    for (const [, init] of responseCalls) {
      const body = JSON.parse(String((init as RequestInit).body))
      expect(body.tools.some((tool: { type?: string }) => tool.type === 'image_generation')).toBe(false)
      expect(body.tools.find((tool: { name?: string }) => tool.name === 'generate_image_batch')?.description).toContain('including a single image')
    }
  })

  it('extracts image_generation results from base64 object fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'image_generation_call',
        id: 'ig_base64',
        result: { base64: 'ZmlsZQ==' },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
    })

    const result = await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    expect(result.images).toEqual([{
      toolCallId: 'ig_base64',
      dataUrl: 'data:image/png;base64,ZmlsZQ==',
      actualParams: {},
    }])
  })

  it('stops reading a stream when the caller aborts after output starts', async () => {
    const streamBody = [
      'data: {"type":"response.output_text.delta","delta":"Hel"}',
      '',
      '',
    ].join('\n')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(streamBody))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const textDeltas: string[] = []
    const abortController = new AbortController()
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      apiMode: 'responses',
      streamImages: true,
    })

    await expect(callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
      signal: abortController.signal,
      onTextDelta: (delta) => {
        textDeltas.push(delta)
        abortController.abort()
      },
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(textDeltas).toEqual(['Hel'])
  })

  it('generates a short conversation title without image tools', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: '<title>生成猫咪头像</title>' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      streamImages: true,
    })

    const title = await callAgentConversationTitleApi({
      settings: DEFAULT_SETTINGS,
      profile,
      prompt: '帮我生成一张橘猫头像，要赛博朋克风格',
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.instructions).toContain('<title>short title</title>')
    expect(body.tools).toBeUndefined()
    expect(body.stream).toBeUndefined()
    expect(body.input[0].content[0].text).toContain('帮我生成一张橘猫头像，要赛博朋克风格')
    expect(title).toBe('生成猫咪头像')
  })

  it('requests web search and applies citations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_search',
      output: [
        {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: { type: 'search', query: 'OpenAI web search docs' },
        },
        {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'See OpenAI docs.',
            annotations: [{
              type: 'url_citation',
              start_index: 4,
              end_index: 15,
              url: 'https://platform.openai.com/docs',
              title: 'OpenAI Docs',
            }],
          }],
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
    })

    const result = await callAgentResponsesApi({
      settings: { ...DEFAULT_SETTINGS, agentWebSearch: true },
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.tools).toEqual(expect.arrayContaining([{ type: 'web_search' }]))
    expect(result.text).toBe('See [OpenAI docs](https://platform.openai.com/docs).')
    expect(result.outputItems?.[0]).toMatchObject({ type: 'web_search_call', status: 'completed' })
  })
})

describe('callBatchImageSingle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('routes Agent batch image calls through the selected Images API profile', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const imageProfile = createDefaultOpenAIProfile({
      id: 'sakrylle-images',
      apiKey: 'image-key',
      apiMode: 'images',
      model: 'gpt-image-2',
    })
    const responsesProfile = createDefaultOpenAIProfile({
      id: 'sakrylle-chat',
      apiKey: 'chat-key',
      apiMode: 'responses',
      model: 'gpt-5.5',
      imageProfileId: imageProfile.id,
    })

    const result = await callBatchImageSingle({
      profile: responsesProfile,
      allProfiles: [responsesProfile, imageProfile],
      params: DEFAULT_PARAMS,
      batchItemId: 'item-1',
      prompt: '画一只猫',
      referenceImageDataUrls: [],
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.sakrylle.com/v1/images/generations')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer image-key' })
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      model: 'gpt-image-2',
      prompt: '画一只猫',
    })
    expect(result.image?.dataUrl).toBe('data:image/png;base64,aW1hZ2U=')
  })

  it('uses gallery-compatible multipart fields for Agent Images API edits', async () => {
    const realFetch = globalThis.fetch
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('data:')) return realFetch(input, init)
      return new Response(JSON.stringify({
        data: [{ b64_json: 'ZWRpdA==' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const imageProfile = createDefaultOpenAIProfile({
      id: 'sakrylle-images',
      apiKey: 'image-key',
      apiMode: 'images',
      model: 'gpt-image-2',
    })
    const responsesProfile = createDefaultOpenAIProfile({
      id: 'sakrylle-chat',
      apiKey: 'chat-key',
      apiMode: 'responses',
      model: 'gpt-5.5',
      imageProfileId: imageProfile.id,
    })

    const result = await callBatchImageSingle({
      profile: responsesProfile,
      allProfiles: [responsesProfile, imageProfile],
      params: DEFAULT_PARAMS,
      batchItemId: 'item-1',
      prompt: '修复这张图片',
      referenceImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    })

    const apiCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/images/edits'))
    expect(apiCall).toBeTruthy()
    const [url, init] = apiCall!
    const body = (init as RequestInit).body as FormData
    expect(String(url)).toBe('https://api.sakrylle.com/v1/images/edits')
    expect(body.get('image')).toBeNull()
    expect(body.getAll('image[]')).toHaveLength(1)
    expect(body.get('prompt')).toBe('修复这张图片')
    expect(result.image?.dataUrl).toBe('data:image/png;base64,ZWRpdA==')
  })

  it('returns a configuration error for Sakrylle image calls without an Images API profile', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const responsesProfile = createDefaultOpenAIProfile({
      id: 'sakrylle-chat',
      apiKey: 'chat-key',
      apiMode: 'responses',
      model: 'gpt-5.5',
    })

    const result = await callBatchImageSingle({
      profile: responsesProfile,
      allProfiles: [responsesProfile],
      params: DEFAULT_PARAMS,
      batchItemId: 'item-1',
      prompt: '画一只猫',
      referenceImageDataUrls: [],
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.image).toBeNull()
    expect(result.error).toContain('Images API profile')
  })
})
