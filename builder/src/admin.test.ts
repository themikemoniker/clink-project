// node --test, no framework — the same style and the same runner as listing.test.ts,
// deploy.test.ts, storefront/src/listing.test.ts and spike/ladder.test.ts.
//
// What matters here is the round trip. An edit is a republish under the same `d` (NIP-01 has no
// update verb), so everything the listing carries has to survive being read back out of the
// event and written again — and anything that does not survive is data the seller silently
// loses by pressing Save.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { parseListings } from '../../storefront/src/listing.ts'
import { DEFAULT_SALE, listingD as saleListingD, type SaleDraft } from './sale.ts'
import { blobFrom, draftFrom, imetaValues, noPublishSaleReason, reusableOffer, soldCount } from './admin.ts'
import { approvalCount, eventsToSign, listingTags, type Blob, type Draft } from './listing.ts'
import { parseNotes, MAX_NOTE } from './notes.ts'

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const NOW = 1_756_000_000

// Slice 9. The builder no longer imports the spike fixture's sale — see ./sale.ts for why that
// was the slice's real bug. A sale that is emphatically NOT ours keeps these honest: if any of
// this leaks a Guadalajara geohash again, it will be because a test asserted one.
const SALE: SaleDraft = {
  ...DEFAULT_SALE,
  d: 'sobras-de-mudanza',
  title: 'Sobras de mudanza',
  location: 'Barrio de Xochimilco, Oaxaca',
  g: '9g4h2xz',
}
const listingD = (slug: string) => saleListingD(SALE.d, slug)

// The same real noffer offer.test.ts uses: minted by the running Lightning.Pub 0.0.37 for the
// fixture's `plants` at 6,000 sats. A golden vector from the node, not from our own encoder.
const REAL_NOFFER =
  'noffer1qszqqqqhwqpszqqzgserxvrzvvcx2vt9v43kgwf4xsurxerxx93rvc358yunqcf3xyukyvmxx4jkgdf4v4snwwrrvejkvenxxscnyvt9x43rjefn8y6xgvenxvuxgeqpr9mhxue69uhhyetvv9ujumrfva58gmnfdenjuur4vgqzq0c2hedfg3hccr2zl7p7x9ne9j3e8vvjpjakahjswg6s29spt0huyqj43q'

const SHA = {
  hero: 'd70c6578967e32dedba6dc445cd9ce2110287d9f16191dd8e64265bde209a9f6',
  mid: '9b498a45c9836f177191a039e401f8f1a4e848ded9fe1b6054f843512beb056e',
  small: 'f011908a1dc16de617742a8c0d8cceb1d1319d5c80192fb5ff46749972a52e62',
}
const BLOSSOM = ['https://cdn.hzrd149.com', 'https://blossom.primal.net', 'https://nostr.download']

const blob = (w: number, h: number, sha: string): Blob => ({
  url: `${BLOSSOM[0]}/${sha}.jpg`,
  w,
  h,
  sha256: sha,
  type: 'image/jpeg',
})

const draft = (over: Partial<Draft> = {}): Draft => ({
  slug: 'brass-lamp',
  title: 'Brass floor lamp',
  summary: 'Rewired, works, some patina on the base.',
  priceSats: 6_000,
  stock: 3,
  alt: 'A brass floor lamp with a linen shade.',
  blobs: [blob(1200, 900, SHA.hero), blob(480, 360, SHA.mid), blob(160, 120, SHA.small)],
  servers: BLOSSOM,
  ...over,
})

const publishedAs = (d: Draft) => {
  const event = finalizeEvent(eventsToSign(d, pk, NOW, SALE)[0]!, sk)
  const item = parseListings([event], pk)[0]!
  return { event, item }
}

// --- the round trip ---------------------------------------------------------------------------

test('a published item reads back as the draft that republishes it byte for byte', () => {
  // The one that matters. If this drifts, pressing Save on an unchanged item silently rewrites
  // it — a lost photo, a lost alt text, a dropped Blossom mirror — under the same `d`, and the
  // old version is gone from the relays because NIP-01 replaces rather than versions.
  const original = draft()
  const { event, item } = publishedAs(original)

  const round = draftFrom(item, event, SALE.d)
  assert.ok(round)
  assert.equal(round.slug, original.slug)
  assert.equal(round.title, original.title)
  assert.equal(round.summary, original.summary)
  assert.equal(round.priceSats, original.priceSats)
  assert.equal(round.stock, original.stock)
  assert.equal(round.alt, original.alt)
  assert.deepEqual(round.blobs, original.blobs)
  // The mirror list survives, which is the whole reason `imeta fallback` finally has a reader:
  // a save that dropped it would take a three-server mirror back down to one.
  assert.deepEqual([...round.servers].sort(), [...original.servers].sort())

  // And the proof: the tags it would publish are the ones already on the relay. `published_at`
  // is the timestamp of the save and is expected to move.
  const strip = (tags: string[][]) => tags.filter(t => t[0] !== 'published_at')
  assert.deepEqual(strip(listingTags(round, pk, NOW + 500, SALE)), strip(event.tags))
})

test('an item with no photo and no offer round-trips too', () => {
  const original = draft({ blobs: [], servers: [], alt: '' })
  const { event, item } = publishedAs(original)
  const round = draftFrom(item, event, SALE.d)!
  assert.deepEqual(round.blobs, [])
  assert.deepEqual(round.servers, [])
  assert.equal(round.noffer, undefined)
})

test('a sold item reads back as stock 0, whichever way it says sold', () => {
  // `stock` is a Gamma tag and `status` is NIP-99's; the ladder moves both together, but a
  // listing seeded before either existed can carry only `status: sold`. Both must land on 0,
  // because the difference decides how many ladder rungs a re-publish signs.
  const { event, item } = publishedAs(draft({ stock: 0 }))
  assert.equal(draftFrom(item, event, SALE.d)!.stock, 0)

  const noStock = finalizeEvent(
    { kind: 30402, created_at: NOW, content: '', tags: [['d', listingD('mirror')], ['title', 'Mirror'], ['status', 'sold']] },
    sk,
  )
  const parsed = parseListings([noStock], pk)[0]!
  assert.equal(parsed.stock, undefined)
  assert.equal(draftFrom(parsed, noStock, SALE.d)!.stock, 0)
})

// --- what it refuses to edit ------------------------------------------------------------------

test('a fiat-priced item is not editable here, because this form would silently re-price it', () => {
  // The fixture's `records` is 80 MXN. There is no conversion anywhere in this project and no
  // oracle to do one with, so a sats-only form republishing it writes `80 sats` — a 99.99%
  // discount on an item somebody can then buy.
  const ev = finalizeEvent(
    { kind: 30402, created_at: NOW, content: '', tags: [['d', listingD('records')], ['title', 'Records'], ['price', '80', 'MXN']] },
    sk,
  )
  assert.equal(draftFrom(parseListings([ev], pk)[0]!, ev, SALE.d), null)
})

test('an item addressed outside this sale is not editable, because saving it would orphan the original', () => {
  const ev = finalizeEvent(
    { kind: 30402, created_at: NOW, content: '', tags: [['d', 'some-other-sale-chair'], ['title', 'Chair'], ['price', '10', 'sats']] },
    sk,
  )
  assert.equal(draftFrom(parseListings([ev], pk)[0]!, ev, SALE.d), null)
  // …and the `d` tag that is nothing but the prefix has no slug to republish under.
  const bare = finalizeEvent(
    { kind: 30402, created_at: NOW, content: '', tags: [['d', SALE.d], ['title', 'The sale itself']] },
    sk,
  )
  assert.equal(draftFrom(parseListings([bare], pk)[0]!, bare, SALE.d), null)
})

// --- the money path ---------------------------------------------------------------------------

test('an offer is reused at the same price and abandoned at a different one', () => {
  // Reuse is what keeps an edit from minting a second payable offer — CLINK Manage `create` is
  // explicitly not idempotent (clink-manage.md:226) — and it is the only edit path that works
  // at all on the fixture's natively-minted offers (findings §13.20).
  assert.equal(reusableOffer(REAL_NOFFER, 6_000), REAL_NOFFER)
  assert.equal(reusableOffer(REAL_NOFFER, 6_001), undefined)
  assert.equal(reusableOffer(REAL_NOFFER, 0), undefined)
  assert.equal(reusableOffer(undefined, 6_000), undefined)
  // A pointer that lost a character decodes to nobody, not to a plausible wrong node.
  assert.equal(reusableOffer(REAL_NOFFER.slice(0, -1), 6_000), undefined)
  assert.equal(reusableOffer('noffer1' + 'q'.repeat(40), 6_000), undefined)
})

test('the reused offer survives the same trust boundary a minted one does', () => {
  // publish.ts refuses to publish when the listing's price and the pointer's TLV 4 disagree, by
  // checking that the storefront's own parser still draws a Buy button. A reused offer has to
  // clear that same door or an edit would fail at publish time instead of at reuse time.
  const { item } = publishedAs(draft({ priceSats: 6_000, noffer: REAL_NOFFER }))
  assert.ok(item.offer, 'the storefront would draw a Buy button')
  assert.equal(item.offer!.priceSats, 6_000)

  const mismatched = publishedAs(draft({ priceSats: 6_001, noffer: REAL_NOFFER })).item
  assert.equal(mismatched.offer, undefined, 'a price change must not keep the old offer')
})

test('the sha256 comes back out of a Blossom URL, and nothing else does', () => {
  assert.deepEqual(blobFrom({ url: `${BLOSSOM[0]}/${SHA.hero}.jpg`, w: 1200, h: 900 }), {
    url: `${BLOSSOM[0]}/${SHA.hero}.jpg`,
    w: 1200,
    h: 900,
    sha256: SHA.hero,
    type: 'image/jpeg',
  })
  // The live fixture's URLs are subdomain-per-npub and carry no extension on some servers.
  assert.equal(blobFrom({ url: `https://npub1abc.blossom.band/${SHA.hero}`, w: 160, h: 120 })!.sha256, SHA.hero)
  assert.equal(blobFrom({ url: `${BLOSSOM[0]}/${SHA.hero.toUpperCase()}.jpg`, w: 1, h: 1 })!.sha256, SHA.hero)
  // Anything that is not a content address is not a blob we can re-publish a claim about.
  assert.equal(blobFrom({ url: 'https://example.com/photo.jpg', w: 1200, h: 900 }), null)
  assert.equal(blobFrom({ url: `${BLOSSOM[0]}/${SHA.hero.slice(0, 40)}.jpg`, w: 1200, h: 900 }), null)
  assert.equal(blobFrom({ url: `${BLOSSOM[0]}/${SHA.hero}.jpg`, w: 1200 }), null) // no dim, no aspect box
})

test('imeta fields are read per key, and repeats are kept', () => {
  const { event } = publishedAs(draft())
  assert.deepEqual(imetaValues(event, 'alt'), ['A brass floor lamp with a linen shade.'])
  assert.deepEqual(imetaValues(event, 'x'), [SHA.hero])
  // The hero's own server is in `url`, so `fallback` carries the other two.
  assert.equal(imetaValues(event, 'fallback').length, BLOSSOM.length - 1)
  assert.deepEqual(imetaValues(event, 'blurhash'), []) // deliberately not written
})

// --- what the panel shows ----------------------------------------------------------------------

test('units sold is derived from public information, and is unknown without a ladder', () => {
  const { item } = publishedAs(draft({ stock: 1 }))
  assert.equal(soldCount(3, item), 2) // three units authored, one still listed
  assert.equal(soldCount(3, publishedAs(draft({ stock: 3 })).item), 0)
  assert.equal(soldCount(3, publishedAs(draft({ stock: 0 })).item), 3)
  // The fixture's items were published by a script this browser has no ladder for. Saying
  // nothing is the honest answer; the node-side one is /spike/sales-report.ts.
  assert.equal(soldCount(undefined, item), undefined)
  // A relay can hand back a stock higher than the item was ever authored at.
  assert.equal(soldCount(1, publishedAs(draft({ stock: 9 })).item), 0)
})

test('an edit that keeps its photos does not pay for uploads it will not make', () => {
  const d = draft()
  assert.equal(approvalCount(d, true), 3 + 1 + 1 + 3) // new item: 3 uploads, offer, listing, ladder
  assert.equal(approvalCount(d, false, 0), 1 + 3) // edit, price unchanged: listing + ladder only
})

// --- private notes -----------------------------------------------------------------------------

test('the note map is bounded on the way in, because "our own data" is only true until it decrypts', () => {
  assert.deepEqual(parseNotes(JSON.stringify({ [listingD('lamp')]: 'paid 400 MXN at the tianguis' })), {
    [listingD('lamp')]: 'paid 400 MXN at the tianguis',
  })
  assert.deepEqual(parseNotes('not json'), {})
  assert.deepEqual(parseNotes('[1,2,3]'), {})
  assert.deepEqual(parseNotes('null'), {})
  assert.deepEqual(parseNotes(JSON.stringify({ a: 12, b: null, c: '   ' })), {}) // only non-empty strings
  assert.equal(parseNotes(JSON.stringify({ a: 'x'.repeat(9_000) })).a!.length, MAX_NOTE)
  assert.equal(Object.keys(parseNotes(JSON.stringify(Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`k${i}`, 'n'])))))
    .length, 500)
})

// --- item 3 + item 13 (2026-08-24): the same button, two ways to lose a sale -------------------
//
// A kind 30405 is a replacement, so the member list handed to `publishSale` IS the sale from that
// moment on. Item 3's defect made it EMPTY (the button was live before `loadPanel`'s four-relay
// read resolved); item 13's makes it SHORT (one slow relay). Fix one and the button can still drop
// items, which is why the 2026-08-23 review moved item 13's quorum and show-the-count bullets into
// milestone A — findings §13. Its refuse-to-shrink bullet stays in D.

const ready = { signedIn: true, panelLoaded: true, items: 9, answered: 4, relays: 4 }

test('the sale cannot be published before the panel has read the relays', () => {
  // The exact window: showSigner() enabled the button synchronously and then fired
  // `void loadPanel()`. `owned` is [] until that resolves, and a click in between signed a
  // kind 30405 with zero member tags — a SECOND sale, empty, un-listing everything.
  assert.match(noPublishSaleReason({ ...ready, panelLoaded: false, items: 0 })!, /Still reading/)
  assert.match(noPublishSaleReason({ ...ready, signedIn: false })!, /Connect a signer/)
  // And after the read, an empty result is still not a reason to replace a live sale with nothing.
  assert.match(noPublishSaleReason({ ...ready, items: 0, answered: 0 })!, /empty one/)
})

test('a member list short of quorum does not publish', () => {
  // Under a majority, the union may be missing whatever only a silent relay held.
  assert.match(noPublishSaleReason({ ...ready, answered: 1 })!, /Only 1 of 4 relays/)
  assert.match(noPublishSaleReason({ ...ready, answered: 2 })!, /Only 2 of 4 relays/)
  assert.equal(noPublishSaleReason({ ...ready, answered: 3 }), undefined)
  assert.equal(noPublishSaleReason(ready), undefined)
  // A majority, not unanimity: one permanently unreachable relay must not block a seller forever.
  assert.equal(noPublishSaleReason({ ...ready, answered: 2, relays: 3 }), undefined)
  assert.match(noPublishSaleReason({ ...ready, answered: 1, relays: 3 })!, /Only 1 of 3 relays/)
})

test('the reason is a sentence, because a disabled button that says nothing is its own defect', () => {
  for (const state of [
    { ...ready, signedIn: false },
    { ...ready, panelLoaded: false },
    { ...ready, items: 0 },
    { ...ready, answered: 0 },
  ]) {
    const reason = noPublishSaleReason(state)!
    assert.equal(typeof reason, 'string')
    assert.equal(reason.endsWith('.') || reason.endsWith('”.'), true, reason)
  }
})
