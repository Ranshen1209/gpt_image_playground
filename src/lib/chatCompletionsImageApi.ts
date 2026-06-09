import type { ApiProfile } from '../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import i18n from './i18n'
import {
  type CallApiOptions,
  type CallApiResult,
  fetchImageUrlAsDataUrl as defaultFetchImageUrlAsDataUrl,
  MIME_MAP,
} from './imageApiShared'
import {
  getStringValue,
  isRecordValue,
  PROMPT_REWRITE_GUARD_PREFIX,
  readJsonServerSentEvents,
} from './openaiCompatibleImageApi'
import { resolveBearerToken } from './oauthFallback'
import { getSakrylleImageRequestParams } from './sakrylleImageSize'

const CHAT_COMPLETIONS_PATH = 'chat/completions'
export const IDLE_TIMEOUT_MS = 60000
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/

/** 从累积文本里提取第一个 Markdown 图片 URL */
export function extractMarkdownImageUrl(text: string): string | null {
  const match = text.match(MARKDOWN_IMAGE_RE)
  return match ? match[1] : null
}

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

const MASK_INSTRUCTION =
  ' The last image is a mask: its transparent area marks where to apply the edit; keep the rest unchanged.'

/** 组装 chat message 的 content 数组。蒙版作为额外一张 image_url + 文字说明 */
export function buildChatMessageContent(
  prompt: string,
  inputImageDataUrls: string[],
  maskDataUrl: string | undefined,
): ChatContentPart[] {
  const text = `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}${maskDataUrl ? MASK_INSTRUCTION : ''}`
  const parts: ChatContentPart[] = [{ type: 'text', text }]
  for (const url of inputImageDataUrls) {
    parts.push({ type: 'image_url', image_url: { url } })
  }
  if (maskDataUrl) {
    parts.push({ type: 'image_url', image_url: { url: maskDataUrl } })
  }
  return parts
}

/** delta.content 可能是 string 或 [{type,text}] 数组,统一抽成纯文本 */
function deltaContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecordValue(part) ? getStringValue(part, 'text') ?? '' : ''))
      .join('')
  }
  return ''
}

type FetchImageUrlAsDataUrl = typeof defaultFetchImageUrlAsDataUrl

export async function parseChatCompletionImageStream(
  response: Response,
  mime: string,
  onPartialImage: CallApiOptions['onPartialImage'],
  resetIdle: () => void,
  fetchImageUrlAsDataUrl: FetchImageUrlAsDataUrl = defaultFetchImageUrlAsDataUrl,
  signal?: AbortSignal,
): Promise<CallApiResult> {
  let accumulated = ''

  await readJsonServerSentEvents(response, (event) => {
    resetIdle()
    if (event.object !== 'chat.completion.chunk') return
    const choices = event.choices
    if (!Array.isArray(choices) || !choices.length) return
    const first = choices[0]
    if (!isRecordValue(first)) return
    const delta = first.delta
    if (isRecordValue(delta)) accumulated += deltaContentToText(delta.content)
  })

  const url = extractMarkdownImageUrl(accumulated)
  if (!url) {
    const err = new Error(i18n.t('errors.chatImageNoImage')) as Error & { httpStatus?: number }
    err.httpStatus = 503
    throw err
  }

  const dataUrl = await fetchImageUrlAsDataUrl(url, mime, signal)
  onPartialImage?.({ image: dataUrl, final: true })

  return { images: [dataUrl], rawImageUrls: [url] }
}

async function createRequestHeaders(profile: ApiProfile): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await resolveBearerToken(profile)}` }
}

export async function callImagesApiViaChat(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const params = getSakrylleImageRequestParams(opts.params, profile)
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const requestHeaders = await createRequestHeaders(profile)

  const body = {
    model: profile.model,
    stream: true,
    messages: [
      { role: 'user', content: buildChatMessageContent(opts.prompt, opts.inputImageDataUrls, opts.maskDataUrl) },
    ],
  }

  const controller = new AbortController()
  const makeTimeoutError = (name: string, message: string) => {
    const err = new Error(message)
    err.name = name
    return err
  }

  const overallTimeoutId = setTimeout(
    () => controller.abort(makeTimeoutError('OverallTimeout', i18n.t('errors.chatImageOverallTimeout'))),
    profile.timeout * 1000,
  )
  let idleTimeoutId: ReturnType<typeof setTimeout>
  const resetIdle = () => {
    clearTimeout(idleTimeoutId)
    idleTimeoutId = setTimeout(
      () => controller.abort(makeTimeoutError('IdleTimeout', i18n.t('errors.chatImageIdleTimeout'))),
      IDLE_TIMEOUT_MS,
    )
  }
  resetIdle()

  try {
    const response = await fetch(buildApiUrl(profile.baseUrl, CHAT_COMPLETIONS_PATH, proxyConfig, useApiProxy), {
      method: 'POST',
      headers: { ...requestHeaders, 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const err = new Error(await response.text()) as Error & { httpStatus?: number }
      err.httpStatus = response.status
      throw err
    }

    return await parseChatCompletionImageStream(response, mime, opts.onPartialImage, resetIdle, defaultFetchImageUrlAsDataUrl, controller.signal)
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason
    }
    throw err
  } finally {
    clearTimeout(overallTimeoutId)
    clearTimeout(idleTimeoutId!)
  }
}
