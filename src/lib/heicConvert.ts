// HEIC/HEIF support for input images.
//
// Chrome / Firefox cannot decode HEIC natively, so a HEIC file uploaded as an
// input image renders a broken <img> preview AND fails the canvas-based
// compress/re-encode step on send (new Image() can't decode it) — meaning the
// raw HEIC reaches the API, which rejects it. We fix the whole chain by
// decoding HEIC -> JPEG at ingestion time, before it is stored or previewed.
//
// The decoder (heic-to, bundles a current libheif-js with the wasm inlined) is
// ~3MB, so it is loaded lazily via dynamic import() ONLY when a HEIC file is
// actually encountered — the main bundle is unaffected for the common
// (non-HEIC) case. We use heic-to rather than heic2any because heic2any's older
// bundled libheif fails on modern iPhone HEIC ("ERR_LIBHEIF format not
// supported"), which heic-to decodes correctly.

const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
])

const HEIC_EXTENSION = /\.(heic|heif)$/i

/** Cheap sync hint from MIME type / filename. Misses HEIC files with empty type. */
function isHeicByHint(file: Blob): boolean {
  if (file.type && HEIC_MIME_TYPES.has(file.type.toLowerCase())) return true
  const name = (file as File).name
  if (name && HEIC_EXTENSION.test(name)) return true
  return false
}

// Magic-byte sniff for files whose type/name give no hint (some pickers drop
// the extension and report an empty type). HEIC is an ISO-BMFF container: bytes
// 4–8 are the 'ftyp' box tag, bytes 8–12 are the brand. Match known HEIC/HEIF
// brands so we don't misfire on regular MP4/MOV ftyp containers.
const HEIC_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1',
])

async function isHeicBySniff(file: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    if (head.length < 12) return false
    // 'ftyp' == 0x66 0x74 0x79 0x70 at offset 4.
    if (head[4] !== 0x66 || head[5] !== 0x74 || head[6] !== 0x79 || head[7] !== 0x70) return false
    const brand = String.fromCharCode(head[8], head[9], head[10], head[11]).toLowerCase()
    return HEIC_BRANDS.has(brand)
  } catch {
    return false
  }
}

/**
 * Sync best-effort check (MIME / extension only) for pre-filtering file lists,
 * where an async magic-byte sniff isn't practical. HEIC files reported with an
 * empty MIME type but a .heic/.heif name still pass here.
 */
export function isLikelyHeic(file: Blob): boolean {
  return isHeicByHint(file)
}

/** True if the file is HEIC/HEIF and must be transcoded before use. */
export async function isHeicFile(file: Blob): Promise<boolean> {
  if (isHeicByHint(file)) return true
  return isHeicBySniff(file)
}

/**
 * Decode a HEIC/HEIF blob to a JPEG blob. Lazily loads the heic-to decoder.
 * Throws if decoding fails (caller surfaces a friendly error and skips the file).
 */
export async function convertHeicToJpeg(file: Blob, quality = 0.92): Promise<Blob> {
  const { heicTo } = await import('heic-to')
  return heicTo({ blob: file, type: 'image/jpeg', quality })
}
