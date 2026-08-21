// The other half of the image pipeline. Slice 1 shipped the render half — srcset from NIP-58
// `thumb` tags, aspect-ratio boxes, lazy below the fold — and said the generator half "cannot
// exist until something uploads, so it lands in slice 4" (/docs/spec.md §10). This is it.
//
// design.md §2.1: "A 4MB phone photo from a driveway will destroy load time." Resize on the
// client, one Blossom blob per width, and never upload the original.
//
// Nothing here holds a key: the kind 24242 auth is signed through the Signer like everything
// else.
import { mirror, SERVERS } from './blossom.ts'
import type { Signer } from './signer.ts'
import type { Blob as PhotoBlob } from './listing.ts'

// The same three widths /spike/seed-listings.ts faked by fetching pre-sized images, so the
// storefront's srcset keeps working unchanged. 1200 is the item detail view, 480 the index card
// on a 2x phone, 160 the flyer thumb.
export const WIDTHS = [1200, 480, 160]

// Slice 4 shipped this as `['https://blossom.band']` and noted that "the moment a second server
// that takes anonymous uploads exists it goes in this array and the `fallback` fields in the
// item's `imeta` tag start carrying it for free". Slice 5 found four, by fixing the auth header
// encoding rather than by finding new servers — see ./blossom.ts. The list lives there now,
// shared with the site deploy, and `imeta fallback` finally carries something.
export { SERVERS as BLOSSOM } from './blossom.ts'

// A phone photo is a few MB; anything much past that is not a yard sale photo.
const MAX_SOURCE_BYTES = 25 * 1024 * 1024
const JPEG_QUALITY = 0.82

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

/**
 * Which widths to actually emit for a source this wide.
 *
 * Never upscale: a 300px photo asked for at 1200 would be a bigger blob carrying no more detail,
 * and the storefront's srcset would then advertise a resolution that does not exist.
 *
 * Clamping makes widths collide, and the collision is the subtle part. An 800px source clamps
 * 1200 to 800, but 480 and 160 are still real, distinct renditions and must survive — dropping
 * them would leave the index loading a full-size blob. Only an exact duplicate is dropped, so a
 * 400px source emits 400 and 160 rather than 400 twice under two `thumb` tags pointing at one URL.
 */
export const renditionWidths = (sourceWidth: number): number[] => [
  ...new Set(WIDTHS.map(w => Math.min(w, sourceWidth))),
]

// The resized bytes, kept beside their descriptor so the public type stays a plain record of
// what the listing tag needs. Weak, so a discarded draft's photos are collectable.
const payloads = new WeakMap<PhotoBlob, ArrayBuffer>()

/**
 * Decode once, then draw at each width. `createImageBitmap` respects EXIF orientation with
 * `imageOrientation: 'from-image'` — without it, a photo taken in portrait uploads sideways and
 * every downstream aspect-ratio box is wrong.
 */
export const resize = async (file: File): Promise<PhotoBlob[]> => {
  if (file.size > MAX_SOURCE_BYTES) throw new Error(`${file.name} is ${(file.size / 1e6).toFixed(1)} MB — too large.`)
  const source = await createImageBitmap(file, { imageOrientation: 'from-image' })

  const out: PhotoBlob[] = []
  for (const w of renditionWidths(source.width)) {
    const h = Math.round((source.height / source.width) * w)
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser will not give us a 2d canvas, so photos cannot be resized.')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, 0, 0, w, h)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
    const bytes = await blob.arrayBuffer()
    out.push({
      url: '', // filled in by upload()
      w,
      h,
      type: 'image/jpeg',
      sha256: hex(await crypto.subtle.digest('SHA-256', bytes)),
    })
    // Keep the bytes beside the descriptor for the upload step without widening the public type.
    payloads.set(out[out.length - 1]!, bytes)
  }
  source.close()
  return out
}


export type UploadResult = { blobs: PhotoBlob[]; servers: string[] }

/**
 * Upload every rendition to every server that will take it. Returns only the blobs at least one
 * server actually holds, and only the servers that hold all of them — which is what the item's
 * `imeta fallback` fields are built from (listing.ts `imetaTag`).
 *
 * The auth, the per-blob signature rule and the returned-hash check all live in ./blossom.ts
 * now, shared with the site deploy.
 */
export const upload = async (
  signer: Signer,
  blobs: PhotoBlob[],
  onProgress: (done: number, total: number) => void,
): Promise<UploadResult> => {
  const uploads = blobs.flatMap(b => {
    const bytes = payloads.get(b)
    return bytes ? [{ sha256: b.sha256, bytes, type: b.type }] : []
  })
  const { urls, complete } = await mirror(signer, uploads, SERVERS, onProgress)
  for (const blob of blobs) blob.url ||= urls.get(blob.sha256) ?? ''
  return { blobs: blobs.filter(b => b.url), servers: complete }
}
