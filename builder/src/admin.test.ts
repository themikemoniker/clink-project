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
import {
  blobFrom,
  draftFrom,
  droppedMembers,
  fiatCurrency,
  fiatPriceReason,
  imetaValues,
  isSats,
  loadItems,
  noPublishSaleReason,
  reusableOffer,
  saleMemberDs,
  soldCount,
} from './admin.ts'
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

// M3 REVERSED THIS TEST'S CONCLUSION, AND KEPT ITS PREMISE. It used to assert
// `draftFrom(...) === null` for the fixture's 80 MXN `records`, on the reasoning below — which is
// still exactly right about the danger and was wrong that refusing forever was the only answer.
// The item is editable now and republishes as `["price","80","MXN"]`; what makes that safe is
// that no offer can be minted behind it. The tests for the new behaviour are in M3's own section
// at the foot of this file; this one keeps the half that must never change.
test('a fiat item never republishes as sats, which is the danger the old refusal was about', () => {
  // The fixture's `records` is 80 MXN. There is no conversion anywhere in this project and no
  // oracle to do one with, so a sats-only form republishing it would write `80 sats` — a 99.99%
  // discount on an item somebody can then buy.
  const ev = finalizeEvent(
    { kind: 30402, created_at: NOW, content: '', tags: [['d', listingD('records')], ['title', 'Records'], ['price', '80', 'MXN']] },
    sk,
  )
  const round = draftFrom(parseListings([ev], pk)[0]!, ev, SALE.d)
  assert.ok(round)
  assert.deepEqual(
    listingTags(round, pk, NOW, SALE).find(t => t[0] === 'price'),
    ['price', '80', 'MXN'],
  )
  // `priceSats` is 0 and stays 0: nothing reads it for a fiat item, and a non-zero value here is
  // a number that could be mistaken for a price.
  assert.equal(round.priceSats, 0)
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
  assert.equal(approvalCount(d, true, false), 3 + 1 + 1 + 3) // new item: 3 uploads, offer, listing, ladder
  assert.equal(approvalCount(d, false, false, 0), 1 + 3) // edit, price unchanged: listing + ladder only
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

// The quorum is only worth having if the number it counts is THIS read. `pool.seenOn` is a Map on
// the pool that is only ever added to, and main.ts holds one pool for the session — so before
// 2026-08-24 a relay that answered once counted as answering forever, and the gate could be walked
// past by pressing the "Reload my items" its own error message tells the seller to press.
test('a relay that answered a previous load is not counted as answering this one', async () => {
  const { event } = publishedAs(draft())
  // A stub in the shape the library actually has: querySync returns the union, and seenOn
  // accumulates across calls because nothing in nostr-tools ever clears it (abstract-pool.js:698).
  const seenOn = new Map<string, Set<{ url: string }>>()
  const pool = {
    trackRelays: false,
    seenOn,
    querySync: async (_relays: string[], _filter: unknown) => {
      for (const url of answering) {
        const set = seenOn.get(event.id) ?? new Set<{ url: string }>()
        set.add({ url })
        seenOn.set(event.id, set)
      }
      return [event]
    },
  }
  const relays = ['wss://a', 'wss://b', 'wss://c', 'wss://d']
  let answering = ['wss://a', 'wss://b']

  const first = await loadItems(pool as never, relays, pk)
  assert.deepEqual(first.answered.sort(), ['wss://a', 'wss://b'])

  // The seller presses reload. `a` is down now and `c` answers instead — still two of four, so the
  // list is still short and publishing must still be refused.
  answering = ['wss://b', 'wss://c']
  const second = await loadItems(pool as never, relays, pk)
  assert.deepEqual(second.answered.sort(), ['wss://b', 'wss://c'])
  assert.match(
    noPublishSaleReason({ ...ready, items: second.items.length, answered: second.answered.length })!,
    /Only 2 of 4 relays/,
  )
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

// --- item 13's last bullet (2026-08-26): refuse to shrink a sale silently ---------------------
//
// The other two bullets landed in milestone A and both are about a list that is short BY ACCIDENT
// — empty because the read had not finished, short because a relay was slow. This is the case
// neither of them can see: a list that is short and correct, because the seller meant to retire
// something. A kind 30405 is a replacement either way, so the wire cannot tell them apart, and
// neither can we. What we can do is name what is about to go and make somebody say yes.
//
// This has to exist BEFORE M3's delete, not after: M3 retires an item BY dropping it from the
// member list, so without a confirmation path M3 would trip a refusal on every legitimate use.

test('the sale on the relays is read back as the item ds it lists', () => {
  // `30402:<pubkey>:<d>` — Gamma spec.md:221, and `orderBySale` builds refs in that exact shape.
  assert.deepEqual(saleMemberDs([`30402:${pk}:mugs`, `30402:${pk}:lamp`], pk), ['mugs', 'lamp'])
  assert.deepEqual(saleMemberDs([], pk), [])
  assert.deepEqual(saleMemberDs(undefined, pk), [])
})

test('a ref that is not this seller’s own listing is skipped, not counted as a member', () => {
  const other = 'f'.repeat(64)
  assert.deepEqual(saleMemberDs([`30402:${other}:theirs`, `30402:${pk}:mine`], pk), ['mine'])
  // A different kind is not a 30402 member however it is spelled.
  assert.deepEqual(saleMemberDs([`30405:${pk}:nested`, `30023:${pk}:article`], pk), [])
  // A duplicate ref is one member. The count is shown to a seller, so it has to be the count.
  assert.deepEqual(saleMemberDs([`30402:${pk}:mugs`, `30402:${pk}:mugs`], pk), ['mugs'])
  // Nonsense in, nothing out — the refs come off a relay.
  assert.deepEqual(saleMemberDs(['', 'not-a-ref', `30402:${pk}:`], pk), [])
  assert.deepEqual(saleMemberDs([`30402:${pk}:mugs`], 'not-a-pubkey'), [])
})

test('a d containing a colon survives, because only the first two are the address', () => {
  assert.deepEqual(saleMemberDs([`30402:${pk}:sale:2026:mugs`], pk), ['sale:2026:mugs'])
})

test('publishing a shorter list names every item it would un-list', () => {
  assert.deepEqual(droppedMembers(['mugs', 'lamp', 'bike'], ['mugs', 'bike']), ['lamp'])
  assert.deepEqual(droppedMembers(['mugs', 'lamp', 'bike'], []), ['mugs', 'lamp', 'bike'])
})

test('it is a SET difference, not a length test, because a swap is a same-length shrink', () => {
  // The roadmap words this as "shorter than the one on the relays". A count would wave this
  // through: three in, three out, and `lamp` is silently gone from the sale.
  assert.deepEqual(droppedMembers(['mugs', 'lamp', 'bike'], ['mugs', 'bike', 'couch']), ['lamp'])
  // And it must not fire on a rename-free reorder, which is not a shrink at all.
  assert.deepEqual(droppedMembers(['mugs', 'lamp'], ['lamp', 'mugs']), [])
})

test('growing, or publishing the first sale there has ever been, asks nothing', () => {
  assert.deepEqual(droppedMembers(['mugs'], ['mugs', 'lamp']), [])
  assert.deepEqual(droppedMembers(['mugs'], ['mugs']), [])
  // No sale on the relays yet: there is nothing to shrink, so there is nothing to confirm.
  assert.deepEqual(droppedMembers([], ['mugs', 'lamp']), [])
  assert.deepEqual(droppedMembers([], []), [])
})

// --- M3, the fiat half (2026-08-26) ----------------------------------------------------------
//
// `draftFrom` used to be `if (item.price && item.price.currency !== 'sats') return null`, so
// `records` at 80 MXN could never be edited at all — not its title, not its photo, not its stock.
// The guard was right about the danger (a sats-only form republishes 80 MXN as 80 SATS, a silent
// 99.99% discount on something somebody might then buy) and wrong that refusing forever was the
// only way to be right.
//
// It also compared on the exact lowercase string while storefront/src/listing.ts accepted
// `/^sats?$/i`, so an item priced `sat` or `SATS` was BUYABLE and NOT EDITABLE. Measured against
// both live sales on 2026-08-26 — 17 listings, every price tag exactly `sats` or `MXN` — so that
// half was latent, not live. Both files call one exported predicate now.

test('the two currency tests agree, because there is only one of them left', () => {
  assert.equal(isSats('sats'), true)
  assert.equal(isSats('sat'), true)
  assert.equal(isSats('SATS'), true)
  assert.equal(isSats('Sats'), true)
  assert.equal(isSats('MXN'), false)
  assert.equal(isSats('satoshi'), false)
})

test('a currency this form may carry is letters, bounded, and never a spelling of sats', () => {
  assert.equal(fiatCurrency('MXN'), 'MXN')
  assert.equal(fiatCurrency('mxn'), 'mxn') // written back exactly as the listing had it
  assert.equal(fiatCurrency('  EUR  '), 'EUR')
  // THE ONE THAT MUST NOT PASS. `listingTags` writes this straight into the price tag and
  // publish.ts mints nothing for a fiat draft, so a "fiat" currency that reads as sats would
  // produce a listing priced N sats that nothing can charge for — and one round trip later a
  // seller could put an offer behind a number that was never sats.
  assert.equal(fiatCurrency('sats'), null)
  assert.equal(fiatCurrency('SATS'), null)
  assert.equal(fiatCurrency('sat'), null)
  // Bounded, because this comes off a relay.
  assert.equal(fiatCurrency('US$'), null)
  assert.equal(fiatCurrency('MX N'), null)
  assert.equal(fiatCurrency('123'), null)
  assert.equal(fiatCurrency(''), null)
  assert.equal(fiatCurrency(undefined), null)
  assert.equal(fiatCurrency('a'.repeat(13)), null)
  assert.equal(fiatCurrency('a'.repeat(12)), 'a'.repeat(12))
})

test('a fiat item is editable now, and republishes as its own currency and not as sats', () => {
  // The whole of M3's first bullet, as a round trip. 80 MXN in, 80 MXN out.
  const original = draft({ priceSats: 0, fiat: { amount: 80, currency: 'MXN' }, blobs: [], servers: [], alt: '' })
  const { event, item } = publishedAs(original)
  assert.deepEqual(event.tags.find(t => t[0] === 'price'), ['price', '80', 'MXN'])

  const round = draftFrom(item, event, SALE.d)
  assert.ok(round, 'a fiat item used to be uneditable and now is not')
  assert.deepEqual(round.fiat, { amount: 80, currency: 'MXN' })
  assert.equal(round.priceSats, 0)
  assert.equal(round.title, original.title)

  // And the proof, the same one the sats round trip makes: the tags it would republish are the
  // ones already on the relay. A regression that re-priced it would land here.
  const strip = (tags: string[][]) => tags.filter(t => t[0] !== 'published_at')
  assert.deepEqual(strip(listingTags(round, pk, NOW + 500, SALE)), strip(event.tags))
})

test('a fiat amount is checked against the storefront’s bound, not against the sats rule', () => {
  // THE ASSERTION THAT WOULD HAVE CAUGHT IT. `doPublish` validated a fiat amount with
  // `Number.isSafeInteger` for one slice, which is the rule for sats: a sat is whole by
  // definition and a peso is not. It lived inline in the submit handler, so nothing could reach
  // it. It is `fiatPriceReason` now, and this is what it has to say.
  assert.equal(fiatPriceReason(12.5, 'USD'), undefined)
  assert.equal(fiatPriceReason(80.5, 'MXN'), undefined)
  assert.equal(fiatPriceReason(80, 'MXN'), undefined)
  // Zero is a real price. `boxes` is `["price","0","MXN"]` on the live sale and the page draws it
  // as "Free". A BLANK field is also 0 and is a different thing entirely, which is why the markup
  // carries `required` and this function is not asked to tell them apart.
  assert.equal(fiatPriceReason(0, 'MXN'), undefined)

  // The bound is `parsePrice`'s bound: a price this form accepts has to be one the page reads back.
  assert.ok(fiatPriceReason(-1, 'MXN'))
  assert.ok(fiatPriceReason(NaN, 'MXN'))
  assert.ok(fiatPriceReason(Infinity, 'MXN'))
  assert.ok(fiatPriceReason(1e16, 'MXN'))
  assert.equal(fiatPriceReason(1e15, 'MXN'), undefined)

  // It names the currency, because "give a price in MXN" is an instruction and "invalid price"
  // is a status message about our form.
  assert.match(fiatPriceReason(-1, 'MXN')!, /MXN/)
})

test('every amount the form accepts survives the trip to a tag and back', () => {
  // The bound above is only worth anything if it agrees with the parser it claims to match.
  // `String()` writes the tag and `Number()` reads it, so this is the round trip asserted end to
  // end rather than reasoned about, including the exponent form, which is what `String()` emits
  // at the small end and which `Number()` reads straight back.
  for (const amount of [0, 1, 12.5, 80.5, 0.01, 1e-7, 1e15]) {
    assert.equal(fiatPriceReason(amount, 'USD'), undefined, `${amount} should be publishable`)
    assert.equal(Number(String(amount)), amount, `${amount} should survive String -> Number`)
  }
})

test('a fiat price does not have to be a whole number, because a peso is not a sat', () => {
  // THE FIRST PASS AT M3 VALIDATED THIS WITH `Number.isSafeInteger`, inherited from the sats
  // field rather than reasoned about. A sat is whole by definition; 12.50 USD is an ordinary
  // price, and `parsePrice` in storefront/src/listing.ts has always accepted any finite number
  // from 0 to 1e15. So a fractional listing was editable and then unpublishable, and the only
  // way out the form offered a seller was to change what the item costs, which is the silent
  // re-pricing this whole item exists to prevent.
  const original = draft({ priceSats: 0, fiat: { amount: 12.5, currency: 'USD' }, blobs: [], servers: [], alt: '' })
  const { event, item } = publishedAs(original)
  assert.deepEqual(event.tags.find(t => t[0] === 'price'), ['price', '12.5', 'USD'])

  const round = draftFrom(item, event, SALE.d)
  assert.ok(round, 'a fractional fiat item has to survive the round trip like any other')
  assert.deepEqual(round.fiat, { amount: 12.5, currency: 'USD' })
  assert.equal(round.priceSats, 0)

  const strip = (tags: string[][]) => tags.filter(t => t[0] !== 'published_at')
  assert.deepEqual(strip(listingTags(round, pk, NOW + 500, SALE)), strip(event.tags))

  // Still unpayable, which is the invariant that makes carrying any of this safe at all.
  assert.equal(item.offer, undefined)
  assert.deepEqual(item.price, { amount: 12.5, currency: 'USD' })
})

test('the round trip is through Number, so trailing zeros are the one thing not carried byte for byte', () => {
  // `parsePrice` is `Number(tag[1])` and `listingTags` is `String(amount)`, so a relay that hands
  // us `12.50` hands the form 12.5 and the form writes back `12.5`. The VALUE is identical and
  // the bytes are not. Asserted rather than left to be discovered, because "carried through
  // unchanged" is the claim M3 makes and this is the edge where it is a value claim, not a byte
  // one. Nothing reads a price tag for its formatting: the storefront renders through
  // `formatPrice`, which formats from the number.
  const original = draft({ priceSats: 0, fiat: { amount: 80, currency: 'MXN' } })
  const template = eventsToSign(original, pk, NOW, SALE)[0]!
  const event = finalizeEvent(
    { ...template, tags: template.tags.map(t => (t[0] === 'price' ? ['price', '12.50', 'USD'] : t)) },
    sk,
  )
  const item = parseListings([event], pk)[0]!
  const round = draftFrom(item, event, SALE.d)!
  assert.deepEqual(round.fiat, { amount: 12.5, currency: 'USD' })
  assert.deepEqual(listingTags(round, pk, NOW, SALE).find(t => t[0] === 'price'), ['price', '12.5', 'USD'])
})

test('editing a fiat item cannot make it buyable, whatever the seller has configured', () => {
  const fiat = draft({ priceSats: 0, fiat: { amount: 80, currency: 'MXN' }, stock: 3 })
  // `mintOffer: true` is the caller saying "there is a node and stock". It still counts zero.
  assert.equal(approvalCount(fiat, true, false, 0), approvalCount(fiat, false, false, 0))
  // Which is exactly one less than the same item priced in sats would cost.
  assert.equal(approvalCount(draft({ stock: 3 }), true, false, 0), approvalCount(fiat, true, false, 0) + 1)
  // And no listing it publishes carries a payable pointer.
  const { event } = publishedAs({ ...fiat, noffer: REAL_NOFFER })
  assert.equal(
    event.tags.some(t => t[0] === 'clink_offer'),
    true,
    'listingTags writes whatever noffer it is handed — the refusal is publish.ts and draftFrom, asserted below',
  )
})

test('a fiat item drops any clink_offer on the way into the form, so an edit cannot carry one', () => {
  // `reusableOffer` measures a pointer's own TLV 4 against a SATS price and a fiat item has none,
  // so a pointer some other tool wrote could never be checked. Dropping it is what keeps
  // "unpayable" true across an edit rather than only at first publish.
  const { event, item } = publishedAs(
    draft({ priceSats: 0, fiat: { amount: 80, currency: 'MXN' }, noffer: REAL_NOFFER }),
  )
  assert.equal(event.tags.some(t => t[0] === 'clink_offer'), true)
  assert.equal(draftFrom(item, event, SALE.d)!.noffer, undefined)
})

test('the storefront still refuses to draw a Buy button for it, which is the point', () => {
  const { item } = publishedAs(
    draft({ priceSats: 0, fiat: { amount: 80, currency: 'MXN' }, noffer: REAL_NOFFER }),
  )
  // parseListings is the storefront's own parser, run here on the tags the builder would publish.
  assert.equal(item.offer, undefined)
  assert.deepEqual(item.price, { amount: 80, currency: 'MXN' })
})

test('an item priced SATS is a sats item to both files now, not buyable-but-uneditable', () => {
  // The latent half. Before 2026-08-26 the storefront's `/^sats?$/i` drew a Buy button and the
  // builder's `!== 'sats'` refused to edit it, and nothing in the tree wrote that spelling so
  // nobody found out.
  const original = draft({ priceSats: 6_000 })
  const template = eventsToSign(original, pk, NOW, SALE)[0]!
  const event = finalizeEvent(
    { ...template, tags: template.tags.map(t => (t[0] === 'price' ? ['price', t[1]!, 'SATS'] : t)) },
    sk,
  )
  const item = parseListings([event], pk)[0]!
  const round = draftFrom(item, event, SALE.d)
  assert.ok(round, 'SATS used to return null here while the storefront happily drew a Buy button')
  assert.equal(round.fiat, undefined)
  assert.equal(round.priceSats, 6_000)
})

test('a currency this form cannot carry at all is still refused, rather than mangled', () => {
  const original = draft({ priceSats: 80 })
  const template = eventsToSign(original, pk, NOW, SALE)[0]!
  const event = finalizeEvent(
    { ...template, tags: template.tags.map(t => (t[0] === 'price' ? ['price', t[1]!, 'US$'] : t)) },
    sk,
  )
  const item = parseListings([event], pk)[0]!
  assert.equal(draftFrom(item, event, SALE.d), null)
})
