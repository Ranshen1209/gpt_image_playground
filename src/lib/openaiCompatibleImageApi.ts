import { DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type ImageApiResponse, type ImageResponseItem, type ResponsesApiResponse, type ResponsesOutputItem, type TaskParams } from '../types'
import { dataUrlToBlob, imageDataUrlToPngBlob, maskDataUrlToPngBlob } from './canvasImage'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import {
  assertImageInputPayloadSize,
  assertMaskEditFileSize,
  type CallApiOptions,
  type CallApiResult,
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  getDataUrlDecodedByteSize,
  getDataUrlEncodedByteSize,
  isDataUrl,
  isHttpUrl,
  mergeActualParams,
  MIME_MAP,
  normalizeBase64Image,
  pickActualParams,
} from './imageApiShared'

const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

const IMAGES_GENERATION_PATH = 'images/generations'
const IMAGES_EDIT_PATH = 'images/edits'

function getStreamPartialImages(profile: ApiProfile): number {
  return profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
}

function normalizeImageApiPayload(value: unknown): ImageApiResponse {
  if (Array.isArray(value)) return { data: value as ImageApiResponse['data'] }
  if (value && typeof value === 'object') return value as ImageApiResponse
  return { data: [] }
}

function createRequestHeaders(profile: ApiProfile): Record<string, string> {
  return {
    Authorization: `Bearer ${profile.apiKey}`,
  }
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream') ?? false
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getNumberValue(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getStreamEventErrorMessage(event: Record<string, unknown>): string | null {
  const error = event.error
  if (isRecordValue(error)) {
    const message = getStringValue(error, 'message')
    if (message) return message
  }
  if (typeof error === 'string' && error.trim()) return error

  const type = getStringValue(event, 'type')
  if (type?.endsWith('.failed')) {
    return getStringValue(event, 'message') ?? '流式请求失败'
  }
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

async function readJsonServerSentEvents(response: Response, onEvent: (event: Record<string, unknown>) => void | Promise<void>): Promise<void> {
  if (!response.body) throw new Error('接口未返回可读取的流式响应')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const processBlock = async (block: string) => {
    const data = parseServerSentEventBlock(block)
    if (!data) return

    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      throw new Error('流式响应包含无法解析的 JSON 事件')
    }
    if (!isRecordValue(event)) return

    const errorMessage = getStreamEventErrorMessage(event)
    if (errorMessage) throw new Error(errorMessage)

    await onEvent(event)
  }

  while (true) {
    const { value, done } = await reader.read()
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
  if (buffer.trim()) await processBlock(buffer)
}

function createResponsesImageTool(
  params: TaskParams,
  isEdit: boolean,
  profile: ApiProfile,
  maskDataUrl?: string,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: isEdit ? 'edit' : 'generate',
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }

  if (profile.streamImages) {
    tool.partial_images = getStreamPartialImages(profile)
  }

  if (!profile.codexCli) {
    tool.quality = params.quality
  }

  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }

  if (maskDataUrl) {
    tool.input_image_mask = {
      image_url: maskDataUrl,
    }
  }

  return tool
}

function createResponsesInput(prompt: string, inputImageDataUrls: string[]): unknown {
  const text = `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
  if (!inputImageDataUrls.length) return text

  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...inputImageDataUrls.map((dataUrl) => ({
          type: 'input_image',
          image_url: dataUrl,
        })),
      ],
    },
  ]
}

function parseResponsesImageResults(payload: ResponsesApiResponse, fallbackMime: string): Array<{
  image: string
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
}> {
  const output = payload.output
  if (!Array.isArray(output) || !output.length) {
    const err = new Error('接口未返回图片数据')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const results: Array<{ image: string; actualParams?: Partial<TaskParams>; revisedPrompt?: string }> = []

  for (const item of output) {
    if (item?.type !== 'image_generation_call') continue

    const b64 = getResponsesImageResultBase64(item.result)
    if (b64) {
      results.push({
        image: normalizeBase64Image(b64, fallbackMime),
        actualParams: mergeActualParams(pickActualParams(item)),
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      })
    }
  }

  if (!results.length) {
    const err = new Error('接口没有返回可识别的图片数据，请查看原始响应内容确认服务商实际返回的数据结构。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  return results
}

function getResponsesImageResultBase64(result: ResponsesOutputItem['result']): string | undefined {
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

  return b64.trim() ? b64 : undefined
}

async function parseImagesApiResponse(payload: ImageApiResponse, mime: string, signal?: AbortSignal): Promise<CallApiResult> {
  const data = payload.data
  if (!Array.isArray(data) || !data.length) {
    const err = new Error('接口没有返回图片数据，请查看原始响应内容确认服务商实际返回的数据结构。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const images: string[] = []
  const rawImageUrls = data.map((item) => item.url).filter(isHttpUrl)
  const revisedPrompts: Array<string | undefined> = []
  try {
    for (const item of data) {
      const b64 = item.b64_json
      if (b64) {
        images.push(normalizeBase64Image(b64, mime))
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
        continue
      }

      if (isHttpUrl(item.url) || isDataUrl(item.url)) {
        images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal))
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
      }
    }
  } catch (err) {
    if (rawImageUrls.length > 0 && err instanceof Error) {
      (err as any).rawImageUrls = rawImageUrls
    }
    throw err
  }

  if (!images.length) {
    const err = new Error('接口没有返回可识别的图片数据，请查看原始响应内容确认服务商实际返回的数据结构。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const actualParams = mergeActualParams(
    pickActualParams(payload),
  )
  return {
    images,
    actualParams,
    actualParamsList: images.map(() => actualParams),
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

function eventToImageResponseItem(event: Record<string, unknown>): ImageResponseItem {
  return {
    b64_json: getStringValue(event, 'b64_json'),
    revised_prompt: getStringValue(event, 'revised_prompt'),
    size: getStringValue(event, 'size'),
    quality: getStringValue(event, 'quality'),
    output_format: getStringValue(event, 'output_format'),
    output_compression: getNumberValue(event, 'output_compression'),
    moderation: getStringValue(event, 'moderation'),
  }
}

async function parseImagesApiStreamResponse(
  response: Response,
  mime: string,
  onPartialImage?: CallApiOptions['onPartialImage'],
): Promise<CallApiResult> {
  const completedItems: ImageResponseItem[] = []
  let resultPayload: ImageApiResponse | null = null

  await readJsonServerSentEvents(response, (event) => {
    const type = getStringValue(event, 'type')
    const object = getStringValue(event, 'object')
    if (type === 'image_generation.partial_image' || type === 'image_edit.partial_image') {
      const b64 = getStringValue(event, 'b64_json')
      if (b64) {
        onPartialImage?.({
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
        })
      }
      return
    }

    if (object === 'image.generation.result' || object === 'image.edit.result') {
      resultPayload = normalizeImageApiPayload(event)
      return
    }

    if (type === 'image_generation.completed' || type === 'image_edit.completed') {
      completedItems.push(eventToImageResponseItem(event))
    }
  })

  if (resultPayload) {
    return parseImagesApiResponse(resultPayload, mime)
  }

  if (!completedItems.length) {
    throw new Error('流式接口未返回最终图片数据')
  }

  const images = completedItems
    .map((item) => item.b64_json)
    .filter((b64): b64 is string => Boolean(b64))
    .map((b64) => normalizeBase64Image(b64, mime))
  if (!images.length) throw new Error('流式接口未返回可用图片数据')

  const actualParamsList = completedItems.map((item) => mergeActualParams(pickActualParams(item)))
  const actualParams = mergeActualParams(
    actualParamsList[0],
    images.length > 1 ? { n: images.length } : undefined,
  )
  return {
    images,
    actualParams,
    actualParamsList,
    revisedPrompts: completedItems.map((item) => item.revised_prompt),
  }
}

function getResponsesStreamPayload(event: Record<string, unknown>): ResponsesApiResponse | null {
  const response = event.response
  if (isRecordValue(response)) return response as ResponsesApiResponse

  const item = event.item
  if (isRecordValue(item) && item.type === 'image_generation_call') {
    return { output: [item as ResponsesOutputItem] }
  }

  return null
}

async function parseResponsesApiStreamResponse(
  response: Response,
  mime: string,
  onPartialImage?: CallApiOptions['onPartialImage'],
): Promise<CallApiResult> {
  let completedPayload: ResponsesApiResponse | null = null
  const outputItems: ResponsesOutputItem[] = []

  await readJsonServerSentEvents(response, (event) => {
    const type = getStringValue(event, 'type')
    if (type === 'response.image_generation_call.partial_image') {
      const b64 = getStringValue(event, 'partial_image_b64')
      if (b64) {
        onPartialImage?.({
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
        })
      }
      return
    }

    const payload = getResponsesStreamPayload(event)
    if (!payload) return

    if (type === 'response.output_item.done' && Array.isArray(payload.output)) {
      outputItems.push(...payload.output)
      return
    }

    completedPayload = payload
  })

  const payload = completedPayload ?? (outputItems.length ? { output: outputItems } : null)
  if (!payload) throw new Error('流式接口未返回最终图片数据')

  let imageResults: ReturnType<typeof parseResponsesImageResults>
  try {
    imageResults = parseResponsesImageResults(payload, mime)
  } catch (err) {
    const collectedImageItems = outputItems.filter((item) => getResponsesImageResultBase64(item.result))
    if (collectedImageItems.length === 0) throw err
    imageResults = parseResponsesImageResults({ output: collectedImageItems }, mime)
  }
  const actualParams = mergeActualParams(imageResults[0]?.actualParams ?? {})
  return {
    images: imageResults.map((result) => result.image),
    actualParams,
    actualParamsList: imageResults.map((result) => mergeActualParams(result.actualParams ?? {})),
    revisedPrompts: imageResults.map((result) => result.revisedPrompt),
  }
}

export async function callOpenAICompatibleImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  return profile.apiMode === 'responses'
    ? callResponsesImageApi(opts, profile)
    : callImagesApi(opts, profile)
}

async function callImagesApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if ((profile.codexCli || (profile.streamImages && n > 1)) && n > 1) {
    return callImagesApiConcurrent(opts, profile, n)
  }

  return callImagesApiSingle(opts, profile)
}

async function callImagesApiConcurrent(opts: CallApiOptions, profile: ApiProfile, n: number): Promise<CallApiResult> {
  const singleOpts = {
    ...opts,
    params: {
      ...opts.params,
      n: 1,
      ...(profile.codexCli ? { quality: 'auto' as const } : {}),
    },
  }
  const results = await Promise.allSettled(
    Array.from({ length: n }).map((_, requestIndex) => callImagesApiSingle({
      ...singleOpts,
      onPartialImage: opts.onPartialImage
        ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
        : undefined,
    }, profile)),
  )

  const successfulResults = results
    .filter((r): r is PromiseFulfilledResult<CallApiResult> => r.status === 'fulfilled')
    .map((r) => r.value)

  if (successfulResults.length === 0) {
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (firstError) throw firstError.reason
    throw new Error('所有并发请求均失败')
  }

  const images = successfulResults.flatMap((r) => r.images)
  const actualParamsList = successfulResults.flatMap((r) =>
    r.actualParamsList?.length ? r.actualParamsList : r.images.map(() => r.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((r) =>
    r.revisedPrompts?.length ? r.revisedPrompts : r.images.map(() => undefined),
  )
  const rawImageUrls = successfulResults.flatMap((r) => r.rawImageUrls ?? [])
  const actualParams = mergeActualParams(
    successfulResults[0]?.actualParams ?? {},
    { n: images.length },
  )

  return { images, actualParams, actualParamsList, revisedPrompts, ...(rawImageUrls.length ? { rawImageUrls } : {}) }
}

async function callImagesApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const { prompt: originalPrompt, params, inputImageDataUrls } = opts
  const prompt = profile.codexCli
    ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${originalPrompt}`
    : originalPrompt
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const requestHeaders = createRequestHeaders(profile)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)

  try {
    let response: Response

    if (isEdit) {
      const formData = new FormData()
      formData.append('model', profile.model)
      formData.append('prompt', prompt)
      formData.append('size', params.size)
      formData.append('output_format', params.output_format)
      formData.append('moderation', params.moderation)

      if (!profile.codexCli) {
        formData.append('quality', params.quality)
      }

      if (params.output_format !== 'png' && params.output_compression != null) {
        formData.append('output_compression', String(params.output_compression))
      }
      if (params.n > 1) {
        formData.append('n', String(params.n))
      }
      if (profile.responseFormatB64Json) {
        formData.append('response_format', 'b64_json')
      }
      if (profile.streamImages) {
        formData.append('stream', 'true')
        formData.append('partial_images', String(getStreamPartialImages(profile)))
      }

      const imageBlobs: Blob[] = []
      for (let i = 0; i < inputImageDataUrls.length; i++) {
        const dataUrl = inputImageDataUrls[i]
        const blob = opts.maskDataUrl && i === 0
          ? await imageDataUrlToPngBlob(dataUrl)
          : await dataUrlToBlob(dataUrl)
        imageBlobs.push(blob)
      }

      const maskBlob = opts.maskDataUrl ? await maskDataUrlToPngBlob(opts.maskDataUrl) : null
      if (opts.maskDataUrl) {
        assertMaskEditFileSize('遮罩主图文件', imageBlobs[0]?.size ?? 0)
        assertMaskEditFileSize('遮罩文件', maskBlob?.size ?? 0)
      }
      assertImageInputPayloadSize(
        imageBlobs.reduce((sum, blob) => sum + blob.size, 0) + (maskBlob?.size ?? 0),
      )

      for (let i = 0; i < imageBlobs.length; i++) {
        const blob = imageBlobs[i]
        const ext = blob.type.split('/')[1] || 'png'
        formData.append('image[]', blob, `input-${i + 1}.${ext}`)
      }

      if (maskBlob) {
        formData.append('mask', maskBlob, 'mask.png')
      }

      response = await fetch(buildApiUrl(profile.baseUrl, IMAGES_EDIT_PATH, proxyConfig, useApiProxy), {
        method: 'POST',
        headers: requestHeaders,
        cache: 'no-store',
        body: formData,
        signal: controller.signal,
      })
    } else {
      const body: Record<string, unknown> = {
        model: profile.model,
        prompt,
        size: params.size,
        output_format: params.output_format,
        moderation: params.moderation,
      }

      if (!profile.codexCli) {
        body.quality = params.quality
      }

      if (params.output_format !== 'png' && params.output_compression != null) {
        body.output_compression = params.output_compression
      }
      if (params.n > 1) {
        body.n = params.n
      }
      if (profile.responseFormatB64Json) {
        body.response_format = 'b64_json'
      }
      if (profile.streamImages) {
        body.stream = true
        body.partial_images = getStreamPartialImages(profile)
      }

      response = await fetch(buildApiUrl(profile.baseUrl, IMAGES_GENERATION_PATH, proxyConfig, useApiProxy), {
        method: 'POST',
        headers: {
          ...requestHeaders,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    }

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    if (profile.streamImages && isEventStreamResponse(response)) {
      return parseImagesApiStreamResponse(response, mime, opts.onPartialImage)
    }

    return parseImagesApiResponse(await response.json() as ImageApiResponse, mime, controller.signal)
  } finally {
    clearTimeout(timeoutId)
  }
}

async function callResponsesImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if (n === 1) {
    return callResponsesImageApiSingle(opts, profile)
  }

  const promises = Array.from({ length: n }).map((_, requestIndex) => callResponsesImageApiSingle({
    ...opts,
    onPartialImage: opts.onPartialImage
      ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
      : undefined,
  }, profile))
  const results = await Promise.allSettled(promises)

  const successfulResults = results
    .filter((r): r is PromiseFulfilledResult<CallApiResult> => r.status === 'fulfilled')
    .map((r) => r.value)

  if (successfulResults.length === 0) {
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (firstError) throw firstError.reason
    throw new Error('所有并发请求均失败')
  }

  const images = successfulResults.flatMap((r) => r.images)
  const actualParamsList = successfulResults.flatMap((r) =>
    r.actualParamsList?.length ? r.actualParamsList : r.images.map(() => r.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((r) =>
    r.revisedPrompts?.length ? r.revisedPrompts : r.images.map(() => undefined),
  )
  const rawImageUrls = successfulResults.flatMap((r) => r.rawImageUrls ?? [])
  const actualParams = mergeActualParams(
    successfulResults[0]?.actualParams ?? {},
    images.length === opts.params.n ? { n: opts.params.n } : { n: images.length },
  )

  return { images, actualParams, actualParamsList, revisedPrompts, ...(rawImageUrls.length ? { rawImageUrls } : {}) }
}

async function callResponsesImageApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const { prompt, params, inputImageDataUrls } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const requestHeaders = createRequestHeaders(profile)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)

  try {
    if (opts.maskDataUrl) {
      assertMaskEditFileSize('遮罩主图文件', getDataUrlDecodedByteSize(inputImageDataUrls[0] ?? ''))
      assertMaskEditFileSize('遮罩文件', getDataUrlDecodedByteSize(opts.maskDataUrl))
    }
    assertImageInputPayloadSize(
      inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
        (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
    )

    const body: Record<string, unknown> = {
      model: profile.model,
      input: createResponsesInput(prompt, inputImageDataUrls),
      tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0, profile, opts.maskDataUrl)],
      tool_choice: 'required',
    }
    if (profile.streamImages) {
      body.stream = true
    }

    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: {
        ...requestHeaders,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    if (profile.streamImages && isEventStreamResponse(response)) {
      return parseResponsesApiStreamResponse(response, mime, opts.onPartialImage)
    }

    const payload = await response.json() as ResponsesApiResponse
    const imageResults = parseResponsesImageResults(payload, mime)
    const actualParams = mergeActualParams(
      imageResults[0]?.actualParams ?? {},
    )
    return {
      images: imageResults.map((result) => result.image),
      actualParams,
      actualParamsList: imageResults.map((result) =>
        mergeActualParams(result.actualParams ?? {}),
      ),
      revisedPrompts: imageResults.map((result) => result.revisedPrompt),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
