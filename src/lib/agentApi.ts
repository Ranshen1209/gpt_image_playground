import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type AppSettings, type ResponsesApiResponse, type ResponsesOutputItem, type TaskParams } from '../types'
import { dataUrlToBlob } from './canvasImage'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { assertImageInputPayloadSize, fetchImageUrlAsDataUrl, getApiErrorMessage, isHttpUrl, MIME_MAP, normalizeBase64Image, pickActualParams } from './imageApiShared'
import { DEFAULT_RESPONSES_MODEL } from './apiProfiles'
import i18n from './i18n'

export interface AgentApiMessage {
  role: 'user' | 'assistant'
  text: string
  imageDataUrls?: string[]
}

export interface AgentApiResultImage {
  toolCallId?: string
  action?: string
  dataUrl: string
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
}

export interface AgentApiResult {
  responseId?: string
  text: string
  images: AgentApiResultImage[]
  outputItems: ResponsesApiResponse['output']
  rawResponsePayload?: string
}

const AGENT_IMAGE_INSTRUCTIONS_COMMON = [
  'You are an image-generation assistant in a multi-turn gallery app.',
  '',
  '## Progressive Batch Generation',
  'For multi-image requests, use a progressive batching strategy to ensure consistency:',
  '  1. **Base Reference First:** If the images need to share a consistent style, character, or layout (e.g. PPT slides, storyboards), generate ONE primary image first to establish the visual baseline, then call continue_generation to get another round.',
  '  2. **Batch Remaining Tasks:** Once the base reference is available, list all remaining images to be generated. The app will generate them concurrently for you. In your descriptions, explicitly instruct to reference the base image to maintain consistency.',
  '  3. **Independent Images:** If the requested images are completely independent (e.g. "3 different cats"), generate them together in ONE response. Do NOT generate them one by one across multiple responses.',
  'As the turn continues, output a brief progress note before each tool call.',
  '',
].join('\n')

const AGENT_HOSTED_IMAGE_TOOL_INSTRUCTIONS = [
  '## Generating images',
  '- For single-image requests, generate directly without any listing.',
  '- One image_generation call per distinct image. Never collage.',
  '- Dependent images (a later image needs to reference an earlier one) → generate the prerequisite first, then call continue_generation. The next round will have the result available as `<ref id="..." />`.',
  '- Only generate when explicitly requested; otherwise reply with text.',
  '- Preserve the user\'s original intent faithfully. Never substitute requested subjects for copyright/trademark reasons.',
].join('\n')

const AGENT_APP_MANAGED_IMAGE_TOOL_INSTRUCTIONS = [
  '## Generating images',
  '- The image_generation tool is available for planning, but this app executes the actual image request through its configured Images API profile.',
  '- For single-image requests or prerequisite/base images, call image_generation directly.',
  '- Use generate_image_batch when 2+ independent images can be generated concurrently. For a single image, prefer image_generation.',
  '- Never create a collage unless the user explicitly asks for a collage.',
  '- Dependent images (a later image needs to reference an earlier one) → call image_generation for the prerequisite first, then call continue_generation. The next round will have the result available as `<ref id="..." />`.',
  '- Independent images should be generated together in one generate_image_batch call.',
  '- Only generate when explicitly requested; otherwise reply with text.',
  '- Preserve the user\'s original intent faithfully. Never substitute requested subjects for copyright/trademark reasons.',
].join('\n')

const AGENT_REFERENCE_INSTRUCTIONS = [
  '## Reference tags and generated images in context',
  'NEVER output `<ref>`, `<available_refs>`, `<removed_ref>`, or any XML reference tags in visible assistant text — the system injects them automatically and your raw output will be shown directly to the user.',
  '- Previously generated images are injected as user messages containing the actual image (input_image) followed by a `<ref id="round-N-image-M" prompt="..." />` tag identifying it.',
  '- Deleted images appear as `<removed_ref id="..." />` without an accompanying image — do not reference them.',
  '- In user messages: `<ref id="..." />` may also point to user-attached/cited images.',
  '- In generate_image_batch tool arguments, include matching `<ref id="..." />` tags inside each image prompt when the prompt refers to a reference image. Do not use separate bare reference ids.',
  'Resolve user mentions ("the first image") to the matching id. Only use existing ids in image prompts.',
].join('\n')

function createAgentInstructions(settings: AppSettings, useAppManagedImageGeneration: boolean, includeImageTool = true) {
  const maxToolRounds = Number.isFinite(settings.agentMaxToolRounds)
    ? Math.max(1, Math.trunc(settings.agentMaxToolRounds))
    : DEFAULT_AGENT_MAX_TOOL_ROUNDS
  return [
    AGENT_IMAGE_INSTRUCTIONS_COMMON,
    useAppManagedImageGeneration && !includeImageTool
      ? AGENT_APP_MANAGED_IMAGE_TOOL_INSTRUCTIONS.replace(
          '- For single-image requests or prerequisite/base images, call image_generation directly.',
          '- The image_generation tool is unavailable in this retry. Use generate_image_batch for every image request, including single images and prerequisite/base images.',
        ).replace(
          '- Use generate_image_batch when 2+ independent images can be generated concurrently. For a single image, prefer image_generation.',
          '- For single images, provide exactly one item in generate_image_batch.',
        )
      : useAppManagedImageGeneration
      ? AGENT_APP_MANAGED_IMAGE_TOOL_INSTRUCTIONS
      : AGENT_HOSTED_IMAGE_TOOL_INSTRUCTIONS,
    AGENT_REFERENCE_INSTRUCTIONS,
    '',
    '## Tool policy',
    `- Current maximum tool-use rounds for this Agent turn: ${maxToolRounds}.`,
    '- Call continue_generation ONLY when you have generated a prerequisite image and need another round to generate dependent images. Do NOT call it when the task is complete.',
    '- When web_search is available, use it only when current external information would improve the answer or the user asks for research/news/facts.',
    '- When the requested task is complete, stop calling tools and provide the final response.',
  ].join('\n')
}

const AGENT_TITLE_INSTRUCTIONS = [
  'Generate a concise conversation title from the first user message.',
  'Output exactly one XML element in this form: <title>short title</title>',
  'Do not output markdown, code fences, explanations, attributes, or additional XML elements.',
  'Use the main language of the user message. Chinese titles should be no more than 12 characters. English titles should be no more than 5 words.',
  'Escape XML special characters when necessary.',
].join('\n')

const AGENT_TITLE_MAX_LENGTH = 28

async function createHeaders(profile: ApiProfile): Promise<Record<string, string>> {
  const { resolveBearerToken } = await import('./oauthFallback')
  const token = await resolveBearerToken(profile)
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function isSakrylleApiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.sakrylle.com'
  } catch {
    return baseUrl.toLowerCase().includes('api.sakrylle.com')
  }
}

function findAgentImagesApiProfile(profile: ApiProfile, profiles: ApiProfile[] | undefined): ApiProfile | undefined {
  if (!profiles?.length) return undefined
  if (profile.imageProfileId) {
    const selected = profiles.find((item) =>
      item.id === profile.imageProfileId &&
      item.provider === 'openai' &&
      item.apiMode === 'images',
    )
    if (selected) return selected
  }

  if (profile.apiMode !== 'responses') return undefined
  return profiles.find((item) =>
    item.id !== profile.id &&
    item.provider === 'openai' &&
    item.apiMode === 'images',
  )
}

function shouldUseAppManagedImageGeneration(profile: ApiProfile, profiles: ApiProfile[] | undefined): boolean {
  return Boolean(findAgentImagesApiProfile(profile, profiles)) || isSakrylleApiBaseUrl(profile.baseUrl)
}

function createImageTool(params: TaskParams, profile: ApiProfile, maskDataUrl?: string): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: 'auto',
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }

  tool.quality = params.quality

  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }

  if (profile.streamImages) {
    tool.partial_images = profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
  }

  if (maskDataUrl) {
    tool.input_image_mask = {
      image_url: maskDataUrl,
    }
  }

  return tool
}

function createBatchImageTool(useAppManagedImageGeneration: boolean, includeImageTool = true): Record<string, unknown> {
  return {
    type: 'function',
    name: 'generate_image_batch',
    description: (
      useAppManagedImageGeneration
        ? includeImageTool
          ? [
            'Generate multiple images concurrently through the app-managed Images API pipeline. Use this ONLY when:',
            '1. There are 2+ remaining images whose prerequisites (base references) are ALL already generated.',
            '2. These images are independent of each other (none references another image in this same batch).',
            'For single images or prerequisite/base images, use the image_generation tool instead.',
          ]
          : [
              'Generate one or more images through the app-managed Images API pipeline.',
              'Use this for every image request, including a single image.',
              'For a single image, provide one item in the images array.',
            ]
        : [
            'Generate multiple images concurrently. Use this ONLY when:',
            '1. There are 2+ remaining images whose prerequisites (base references) are ALL already generated.',
            '2. These images are independent of each other (none references another image in this same batch).',
            'For single images or prerequisite/base images, use the built-in image_generation tool instead.',
          ]
    ).concat([
      'Each image prompt must be self-contained and include full visual style descriptions.',
      'If an image needs to match a previously generated image, include the corresponding XML tag (e.g. <ref id="round-1-image-1" />) inside that image prompt so the app can attach the reference image automatically.',
    ]).join(' '),
    parameters: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          description: 'Array of images to generate concurrently.',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Short stable identifier for this image, e.g. "slide_2_problem", "scene_3".',
              },
              prompt: {
                type: 'string',
                description: 'Complete image generation prompt with all visual details. If it refers to a previous image, include the matching XML tag, e.g. <ref id="round-1-image-1" />.',
              },
            },
            required: ['id', 'prompt'],
            additionalProperties: false,
          },
        },
      },
      required: ['images'],
      additionalProperties: false,
    },
    strict: true,
  }
}

function createAgentTools(params: TaskParams, profile: ApiProfile, settings: AppSettings, maskDataUrl?: string, useAppManagedImageGeneration = false, includeImageTool = true): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = []

  if (includeImageTool) {
    tools.push(createImageTool(params, profile, maskDataUrl))
  }

  // generate_image_batch: custom function tool for concurrent multi-image generation
  tools.push(createBatchImageTool(useAppManagedImageGeneration, includeImageTool))

  // continue_generation: model calls this to request another round (e.g. after generating a prerequisite image)
  tools.push({
    type: 'function',
    name: 'continue_generation',
    description: [
      'Request another round to continue generating images.',
      'Call this ONLY when you have just generated a prerequisite/base image and still need to generate dependent images that reference it.',
      'Do NOT call this when the task is already complete.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief explanation of why another round is needed and what will be generated next.',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    strict: true,
  })

  if (settings.agentWebSearch) {
    tools.push({ type: 'web_search' })
  }
  return tools
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream') ?? false
}

function shouldRetryAgentWithoutImageTool(status: number, message: string): boolean {
  if (status === 503 || status === 502 || status === 504) return true
  return /service temporarily unavailable|upstream service temporarily unavailable/i.test(message)
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value ? value : undefined
}

function getNumberValue(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function escapeMarkdownLinkLabel(text: string) {
  return text.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
}

type ResponseTextAnnotation = NonNullable<NonNullable<ResponsesOutputItem['content']>[number]['annotations']>[number]

function applyUrlCitations(text: string, annotations: ResponseTextAnnotation[] | undefined) {
  const citations = (annotations ?? [])
    .filter((annotation) =>
      annotation.type === 'url_citation' &&
      typeof annotation.url === 'string' &&
      annotation.url.trim() &&
      typeof annotation.start_index === 'number' &&
      typeof annotation.end_index === 'number' &&
      annotation.start_index >= 0 &&
      annotation.end_index > annotation.start_index &&
      annotation.end_index <= text.length,
    )
    .sort((a, b) => (a.start_index ?? 0) - (b.start_index ?? 0))

  if (citations.length === 0) return text

  let cursor = 0
  let output = ''
  for (const citation of citations) {
    const start = citation.start_index ?? 0
    const end = citation.end_index ?? start
    if (start < cursor) continue

    output += text.slice(cursor, start)
    const label = text.slice(start, end) || citation.title || citation.url || 'source'
    output += `[${escapeMarkdownLinkLabel(label)}](${citation.url})`
    cursor = end
  }
  output += text.slice(cursor)
  return output
}

function getStreamEventErrorMessage(event: Record<string, unknown>): string | null {
  const error = event.error
  if (isRecordValue(error)) {
    const message = getStringValue(error, 'message')
    if (message) return message
  }
  if (typeof error === 'string' && error.trim()) return error

  const type = getStringValue(event, 'type')
  if (type?.endsWith('.failed')) return getStringValue(event, 'message') ?? i18n.t('errors.agentStreamFailed')
  return null
}

function parseServerSentEventBlock(block: string): string | null {
  const dataLines: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    dataLines.push(line.slice(5).replace(/^ /, ''))
  }

  const data = dataLines.join('\n').trim()
  if (!data || data === '[DONE]') return null
  return data
}

function getAbortedSignal(signals: Array<AbortSignal | undefined>) {
  return signals.find((signal) => signal?.aborted)
}

function throwIfAborted(...signals: Array<AbortSignal | undefined>) {
  const signal = getAbortedSignal(signals)
  if (!signal) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException(i18n.t('errors.requestStopped'), 'AbortError')
}

async function readJsonServerSentEvents(response: Response, onEvent: (event: Record<string, unknown>) => void | Promise<void>, signals: Array<AbortSignal | undefined> = []): Promise<void> {
  if (!response.body) throw new Error(i18n.t('errors.agentStreamNoBody'))

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined)
  }
  throwIfAborted(...signals)
  for (const signal of signals) signal?.addEventListener('abort', cancelReader, { once: true })

  const processBlock = async (block: string) => {
    const data = parseServerSentEventBlock(block)
    if (!data) return

    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      throw new Error(i18n.t('errors.agentStreamInvalidJson'))
    }
    if (!isRecordValue(event)) return

    const errorMessage = getStreamEventErrorMessage(event)
    if (errorMessage) throw new Error(errorMessage)

    throwIfAborted(...signals)
    await onEvent(event)
    await Promise.resolve()
    throwIfAborted(...signals)
  }

  try {
    while (true) {
      throwIfAborted(...signals)
      const { value, done } = await reader.read()
      throwIfAborted(...signals)
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separatorIndex = buffer.search(/\r?\n\r?\n/)
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex)
        const separator = buffer.match(/\r?\n\r?\n/)?.[0] ?? '\n\n'
        buffer = buffer.slice(separatorIndex + separator.length)
        await processBlock(block)
        separatorIndex = buffer.search(/\r?\n\r?\n/)
      }
    }

    buffer += decoder.decode()
    throwIfAborted(...signals)
    if (buffer.trim()) await processBlock(buffer)
  } finally {
    for (const signal of signals) signal?.removeEventListener('abort', cancelReader)
  }
}

function createInput(messages: AgentApiMessage[]) {
  return messages.map((message) => {
    const content: Array<Record<string, string>> = [
      { type: message.role === 'user' ? 'input_text' : 'output_text', text: message.text },
    ]

    if (message.role === 'user') {
      for (const dataUrl of message.imageDataUrls ?? []) {
        content.push({ type: 'input_image', image_url: dataUrl })
      }
    }

    return {
      role: message.role,
      content,
    }
  })
}

function extractText(payload: ResponsesApiResponse) {
  const chunks: string[] = []

  for (const item of payload.output ?? []) {
    if (item.type !== 'message') continue
    for (const part of item.content ?? []) {
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        chunks.push(applyUrlCitations(part.text, part.annotations))
      }
    }
  }

  return chunks.join('\n').trim()
}

function decodeXmlText(text: string) {
  return text.replace(/&(?:#(\d+)|#x([\da-fA-F]+)|amp|lt|gt|quot|apos);/g, (entity, decimal: string | undefined, hex: string | undefined) => {
    if (decimal) return String.fromCodePoint(Number(decimal))
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
    switch (entity) {
      case '&amp;': return '&'
      case '&lt;': return '<'
      case '&gt;': return '>'
      case '&quot;': return '"'
      case '&apos;': return "'"
      default: return entity
    }
  })
}

function parseAgentConversationTitleXml(text: string) {
  const match = text.match(/<title>([\s\S]*?)<\/title>/i)
  const title = match ? decodeXmlText(match[1]).trim() : ''
  const chars = Array.from(title)
  if (chars.length <= AGENT_TITLE_MAX_LENGTH) return title
  return `${chars.slice(0, AGENT_TITLE_MAX_LENGTH - 3).join('')}...`
}

function extractImages(payload: ResponsesApiResponse, fallbackMime: string): AgentApiResultImage[] {
  const images: AgentApiResultImage[] = []

  for (const item of payload.output ?? []) {
    if (item.type !== 'image_generation_call') continue

    const result = item.result
    if (typeof result === 'string' && result.trim()) {
      images.push({
        toolCallId: typeof item.id === 'string' ? item.id : undefined,
        action: typeof item.action === 'string' ? item.action : undefined,
        dataUrl: normalizeBase64Image(result, fallbackMime),
        actualParams: pickActualParams(item),
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      })
      continue
    }

    if (result && typeof result === 'object') {
      const b64 = typeof result.b64_json === 'string'
        ? result.b64_json
        : typeof result.base64 === 'string'
        ? result.base64
        : typeof result.image === 'string'
        ? result.image
        : typeof result.data === 'string'
        ? result.data
        : ''
      if (b64.trim()) {
        images.push({
          toolCallId: typeof item.id === 'string' ? item.id : undefined,
          action: typeof item.action === 'string' ? item.action : undefined,
          dataUrl: normalizeBase64Image(b64, fallbackMime),
          actualParams: pickActualParams(item),
          revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
        })
      }
    }
  }

  return images
}

function extractImageFromOutputItem(item: ResponsesOutputItem, fallbackMime: string): AgentApiResultImage | null {
  if (item.type !== 'image_generation_call') return null

  const result = item.result
  const b64 = typeof result === 'string'
    ? result
    : result && typeof result === 'object'
    ? typeof result.b64_json === 'string'
      ? result.b64_json
      : typeof result.base64 === 'string'
      ? result.base64
      : typeof result.image === 'string'
      ? result.image
      : typeof result.data === 'string'
      ? result.data
      : ''
    : ''

  if (!b64.trim()) return null
  return {
    toolCallId: typeof item.id === 'string' ? item.id : undefined,
    action: typeof item.action === 'string' ? item.action : undefined,
    dataUrl: normalizeBase64Image(b64, fallbackMime),
    actualParams: pickActualParams(item),
    revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
  }
}

function getStreamResponsePayload(event: Record<string, unknown>): ResponsesApiResponse | null {
  const response = event.response
  if (isRecordValue(response)) return response as ResponsesApiResponse

  const item = event.item
  if (isRecordValue(item)) return { output: [item as ResponsesOutputItem] }

  return null
}

async function parseAgentStreamResponse(
  response: Response,
  mime: string,
  signal?: AbortSignal,
  callerSignal?: AbortSignal,
  onTextDelta?: (delta: string) => void,
  onOutputItems?: (outputItems: ResponsesOutputItem[]) => void,
  onImageToolStarted?: (event: { toolCallId: string; outputIndex?: number }) => void | Promise<void>,
  onImagePartialImage?: (event: { toolCallId: string; image: string; partialImageIndex?: number; outputIndex?: number }) => void | Promise<void>,
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>,
): Promise<AgentApiResult> {
  let completedPayload: ResponsesApiResponse | null = null
  const outputItems: ResponsesOutputItem[] = []
  let streamedText = ''

  const publishOutputItems = (items: ResponsesOutputItem[]) => {
    for (const item of items) {
      const index = item.id ? outputItems.findIndex((existing) => existing.id === item.id) : -1
      if (index >= 0) outputItems[index] = item
      else outputItems.push(item)
    }
    onOutputItems?.([...outputItems])
  }

  const publishWebSearchStatus = (event: Record<string, unknown>, status: string, actionType?: string) => {
    const id = getStringValue(event, 'item_id')
    if (!id) return

    const index = outputItems.findIndex((item) => item.id === id)
    const current = index >= 0 ? outputItems[index] : { id, type: 'web_search_call' }
    const next: ResponsesOutputItem = {
      ...current,
      id,
      type: 'web_search_call',
      status,
      ...(actionType ? { action: { type: actionType } } : {}),
    }
    if (index >= 0) outputItems[index] = next
    else outputItems.push(next)
    onOutputItems?.([...outputItems])
  }

  await readJsonServerSentEvents(response, async (event) => {
    const type = getStringValue(event, 'type')

    if (type === 'response.image_generation_call.partial_image') {
      const toolCallId = getStringValue(event, 'item_id')
      const b64 = getStringValue(event, 'partial_image_b64')
      if (toolCallId && b64) {
        await onImagePartialImage?.({
          toolCallId,
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
          outputIndex: getNumberValue(event, 'output_index'),
        })
      }
      return
    }

    if (type === 'response.web_search_call.searching') {
      publishWebSearchStatus(event, 'in_progress', 'search')
      return
    }
    if (type === 'response.web_search_call.completed') {
      publishWebSearchStatus(event, 'completed')
      return
    }
    if (type === 'response.web_search_call.failed') {
      publishWebSearchStatus(event, 'failed')
      return
    }
    if (type === 'response.web_search_call.in_progress') {
      publishWebSearchStatus(event, 'in_progress')
      return
    }

    if (type === 'response.output_text.delta') {
      const delta = getStringValue(event, 'delta')
      if (delta) {
        streamedText += delta
        onTextDelta?.(delta)
      }
      return
    }

    const payload = getStreamResponsePayload(event)
    if (!payload) return

    if (Array.isArray(payload.output)) {
      publishOutputItems(payload.output)
    }

    if (type === 'response.output_item.added') {
      const item = payload.output?.[0]
      if (item?.type === 'image_generation_call' && typeof item.id === 'string' && item.id) {
        await onImageToolStarted?.({
          toolCallId: item.id,
          outputIndex: getNumberValue(event, 'output_index'),
        })
      }
      return
    }

    if (type === 'response.output_item.done') {
      const item = payload.output?.[0]
      const image = item ? extractImageFromOutputItem(item, mime) : null
      if (image) await onImageToolCompleted?.(image)
      return
    }

    if (type === 'response.completed' || isRecordValue(event.response)) {
      completedPayload = payload
    }
  }, [signal, callerSignal])

  throwIfAborted(signal, callerSignal)
  const payload: ResponsesApiResponse | null = completedPayload ?? (outputItems.length ? { output: outputItems } : null)
  if (!payload) throw new Error(i18n.t('errors.agentStreamNoFinal'))

  const text = extractText(payload) || streamedText.trim()
  return {
    responseId: payload.id,
    text,
    images: extractImages(payload, mime),
    outputItems: payload.output ?? [],
    rawResponsePayload: JSON.stringify(payload, null, 2),
  }
}

function isRetriableHttpStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

async function sleepUnlessAborted(ms: number, ...signals: Array<AbortSignal | undefined>): Promise<void> {
  if (getAbortedSignal(signals)) return
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      for (const signal of signals) signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    for (const signal of signals) signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Retries a fetch on transient upstream errors (502/503/504). buildInit is
// called on every attempt so RequestInit (including AbortSignal-bound bodies)
// stays fresh. We only retry before reading the response body — once a
// streaming response starts emitting events, network errors are surfaced.
async function fetchWithRetry(
  url: string,
  buildInit: () => Promise<RequestInit> | RequestInit,
  options: { maxAttempts?: number; signals?: Array<AbortSignal | undefined> } = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 3
  const signals = options.signals ?? []
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(...signals)
    try {
      const init = await buildInit()
      const response = await fetch(url, init)
      if (response.ok || !isRetriableHttpStatus(response.status) || attempt === maxAttempts) {
        return response
      }
      try { await response.text() } catch { /* drain so the connection releases */ }
    } catch (err) {
      if (getAbortedSignal(signals)) throw err
      lastError = err
      if (attempt === maxAttempts) throw err
    }
    const delayMs = 600 * Math.pow(2.5, attempt - 1)
    await sleepUnlessAborted(delayMs, ...signals)
  }

  throw lastError instanceof Error ? lastError : new Error('fetch failed after retries')
}

export async function callAgentResponsesApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  params: TaskParams
  input: unknown
  maskDataUrl?: string
  signal?: AbortSignal
  onTextDelta?: (delta: string) => void
  onOutputItems?: (outputItems: ResponsesOutputItem[]) => void
  onImageToolStarted?: (event: { toolCallId: string; outputIndex?: number }) => void | Promise<void>
  onImagePartialImage?: (event: { toolCallId: string; image: string; partialImageIndex?: number; outputIndex?: number }) => void | Promise<void>
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>
}): Promise<AgentApiResult> {
  const { settings, profile, params, input, maskDataUrl, signal, onTextDelta, onOutputItems, onImageToolStarted, onImagePartialImage, onImageToolCompleted } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const useAppManagedImageGeneration = shouldUseAppManagedImageGeneration(profile, settings.profiles)
  const shouldStreamResponse = profile.streamImages === true && !useAppManagedImageGeneration
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const createBody = (includeImageTool: boolean): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: profile.responsesModel || DEFAULT_RESPONSES_MODEL,
        instructions: createAgentInstructions(settings, useAppManagedImageGeneration, includeImageTool),
        input,
        tools: createAgentTools(params, profile, settings, maskDataUrl, useAppManagedImageGeneration, includeImageTool),
      }
      if (shouldStreamResponse && includeImageTool) {
        body.stream = true
      }
      return body
    }

    const requestResponses = (includeImageTool: boolean) => fetchWithRetry(
        buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy),
        async () => ({
          method: 'POST',
          headers: await createHeaders(profile),
          cache: 'no-store',
          body: JSON.stringify(createBody(includeImageTool)),
          signal: controller.signal,
        }),
        { signals: [controller.signal, signal] },
      )

    const includeImageToolForFirstRequest = !useAppManagedImageGeneration
    let response = await requestResponses(includeImageToolForFirstRequest)
    if (!response.ok) {
      const errorMessage = await getApiErrorMessage(response)
      if (useAppManagedImageGeneration && shouldRetryAgentWithoutImageTool(response.status, errorMessage)) {
        response = await requestResponses(false)
      } else {
        throw new Error(errorMessage)
      }
    }

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    if (shouldStreamResponse && isEventStreamResponse(response)) {
      return parseAgentStreamResponse(response, mime, controller.signal, signal, onTextDelta, onOutputItems, onImageToolStarted, onImagePartialImage, onImageToolCompleted)
    }

    const payload = await response.json() as ResponsesApiResponse
    throwIfAborted(controller.signal, signal)
    return {
      responseId: payload.id,
      text: extractText(payload),
      images: extractImages(payload, mime),
      outputItems: payload.output,
      rawResponsePayload: JSON.stringify(payload, null, 2),
    }
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function callAgentConversationTitleApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  prompt: string
  imageDataUrls?: string[]
  signal?: AbortSignal
}): Promise<string> {
  const { settings, profile, prompt, imageDataUrls, signal } = opts
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const content: Array<Record<string, string>> = [
      { type: 'input_text', text: `The following is the first message the user sent in a conversation. Generate a title for this conversation.\n\n${prompt}` },
    ]
    for (const dataUrl of imageDataUrls ?? []) {
      content.push({ type: 'input_image', image_url: dataUrl })
    }

    const response = await fetchWithRetry(
      buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy),
      async () => ({
        method: 'POST',
        headers: await createHeaders(profile),
        cache: 'no-store',
        body: JSON.stringify({
          model: profile.responsesModel || DEFAULT_RESPONSES_MODEL,
          instructions: AGENT_TITLE_INSTRUCTIONS,
          input: [{ role: 'user', content }],
          max_output_tokens: 32,
        }),
        signal: controller.signal,
      }),
      { signals: [controller.signal, signal] },
    )

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    const payload = await response.json() as ResponsesApiResponse
    return parseAgentConversationTitleXml(extractText(payload))
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

// ---------------------------------------------------------------------------
// Batch image generation: execute a single image via Responses API
// Uses the same pattern as gallery Responses API mode:
//   - PROMPT_REWRITE_GUARD to prevent prompt modification
//   - tool_choice: 'required' to force immediate generation
//   - Reference images passed as input_image
// ---------------------------------------------------------------------------

const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

export interface BatchImageCallResult {
  /** The batch item id from the model's function call */
  batchItemId: string
  image: AgentApiResultImage | null
  error: string | null
  rawResponsePayload?: string
}

/**
 * Generate a single image via Images API (POST /v1/images/generations or /v1/images/edits).
 * Used when profile.imageProfileId is specified in Agent mode.
 */
async function callBatchImageSingleViaImagesApi(opts: {
  profile: ApiProfile
  params: TaskParams
  batchItemId: string
  prompt: string
  referenceImageDataUrls: string[]
  signal?: AbortSignal
  onImageToolStarted?: () => void | Promise<void>
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>
}): Promise<BatchImageCallResult> {
  const { profile, params, batchItemId, prompt, referenceImageDataUrls, signal, onImageToolStarted, onImageToolCompleted } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    await onImageToolStarted?.()

    // Determine endpoint: edits if reference images, otherwise generations
    const endpoint = referenceImageDataUrls.length > 0 ? 'images/edits' : 'images/generations'
    const isEdit = endpoint === 'images/edits'

    let body: FormData | string
    if (isEdit) {
      // Multipart form for edits
      const formData = new FormData()
      formData.append('prompt', prompt)
      formData.append('model', profile.model)
      formData.append('size', params.size)
      formData.append('quality', params.quality)
      formData.append('output_format', params.output_format)
      formData.append('moderation', params.moderation)
      formData.append('n', '1')
      if (params.output_format !== 'png' && params.output_compression != null) {
        formData.append('output_compression', String(params.output_compression))
      }
      if (profile.responseFormatB64Json) {
        formData.append('response_format', 'b64_json')
      }

      // Add reference images
      const imageBlobs: Blob[] = []
      for (let i = 0; i < referenceImageDataUrls.length; i++) {
        const dataUrl = referenceImageDataUrls[i]
        imageBlobs.push(await dataUrlToBlob(dataUrl))
      }
      assertImageInputPayloadSize(imageBlobs.reduce((sum, blob) => sum + blob.size, 0))

      for (let i = 0; i < imageBlobs.length; i++) {
        const blob = imageBlobs[i]
        const ext = blob.type.split('/')[1] || 'png'
        formData.append('image[]', blob, `ref_${i + 1}.${ext}`)
      }

      body = formData
    } else {
      // JSON for generations
      body = JSON.stringify({
        model: profile.model,
        prompt,
        size: params.size,
        quality: params.quality,
        output_format: params.output_format,
        moderation: params.moderation,
        n: 1,
        ...(params.output_format !== 'png' && params.output_compression != null ? { output_compression: params.output_compression } : {}),
      })
    }

    const { resolveBearerToken } = await import('./oauthFallback')
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await resolveBearerToken(profile)}`,
    }
    if (!isEdit) {
      headers['Content-Type'] = 'application/json'
    }

    const response = await fetchWithRetry(
      buildApiUrl(profile.baseUrl, endpoint, proxyConfig, useApiProxy),
      async () => ({
        method: 'POST',
        headers,
        cache: 'no-store',
        body,
        signal: controller.signal,
      }),
      { signals: [controller.signal, signal] },
    )

    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)

    if (!response.ok) {
      const errorMsg = await getApiErrorMessage(response)
      return { batchItemId, image: null, error: errorMsg }
    }

    const json = await response.json()
    const dataArray = Array.isArray(json.data) ? json.data : []
    if (dataArray.length === 0) {
      return { batchItemId, image: null, error: 'No image returned from API' }
    }

    const firstImage = dataArray[0]
    const imageValue = firstImage.b64_json || firstImage.url
    if (!imageValue) {
      return { batchItemId, image: null, error: 'Image data missing in response' }
    }

    const dataUrl = isHttpUrl(imageValue)
      ? await fetchImageUrlAsDataUrl(imageValue, mime, signal)
      : normalizeBase64Image(imageValue, mime)
    const resultImage: AgentApiResultImage = {
      dataUrl,
      revisedPrompt: firstImage.revised_prompt || prompt,
      actualParams: pickActualParams(firstImage),
    }

    await onImageToolCompleted?.(resultImage)

    return {
      batchItemId,
      image: resultImage,
      error: null,
      rawResponsePayload: JSON.stringify(json, null, 2),
    }
  } catch (err: unknown) {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)

    if (err instanceof Error && err.name === 'AbortError') {
      return { batchItemId, image: null, error: i18n.t('errors.requestCancelled') }
    }
    return { batchItemId, image: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Generate a single image using Responses API with prompt-rewrite guard,
 * or switch to Images API if profile.imageProfileId is specified or auto-detected.
 */
export async function callBatchImageSingle(opts: {
  profile: ApiProfile
  allProfiles?: ApiProfile[]
  params: TaskParams
  batchItemId: string
  prompt: string
  referenceImageDataUrls: string[]
  referenceIds?: string[]
  signal?: AbortSignal
  onImageToolStarted?: () => void | Promise<void>
  onPartialImage?: (event: { image: string; partialImageIndex?: number }) => void | Promise<void>
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>
}): Promise<BatchImageCallResult> {
  const { profile, allProfiles, params, batchItemId, prompt, referenceImageDataUrls, referenceIds, signal, onImageToolStarted, onPartialImage, onImageToolCompleted } = opts

  // Auto-detect: if current profile is responses mode, find first images profile
  const imageProfile = profile.apiMode === 'images' ? profile : findAgentImagesApiProfile(profile, allProfiles)

  // If imageProfile found, delegate to Images API
  if (imageProfile) {
    return callBatchImageSingleViaImagesApi({
      profile: imageProfile,
      params,
      batchItemId,
      prompt,
      referenceImageDataUrls,
      signal,
      onImageToolStarted,
      onImageToolCompleted,
    })
  }

  if (isSakrylleApiBaseUrl(profile.baseUrl)) {
    return { batchItemId, image: null, error: i18n.t('errors.agentMissingImagesProfile') }
  }

  // Otherwise use Responses API with image_generation tool
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    // Build input: reference id mapping + prompt-rewrite guard + reference images.
    const referenceMapping = referenceImageDataUrls.length > 0
      ? `Attached reference images correspond to these ids, in order: ${(referenceIds ?? []).map((id) => `<ref id="${id}" />`).join(', ') || 'reference images'}.`
      : ''
    const guardedPrompt = [referenceMapping, `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`].filter(Boolean).join('\n\n')
    let input: unknown
    if (referenceImageDataUrls.length > 0) {
      input = [{
        role: 'user',
        content: [
          { type: 'input_text', text: guardedPrompt },
          ...referenceImageDataUrls.map((dataUrl) => ({
            type: 'input_image',
            image_url: dataUrl,
          })),
        ],
      }]
    } else {
      input = guardedPrompt
    }

    // Build image_generation tool with current params
    const tool: Record<string, unknown> = {
      type: 'image_generation',
      action: referenceImageDataUrls.length > 0 ? 'auto' : 'generate',
      size: params.size,
      output_format: params.output_format,
      moderation: params.moderation,
      quality: params.quality,
    }
    if (params.output_format !== 'png' && params.output_compression != null) {
      tool.output_compression = params.output_compression
    }
    if (profile.streamImages) {
      tool.partial_images = profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
    }

    const body: Record<string, unknown> = {
      model: profile.model,
      input,
      tools: [tool],
      tool_choice: 'required',
    }
    if (profile.streamImages) {
      body.stream = true
    }

    const response = await fetchWithRetry(
      buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy),
      async () => ({
        method: 'POST',
        headers: await createHeaders(profile),
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      { signals: [controller.signal, signal] },
    )

    if (!response.ok) {
      const errorMsg = await getApiErrorMessage(response)
      return { batchItemId, image: null, error: errorMsg }
    }

    // Handle streaming
    if (profile.streamImages && isEventStreamResponse(response)) {
      await onImageToolStarted?.()
      let completedImage: AgentApiResultImage | null = null
      let rawPayload: string | undefined

      await readJsonServerSentEvents(response, async (event) => {
        const type = getStringValue(event, 'type')

        if (type === 'response.image_generation_call.partial_image') {
          const b64 = getStringValue(event, 'partial_image_b64')
          if (b64) {
            await onPartialImage?.({
              image: normalizeBase64Image(b64, mime),
              partialImageIndex: getNumberValue(event, 'partial_image_index'),
            })
          }
          return
        }

        if (type === 'response.output_item.done') {
          const payload = getStreamResponsePayload(event)
          const item = payload?.output?.[0]
          if (item) {
            const img = extractImageFromOutputItem(item, mime)
            if (img) {
              completedImage = img
              await onImageToolCompleted?.(img)
            }
          }
          return
        }

        if (type === 'response.completed' || isRecordValue(event.response)) {
          const payload = getStreamResponsePayload(event)
          if (payload) rawPayload = JSON.stringify(payload, null, 2)
          if (!completedImage && payload) {
            const images = extractImages(payload, mime)
            if (images.length > 0) {
              completedImage = images[0]
              await onImageToolCompleted?.(completedImage)
            }
          }
        }
      }, [controller.signal, signal])

      return {
        batchItemId,
        image: completedImage,
        error: completedImage ? null : i18n.t('errors.streamingNoImage'),
        rawResponsePayload: rawPayload,
      }
    }

    // Non-streaming
    const payload = await response.json() as ResponsesApiResponse
    const images = extractImages(payload, mime)
    const image = images[0] ?? null
    if (image) await onImageToolCompleted?.(image)
    return {
      batchItemId,
      image,
      error: image ? null : i18n.t('errors.imagePayloadMissing'),
      rawResponsePayload: JSON.stringify(payload, null, 2),
    }
  } catch (err) {
    if (controller.signal.aborted || signal?.aborted) {
      return { batchItemId, image: null, error: i18n.t('errors.requestCancelled') }
    }
    return { batchItemId, image: null, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

/** Parse the arguments of a generate_image_batch function call */
export function parseBatchImageCallArguments(args: string): Array<{ id: string; prompt: string }> | null {
  try {
    const parsed = JSON.parse(args) as { images?: unknown }
    if (!parsed || !Array.isArray(parsed.images)) return null
    const items: Array<{ id: string; prompt: string }> = []
    for (const raw of parsed.images) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
      if (!prompt) continue
      items.push({ id: id || `image_${items.length + 1}`, prompt })
    }
    return items.length > 0 ? items : null
  } catch {
    return null
  }
}
