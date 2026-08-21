// Spike: seed a fake yard sale so slice 1's storefront has something real to render.
//
// KEY HANDLING NOTICE. /CLAUDE.md rule 2 says no private key touches this codebase outside a
// Signer. This script is the one approved exception, agreed 2026-08-20, and it is deliberately
// narrow: a throwaway identity in /spike/.dev-key (gitignored, chmod 600), never funded, never
// the seller's, used only to publish public test listings. DELETE THIS FILE AND THE KEY when
// slice 4 lands a real Signer — at that point the builder authors listings and this is dead code.
//
// What it does, in the order slice 4/5 will eventually do it for real:
//   1. photos -> N widths -> Blossom, one signed kind 24242 auth per blob (BUD-11 11.md:11-27)
//   2. one kind 30402 per item   (NIP-99 99.md:32-43 + GammaMarkets spec.md:104-190)
//   3. one kind 30405 collection (GammaMarkets spec.md:213-236) = the sale, and the masthead
//
// Slice 2 added the `clink_offer` tag. Its values come from /spike/.offers.json, which
// mint-offers.ts writes; run that first or the listings publish without a Buy button, which is
// exactly the state slice 1 shipped in.
//
// Usage: node seed-listings.ts [--relays wss://a,wss://b] [--blossom https://x,https://y]
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { ITEMS, SALE, SALE_RELAYS, listingD, offerPriceSats } from './fixture.ts'
import { atStock, unitsOf } from './ladder.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = join(HERE, '.dev-key')
const OFFERS_FILE = join(HERE, '.offers.json')
const LADDER_FILE = join(HERE, '.ladder.json')
const PHOTO_DIR = join(HERE, 'seed-photos')

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const RELAYS = arg('relays', SALE_RELAYS.join(',')).split(',')
// blossom.band only. `cdn.satellite.earth` was in this default until 2026-08-21 and never once
// accepted a blob: it returns 401 for HTML (findings §7) and simply times out on images, so every
// seed paid 21 x 20s of AbortSignal.timeout for nothing — ~7 minutes of the run. Removing it is
// not a decision to stop mirroring; it is deleting a server that was never a mirror. The flag is
// still here, and the moment a second server that accepts anonymous uploads is found it belongs
// in this string, because blobs on one server are one garbage collection from a broken
// storefront (/docs/spec.md §14, findings §9).
const BLOSSOM = arg('blossom', 'https://blossom.band').split(',')

// --- the throwaway identity -------------------------------------------------------------
if (!existsSync(KEY_FILE)) {
  writeFileSync(KEY_FILE, bytesToHex(generateSecretKey()), { mode: 0o600 })
  console.log(`# generated a new throwaway dev key at ${KEY_FILE}`)
}
chmodSync(KEY_FILE, 0o600)
const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const pk = getPublicKey(sk)
console.log(`# seeding as ${nip19.npubEncode(pk)}\n#          hex ${pk}`)

// --- the sale ---------------------------------------------------------------------------
// SALE and ITEMS live in ./fixture.ts, shared with mint-offers.ts so an item's listed price and
// its minted offer cannot drift apart.
type MintedOffer = { noffer: string; price_sats: number; payer_data: string[] }
const OFFERS: Record<string, MintedOffer> = existsSync(OFFERS_FILE)
  ? JSON.parse(readFileSync(OFFERS_FILE, 'utf8'))
  : {}
console.log(existsSync(OFFERS_FILE)
  ? `# ${Object.keys(OFFERS).length} minted offer(s) loaded from ${OFFERS_FILE}`
  : `# no ${OFFERS_FILE} — publishing without clink_offer tags; run mint-offers.ts first`)

// Refuse to publish a listing whose advertised price disagrees with the offer it points at.
// The storefront re-checks this off the noffer's own TLVs and would simply hide the Buy button,
// which is a silent failure; failing here is the loud one.
for (const item of ITEMS) {
  const minted = OFFERS[listingD(item)]
  if (minted && minted.price_sats !== offerPriceSats(item)) {
    throw new Error(`${listingD(item)}: offer is ${minted.price_sats} sats, listing says ${item.price.join(' ')} — re-run mint-offers.ts`)
  }
}

// --- 1. photos: fetch at three widths, hash, upload with ONE auth ------------------------
// Widths mirror what slice 4's canvas resize will emit. Fetching them pre-sized keeps this
// fixture free of an image dependency; it is NOT the real pipeline.
const WIDTHS = [{ w: 1200, h: 900 }, { w: 480, h: 360 }, { w: 160, h: 120 }]
mkdirSync(PHOTO_DIR, { recursive: true })

type Blob = { item: string; w: number; h: number; sha256: string; bytes: Uint8Array; url?: string }
const blobs: Blob[] = []
for (const item of ITEMS.filter(i => i.photo)) {
  for (const { w, h } of WIDTHS) {
    const file = join(PHOTO_DIR, `${item.d}-${w}.jpg`)
    if (!existsSync(file)) {
      const res = await fetch(`https://picsum.photos/seed/${item.d}/${w}/${h}`, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`photo fetch ${item.d}@${w}: ${res.status}`)
      writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    }
    const bytes = readFileSync(file)
    blobs.push({ item: item.d, w, h, bytes, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
}
console.log(`# ${blobs.length} blobs across ${new Set(blobs.map(b => b.item)).size} items`)

// BUD-11 11.md:11-27 — kind 24242, human-readable content, future `expiration`, `t` verb, and
// `x` blob hashes. Short expiry per 11.md:85-91; no `server` tag, which 11.md:25 makes valid on
// every server so the same token also covers mirroring.
//
// ONE AUTH PER BLOB, and that is not the obvious reading of the spec. 11.md:40 says a token
// "MAY have multiple `x` tags" and 11.md:67 says the server "MUST verify that at least one `x`
// tag matches the blob hash implied by the endpoint", which reads like one signed event can
// authorise a whole batch. Measured against blossom.band on 2026-08-20 (see /spike/probe-blossom.ts)
// it does not: with a two-`x` token, PUT /upload of blob B returns blob A's descriptor — A's
// sha256 and A's size — with a 200. The server takes the first `x` as the blob's identity
// instead of hashing the body. Every photo after the first is silently discarded and every
// listing ends up pointing at the same image. It succeeds, which is what makes it dangerous.
//
// Cost: N signatures instead of 1. See /docs/spike-findings.md §9 — this removes one of the two
// levers the signature-prompt budget in /docs/spec.md §5 was counting on.
const authFor = (sha256: string) => {
  const ev = finalizeEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'upload'],
      ['expiration', String(Math.floor(Date.now() / 1000) + 300)],
      ['x', sha256],
    ],
    content: 'Upload yard sale photo',
  }, sk)
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64url')}`
}

for (const server of BLOSSOM) {
  const codes: number[] = []
  for (const b of blobs) {
    let res: Response
    try {
      res = await fetch(`${server}/upload`, {
        method: 'PUT',
        headers: { authorization: authFor(b.sha256), 'content-type': 'image/jpeg' },
        body: b.bytes,
        signal: AbortSignal.timeout(20_000),
      })
    } catch (err) {
      codes.push(0)
      if (codes.length === 1) console.log(`#   ${server} unreachable: ${String(err).slice(0, 120)}`)
      continue
    }
    codes.push(res.status)
    if (res.ok) {
      const body = await res.json().catch(() => ({}))
      // Trust our own hash, never the server's echo of it — that echo is exactly what was
      // wrong under a batched token, and a mismatch means the blob we asked for is not the
      // blob that got stored.
      if (body.sha256 && body.sha256 !== b.sha256) {
        console.log(`#   ${server} MISATTRIBUTED ${b.item}@${b.w}: asked ${b.sha256.slice(0, 12)}, got ${String(body.sha256).slice(0, 12)}`)
        continue
      }
      b.url ??= body.url ?? `${server}/${b.sha256}`
    } else if (codes.length === 1) {
      console.log(`#   ${server} rejected: ${res.status} ${(await res.text()).slice(0, 160)}`)
    }
  }
  console.log(`# ${server}: ${codes.length} uploads -> ${[...new Set(codes)].join(',')}`)
}
const hosted = blobs.filter(b => b.url)
if (hosted.length === 0) console.log('# WARNING: no blob uploaded; listings will have no images')

// --- 2 + 3. the events -------------------------------------------------------------------
const now = Math.floor(Date.now() / 1000)
const imagesFor = (d: string) => {
  const mine = blobs.filter(b => b.item === d && b.url).sort((a, b) => b.w - a.w)
  const [full, ...thumbs] = mine
  return full
    // NIP-58 58.md:31 — ["image", url, "WxH"]. GammaMarkets spec.md:135 adds an optional
    // 4th sort-order element; one image per item here, so it is omitted.
    ? [['image', full.url!, `${full.w}x${full.h}`],
       // NIP-58 58.md:34 — one or more `thumb` tags, each optionally dimensioned. This is the
       // standard multi-width source. No custom tag needed for srcset.
       ...thumbs.map(t => ['thumb', t.url!, `${t.w}x${t.h}`])]
    : []
}

const tagsFor = (item: (typeof ITEMS)[number]): string[][] => [
  ['d', listingD(item)],
  ['title', item.title],
  // NIP-99 99.md:38 ["price","<number>","<currency>","<frequency>"?]. We never write frequency.
  ['price', item.price[0], item.price[1]],
  ['published_at', String(now)],
  // GammaMarkets spec.md:119-121 — ["type","simple","physical"]; default is digital, and a
  // yard sale is emphatically not digital.
  ['type', 'simple', 'physical'],
  ...(item.summary ? [['summary', item.summary]] : []),
  // GammaMarkets spec.md:124 — `stock`, "Available quantity as integer". This is the
  // standardised name; do not invent `quantity`.
  ...(item.stock !== undefined ? [['stock', item.stock]] : []),
  // NIP-99 99.md:43 — optional, "active" or "sold". Kept alongside `stock` because generic
  // NIP-99 clients read this one and know nothing about GammaMarkets.
  ['status', item.status ?? (item.stock === '0' ? 'sold' : 'active')],
  ['location', SALE.location],
  ['g', SALE.g],
  ['t', 'yardsale'],
  // GammaMarkets spec.md:148 — products point at their collection for discoverability.
  ['a', `30405:${pk}:${SALE.d}`],
  // Our own tag. `clink_offer` is the name CLINK standardises for a kind 0 metadata field and
  // for NIP-05 (clink-offers.md:58-83); no spec puts an noffer on a listing, so we reuse the
  // standard name rather than invent a second one. Purpose-made per item — never the
  // account's default offer, whose id IS the account pointer (/docs/spike-findings.md §3).
  ...(OFFERS[listingD(item)] ? [['clink_offer', OFFERS[listingD(item)]!.noffer]] : []),
  ...imagesFor(item.d),
]

const listings = ITEMS.map(item =>
  finalizeEvent({ kind: 30402, created_at: now, tags: tagsFor(item), content: item.summary ?? '' }, sk),
)

// --- 2b. the pre-signed availability ladder ----------------------------------------------
// Every future state of every buyable item, signed here and now, so slice 3's watcher can
// publish availability without ever holding a key. The reasoning is in ./ladder.ts; the two
// properties that make it safe are below.
const ladder: Record<string, { units: number; steps: ReturnType<typeof finalizeEvent>[] }> = {}
for (const item of ITEMS) {
  if (offerPriceSats(item) === undefined) continue // not buyable: nothing can sell, nothing to step
  const units = unitsOf(item.stock)
  ladder[listingD(item)] = {
    units,
    // steps[i] is the listing after i+1 units have sold, so the last step is stock 0 / sold.
    //
    // created_at STRICTLY INCREASES as stock falls, and that is load-bearing rather than
    // cosmetic. NIP-01 keeps only the newest event per (kind, pubkey, d) — with a tie broken
    // on the lowest id, which is why equal timestamps would be a coin flip — so a watcher that
    // published these out of order, or replayed an early one after a late one, changes
    // nothing: the relay keeps the later state. Availability cannot run backwards, by
    // construction rather than by the watcher behaving.
    steps: Array.from({ length: units }, (_, i) =>
      finalizeEvent(
        { kind: 30402, created_at: now + i + 1, tags: atStock(tagsFor(item), units - i - 1), content: item.summary ?? '' },
        sk,
      ),
    ),
  }
}
writeFileSync(LADDER_FILE, JSON.stringify(ladder, null, 2) + '\n')
console.log(`# pre-signed ${Object.values(ladder).reduce((n, l) => n + l.steps.length, 0)} ladder step(s) for ${Object.keys(ladder).length} item(s) -> ${LADDER_FILE}`)

// GammaMarkets spec.md:213-236. This is the sale itself: one signed event carrying the
// masthead (title/summary/location) and the member list. Replaces the `t`-tag grouping that
// /docs/spec.md §6.3 guessed at.
const collection = finalizeEvent({
  kind: 30405,
  created_at: now,
  tags: [
    ['d', SALE.d],
    ['title', SALE.title],
    ['summary', SALE.summary],
    ['location', SALE.location],
    ['g', SALE.g],
    ...listings.map(l => ['a', `30402:${pk}:${l.tags.find(t => t[0] === 'd')![1]}`]),
  ],
  content: SALE.summary,
}, sk)

const pool = new SimplePool()
for (const ev of [...listings, collection]) {
  const results = await Promise.allSettled(pool.publish(RELAYS, ev)
    .map(p => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000))])))
  const ok = results.filter(r => r.status === 'fulfilled').length
  const why = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
  console.log(`# kind ${ev.kind} ${ev.tags.find(t => t[0] === 'd')![1].padEnd(26)} -> ${ok}/${RELAYS.length} relays` +
    (ok < RELAYS.length && why ? `  (${String(why.reason).slice(0, 90)})` : ''))
}
pool.close(RELAYS)
console.log(`\n# storefront pubkey: ${pk}`)
console.log(`# sale d-tag:        ${SALE.d}`)
process.exit(0)
