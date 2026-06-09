import { describe, it, expect, vi } from 'vitest'
import { parseChatCompletionImageStream, extractMarkdownImageUrl, buildChatMessageContent } from './chatCompletionsImageApi'

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
