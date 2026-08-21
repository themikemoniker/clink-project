// The other half of the image pipeline. Slice 1 shipped the render half — srcset from NIP-58
// `thumb` tags, aspect-ratio boxes, lazy below the fold — and said the generator half "cannot
// exist until something uploads, so it lands in slice 4" (/docs/spec.md §10). This is it.
//
// design.md §2.1: "A 4MB phone photo from a driveway will destroy load time." Resize on the
// client, one Blossom blob per width, and never upload the original.
//
// Nothing here holds a key: the kind 24242 auth is signed through the Signer like everything
// else.
import type { Signer } from './signer.ts'
import type { Blob as PhotoBlob } from './listing.ts'

// The same three widths /spike/seed-listings.ts faked by fetching pre-sized images, so the
// storefront's srcset keeps working unchanged. 1200 is the item detail view, 480 the index card
// on a 2x phone, 160 the flyer thumb.
export const WIDTHS = [1200, 480, 160]

// blossom.band only. `cdn.satellite.earth` came out of the default on 2026-08-21 having never
// accepted a single blob (findings §9). Blobs therefore live on exactly ONE server, which is
// one garbage collection from a broken storefront — the moment a second server that takes
// anonymous uploads exists it goes in this array and the `fallback` fields in the item's
// `imeta` tag start carrying it for free (see listing.ts `imetaTag`).
export const BLOSSOM = ['https://blossom.band']

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


/**
 * BUD-11 (`buds/11.md:11-27`): kind 24242, human-readable content, a future `expiration`, a `t`
 * verb, and `x` blob hashes.
 *
 * ONE AUTH PER BLOB, and that is NOT the obvious reading of the spec. 11.md:40 annotates the
 * example "Authorization token MAY have multiple `x` tags" and 11.md:67 says the server MUST
 * verify that *at least one* matches — which reads like one signed event can authorise a batch.
 * Measured against blossom.band (findings §9, /spike/probe-blossom.ts): with a two-`x` token,
 * uploading blob B returns blob A's descriptor, with a 200. The server takes the first `x` as
 * the blob's identity instead of hashing the body, so every photo after the first is silently
 * discarded and every listing ends up pointing at the same image.
 *
 * It costs N signatures instead of 1. Both signers key a remembered grant on (app, type, kind)
 * and these are all kind 24242, so N auths are still ONE approval between them (findings §8).
 * Never batch this.
 */
const authFor = async (signer: Signer, sha256: string, verb: 'upload'): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  const event = await signer.signEvent({
    kind: 24242,
    created_at: now,
    tags: [
      ['t', verb], // 11.md:11-19
      ['expiration', String(now + 300)], // short — an unscoped token is replayable, 11.md:85-91
      ['x', sha256],
    ],
    content: 'Upload yard sale photo',
  })
  // 11.md:50 — `Authorization: Nostr <base64url-no-padding of the event JSON>`.
  const json = new TextEncoder().encode(JSON.stringify(event))
  const b64 = btoa(String.fromCharCode(...json))
  return `Nostr ${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

export type UploadResult = { blobs: PhotoBlob[]; servers: string[] }

/**
 * Upload every rendition to every server. Returns only the blobs at least one server actually
 * holds, and only the servers that hold all of them.
 *
 * The returned sha256 is compared against the one we computed, every time. A 200 is not
 * evidence the server stored what we sent — that is the generalised lesson of findings §13.11,
 * and it is the check that would have caught the batched-auth corruption on the day.
 */
export const upload = async (
  signer: Signer,
  blobs: PhotoBlob[],
  onProgress: (done: number, total: number) => void,
): Promise<UploadResult> => {
  const total = blobs.length * BLOSSOM.length
  let done = 0
  const complete: string[] = []

  for (const server of BLOSSOM) {
    let stored = 0
    for (const blob of blobs) {
      const bytes = payloads.get(blob)
      if (!bytes) continue
      try {
        const res = await fetch(`${server}/upload`, {
          method: 'PUT',
          headers: { authorization: await authFor(signer, blob.sha256, 'upload'), 'content-type': blob.type },
          body: bytes,
          signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) {
          console.warn(`${server} rejected ${blob.w}px: ${res.status}`)
          continue
        }
        const body = (await res.json().catch(() => ({}))) as { url?: string; sha256?: string }
        if (body.sha256 && body.sha256 !== blob.sha256) {
          console.warn(`${server} MISATTRIBUTED ${blob.w}px: asked ${blob.sha256.slice(0, 12)}, got ${String(body.sha256).slice(0, 12)}`)
          continue
        }
        // Address it by our own hash, not by the server's echo of a URL.
        blob.url ||= body.url ?? `${server}/${blob.sha256}`
        stored++
      } catch (err) {
        console.warn(`${server} ${blob.w}px: ${String(err).slice(0, 120)}`)
      } finally {
        onProgress(++done, total)
      }
    }
    if (stored === blobs.length) complete.push(server)
  }

  return { blobs: blobs.filter(b => b.url), servers: complete }
}
