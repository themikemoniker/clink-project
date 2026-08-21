// The page's decisions, without the page. Same runner and same style as listing.test.ts and
// offer.test.ts — `npm test`, node --test, no framework, no new dependency.
//
// /docs/known-defects.md carried "render.ts is 402 untested lines" from the slice 0-5 review with
// the fix column saying it "needs a DOM harness, which is a new dependency and a new test style;
// that is a decision, not a follow-up fix". Slice 8 owned the decision and the measurement made
// it easy: render.ts touches `document` only inside function bodies, so importing it in bare node
// works today. The decisions were untestable only because they were private, not because they
// needed a browser.
//
// SCOPE, stated rather than implied. This file tests what render.ts DECIDES — which copy a
// decline gets, whether a stock line earns its space, how a number reads to a person in a
// driveway. It does not test what render.ts BUILDS: no assertion here says renderDetail emits a
// <main>. That half is the browser session (/docs/prompts/browser-verify-and-deploy.md).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Item } from './listing.ts'
import { declineText, formatPrice, geoUri, missingItemNote, noBuyReason, sats, stockNote } from './render.ts'

const item = (over: Partial<Item> = {}): Item => ({
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  d: 'yardsale-2026-08-mugs',
  created_at: 1_787_000_000,
  title: 'Mugs',
  content: '',
  sold: false,
  images: [],
  thumbs: [],
  ...over,
})

test('sats reads as a grouped number, because a driveway is not a terminal', () => {
  assert.equal(sats(1000), '1,000 sats')
  assert.equal(sats(180000), '180,000 sats')
  // The node's floor (offer.ts MIN_PAYABLE_SATS). No grouping, and no "sat" singular — the unit
  // is plural everywhere in this project including at 1, which is what wallets do.
  assert.equal(sats(10), '10 sats')
})

test('a price in sats is never run through Intl, because Intl throws on it', () => {
  assert.equal(formatPrice({ amount: 1000, currency: 'sats' }), '1,000 sats')
  assert.equal(formatPrice({ amount: 1000, currency: 'SAT' }), '1,000 sats')
  assert.equal(formatPrice({ amount: 0, currency: 'sats' }), 'Free')
  assert.equal(formatPrice(undefined), undefined)
})

test('a currency Intl cannot parse degrades to the code rather than throwing', () => {
  // 99.md:41 calls the field "ISO 4217-like", which in the wild means anything. Writing this test
  // measured where the try/catch actually earns its keep, which was not where it looked: Intl
  // accepts ANY three ASCII letters and invents a formatting for it — `ZZZ 5`, `XBT 5`, `BTC 5` —
  // and throws RangeError only on a length that is not three. So the fallback catches `btcs` and
  // `zz`, not the made-up-but-plausible codes. Both branches are asserted here because a listing
  // is authored by a stranger and either one blanking the page is the same bug.
  assert.equal(formatPrice({ amount: 5, currency: 'btcs' }), '5 BTCS') // throws -> our fallback
  // Matched rather than compared: Intl separates the code from the number with U+00A0, not a
  // space, which is invisible in a diff and is exactly the kind of assertion that wastes an hour.
  assert.match(formatPrice({ amount: 5, currency: 'zzz' })!, /^ZZZ\s5$/u) // Intl obliges, oddly
  // A real code still gets the real formatter. `records` in the live fixture is 80 MXN, which is
  // the item slice 8 gives copy to — this is the price it must keep showing while it does.
  assert.match(formatPrice({ amount: 80, currency: 'MXN' })!, /80/)
})

test('a stock line only appears when there is genuinely more than one', () => {
  // "1 left" on every row of a yard sale is noise: a yard sale item is one thing unless it says
  // otherwise. And a seller who wrote no stock tag at all has not made a claim to repeat.
  assert.equal(stockNote(item({ stock: 3 })), '3 available')
  assert.equal(stockNote(item({ stock: 1 })), undefined)
  assert.equal(stockNote(item({ stock: 0 })), undefined)
  assert.equal(stockNote(item({ stock: undefined })), undefined)
})

// --- the five Offers decline codes (clink-offers.md:188-192) ---------------------------------
//
// These are the only place a buyer meets the protocol, and each one has a different next action.
// The failure this guards is the flat one: every decline rendering as "something went wrong",
// which tells a person in a driveway nothing about whether to wait, reload, or give up.

test('a code 1 naming the missing keys re-prompts instead of dead-ending', () => {
  // Lightning.Pub's `payer_data` array on the error is an extension, not in the Offers spec's
  // error payload (/docs/spike-findings.md §6). It is the difference between "declined" and
  // "declined, and here is the field you missed".
  const text = declineText({ ok: false, code: 1, error: 'x', payerData: ['refund_pointer'] })
  assert.match(text, /refund_pointer/)
})

test('a code 1 with no keys means the offer itself is gone, and says to reload', () => {
  const text = declineText({ ok: false, code: 1, error: 'Invalid Offer' })
  assert.match(text, /no longer for sale/)
  assert.doesNotMatch(text, /refund_pointer/)
})

test('a code 5 carrying a range shows the range in sats, not in the node’s words', () => {
  const text = declineText({ ok: false, code: 5, error: 'Invalid Amount', range: { min: 1, max: 8000 } })
  assert.match(text, /1 sats/)
  assert.match(text, /8,000 sats/)
})

test('a code 5 with no range still says something a person can act on', () => {
  assert.equal(declineText({ ok: false, code: 5, error: 'Invalid Amount' }), 'That amount was refused.')
})

test('codes 2, 3 and 4 each get their own next action', () => {
  assert.match(declineText({ ok: false, code: 2, error: 'x' }), /try again/i)
  assert.match(declineText({ ok: false, code: 3, error: 'x' }), /reload/i)
  assert.match(declineText({ ok: false, code: 4, error: 'x' }), /does not support/i)
})

test('code 0 is ours and falls through to our own sentence, never to a node string', () => {
  // buy.ts uses code 0 for "no answer" and for "we refuse to trust this answer" — a price
  // mismatch, most importantly. Those messages are already written for a buyer, so the switch
  // must not overwrite them with generic copy.
  const mismatch = 'The node offered an invoice for 1,000 sats, not the 1,001 sats listed. Nothing was paid.'
  assert.equal(declineText({ ok: false, code: 0, error: mismatch }), mismatch)
})

test('an unknown code from a node we have never met does not render as undefined', () => {
  // Be lenient on receive. A node inventing code 99 must not blank the status line.
  assert.equal(declineText({ ok: false, code: 99, error: 'Something specific' }), 'Something specific')
})

// --- buyers this page does not serve (slice 8) ------------------------------------------------
//
// `renderBuy` used to return `false` for any item with no offer, so two items on the live fixture
// showed a price and no way to act on it and no explanation: `records` at 80 MXN and `boxes` at
// free. Every assertion below is about a SENTENCE A BUYER CAN ACT ON — the failure being guarded
// is copy that describes our data model ("no offer available") instead of their next step.

test('a fiat-priced item says cash at the table and names the currency', () => {
  // The live fixture's `records`. There is no conversion in this project and never will be — a
  // price oracle is somebody else's server (/CLAUDE.md rule 1, spec §6.1) — so this is a real
  // price the page genuinely cannot take, not a listing that is broken.
  const text = noBuyReason(item({ price: { amount: 80, currency: 'MXN' } }))!
  assert.match(text, /MXN/)
  assert.match(text, /cash at the table/i)
})

test('a free item says how to claim it', () => {
  // The live fixture's `boxes`. It rendered the word "free" and offered no way to act on it.
  assert.match(noBuyReason(item({ price: { amount: 0, currency: 'sats' } }))!, /free/i)
})

test('a price under the node’s 10-sat floor is cash, not a Buy button that always fails', () => {
  // Lightning.Pub hardcodes the floor (offer.ts MIN_PAYABLE_SATS, findings §13.7). A button here
  // would only ever answer `code: 5`.
  assert.match(noBuyReason(item({ price: { amount: 9, currency: 'sats' } }))!, /cash at the table/i)
  // 10 exactly is payable, so it falls through to the "no usable offer" sentence instead.
  assert.doesNotMatch(noBuyReason(item({ price: { amount: 10, currency: 'sats' } }))!, /Too small/)
})

test('a sats-priced item with no usable offer points at the seller, not at our data model', () => {
  // Reached two ways a buyer cannot tell apart and does not need to: no `clink_offer` tag at all,
  // or one whose TLV 4 price disagrees with the price tag (listing.ts `buyableOffer` refuses it).
  const text = noBuyReason(item({ price: { amount: 1000, currency: 'sats' } }))!
  assert.match(text, /ask the seller/i)
  assert.doesNotMatch(text, /offer|noffer|CLINK|tag/i)
})

test('an item with no price at all still gets a next step', () => {
  assert.match(noBuyReason(item({ price: undefined }))!, /ask the seller/i)
})

test('a sold item says nothing, because the stamp already said it twice', () => {
  // Sold is already carried by the stamp and the strikethrough. A third sentence explaining that
  // a sold thing cannot be bought is noise, and `sold` must win over every other branch —
  // including the fiat one, which would otherwise offer cash for something that is gone.
  assert.equal(noBuyReason(item({ sold: true, price: { amount: 1000, currency: 'sats' } })), undefined)
  assert.equal(noBuyReason(item({ sold: true, price: { amount: 80, currency: 'MXN' } })), undefined)
  assert.equal(noBuyReason(item({ sold: true, price: undefined })), undefined)
})

// --- slice 9 ---------------------------------------------------------------------------------

test('the geohash decodes to where it actually is', () => {
  // Checked against the two geohashes with published reference values rather than against this
  // implementation's own output, because "it round-trips with itself" proves nothing about the
  // bit order. u4pruydqqvj is the canonical Wikipedia example (57.64911, 10.40744) and ezs42 the
  // movable-type one (42.605, -5.603) that NIP-73 links to at 73.md:49.
  const at = (gh: string) => geoUri(gh)!.slice('geo:'.length).split(',').map(Number) as [number, number]
  const [lat1, lon1] = at('u4pruydqqvj')
  assert.ok(Math.abs(lat1 - 57.64911) < 0.0001, `lat was ${lat1}`)
  assert.ok(Math.abs(lon1 - 10.40744) < 0.0001, `lon was ${lon1}`)
  const [lat2, lon2] = at('ezs42')
  assert.ok(Math.abs(lat2 - 42.605) < 0.05, `lat was ${lat2}`)
  assert.ok(Math.abs(lon2 - -5.603) < 0.05, `lon was ${lon2}`)
  assert.match(geoUri('9ewmxg9')!, /^geo:-?\d+\.\d+,-?\d+\.\d+$/)
})

test('the fixture sale lands in the neighbourhood its location tag names', () => {
  // This assertion is why the fixture's `g` changed in slice 9. It was `9ewmr4z` from slice 1,
  // which is Guadalajara but 5.9 km from Colonia Americana — a plausible wrong value that sat on
  // four public relays for eight slices because NOTHING IN THIS PROJECT HAD EVER DECODED ONE.
  // Colonia Americana is ~20.674, -103.368; the tolerance below is about a kilometre.
  const [lat, lon] = geoUri('9ewmxg9')!.slice('geo:'.length).split(',').map(Number) as [number, number]
  assert.ok(Math.abs(lat - 20.674) < 0.01, `lat was ${lat}`)
  assert.ok(Math.abs(lon - -103.368) < 0.01, `lon was ${lon}`)
})

test('precision follows the geohash, because a 1-character one is a continent', () => {
  // "s" is a quarter of the planet. Printing 0.00000,0.00000 for it would be a lie with a
  // decimal point in it. Fewer characters, fewer decimals.
  const coarse = geoUri('s')!.split(',')[0]!.split('.')[1]!.length
  const fine = geoUri('9ewmr4z')!.split(',')[0]!.split('.')[1]!.length
  assert.ok(coarse < fine, `${coarse} decimals for one character vs ${fine} for seven`)
})

test('anything that is not a geohash gets no link at all', () => {
  // a, i, l and o are the four letters the Niemeyer alphabet omits, so they are exactly the
  // characters a typo or a mis-scan produces. A geo: URI built from one points somewhere real
  // and wrong, which is worse than no link.
  for (const bad of ['', 'colonia americana', '9ewmr4a', '9ewmr4i', '9ewmr4l', '9ewmr4o', '9EWMR4Z', '9ewmr4z9ewmr4z']) {
    assert.equal(geoUri(bad), undefined, `${JSON.stringify(bad)} should not decode`)
  }
  assert.equal(geoUri(undefined), undefined)
})

test('a deep link to an item that is gone says a sticker outlived its item', () => {
  // The reachable case: slice 9 prints stickers, the mug sells, the seller takes the listing
  // down, the sticker stays on the mug. Somebody scans it tomorrow.
  const note = missingItemNote('yardsale-2026-08-mugs', 8)
  assert.match(note, /sticker/i)
  assert.match(note, /yardsale-2026-08-mugs/)
  // It must not claim the sale is empty or the relays failed — eight items came back.
  assert.doesNotMatch(note, /relay/i)
})

test('with nothing at all from the relays the note refuses to pick a cause', () => {
  // Zero items means the page genuinely cannot tell "this item was removed" from "the relays
  // did not answer", and inventing either one sends the buyer to the wrong remedy.
  const note = missingItemNote('yardsale-2026-08-mugs', 0)
  assert.match(note, /relays/i)
  assert.doesNotMatch(note, /sticker/i)
  assert.match(note, /again/i)
})

test('the missing d is bounded before it reaches the page', () => {
  // It arrives from location.hash, which is whoever typed or scanned it. h() puts it in the DOM
  // through textContent so markup is inert either way — this is about a 40 KB URL becoming a
  // 40 KB paragraph.
  const note = missingItemNote('x'.repeat(5_000), 3)
  assert.ok(note.length < 300, `note was ${note.length} characters`)
})
