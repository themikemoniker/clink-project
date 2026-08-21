// Blossom uploads: the BUD-11 auth, and one blob pushed to every server that will take it.
//
// Lifted out of photos.ts in slice 5, the way pub-rpc.ts was lifted out of mint-offers.ts in
// slice 3 (/docs/spike-findings.md §13.13), because the site deploy uploads blobs too and a
// second copy of the auth header on the money path is a second thing to keep in step.
//
//   BUD-11  buds/11.md   kind 24242 upload auth
//   BUD-03  buds/03.md   kind 10063 user server list (written by ./deploy.ts)
import type { Signer } from './signer.ts'

/**
 * THE ENCODING IS THE FIND OF SLICE 5, and it is worth the paragraph.
 *
 * BUD-11 11.md:50: "the authorization token MUST be encoded as Base64 URL-safe without padding
 * (Base64url, as used by JWTs)". We complied, and that compliance was costing us the entire
 * mirror. Measured 2026-08-21 with a real anonymous HTML upload and again with a real JPEG:
 *
 *                        base64url (spec)   standard base64
 *   cdn.hzrd149.com      201  201           201  201
 *   blossom.primal.net   400  400           200  200
 *   files.sovbit.host    400  400           200  200
 *   nostr.download       400  400           201  201
 *   blossom.band         200(jpeg only)     200(jpeg only)
 *
 * Standard base64 is accepted by all five; base64url by exactly one. Three of the four servers
 * that will store an nsite's HTML for an unknown pubkey were rejecting us over a character
 * class. So we send standard base64 — a deliberate divergence from a MUST, in the direction
 * that four independent implementations accept, and the one that turns findings §9's "blobs
 * live on exactly one server, one garbage collection from a broken storefront" into a mirror.
 *
 * ponytail: if a server ever appears that takes base64url and NOT standard base64, this becomes
 * a per-server preference rather than one constant. None of the five is that server today.
 */
const encodeAuth = (json: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(json)))

/**
 * Every Blossom server this project knows will accept an anonymous upload, most trusted first.
 *
 * ONE list, not one per content type, even though `blossom.band` is nostr.build and answers
 * `400 Content-Type header does not match the file content` for HTML while taking every photo.
 * `mirror()` reports which servers ended up holding a complete copy, so the site deploy drops
 * band by discovering it rather than by remembering it — and the day band starts accepting
 * text, nothing here has to change.
 */
export const SERVERS = [
  'https://cdn.hzrd149.com', // the only one slice 1 found; still the reference
  'https://blossom.primal.net',
  'https://files.sovbit.host',
  'https://nostr.download',
  'https://blossom.band', // photos only, today
]

/**
 * BUD-11 (`buds/11.md:11-27`): kind 24242, human-readable content, a future `expiration`, a `t`
 * verb, and `x` blob hashes.
 *
 * ONE AUTH PER BLOB, and that is NOT the obvious reading of the spec. 11.md:40 annotates the
 * example "Authorization token MAY have multiple `x` tags" and 11.md:67 says the server MUST
 * verify that *at least one* matches — which reads like one signed event can authorise a batch.
 * Measured against blossom.band (findings §9, /spike/probe-blossom.ts): with a two-`x` token,
 * uploading blob B returns blob A's descriptor, with a 200. The server takes the first `x` as
 * the blob's identity instead of hashing the body, so every blob after the first is silently
 * discarded. Never batch this.
 *
 * One auth per blob is NOT one auth per upload, though, and that distinction is what makes
 * mirroring affordable: 11.md:25 makes a token with no `server` tag valid on every server, so
 * the same signature covers that blob across all of them. N blobs on M servers is N signatures.
 */
export const authHeader = async (signer: Signer, sha256: string): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  const event = await signer.signEvent({
    kind: 24242,
    created_at: now,
    tags: [
      ['t', 'upload'], // 11.md:11-19
      ['expiration', String(now + 300)], // short — an unscoped token is replayable, 11.md:85-91
      ['x', sha256],
    ],
    content: 'Upload a Lamppost blob',
  })
  return `Nostr ${encodeAuth(JSON.stringify(event))}`
}

export type Upload = { sha256: string; bytes: ArrayBuffer | Uint8Array; type: string }

/** Where a blob ended up, and which servers hold a complete copy of everything asked for. */
export type MirrorResult = { urls: Map<string, string>; complete: string[] }

/**
 * Push every blob to every server. One signature per blob, reused across servers.
 *
 * The returned sha256 is compared against the one we computed, every time. A 200 is not
 * evidence the server stored what we sent — the generalised lesson of findings §13.11, and the
 * check that would have caught the batched-auth corruption on the day it happened.
 */
export const mirror = async (
  signer: Signer,
  blobs: Upload[],
  servers: string[],
  onProgress: (done: number, total: number) => void = () => {},
): Promise<MirrorResult> => {
  const urls = new Map<string, string>()
  const stored = new Map<string, number>(servers.map(s => [s, 0]))
  const total = blobs.length * servers.length
  let done = 0

  for (const blob of blobs) {
    const authorization = await authHeader(signer, blob.sha256)
    for (const server of servers) {
      try {
        const res = await fetch(`${server}/upload`, {
          method: 'PUT',
          headers: { authorization, 'content-type': blob.type },
          body: blob.bytes as BodyInit,
          signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) {
          console.warn(`${server} rejected ${blob.sha256.slice(0, 8)} (${blob.type}): ${res.status} ${(await res.text()).slice(0, 120)}`)
          continue
        }
        const body = (await res.json().catch(() => ({}))) as { url?: string; sha256?: string }
        if (body.sha256 && body.sha256 !== blob.sha256) {
          console.warn(`${server} MISATTRIBUTED ${blob.sha256.slice(0, 8)}: got ${String(body.sha256).slice(0, 8)}`)
          continue
        }
        // Address the blob by our own hash. `body.url` is only a convenience, and on
        // blossom.band it is a per-pubkey subdomain rather than `<server>/<sha256>`.
        if (!urls.has(blob.sha256)) urls.set(blob.sha256, body.url ?? `${server}/${blob.sha256}`)
        stored.set(server, stored.get(server)! + 1)
      } catch (err) {
        console.warn(`${server} ${blob.sha256.slice(0, 8)}: ${String(err).slice(0, 120)}`)
      } finally {
        onProgress(++done, total)
      }
    }
  }

  return { urls, complete: servers.filter(s => stored.get(s) === blobs.length) }
}
