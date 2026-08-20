// Does a BUD-11 multi-`x` auth actually attribute each upload to its own blob?
// 11.md:40 "Authorization token MAY have multiple `x` tags"
// 11.md:67 "the server MUST verify that at least one `x` tag matches the blob hash implied by the endpoint"
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'

const sk = generateSecretKey()
const SERVER = process.argv[2] ?? 'https://blossom.band'
const files = ['seed-photos/couch-1200.jpg', 'seed-photos/bike-1200.jpg']
const blobs = files.map(f => {
  const bytes = readFileSync(f)
  return { f, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
})
for (const b of blobs) console.log(`local ${b.f.padEnd(30)} ${b.sha256.slice(0, 16)}`)

const auth = (xs: string[]) => {
  const ev = finalizeEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', 'upload'], ['expiration', String(Math.floor(Date.now() / 1000) + 300)], ...xs.map(x => ['x', x])],
    content: 'probe',
  }, sk)
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64url')}`
}

const put = async (bytes: Uint8Array, header: string) => {
  const res = await fetch(`${SERVER}/upload`, {
    method: 'PUT',
    headers: { authorization: header, 'content-type': 'image/jpeg' },
    body: bytes,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  return { status: res.status, body: text.slice(0, 260) }
}

console.log(`\n=== A. ONE auth carrying BOTH x tags (the batching claim) ===`)
const batched = auth(blobs.map(b => b.sha256))
for (const b of blobs) console.log(b.f, JSON.stringify(await put(b.bytes, batched)))

console.log(`\n=== B. one auth per blob, each carrying only its own x ===`)
for (const b of blobs) console.log(b.f, JSON.stringify(await put(b.bytes, auth([b.sha256]))))
