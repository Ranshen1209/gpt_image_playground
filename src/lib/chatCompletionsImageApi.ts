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
