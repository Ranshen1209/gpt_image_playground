import { describe, expect, it } from 'vitest'
import { isHeicFile, isLikelyHeic } from './heicConvert'

// Build a minimal ISO-BMFF header: 4 size bytes, 'ftyp', then a 4-char brand.
function ftypBlob(brand: string, type = ''): Blob {
  const bytes = new Uint8Array(12)
  bytes.set([0, 0, 0, 12], 0)
  bytes.set([0x66, 0x74, 0x79, 0x70], 4) // 'ftyp'
  for (let i = 0; i < 4; i++) bytes[8 + i] = brand.charCodeAt(i)
  return new Blob([bytes], { type })
}

describe('isLikelyHeic (sync MIME/extension hint)', () => {
  it('matches HEIC MIME types', () => {
    expect(isLikelyHeic(new File([], 'x', { type: 'image/heic' }))).toBe(true)
    expect(isLikelyHeic(new File([], 'x', { type: 'image/heif' }))).toBe(true)
  })

  it('matches .heic/.heif filenames even with empty type', () => {
    expect(isLikelyHeic(new File([], 'IMG_0963.HEIC'))).toBe(true)
    expect(isLikelyHeic(new File([], 'photo.heif', { type: '' }))).toBe(true)
  })

  it('does not match regular images', () => {
    expect(isLikelyHeic(new File([], 'a.png', { type: 'image/png' }))).toBe(false)
    expect(isLikelyHeic(new File([], 'a.jpg', { type: 'image/jpeg' }))).toBe(false)
  })
})

describe('isHeicFile (hint + magic-byte sniff)', () => {
  it('detects HEIC brands by magic bytes when type/name give no hint', async () => {
    await expect(isHeicFile(ftypBlob('heic'))).resolves.toBe(true)
    await expect(isHeicFile(ftypBlob('mif1'))).resolves.toBe(true)
  })

  it('does not misfire on non-HEIC ftyp containers (e.g. MP4)', async () => {
    await expect(isHeicFile(ftypBlob('isom'))).resolves.toBe(false)
    await expect(isHeicFile(ftypBlob('mp42'))).resolves.toBe(false)
  })

  it('returns true via hint without needing the sniff', async () => {
    await expect(isHeicFile(new File([], 'x.heic'))).resolves.toBe(true)
  })

  it('returns false for short/empty blobs', async () => {
    await expect(isHeicFile(new Blob([new Uint8Array(4)]))).resolves.toBe(false)
  })
})
