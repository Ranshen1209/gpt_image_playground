import { describe, it, expect, vi } from 'vitest'
import {
  compressImageForUpload,
  COMPRESS_MAX_DIMENSION,
  COMPRESS_TRIGGER_BYTES,
  COMPRESS_JPEG_QUALITY,
  type CompressImageDeps,
} from './canvasImage'

// ---------------------------------------------------------------------------
// jsdom/node has no real canvas/Image rendering, so compressImageForUpload
// exposes an injectable deps seam (spec §4). Tests assert the LOGIC branches
// (trigger conditions, scale math, mime/quality, min-size, failure fallback)
// rather than real pixels.
// ---------------------------------------------------------------------------

/** Fake canvas whose width/height are observable after the function sets them. */
function makeCanvas(): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
  } as unknown as HTMLCanvasElement
}

function makeDeps(opts: {
  dims: { width: number; height: number }
  canvas?: HTMLCanvasElement
  canvasToBlob?: ReturnType<typeof vi.fn>
  /** length of the data URL returned by blobToDataUrl (controls min() decision) */
  compressedLen?: number
  loadImageError?: Error
}): CompressImageDeps {
  const canvas = opts.canvas ?? makeCanvas()
  const canvasToBlob = opts.canvasToBlob ?? vi.fn().mockResolvedValue(new Blob(['x']))
  const compressedLen = opts.compressedLen ?? 8
  return {
    getImageDimensions: vi.fn().mockResolvedValue(opts.dims),
    loadImage: opts.loadImageError
      ? vi.fn().mockRejectedValue(opts.loadImageError)
      : vi.fn().mockResolvedValue({} as HTMLImageElement),
    canvasToBlob,
    blobToDataUrl: vi.fn().mockResolvedValue('d'.repeat(compressedLen)),
    createCanvas: () => canvas,
  } as unknown as CompressImageDeps
}

function smallDataUrl(byteLen = 100): string {
  return 'data:image/png;base64,' + 'A'.repeat(byteLen)
}

describe('compressImageForUpload — trigger short-circuit', () => {
  it('returns the original and never re-encodes a small in-bounds image', async () => {
    const canvasToBlob = vi.fn()
    const deps = makeDeps({ dims: { width: 800, height: 600 }, canvasToBlob })
    const original = smallDataUrl(100)

    const result = await compressImageForUpload(original, {}, deps)

    expect(result).toBe(original)
    expect(canvasToBlob).not.toHaveBeenCalled()
  })
})

describe('compressImageForUpload — oversize trigger + scale math', () => {
  it('downscales so the longest edge becomes 1536 (preserving aspect ratio)', async () => {
    const canvas = makeCanvas()
    const deps = makeDeps({ dims: { width: 3000, height: 1500 }, canvas, compressedLen: 8 })

    await compressImageForUpload(smallDataUrl(100), {}, deps)

    // scale = 1536/3000 = 0.512 -> 3000*0.512=1536, 1500*0.512=768
    expect(canvas.width).toBe(COMPRESS_MAX_DIMENSION)
    expect(canvas.height).toBe(768)
  })

  it('returns the compressed data URL when it is smaller than the original', async () => {
    const original = smallDataUrl(200)
    const deps = makeDeps({ dims: { width: 3000, height: 3000 }, compressedLen: 10 })

    const result = await compressImageForUpload(original, {}, deps)

    expect(result).toBe('d'.repeat(10))
    expect(result).not.toBe(original)
  })
})

describe('compressImageForUpload — byte-size trigger', () => {
  it('compresses an in-bounds image whose base64 length exceeds the byte trigger', async () => {
    const canvasToBlob = vi.fn().mockResolvedValue(new Blob(['x']))
    const deps = makeDeps({ dims: { width: 1000, height: 1000 }, canvasToBlob, compressedLen: 8 })
    const heavy = 'data:image/png;base64,' + 'A'.repeat(COMPRESS_TRIGGER_BYTES + 1)

    await compressImageForUpload(heavy, {}, deps)

    expect(canvasToBlob).toHaveBeenCalled()
  })
})

describe('compressImageForUpload — min(original, compressed)', () => {
  it('returns the original when re-encoding would produce a larger payload', async () => {
    const original = smallDataUrl(50) // length ~72
    const deps = makeDeps({ dims: { width: 3000, height: 3000 }, compressedLen: 10_000 })

    const result = await compressImageForUpload(original, {}, deps)

    expect(result).toBe(original)
  })
})

describe('compressImageForUpload — failure degradation', () => {
  it('falls back to the original data URL (no throw) when loadImage rejects', async () => {
    const original = smallDataUrl(100)
    const deps = makeDeps({ dims: { width: 3000, height: 3000 }, loadImageError: new Error('decode failed') })

    await expect(compressImageForUpload(original, {}, deps)).resolves.toBe(original)
  })
})

describe('compressImageForUpload — non-mask JPEG path', () => {
  it('re-encodes to image/jpeg at quality 0.85', async () => {
    const canvasToBlob = vi.fn().mockResolvedValue(new Blob(['j']))
    const deps = makeDeps({ dims: { width: 3000, height: 3000 }, canvasToBlob, compressedLen: 8 })

    await compressImageForUpload(smallDataUrl(100), {}, deps)

    expect(canvasToBlob).toHaveBeenCalledWith(expect.anything(), 'image/jpeg', COMPRESS_JPEG_QUALITY)
  })
})

describe('compressImageForUpload — mask PNG path', () => {
  it('re-encodes a mask to image/png with no quality argument', async () => {
    const canvasToBlob = vi.fn().mockResolvedValue(new Blob(['m']))
    const deps = makeDeps({ dims: { width: 3000, height: 3000 }, canvasToBlob, compressedLen: 8 })

    await compressImageForUpload(smallDataUrl(100), { isMask: true }, deps)

    expect(canvasToBlob).toHaveBeenCalledWith(expect.anything(), 'image/png', undefined)
  })

  it('ignores the byte-size trigger for masks; only dimensions trigger compression', async () => {
    const canvasToBlob = vi.fn()
    const deps = makeDeps({ dims: { width: 1000, height: 1000 }, canvasToBlob })
    const heavyMask = 'data:image/png;base64,' + 'A'.repeat(COMPRESS_TRIGGER_BYTES + 1)

    const result = await compressImageForUpload(heavyMask, { isMask: true }, deps)

    expect(result).toBe(heavyMask)
    expect(canvasToBlob).not.toHaveBeenCalled()
  })
})
