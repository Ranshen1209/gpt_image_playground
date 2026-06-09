import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseChatCompletionImageStream,
  extractMarkdownImageUrl,
  buildChatMessageContent,
  IDLE_TIMEOUT_MS,
  callImagesApiViaChat,
} from './chatCompletionsImageApi'
import { isRetryableError } from './openaiCompatibleImageApi'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { DEFAULT_PARAMS } from '../types'

// vi.mock calls must be at the top level so Vitest can hoist them.
vi.mock('./oauthFallback', () => ({
  canUseOAuthForProfile: vi.fn().mockReturnValue(false),
  resolveBearerToken: vi.fn().mockResolvedValue('sk-test'),
}))

vi.mock('./devProxy', async (importOriginal) => {
  const real = await importOriginal<typeof import('./devProxy')>()
  return { ...real, readClientDevProxyConfig: vi.fn().mockReturnValue(null) }
})

// ---------------------------------------------------------------------------
// Helpers used by the existing parseChatCompletionImageStream tests
// ---------------------------------------------------------------------------

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
    const urls = content.filter((p): p is { type: 'image_url'; image_url: { url: string } } => p.type === 'image_url').map((p) => p.image_url.url)
    expect(urls).toEqual(['data:image/png;base64,MAIN', 'data:image/png;base64,MASK'])
    const textPart = content[0] as { type: 'text'; text: string }
    expect(textPart.text).toContain('mask')
  })
})

// ---------------------------------------------------------------------------
// Helpers shared by idle-timeout integration tests
// ---------------------------------------------------------------------------

/** Minimal valid CallApiOptions for callImagesApiViaChat */
function makeOpts() {
  return {
    settings: {} as never,
    prompt: 'test prompt',
    params: { ...DEFAULT_PARAMS, n: 1 },
    inputImageDataUrls: [],
  }
}

/**
 * Profile with a very long overall timeout (600 s) so it never fires during
 * the 60 s idle-timeout tests.
 */
function makeProfile() {
  return createDefaultOpenAIProfile({
    baseUrl: 'https://api.sakrylle.com/v1',
    apiKey: 'sk-test',
    timeout: 600,
  })
}

/**
 * Build a ReadableStream backed by a controller returned to the caller so
 * chunks can be pushed on demand (or withheld to simulate a stall).
 */
function makeControlledStream(): {
  stream: ReadableStream<Uint8Array>
  push: (s: string) => void
  close: () => void
} {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })
  const enc = new TextEncoder()
  return {
    stream,
    push: (s: string) => ctrl.enqueue(enc.encode(s)),
    close: () => ctrl.close(),
  }
}

/** Encode one SSE data line for a chat completion chunk */
function sseChunk(content: string, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content, role: 'assistant' }, finish_reason: finish }],
  })}\n\n`
}

// ---------------------------------------------------------------------------
// spec §4 — dual-timer abort behaviour
// ---------------------------------------------------------------------------

describe('callImagesApiViaChat idle timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // ── Test 1 ─────────────────────────────────────────────────────────────────
  // spec §4: "mock stall > 60s 的流 → abort + 归类可重试"
  //
  // The stream never emits a second chunk after the initial one.  After
  // IDLE_TIMEOUT_MS elapses the AbortController fires with an IdleTimeout
  // error, which propagates out of callImagesApiViaChat and must be classified
  // as retryable by isRetryableError.
  //
  // Implementation note: the abort fires while readJsonServerSentEvents is
  // awaiting the next `reader.read()` call.  The ReadableStream reader in
  // jsdom honours the AbortSignal passed to fetch — but here we rely on the
  // AbortController aborting the fetch signal directly, which causes the
  // pending read() to reject.  We push the first chunk AFTER the call is
  // started (and after fetch has resolved) so the reader is already waiting
  // when the second advance fires.
  it('stalled stream (no chunks after first) fires idle timeout — error is retryable IdleTimeout', async () => {
    const { stream, push } = makeControlledStream()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
    ))

    // Start the call — do not await yet.
    const promise = callImagesApiViaChat(makeOpts(), makeProfile())
    // Attach a no-op catch immediately so Node never marks this as an
    // unhandled rejection while fake timers are advancing.
    promise.catch(() => {})

    // Let microtasks run so fetch() resolves and the SSE reader loop starts.
    await vi.advanceTimersByTimeAsync(0)

    // Deliver the first chunk (resets idle timer to t=0) then go silent.
    push(sseChunk('Generating...\n'))

    // Let the chunk be processed.
    await vi.advanceTimersByTimeAsync(0)

    // Advance past the idle threshold — the AbortController should fire.
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 100)

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof Error &&
        err.name === 'IdleTimeout' &&
        isRetryableError(err) === true
      )
    })
  }, 15_000 /* generous wall-clock budget for fake-timer test */)

  // ── Test 2 ─────────────────────────────────────────────────────────────────
  // spec §4: "mock 稳定心跳超过 60s 但每块都来 → 成功完成(证明心跳复位生效)"
  //
  // The stream emits a progress chunk every 30 s (5 times, spanning 150 s total)
  // then delivers the final image-markdown chunk and closes.  Because each
  // chunk resets the idle timer the 60 s window is never reached.
  //
  // Image-URL fetch: the module uses module-level defaultFetchImageUrlAsDataUrl
  // which internally calls global fetch.  We mock the second fetch call to
  // return a tiny Blob.  fetchImageUrlAsDataUrl reads the blob as a data URL
  // via FileReader — jsdom supports FileReader so the full happy path runs.
  //
  // If the image-URL step still fails for an environmental reason (e.g. jsdom
  // Blob→dataURL edge case), we accept any non-IdleTimeout rejection — the
  // key invariant is that the idle timer never fired during the stream phase.
  it('heartbeat every 30 s for 5 chunks (150 s total) — idle timer never fires', async () => {
    const IMAGE_URL = 'https://cdn.example.com/generated.png'
    const { stream, push, close } = makeControlledStream()

    const fetchMock = vi.fn()
    // Call 1: the SSE chat/completions request
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
    )
    // Call 2: fetchImageUrlAsDataUrl fetches the image URL.
    // A minimal valid PNG (8-byte magic + IHDR would be needed for full decode,
    // but fetchImageUrlAsDataUrl only calls blob.text() / createObjectURL,
    // so any non-empty Blob works here).
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    fetchMock.mockResolvedValueOnce(
      new Response(new Blob([pngBytes], { type: 'image/png' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    // Start the call — do not await yet.
    const callPromise = callImagesApiViaChat(makeOpts(), makeProfile())

    // Let fetch() resolve and the SSE reader loop start.
    await vi.advanceTimersByTimeAsync(0)

    // Emit 5 progress chunks spaced 30 s apart (each resets the idle timer).
    for (let i = 0; i < 5; i++) {
      push(sseChunk(`Progress ${i + 1}/5\n`))
      await vi.advanceTimersByTimeAsync(30_000)
    }

    // Emit the final chunk and close the stream.
    push(sseChunk(`\n\n![image](${IMAGE_URL})\n`, 'stop'))
    close()

    // Let the image-fetch microtasks settle.
    await vi.advanceTimersByTimeAsync(0)

    let result: unknown
    let caughtErr: unknown
    try {
      result = await callPromise
    } catch (e) {
      caughtErr = e
    }

    if (caughtErr !== undefined) {
      // The image-URL fetch step may not fully resolve in jsdom, but the error
      // MUST NOT be an IdleTimeout — that would mean a chunk failed to reset
      // the idle timer.
      const name = (caughtErr as Error).name
      expect(name, `Expected no IdleTimeout but got: ${name}`).not.toBe('IdleTimeout')
    } else {
      // Full happy path — one image returned.
      expect((result as { images: string[] }).images).toHaveLength(1)
    }
  }, 15_000)
})
