# 流式 chat/completions 图像生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Sakrylle 图像生成(文生图/参考图/蒙版/大图/多图)改走流式 `chat/completions`,用连续字节流防 Cloudflare 524 超时,并用进度心跳驱动 60s 空闲超时。

**Architecture:** 在 `callImagesApiSingle` 内部分流(方案 A):Sakrylle baseUrl + 开关开 → 委托新文件 `chatCompletionsImageApi.ts` 的 `callImagesApiViaChat`,否则走现有 multipart/JSON 逻辑。并发层 `runImageRequestsWithRefill` 零改动复用。

**Tech Stack:** React 19 + TypeScript + Vite 6 + Zustand 5 + i18next + Vitest。纯前端 SPA。

**设计文档:** `docs/superpowers/specs/2026-06-09-streaming-chat-completions-image-design.md`

---

## File Structure

**新增:**
- `src/lib/chatCompletionsImageApi.ts` — `callImagesApiViaChat`(构造 chat 请求 + 双计时器)+ `parseChatCompletionImageStream`(SSE 解析 + Markdown URL 提取)+ 错误标记常量。单一职责:chat/completions 图像路径。
- `src/lib/chatCompletionsImageApi.test.ts` — 新文件单测。

**修改:**
- `src/types.ts` — `ApiProfile` 加 `streamChatCompletionsImage?: boolean`。
- `src/lib/apiProfiles.ts` — `createDefaultOpenAIProfile` 设默认 true;`normalizeApiProfile` + `normalizeSettings` legacy profile 归一化补默认。
- `src/lib/openaiCompatibleImageApi.ts` — `export` 现有 `readJsonServerSentEvents`(就地导出);加 `shouldUseChatImagePath` + 分流;`isRetryableError` 三拆分;`runImageRequestsWithRefill` 503 特殊处理;导出共享常量供新文件复用。
- `src/store.ts` — `getTimeoutStreamingHint` 区分空闲/整体超时。
- `src/locales/zh.json` + `src/locales/en.json` — 新 `errors.*` 串。
- `src/components/SettingsModal.tsx` — `streamChatCompletionsImage` 开关 + sanitize。
- `CLAUDE.md` / `package.json` / `public/sw.js` — 文档与版本。

---

## 共享约定(贯穿全部任务)

错误标记用 `name` 字段区分 abort 来源,这些字符串在多个文件用到,必须完全一致:

- 空闲超时 Error 的 `name` = `'IdleTimeout'`
- 整体超时 Error 的 `name` = `'OverallTimeout'`
- 503 账号池消息匹配子串 = `'No available compatible accounts'`
- 空闲超时常量 `IDLE_TIMEOUT_MS = 60000`
- Markdown 图片 URL 正则 = `/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/`

---

## Task 1: 给 ApiProfile 加 streamChatCompletionsImage 字段 + 归一化

**Files:**
- Modify: `src/types.ts:23-24`(ApiProfile interface)
- Modify: `src/lib/apiProfiles.ts:57-58`(createDefaultOpenAIProfile)、`:88-89`(normalizeApiProfile)、`:120-121`(normalizeSettings legacyProfile)
- Test: `src/lib/apiProfiles.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/apiProfiles.test.ts` 末尾(最后一个 `})` 之前)加:

```typescript
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
```

确认文件顶部已 import `createDefaultOpenAIProfile` 和 `normalizeApiProfile`;若缺则补到现有 import 行。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/apiProfiles.test.ts -t streamChatCompletionsImage`
Expected: FAIL — `expected undefined to be true`

- [ ] **Step 3: 加字段到 ApiProfile**

`src/types.ts`,在 `streamImages?: boolean`(第 23 行)和 `streamPartialImages?: number`(第 24 行)之间加一行:

```typescript
  streamImages?: boolean
  /** 走流式 chat/completions 图像路径(仅 Sakrylle baseUrl 生效)。默认 true */
  streamChatCompletionsImage?: boolean
  streamPartialImages?: number
```

- [ ] **Step 4: 设默认 + 归一化**

`src/lib/apiProfiles.ts`:

`createDefaultOpenAIProfile` 里 `streamImages: true,`(第 57 行)下一行加:

```typescript
    streamImages: true,
    streamChatCompletionsImage: true,
```

`normalizeApiProfile` 的 return 里 `streamImages: ...`(第 88 行)下一行加:

```typescript
    streamImages: typeof record.streamImages === 'boolean' ? record.streamImages : defaults.streamImages,
    streamChatCompletionsImage: typeof record.streamChatCompletionsImage === 'boolean' ? record.streamChatCompletionsImage : defaults.streamChatCompletionsImage,
```

`normalizeSettings` 的 legacyProfile(`createDefaultOpenAIProfile({...})`)里 `streamImages: ...`(第 120 行)下一行加:

```typescript
    streamImages: typeof record.streamImages === 'boolean' ? record.streamImages : true,
    streamChatCompletionsImage: typeof record.streamChatCompletionsImage === 'boolean' ? record.streamChatCompletionsImage : true,
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/lib/apiProfiles.test.ts -t streamChatCompletionsImage`
Expected: PASS(3 个用例)

- [ ] **Step 6: 提交**

```bash
git add src/types.ts src/lib/apiProfiles.ts src/lib/apiProfiles.test.ts
git commit -m "feat: add streamChatCompletionsImage profile field (default true)"
```

---

## Task 2: 拆分 isRetryableError(idle 可重试 / overall+user-abort 不重试)

**Files:**
- Modify: `src/lib/openaiCompatibleImageApi.ts:76-84`(isRetryableError)
- Test: `src/lib/openaiCompatibleImageApi.test.ts`

**背景:** 现状 `isRetryableError` 把所有 `AbortError`(name==='AbortError')判为可重试。新增空闲超时后,要按 `name` 区分:`IdleTimeout`=可重试、`OverallTimeout`=不可重试、`AbortError`(用户取消)=不可重试。

- [ ] **Step 1: 写失败测试**

在 `src/lib/openaiCompatibleImageApi.test.ts` 找到现有 `isRetryableError` 的 describe 块(若无则新建),加:

```typescript
describe('isRetryableError abort 三拆分', () => {
  it('idle timeout is retryable', () => {
    const err = new Error('idle'); err.name = 'IdleTimeout'
    expect(isRetryableError(err)).toBe(true)
  })
  it('overall timeout is NOT retryable', () => {
    const err = new Error('overall'); err.name = 'OverallTimeout'
    expect(isRetryableError(err)).toBe(false)
  })
  it('user abort (AbortError) is NOT retryable', () => {
    const err = new DOMException('stopped', 'AbortError')
    expect(isRetryableError(err)).toBe(false)
  })
  it('network TypeError stays retryable', () => {
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true)
  })
  it('429 / 5xx stay retryable', () => {
    const e429 = Object.assign(new Error('rate'), { httpStatus: 429 })
    const e503 = Object.assign(new Error('busy'), { httpStatus: 503 })
    expect(isRetryableError(e429)).toBe(true)
    expect(isRetryableError(e503)).toBe(true)
  })
})
```

确认测试文件已 import `isRetryableError`;若缺补上。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/openaiCompatibleImageApi.test.ts -t "三拆分"`
Expected: FAIL — `user abort` 和 `overall timeout` 当前返回 true

- [ ] **Step 3: 改 isRetryableError**

`src/lib/openaiCompatibleImageApi.ts`,把现有(第 76-84 行):

```typescript
export function isRetryableError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof TypeError) return true
  const status = (err as { httpStatus?: unknown } | null)?.httpStatus
  if (typeof status === 'number') {
    return status === 429 || status >= 500
  }
  return false
}
```

整体替换为:

```typescript
export function isRetryableError(err: unknown): boolean {
  // 空闲超时:上游卡死,重试可能换账号成功 → 可重试
  if (err instanceof Error && err.name === 'IdleTimeout') return true
  // 整体超时:有字节流动但到 600s,真太慢,重试只是再烧时间和钱 → 不可重试
  if (err instanceof Error && err.name === 'OverallTimeout') return false
  // 用户主动取消:绝不重试
  if (err instanceof DOMException && err.name === 'AbortError') return false
  if (err instanceof TypeError) return true
  const status = (err as { httpStatus?: unknown } | null)?.httpStatus
  if (typeof status === 'number') {
    return status === 429 || status >= 500
  }
  return false
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/openaiCompatibleImageApi.test.ts -t "三拆分"`
Expected: PASS(5 个用例)

- [ ] **Step 5: 提交**

```bash
git add src/lib/openaiCompatibleImageApi.ts src/lib/openaiCompatibleImageApi.test.ts
git commit -m "feat: split isRetryableError — idle retryable, overall/user-abort not"
```

---

## Task 3: 导出共享 helper 供新文件复用

**Files:**
- Modify: `src/lib/openaiCompatibleImageApi.ts:230`(readJsonServerSentEvents)、`:24`(PROMPT_REWRITE_GUARD_PREFIX)、`:192-200`(getStringValue/getNumberValue)、`:188`(isRecordValue)

**背景:** 新文件 `chatCompletionsImageApi.ts` 要复用 SSE 读取、prompt 防护前缀、event 字段取值 helper。把它们就地 `export`(不抽文件,避免动太多)。

- [ ] **Step 1: 加 export 关键字**

`src/lib/openaiCompatibleImageApi.ts`,给以下 5 个声明加 `export`:

第 24 行:
```typescript
export const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'
```

第 188 行:
```typescript
export function isRecordValue(value: unknown): value is Record<string, unknown> {
```

第 192 行:
```typescript
export function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
```

第 197 行:
```typescript
export function getNumberValue(source: Record<string, unknown>, key: string): number | undefined {
```

第 230 行:
```typescript
export async function readJsonServerSentEvents(response: Response, onEvent: (event: Record<string, unknown>) => void | Promise<void>): Promise<void> {
```

- [ ] **Step 2: 编译确认无破坏**

Run: `npx tsc -b --noEmit 2>&1 | head -20`
Expected: 无新错误(这些 export 不改变行为)

- [ ] **Step 3: 提交**

```bash
git add src/lib/openaiCompatibleImageApi.ts
git commit -m "refactor: export SSE/prompt helpers for chat image path"
```

---

## Task 4: 新文件 chatCompletionsImageApi.ts — parseChatCompletionImageStream

**Files:**
- Create: `src/lib/chatCompletionsImageApi.ts`
- Test: `src/lib/chatCompletionsImageApi.test.ts`

**背景:** 解析 SSE 流。每个 `chat.completion.chunk` 累积 `delta.content`(可能 string 或数组);进度文本块当心跳调 `resetIdle()`;全文累积后正则提 Markdown 图片 URL,转 dataURL。无 URL → 抛可重试上游过载错误。

- [ ] **Step 1: 写失败测试**

创建 `src/lib/chatCompletionsImageApi.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { parseChatCompletionImageStream, extractMarkdownImageUrl } from './chatCompletionsImageApi'

// 把字符串数组做成一个 text/event-stream Response
function sseResponse(blocks: string[]): Response {
  const body = blocks.map((b) => `data: ${b}\n\n`).join('')
  return new Response(new TextEncoder().encode(body), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function chunk(content: string, finish: string | null = null) {
  return JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content, role: 'assistant' }, finish_reason: finish }],
  })
}

describe('extractMarkdownImageUrl', () => {
  it('extracts the URL from a markdown image', () => {
    expect(extractMarkdownImageUrl('x\n\n![image](https://f.example.com/a.png)'))
      .toBe('https://f.example.com/a.png')
  })
  it('returns null when no markdown image present', () => {
    expect(extractMarkdownImageUrl('excessive system load')).toBeNull()
  })
})

describe('parseChatCompletionImageStream', () => {
  it('treats progress chunks as heartbeats and extracts the final image URL', async () => {
    const resetIdle = vi.fn()
    const fetchAsDataUrl = vi.fn().mockResolvedValue('data:image/png;base64,AAA')
    const res = sseResponse([
      chunk('Progressing...\n'),
      chunk('1% '),
      chunk('\nSuccessfully Generated Image\n\n![image](https://f.example.com/a.png)', 'stop'),
    ])
    const result = await parseChatCompletionImageStream(res, 'image/png', undefined, resetIdle, fetchAsDataUrl)
    expect(resetIdle).toHaveBeenCalled()
    expect(fetchAsDataUrl).toHaveBeenCalledWith('https://f.example.com/a.png', 'image/png', undefined)
    expect(result.images).toEqual(['data:image/png;base64,AAA'])
    expect(result.rawImageUrls).toEqual(['https://f.example.com/a.png'])
  })

  it('tolerates delta.content as an array of parts', async () => {
    const fetchAsDataUrl = vi.fn().mockResolvedValue('data:image/png;base64,BBB')
    const arrChunk = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: [{ type: 'text', text: '![image](https://f.example.com/b.png)' }] }, finish_reason: 'stop' }],
    })
    const res = sseResponse([arrChunk])
    const result = await parseChatCompletionImageStream(res, 'image/png', undefined, vi.fn(), fetchAsDataUrl)
    expect(result.images).toEqual(['data:image/png;base64,BBB'])
  })

  it('throws a retryable error when stream ends with no image url (excessive system load)', async () => {
    const res = sseResponse([chunk('Progressing...\n'), chunk('\nexcessive system load', 'stop')])
    await expect(
      parseChatCompletionImageStream(res, 'image/png', undefined, vi.fn(), vi.fn()),
    ).rejects.toMatchObject({ httpStatus: 503 })
  })

  it('calls onPartialImage when an image is produced', async () => {
    const onPartial = vi.fn()
    const fetchAsDataUrl = vi.fn().mockResolvedValue('data:image/png;base64,CCC')
    const res = sseResponse([chunk('![image](https://f.example.com/c.png)', 'stop')])
    await parseChatCompletionImageStream(res, 'image/png', onPartial, vi.fn(), fetchAsDataUrl)
    expect(onPartial).toHaveBeenCalledWith(expect.objectContaining({ image: 'data:image/png;base64,CCC', final: true }))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/chatCompletionsImageApi.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 创建文件 + 实现解析器**

创建 `src/lib/chatCompletionsImageApi.ts`。

> **注意:** 下面的 import 块是文件的**最终形态**——其中 `ApiProfile`、`buildApiUrl`、`readClientDevProxyConfig`、`shouldUseApiProxy`、`MIME_MAP`、`resolveBearerToken`、`getSakrylleImageRequestParams` 在 **Task 5** 的 `callImagesApiViaChat` 里才用到。本任务先全部写上,不要删"看起来没用"的 import(本任务的验证用 `vitest`/esbuild,不报 unused;首个 `tsc` 门在 Task 5,届时全部用到)。

```typescript
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
    // 流正常结束但无图片(实测上游过载终块是 "excessive system load")→ 当可重试上游过载
    const err = new Error(i18n.t('errors.chatImageNoImage')) as Error & { httpStatus?: number }
    err.httpStatus = 503
    throw err
  }

  const dataUrl = await fetchImageUrlAsDataUrl(url, mime, signal)
  onPartialImage?.({ image: dataUrl, final: true })

  return { images: [dataUrl], rawImageUrls: [url] }
}
```

- [ ] **Step 4: 加 i18n 串**

`src/locales/zh.json` 的 `errors` 对象加:
```json
    "chatImageNoImage": "上游未返回图片(可能繁忙),已自动重试",
```

`src/locales/en.json` 的 `errors` 对象加:
```json
    "chatImageNoImage": "Upstream returned no image (possibly busy); retried automatically",
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/lib/chatCompletionsImageApi.test.ts`
Expected: PASS(6 个用例)

- [ ] **Step 6: 提交**

```bash
git add src/lib/chatCompletionsImageApi.ts src/lib/chatCompletionsImageApi.test.ts src/locales/zh.json src/locales/en.json
git commit -m "feat: parseChatCompletionImageStream — SSE parse + markdown url extract"
```

---

## Task 5: callImagesApiViaChat — 请求构造 + 双计时器

**Files:**
- Modify: `src/lib/chatCompletionsImageApi.ts`(加 `callImagesApiViaChat` + content 组装)
- Test: `src/lib/chatCompletionsImageApi.test.ts`

**背景:** 构造 chat 请求体(text + image_url 多模态),双计时器(overall 不复位 / idle 每 chunk 复位),fetch 后交给 parseChatCompletionImageStream。

- [ ] **Step 1: 写失败测试(content 组装是纯函数,优先测它)**

在 `chatCompletionsImageApi.test.ts` 加(顶部 import 加 `buildChatMessageContent`):

```typescript
import { buildChatMessageContent } from './chatCompletionsImageApi'

describe('buildChatMessageContent', () => {
  const GUARD = 'Use the following text as the complete prompt. Do not rewrite it:'

  it('text-to-image: only a text part with guard prefix', () => {
    const content = buildChatMessageContent('a red apple', [], undefined)
    expect(content).toEqual([{ type: 'text', text: `${GUARD}\na red apple` }])
  })

  it('reference images: text + one image_url per input', () => {
    const content = buildChatMessageContent('combine', ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'], undefined)
    expect(content[0]).toEqual({ type: 'text', text: `${GUARD}\ncombine` })
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } })
    expect(content[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } })
  })

  it('mask: main image + mask image_url + mask-semantics text note', () => {
    const content = buildChatMessageContent('fill center', ['data:image/png;base64,MAIN'], 'data:image/png;base64,MASK')
    // 末尾两项:主图 image_url、蒙版 image_url;且 text 项里含蒙版说明
    const urls = content.filter((p): p is { type: 'image_url'; image_url: { url: string } } => p.type === 'image_url').map((p) => p.image_url.url)
    expect(urls).toEqual(['data:image/png;base64,MAIN', 'data:image/png;base64,MASK'])
    const textPart = content[0] as { type: 'text'; text: string }
    expect(textPart.text).toContain('mask')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/chatCompletionsImageApi.test.ts -t buildChatMessageContent`
Expected: FAIL — `buildChatMessageContent` 未导出

- [ ] **Step 3: 实现 content 组装**

`src/lib/chatCompletionsImageApi.ts` 在 `extractMarkdownImageUrl` 下方加:

```typescript
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/chatCompletionsImageApi.test.ts -t buildChatMessageContent`
Expected: PASS(3 个用例)

- [ ] **Step 5: 实现 callImagesApiViaChat(双计时器)**

`src/lib/chatCompletionsImageApi.ts` 文件末尾加:

```typescript
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
    // controller.abort(reason) 后 fetch 抛 AbortError,但我们要把 reason(Idle/Overall)透出
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason
    }
    throw err
  } finally {
    clearTimeout(overallTimeoutId)
    clearTimeout(idleTimeoutId!)
  }
}
```

- [ ] **Step 6: 加 i18n 串**

`src/locales/zh.json` 的 `errors` 加:
```json
    "chatImageIdleTimeout": "网络中断或上游卡死,已自动重试",
    "chatImageOverallTimeout": "图像生成超过时限",
```

`src/locales/en.json` 的 `errors` 加:
```json
    "chatImageIdleTimeout": "Connection dropped or upstream stalled; retried automatically",
    "chatImageOverallTimeout": "Image generation exceeded the time limit",
```

- [ ] **Step 7: 跑全文件测试 + 编译**

Run: `npx vitest run src/lib/chatCompletionsImageApi.test.ts && npx tsc -b --noEmit 2>&1 | head`
Expected: 测试全 PASS,编译无新错误

- [ ] **Step 8: 提交**

```bash
git add src/lib/chatCompletionsImageApi.ts src/lib/chatCompletionsImageApi.test.ts src/locales/zh.json src/locales/en.json
git commit -m "feat: callImagesApiViaChat — request builder + dual idle/overall timer"
```

---

## Task 6: 分流 + 503 账号池特殊处理

**Files:**
- Modify: `src/lib/openaiCompatibleImageApi.ts`(加 `shouldUseChatImagePath` + `callImagesApiSingle` 顶部分流 + `runImageRequestsWithRefill` 503 早停)
- Test: `src/lib/openaiCompatibleImageApi.test.ts`

**背景:** 在 `callImagesApiSingle`(`:635`)顶部判断:Sakrylle baseUrl + 开关开 → 走 chat 路径。503 "No available compatible accounts" 秒回时,在 `runImageRequestsWithRefill`(`:122`)当轮全失败即停,不烧 2N 补发预算。

- [ ] **Step 1: 写 shouldUseChatImagePath 失败测试**

`src/lib/openaiCompatibleImageApi.test.ts` 加(import 补 `shouldUseChatImagePath`、`createDefaultOpenAIProfile`):

```typescript
import { createDefaultOpenAIProfile } from './apiProfiles'

describe('shouldUseChatImagePath', () => {
  it('true for Sakrylle baseUrl with flag on', () => {
    const profile = createDefaultOpenAIProfile({ baseUrl: 'https://api.sakrylle.com/v1', streamChatCompletionsImage: true })
    expect(shouldUseChatImagePath(profile)).toBe(true)
  })
  it('false when flag off', () => {
    const profile = createDefaultOpenAIProfile({ baseUrl: 'https://api.sakrylle.com/v1', streamChatCompletionsImage: false })
    expect(shouldUseChatImagePath(profile)).toBe(false)
  })
  it('false for non-Sakrylle baseUrl even with flag on', () => {
    const profile = createDefaultOpenAIProfile({ baseUrl: 'https://api.openai.com/v1', streamChatCompletionsImage: true })
    expect(shouldUseChatImagePath(profile)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/openaiCompatibleImageApi.test.ts -t shouldUseChatImagePath`
Expected: FAIL — 未导出

- [ ] **Step 3: 实现 shouldUseChatImagePath + 分流**

`src/lib/openaiCompatibleImageApi.ts`,在 `getStreamPartialImages`(`:37`)下方加:

```typescript
export function shouldUseChatImagePath(profile: ApiProfile): boolean {
  return profile.streamChatCompletionsImage === true && isSakrylleApiBaseUrl(profile.baseUrl)
}
```

文件顶部 import 区(第 22 行 `getSakrylleImageRequestParams` import 下方)加:

```typescript
import { callImagesApiViaChat } from './chatCompletionsImageApi'
```

> **关于循环依赖:** 此 import 与 `chatCompletionsImageApi.ts` 反向 import(它从本文件取 `readJsonServerSentEvents` 等)构成循环。这在 ESM 下安全——两边的跨模块绑定都只在函数体内调用(惰性求值),没有模块初始化期(top-level)互相读取。**不要**为"破循环"把 helper 抽到第三个文件;保持现状。若 `tsc`/vitest 报运行时 `undefined`(不应发生),才考虑抽 helper。

`callImagesApiSingle`(`:635`)函数体第一行 `const { prompt: originalPrompt, ... } = opts` 之前插入:

```typescript
async function callImagesApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  if (shouldUseChatImagePath(profile)) {
    return callImagesApiViaChat(opts, profile)
  }
  const { prompt: originalPrompt, inputImageDataUrls } = opts
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/openaiCompatibleImageApi.test.ts -t shouldUseChatImagePath`
Expected: PASS(3 个用例)

- [ ] **Step 5: 写 503 早停失败测试**

`src/lib/openaiCompatibleImageApi.test.ts` 加(import 补 `runImageRequestsWithRefill`):

```typescript
describe('runImageRequestsWithRefill 503 账号池早停', () => {
  it('does NOT burn refill budget when all fail with "No available compatible accounts"', async () => {
    let calls = 0
    const runSingle = async () => {
      calls++
      const err = Object.assign(new Error('No available compatible accounts'), { httpStatus: 503 })
      throw err
    }
    const result = await runImageRequestsWithRefill(3, runSingle)
    // n=3,若烧满预算会调 6 次;早停应只调一轮 3 次
    expect(calls).toBe(3)
    expect(result.failedCount).toBe(3)
  })
})
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npx vitest run src/lib/openaiCompatibleImageApi.test.ts -t "503 账号池早停"`
Expected: FAIL — 当前 503 算可重试,会补发到 6 次(calls===6)

- [ ] **Step 7: 实现 503 早停**

`src/lib/openaiCompatibleImageApi.ts`,在 `isRetryableError` 下方(`:84` 后)加 helper:

```typescript
const ACCOUNT_POOL_EXHAUSTED_MARKER = 'No available compatible accounts'

function isAccountPoolExhausted(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return message.includes(ACCOUNT_POOL_EXHAUSTED_MARKER)
}
```

`runImageRequestsWithRefill` 的 results.forEach 循环(`:148-156`)里,把:

```typescript
      } else {
        if (firstError === undefined) firstError = r.reason
        if (isRetryableError(r.reason)) roundRetryable++
      }
```

改为:

```typescript
      } else {
        if (firstError === undefined) firstError = r.reason
        // 503 账号池枯竭秒回,补发也是空转烧钱 → 不计入可重试
        if (isRetryableError(r.reason) && !isAccountPoolExhausted(r.reason)) roundRetryable++
      }
```

(现有 `:159` 的 `if (roundSuccess === 0 && roundRetryable === 0) break` 会因此触发早停。)

- [ ] **Step 8: 跑测试 + 编译**

Run: `npx vitest run src/lib/openaiCompatibleImageApi.test.ts && npx tsc -b --noEmit 2>&1 | head`
Expected: 全 PASS,编译无新错误

- [ ] **Step 9: 提交**

```bash
git add src/lib/openaiCompatibleImageApi.ts src/lib/openaiCompatibleImageApi.test.ts
git commit -m "feat: route Sakrylle images via chat path + 503 pool-exhaustion early stop"
```

---

## Task 7: store 超时提示区分空闲/整体

**Files:**
- Modify: `src/store.ts:127-133`(getTimeoutStreamingHint)
- Test: 无新单测(提示是 i18n 串拼接,locales.test.ts 覆盖 parity)

**背景:** 现状 `getTimeoutStreamingHint` 只按 streamImages/partialImages 给提示。chat 路径下空闲超时已自动重试,提示文案应区分。本任务最小改动:确保 chat 路径开启时提示文案合理(指向"已自动重试")。

- [ ] **Step 1: 改 getTimeoutStreamingHint**

`src/store.ts`,`TimeoutStreamingHintProfile` 类型(`:125`)加 `streamChatCompletionsImage`:

```typescript
type TimeoutStreamingHintProfile = Pick<ApiProfile, 'provider' | 'streamImages' | 'streamPartialImages' | 'streamChatCompletionsImage'>
```

`getTimeoutStreamingHint`(`:127`)函数体开头(`if (profile?.provider !== 'openai') return ''` 之后)加:

```typescript
  if (profile?.provider !== 'openai') return ''
  // 走流式 chat 路径时,空闲超时已自动重试,整体超时才到这里
  if (profile.streamChatCompletionsImage) return i18n.t('errors.timeoutHintChatOverall')
```

- [ ] **Step 2: 加 i18n 串**

`src/locales/zh.json` 的 `errors` 加:
```json
    "timeoutHintChatOverall": "生成超过时限。可在设置里调高超时时长。",
```

`src/locales/en.json` 的 `errors` 加:
```json
    "timeoutHintChatOverall": "Generation exceeded the time limit. You can raise the timeout in settings.",
```

- [ ] **Step 3: 跑 locale parity + 编译**

Run: `npx vitest run src/locales/locales.test.ts && npx tsc -b --noEmit 2>&1 | head`
Expected: PASS,编译无新错误

- [ ] **Step 4: 提交**

```bash
git add src/store.ts src/locales/zh.json src/locales/en.json
git commit -m "feat: timeout hint distinguishes chat-path overall timeout"
```

---

## Task 8: SettingsModal 开关 + sanitize

**Files:**
- Modify: `src/components/SettingsModal.tsx:530`(sanitize)、`:1502-1522`(toggle JSX 区)
- Test: 无新单测(UI)

**背景:** 在「流式传输」区(`:1503` `activeProfile.provider === 'openai'` 块)加 `streamChatCompletionsImage` 开关;sanitize(`:530`)补该字段。

- [ ] **Step 1: sanitize 补字段**

`src/components/SettingsModal.tsx` 第 530 行 `streamImages: ...` 下一行加:

```typescript
        streamImages: profile.provider === 'openai' ? profile.streamImages : false,
        streamChatCompletionsImage: profile.provider === 'openai' ? profile.streamChatCompletionsImage : false,
```

- [ ] **Step 2: 加 toggle JSX**

`src/components/SettingsModal.tsx`,在「流式传输」`<div className="block space-y-3">`(`:1504`)内、现有 streamImages `<div>`(`:1505`)**之前**插入一个同构 toggle:

```tsx
                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-3">
                      <span className="block text-sm text-gray-600 dark:text-gray-300">{t('settings.api.streamChatImage')}</span>
                      <button
                        type="button"
                        onClick={() => updateActiveProfile({ streamChatCompletionsImage: !activeProfile.streamChatCompletionsImage }, true)}
                        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${activeProfile.streamChatCompletionsImage ? 'bg-[#9181bd]' : 'bg-gray-300 dark:bg-gray-600'}`}
                        role="switch"
                        aria-checked={!!activeProfile.streamChatCompletionsImage}
                        aria-label={t('settings.api.streamChatImage')}
                      >
                        <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${activeProfile.streamChatCompletionsImage ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
                      </button>
                    </div>
                    <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
                      {t('settings.api.streamChatImageHint')}
                    </div>
                  </div>
```

- [ ] **Step 3: 加 i18n 串**

`src/locales/zh.json` 的 `settings.api` 加:
```json
    "streamChatImage": "流式 chat/completions 生图",
    "streamChatImageHint": "仅对 Sakrylle 官方接口生效。用连续字节流防止生图超时,并提供进度心跳。建议保持开启。",
```

`src/locales/en.json` 的 `settings.api` 加:
```json
    "streamChatImage": "Streaming chat/completions image",
    "streamChatImageHint": "Only applies to the official Sakrylle endpoint. Uses a continuous byte stream to prevent generation timeouts and provides a progress heartbeat. Keep it on.",
```

- [ ] **Step 4: 编译 + locale parity + 构建**

Run: `npx vitest run src/locales/locales.test.ts && npm run build 2>&1 | tail -5`
Expected: parity PASS,`tsc -b && vite build` 成功

- [ ] **Step 5: 提交**

```bash
git add src/components/SettingsModal.tsx src/locales/zh.json src/locales/en.json
git commit -m "feat: streamChatCompletionsImage settings toggle"
```

---

## Task 9: 文档 + 版本号

**Files:**
- Modify: `CLAUDE.md`、`package.json`、`public/sw.js`

- [ ] **Step 1: 更新 CLAUDE.md 端点表**

`CLAUDE.md` 的「端点契约」表(找到 `| Images API | POST images/edits |` 行)下方加一行:

```
| Chat 图像 | `POST chat/completions` (stream) | Sakrylle 图像生成默认路径(文生图/参考图/蒙版),连续 SSE 防 Cloudflare 524 |
```

并在「Images API vs Responses API」段末尾加一段说明:

```
- **流式 chat/completions 图像路径**(v0.10.x):Sakrylle baseUrl + `streamChatCompletionsImage`(默认 true)时,文生图/参考图/蒙版统一走 `POST chat/completions` `stream:true`。实测上游对 `images/generations`/`images/edits` 即使传 `stream:true` 也返回整块 JSON(生成期间零字节 → Cloudflare ~100s 524 切断慢图);chat/completions 返回真 SSE(首字节 ~1.5s + `Progressing...` 进度心跳)。图片在终块 `delta.content` 的 Markdown `![image](URL)` 里。前端 `chatCompletionsImageApi.ts` 双计时器:整体 600s 不复位 + 空闲 60s 每 chunk 复位。空闲超时可重试、整体超时/用户取消不可重试。蒙版作为额外 image_url + 文字说明(实测语义保留,但仅 64² 色块验证过,真实复杂图边缘精度待回归)。
```

- [ ] **Step 2: bump 版本**

`package.json` 的 `"version"` 按当前值 +1 patch(如 `0.10.0` → `0.10.1`)。

`public/sw.js` 的 `CACHE_NAME` 同步改成相同版本号(否则旧 Service Worker 派发旧 chunk)。

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md package.json public/sw.js
git commit -m "docs: document chat/completions image path + bump version"
```

---

## 完成标准

- `npm run test` 全绿
- `npm run build` 成功
- 真 key 冒烟(手动,实现后):
  1. 文生图 → 流式出图,UI 有进度
  2. 参考图编辑 → 流式出图(不再干等 600s)
  3. 蒙版编辑 → 流式出图,语义正确
  4. n=4 多图 → 凑满 4 张,≤6 并发
  5. 故意断网/制造空闲 → 60s 快速失败 + 自动重试一次
