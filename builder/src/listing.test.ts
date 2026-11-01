// node --test, no framework — same style as storefront/src/listing.test.ts (27 assertions) and
// spike/ladder.test.ts (20). This covers the pure half of authoring: what tags an item gets,
// what the `imeta` tag carries, how many signatures a publish really costs, and — the one that
// matters most — that every rung of the ladder survives the storefront's own parser.
//
// The signing/network half is proven against the live node by /spike/check-manage.ts, which
// drives the real builder modules the way check-buy.ts drives the storefront's.
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import test from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { parseListings } from '../../storefront/src/listing.ts'
import { approvalCount, eventsToSign, imetaTag, listingTags, normaliseSlug, type Blob, type Draft } from './listing.ts'
import { DEFAULT_SALE, type SaleDraft } from './sale.ts'
import { renditionWidths, WIDTHS } from './photos.ts'

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const NOW = 1_756_000_000

// Slice 9: the sale is a parameter now, not an import from /spike/fixture.ts. Deliberately NOT
// the fixture's — these tests would have kept passing while every seller published our
// neighbourhood, which is the bug slice 9 fixed (./sale.ts).
const SALE: SaleDraft = {
  ...DEFAULT_SALE,
  d: 'sobras-de-mudanza',
  title: 'Sobras de mudanza',
  location: 'Barrio de Xochimilco, Oaxaca',
  g: '9g4h2xz',
}

const blob = (w: number, h: number, sha: string): Blob => ({
  url: `https://blossom.band/${sha}.jpg`,
  w,
  h,
  sha256: sha,
  type: 'image/jpeg',
})

const draft = (over: Partial<Draft> = {}): Draft => ({
  slug: 'brass-lamp',
  title: 'Brass floor lamp',
  summary: 'Rewired, works.',
  priceSats: 30_000,
  stock: 3,
  alt: 'A brass floor lamp',
  blobs: [blob(480, 360, 'b'.repeat(64)), blob(1200, 900, 'a'.repeat(64))],
  servers: ['https://blossom.band'],
  ...over,
})

const tagValue = (tags: string[][], name: string) => tags.find(t => t[0] === name)?.[1]

test('slug normalisation collapses what would silently overwrite an item', () => {
  // A `d` tag addresses the event forever (NIP-01 replaces on kind+pubkey+d), so two titles
  // that reach the same slug are one item with the second clobbering the first.
  strictEqual(normaliseSlug('Brass Floor Lamp'), 'brass-floor-lamp')
  strictEqual(normaliseSlug('  Lámpara  de  pie  '), 'lampara-de-pie')
  strictEqual(normaliseSlug('---weird---'), 'weird')
  strictEqual(normaliseSlug('!!!'), '')
  ok(normaliseSlug('x'.repeat(200)).length <= 60)
})

test('listing tags carry the standardised names, not invented ones', () => {
  const tags = listingTags(draft(), pk, NOW, SALE)
  strictEqual(tagValue(tags, 'd'), 'sobras-de-mudanza-brass-lamp')
  strictEqual(tagValue(tags, 'title'), 'Brass floor lamp')
  // Gamma spec.md:124 `stock`, not a custom `quantity` — /docs/spec.md §6.1.
  strictEqual(tagValue(tags, 'stock'), '3')
  strictEqual(tagValue(tags, 'status'), 'active')
  // 99.md:38 — three elements, never the optional 4th `frequency`.
  deepStrictEqual(tags.find(t => t[0] === 'price'), ['price', '30000', 'sats'])
  // Gamma spec.md:119-121 — the default is digital, and a yard sale is not.
  deepStrictEqual(tags.find(t => t[0] === 'type'), ['type', 'simple', 'physical'])
  strictEqual(tags.filter(t => t[0] === 'quantity').length, 0)
})

test('an item at stock 0 publishes sold and never advertises an offer', () => {
  const tags = listingTags(draft({ stock: 0, noffer: 'noffer1xxx' }), pk, NOW, SALE)
  strictEqual(tagValue(tags, 'status'), 'sold')
  strictEqual(tagValue(tags, 'stock'), '0')
})

test('the widest photo becomes `image`, the rest become `thumb`, whatever order they arrive in', () => {
  // draft() deliberately lists 480 before 1200. Getting this backwards means the index loads
  // the full-size blob and the detail view loads a thumbnail.
  const tags = listingTags(draft(), pk, NOW, SALE)
  deepStrictEqual(tags.find(t => t[0] === 'image'), ['image', `https://blossom.band/${'a'.repeat(64)}.jpg`, '1200x900'])
  const thumbs = tags.filter(t => t[0] === 'thumb')
  strictEqual(thumbs.length, 1)
  strictEqual(thumbs[0]![2], '480x360')
})

test('imeta carries the NIP-94 fields we can act on, and no blurhash we cannot render', () => {
  // NIP-92 92.md + NIP-94 94.md. The decision slice 1 deferred: this is the tag, these are the
  // field names, and blurhash is deliberately absent — see the note in listing.ts.
  const tag = imetaTag(blob(1200, 900, 'a'.repeat(64)), ['https://blossom.band', 'https://example.test'], 'A brass lamp')
  strictEqual(tag[0], 'imeta')
  ok(tag.includes(`x ${'a'.repeat(64)}`))
  ok(tag.includes('dim 1200x900'))
  ok(tag.includes('m image/jpeg'))
  ok(tag.includes('alt A brass lamp'))
  // "zero or more fallback file sources in case `url` fails" — the standard answer to blobs
  // living on one server. The hero's own server is already in `url` and must not repeat.
  deepStrictEqual(tag.filter(t => t.startsWith('fallback ')), [`fallback https://example.test/${'a'.repeat(64)}`])
  strictEqual(tag.filter(t => t.startsWith('blurhash')).length, 0)
})

test('an item is 1 + units signatures, and the count shown matches the events signed', () => {
  // The term /docs/spec.md §5's budget did not have. A UI that says "1 approval" here is how a
  // seller abandons a publish halfway and leaves a listing with no ladder behind it.
  const d = draft({ stock: 3 })
  strictEqual(eventsToSign(d, pk, NOW, SALE).length, 4) // listing + 3 rungs
  // 2 blobs + 1 offer + 1 listing + 3 rungs
  strictEqual(approvalCount(d, true, false), 7)
  strictEqual(approvalCount(d, false, false), 6)
  strictEqual(eventsToSign(draft({ stock: 0 }), pk, NOW, SALE).length, 1) // sold: no future states
})

test('ladder created_at strictly increases as stock falls', () => {
  // Load-bearing, not cosmetic: NIP-01 keeps the newest per (kind, pubkey, d), so a rung
  // published out of order or replayed is a no-op at the relay. Availability cannot run
  // backwards by construction rather than by the watcher behaving.
  const events = eventsToSign(draft({ stock: 3 }), pk, NOW, SALE)
  const times = events.map(e => e.created_at)
  deepStrictEqual(times, [NOW, NOW + 1, NOW + 2, NOW + 3])
})

test('every rung survives the storefront parser, and the last one drops the offer', () => {
  // The same door slice 3's watcher makes the ladder file go through. If a rung fails here it
  // fails in the watcher too, at the moment money has just arrived.
  // Any string will do here: this test is about the ladder's shape, and whether the tag is a
  // decodable pointer is the next test's job.
  const noffer = 'noffer1qvqsxxxxxx'
  const events = eventsToSign(draft({ stock: 3, noffer }), pk, NOW, SALE).map(t => finalizeEvent(t, sk))
  const parsed = events.map(e => parseListings([e], pk)[0])

  strictEqual(parsed.filter(Boolean).length, 4)
  deepStrictEqual(parsed.map(p => p!.stock), [3, 2, 1, 0])
  deepStrictEqual(parsed.map(p => p!.sold), [false, false, false, true])
  // atStock drops `clink_offer` at stock 0, so a sold listing is not still handing a payable
  // pointer to a page that cached it.
  strictEqual(events[3]!.tags.filter(t => t[0] === 'clink_offer').length, 0)
  strictEqual(events[0]!.tags.filter(t => t[0] === 'clink_offer').length, 1)
})

test('a listing whose price disagrees with its offer is not buyable, and we can see that before publishing', () => {
  // This is the check that stops a Buy button that cannot work from reaching a relay. Given a
  // tag that is not a decodable noffer, storefront/src/listing.ts drops the offer entirely — and
  // publish.ts refuses to publish when it does. The price-disagreement case is the same code
  // path (buyableOffer compares TLV 4 against the price tag) and is exercised end-to-end against
  // a REAL minted noffer by /spike/check-manage.ts.
  const events = eventsToSign(draft({ noffer: 'not-an-noffer' }), pk, NOW, SALE).map(t => finalizeEvent(t, sk))
  const parsed = parseListings([events[0]!], pk)[0]
  ok(parsed)
  strictEqual(parsed.offer, undefined)
})

test('rendition widths never upscale, and never lose a real thumb to a collision', () => {
  // A big photo gets all three. This is the common case and the boring one.
  deepStrictEqual(renditionWidths(4032), WIDTHS)
  // The bug this test exists for: an 800px source clamps 1200 -> 800, but 480 and 160 are still
  // distinct renditions. Dropping them leaves the index loading a full-size blob on mobile data.
  deepStrictEqual(renditionWidths(800), [800, 480, 160])
  // Exactly at a boundary: 480 collides with the clamped 1200 and is dropped, 160 survives.
  deepStrictEqual(renditionWidths(480), [480, 160])
  // A thumbnail-sized source collapses to one blob rather than three `thumb` tags on one URL.
  deepStrictEqual(renditionWidths(120), [120])
  deepStrictEqual(renditionWidths(1200), WIDTHS)
})

// --- slice 9: the item belongs to the seller's sale, not to ours -----------------------------

test('location and geohash come off the sale, not off a fixture in another package', () => {
  // THE SLICE-9 BUG, as an assertion. `listingTags` imported SALE from /spike/fixture.ts, so a
  // seller in Oaxaca published items tagged `Colonia Americana, Guadalajara` and `9ewmr4z`,
  // signed by their own key, permanently, on four public relays.
  const tags = listingTags(draft(), pk, NOW, SALE)
  strictEqual(tagValue(tags, 'location'), 'Barrio de Xochimilco, Oaxaca')
  strictEqual(tagValue(tags, 'g'), '9g4h2xz')
  ok(!JSON.stringify(tags).includes('Guadalajara'))
  ok(!JSON.stringify(tags).includes('9ewm'))
})

test('the a tag points at the sale this browser can actually publish', () => {
  // It used to be `30405:<pubkey>:yardsale-2026-08` for everybody, and NOTHING in the builder
  // ever published a kind 30405 — the only writer in the repo was /spike/seed-listings.ts. So
  // every authored item claimed membership of a collection that did not exist.
  const tags = listingTags(draft(), pk, NOW, SALE)
  deepStrictEqual(tags.find(t => t[0] === 'a'), ['a', `30405:${pk}:sobras-de-mudanza`])
})

test('a sale with no location and no geohash writes neither tag', () => {
  // Not empty ones. `["g",""]` decodes to the equator for anything that does not check, and
  // `["location",""]` renders as a blank line under the masthead.
  const tags = listingTags(draft(), pk, NOW, { ...SALE, location: '', g: '' })
  strictEqual(tags.filter(t => t[0] === 'location').length, 0)
  strictEqual(tags.filter(t => t[0] === 'g').length, 0)
  // The `a` tag is not optional the same way: an item with no collection is a stray.
  strictEqual(tags.filter(t => t[0] === 'a').length, 1)
})

test('the count says the ladder event out loud, because it is a signature the seller will be asked for', () => {
  // M1 adds one signature per item: the ladder now goes out as its own encrypted kind 30078
  // instead of being downloaded as a file. The number shown before the seller starts and the
  // events actually signed have to be one number. This is the same defect class the 2026-08-26
  // review caught on the fiat path, where the count and the publish disagreed about minting.
  //
  // `toWatcher` is a required argument rather than one defaulting to false, so that a call site
  // that has not thought about it cannot silently under-count. Under-counting is the harmful
  // direction: a seller told six and asked for seven has already stopped trusting the number.
  const d = draft({ stock: 3 })
  strictEqual(approvalCount(d, true, false), 7, 'no watcher configured: nothing to encrypt to')
  strictEqual(approvalCount(d, true, true), 8, '2 blobs + 1 offer + 1 listing + 3 rungs + 1 ladder')
  strictEqual(approvalCount(d, false, true), 7)
  strictEqual(approvalCount(d, false, true, 0), 5, 'an edit that keeps its photos: listing + 3 rungs + ladder')

  // One per item, not one per rung, and not one for the whole shop. A sold-out item has no future
  // states left to sign and still has a ladder to send.
  const sold = draft({ stock: 0 })
  strictEqual(
    approvalCount(sold, false, true, 0) - approvalCount(sold, false, false, 0),
    1,
    'the ladder is a single event however many rungs are in it',
  )

  // The encryption is NOT counted. main.ts renders this as "N signatures" and tells the seller
  // their signer should ask once per kind, so the number means signEvent calls. `nip44_encrypt`
  // is a separate signer method and not a signature, and both perms have been in PERMS since
  // slice 4 (signer.ts:41, :49) so neither costs a second bunker approval.
  strictEqual(approvalCount(d, true, true) - approvalCount(d, true, false), 1, 'one, not two')
})
