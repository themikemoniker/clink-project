// node --test, no framework — the eighth suite, same style as the other seven.
//
// Slice 9. What is worth asserting here is not "does saleTags emit a d tag" but the two things
// that were actually wrong before it: the builder had no sale of its own, and the one it borrowed
// carried a geohash 5.9 km from the neighbourhood beside it.
//
// `geohashOf` is tested against published reference coordinates rather than against its own
// round trip, because a round trip agrees with itself even when the bit order is backwards.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { parseSales } from '../../storefront/src/listing.ts'
import { geoUri } from '../../storefront/src/render.ts'
import {
  DEFAULT_SALE,
  draftFromSale,
  geohashOf,
  listingD,
  normaliseGeohash,
  saleD,
  saleTags,
  saleTemplate,
  type SaleDraft,
} from './sale.ts'
import { stickerItems, stickerUrl } from './stickers.ts'
import type { Item } from '../../storefront/src/listing.ts'

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const NOW = 1_756_000_000

const sale: SaleDraft = {
  d: 'sobras-de-mudanza',
  title: 'Sobras de mudanza',
  summary: 'Sábado 23, 8am–2pm. Efectivo o Lightning.',
  location: 'Barrio de Xochimilco, Oaxaca',
  g: '9g4h2xz',
}

// --- the sale event ---------------------------------------------------------------------------

test('the collection carries the masthead and one a tag per member', () => {
  // Gamma spec.md:213-262: required `d` and `title`, one ["a","30402:<pubkey>:<d>"] per member,
  // optional image/summary/location/g.
  const tags = saleTags(sale, pk, ['sobras-de-mudanza-mugs', 'sobras-de-mudanza-lamp'])
  assert.deepEqual(tags.find(t => t[0] === 'd'), ['d', 'sobras-de-mudanza'])
  assert.deepEqual(tags.find(t => t[0] === 'title'), ['title', 'Sobras de mudanza'])
  assert.deepEqual(tags.find(t => t[0] === 'location'), ['location', 'Barrio de Xochimilco, Oaxaca'])
  assert.deepEqual(tags.find(t => t[0] === 'g'), ['g', '9g4h2xz'])
  assert.deepEqual(
    tags.filter(t => t[0] === 'a'),
    [
      ['a', `30402:${pk}:sobras-de-mudanza-mugs`],
      ['a', `30402:${pk}:sobras-de-mudanza-lamp`],
    ],
  )
})

test('member order is preserved, because the storefront renders it', () => {
  // Gamma spec.md:213-236 makes the order meaningful and storefront/src/listing.ts `orderBySale`
  // honours it — collection members in order, strays after. A Set or an object would lose this.
  const ds = ['c', 'a', 'b'].map(x => `${sale.d}-${x}`)
  assert.deepEqual(
    saleTags(sale, pk, ds).filter(t => t[0] === 'a').map(t => t[1]!.split(':')[2]),
    ds,
  )
})

test('an empty optional field writes no tag rather than an empty one', () => {
  const tags = saleTags({ ...sale, summary: '', location: '', g: '' }, pk, [])
  for (const name of ['summary', 'location', 'g']) {
    assert.equal(tags.filter(t => t[0] === name).length, 0, `${name} should be absent`)
  }
  // `["g",""]` in particular is a pin at 0,0 for anything that decodes without checking.
  assert.equal(geoUri(''), undefined)
})

test('the sale survives the storefront’s own parser, which is what publish.ts checks', () => {
  // Same door the listing goes through. A collection whose title did not survive encoding is a
  // masthead that renders as the site's fallback name, and the seller cannot tell that apart
  // from "the relay dropped it".
  const event = finalizeEvent(saleTemplate(sale, pk, [`${sale.d}-mugs`], NOW), sk)
  const parsed = parseSales([event], pk)[0]!
  assert.equal(parsed.d, sale.d)
  assert.equal(parsed.title, sale.title)
  assert.equal(parsed.location, sale.location)
  assert.equal(parsed.geo, sale.g)
  assert.equal(parsed.itemRefs.length, 1)
})

test('a published sale round-trips back into the form that would republish it', () => {
  // An edit is a replacement (NIP-01 has no update verb), so anything not read back here is
  // silently dropped the next time the seller presses Publish.
  const event = finalizeEvent(saleTemplate(sale, pk, [`${sale.d}-mugs`], NOW), sk)
  assert.deepEqual(draftFromSale(parseSales([event], pk)[0]), sale)
})

// --- the `d`, which is the dangerous one ------------------------------------------------------

test('the sale d comes off the relays, so an existing sale keeps its item prefix', () => {
  // THE COLLISION /docs/known-defects.md warned about. The sale's `d` is every item's `d`
  // prefix, and `admin.ts` draftFrom refuses to edit an item outside it. Reading it back rather
  // than asking for it is what stops a first page load orphaning a live sale.
  const event = finalizeEvent(saleTemplate({ ...sale, d: 'yardsale-2026-08' }, pk, [], NOW), sk)
  assert.equal(saleD(parseSales([event], pk)[0]), 'yardsale-2026-08')
  assert.equal(listingD(saleD(parseSales([event], pk)[0]), 'mugs'), 'yardsale-2026-08-mugs')
})

test('a seller with no sale yet gets a default with no date in it', () => {
  assert.equal(saleD(undefined), DEFAULT_SALE.d)
  // A date in the `d` goes stale the moment there is a second sale, at which point changing it
  // orphans every `a` tag and every item prefix at once. The pubkey already makes it unique.
  assert.doesNotMatch(DEFAULT_SALE.d, /\d/)
  assert.deepEqual(draftFromSale(undefined), DEFAULT_SALE)
  // …and mutating the returned draft must not edit the constant.
  const first = draftFromSale(undefined)
  first.title = 'changed'
  assert.notEqual(DEFAULT_SALE.title, 'changed')
})

// --- geohash ----------------------------------------------------------------------------------

test('geohashOf matches published reference coordinates', () => {
  // Wikipedia's canonical example: 57.64911, 10.40744 -> u4pruydqqvj. And the movable-type one
  // NIP-73 links at 73.md:49: 42.6, -5.6 -> ezs42.
  assert.equal(geohashOf(57.64911, 10.40744, 11), 'u4pruydqqvj')
  assert.equal(geohashOf(42.6, -5.6, 5), 'ezs42')
})

test('what the builder writes is what the storefront reads', () => {
  // The two halves are in different packages and neither imports the other's alphabet. This is
  // the assertion that catches them drifting.
  const g = geohashOf(20.6736, -103.3684)
  const [lat, lon] = geoUri(g)!.slice('geo:'.length).split(',').map(Number) as [number, number]
  assert.ok(Math.abs(lat - 20.6736) < 0.001, `lat came back ${lat}`)
  assert.ok(Math.abs(lon - -103.3684) < 0.001, `lon came back ${lon}`)
})

test('seven characters is a driveway, not a house', () => {
  // ±76 m. Publishing more than that to four public relays says which door, which is a decision
  // nobody asked this app to make on a seller's behalf.
  assert.equal(geohashOf(20.6736, -103.3684).length, 7)
  const [a, b] = [geohashOf(20.6736, -103.3684), geohashOf(20.6740, -103.3688)]
  assert.equal(a, b, 'four metres apart should be the same 7-character cell')
})

test('a geohash the seller typed is folded or refused, never repaired', () => {
  assert.equal(normaliseGeohash('  9EWMXG9 '), '9ewmxg9') // copied out of a map tool
  assert.equal(normaliseGeohash('9ewmxg9'), '9ewmxg9')
  // a, i, l and o are the four letters the alphabet omits, so they are exactly what a typo or a
  // mis-scan produces. Repairing one silently would publish a pin somewhere real and wrong.
  for (const bad of ['9ewmxga', '9ewmxgi', '9ewmxgl', '9ewmxgo', 'Colonia Americana', '', '9ewmxg9-']) {
    assert.equal(normaliseGeohash(bad), '', `${JSON.stringify(bad)} should be refused`)
  }
})

// --- stickers (design.md §4) -------------------------------------------------------------------

const item = (over: Partial<Item> = {}): Item => ({
  id: 'a'.repeat(64),
  pubkey: pk,
  d: 'sobras-de-mudanza-mugs',
  created_at: NOW,
  title: 'Tazas',
  content: '',
  sold: false,
  images: [],
  thumbs: [],
  ...over,
})

test('a sticker encodes the storefront deep link, which is what slice 8 decided', () => {
  // NOT the noffer. A raw noffer sticker is unpayable by anything that cannot supply
  // refund_pointer and there is no optional tier on an offer's payer_data (findings §6), so no
  // sticker is both generically payable and refundable. design.md §4 has the measurement too:
  // 110 characters and 43x43 modules, against the noffer's 237 and 59x59.
  const url = stickerUrl('https://npub1abc.nsite.lol', 'sobras-de-mudanza-mugs')
  assert.equal(url, 'https://npub1abc.nsite.lol/#/item/sobras-de-mudanza-mugs')
  assert.doesNotMatch(url, /noffer/)
})

test('a d tag with URL punctuation in it does not truncate the link', () => {
  // Our own slugs are [a-z0-9-] (listing.ts normaliseSlug), but an item imported from a sale
  // authored elsewhere carries whatever its author wrote, and a bare `#` ends a fragment.
  assert.match(stickerUrl('https://x.nsite.lol', 'a#b?c d'), /#\/item\/a%23b%3Fc%20d$/)
  // A trailing slash on the site URL must not produce `//#/`.
  assert.equal(stickerUrl('https://x.nsite.lol/', 'mugs'), 'https://x.nsite.lol/#/item/mugs')
})

test('sold items get no sticker, because the thing is gone', () => {
  const items = [item(), item({ d: 'x', sold: true }), item({ d: 'y' })]
  assert.deepEqual(stickerItems(items).map(i => i.d), ['sobras-de-mudanza-mugs', 'y'])
  // …and the ones already stuck on objects are exactly why the storefront needed
  // `missingItemNote`. This filter cannot reach them.
})
