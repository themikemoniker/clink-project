// The parser is the trust boundary, so it is the thing with a test. Run: npm test
//
// The fixtures are signed with a key generated per run and held only in memory. That is the
// narrowest possible form of the /CLAUDE.md rule-2 exception: a test cannot prove that
// verifyEvent() actually rejects a forged event without producing a genuine signature to
// contrast against. Nothing here is persisted and nothing here ever sees a relay.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { orderBySale, parseListings, parseSales, srcset } from './listing.ts'

const sk = generateSecretKey()
const PK = getPublicKey(sk)
const OTHER = getPublicKey(generateSecretKey())

const listing = (tags: string[][], content = ''): Event =>
  finalizeEvent({ kind: 30402, created_at: 1_700_000_000, tags, content }, sk)

const base = (d: string, extra: string[][] = []) =>
  listing([['d', d], ['title', `Item ${d}`], ...extra])

const one = (ev: Event) => parseListings([ev], PK)[0]

test('a forged event is dropped', () => {
  const good = base('couch')
  assert.equal(parseListings([good], PK).length, 1)

  // How a relay actually delivers it: JSON off a socket, no in-process state attached.
  const fromWire = JSON.parse(JSON.stringify({ ...good, content: 'tampered after signing' }))
  assert.equal(parseListings([fromWire], PK).length, 0)

  // And the same tamper as an in-process spread, which carries nostr-tools' cached
  // `verified` symbol along with it and would otherwise be waved straight through.
  const spread = { ...good, content: 'tampered after signing' }
  assert.equal(parseListings([spread], PK).length, 0, 'cached verification must not be trusted')

  // A tag swap is the one that matters commercially: same content, different price.
  const repriced = JSON.parse(JSON.stringify(base('couch', [['price', '4200', 'MXN']])))
  repriced.tags = repriced.tags.map((t: string[]) => (t[0] === 'price' ? ['price', '1', 'MXN'] : t))
  assert.equal(parseListings([repriced], PK).length, 0)
})

test('an event by another pubkey is dropped even if validly signed', () => {
  const theirs = finalizeEvent(
    { kind: 30402, created_at: 1, tags: [['d', 'couch'], ['title', 'Not yours']], content: '' },
    generateSecretKey(),
  )
  assert.equal(parseListings([theirs], PK).length, 0)
  assert.equal(parseListings([theirs], OTHER).length, 0)
})

test('an event missing d or title is dropped', () => {
  assert.equal(parseListings([listing([['title', 'No d tag']])], PK).length, 0)
  assert.equal(parseListings([listing([['d', 'no-title']])], PK).length, 0)
})

test('sold is derived from stock 0 or status sold, and from nothing else', () => {
  assert.equal(one(base('a', [['stock', '0']]))!.sold, true)
  assert.equal(one(base('b', [['status', 'sold']]))!.sold, true)
  assert.equal(one(base('c', [['stock', '3']]))!.sold, false)
  assert.equal(one(base('d', [['status', 'active']]))!.sold, false)
  assert.equal(one(base('e'))!.sold, false)
  // stock wins where it is a real count; status still speaks for generic NIP-99 clients
  assert.equal(one(base('f', [['stock', '2'], ['status', 'sold']]))!.sold, true)
})

test('stock is undefined rather than guessed when the tag is not an integer', () => {
  assert.equal(one(base('a'))!.stock, undefined)
  assert.equal(one(base('b', [['stock', '']]))!.stock, undefined)
  assert.equal(one(base('c', [['stock', '-1']]))!.stock, undefined)
  assert.equal(one(base('d', [['stock', '2.5']]))!.stock, undefined)
  assert.equal(one(base('e', [['stock', '9e9']]))!.stock, undefined)
  assert.equal(one(base('f', [['stock', '12']]))!.stock, 12)
})

test('price tolerates the optional 4th frequency element and rejects nonsense', () => {
  // 99.md:38 / Gamma spec.md:110 — the two specs disagree on the frequency format, so we
  // read the first three elements and ignore the fourth however it is written.
  assert.deepEqual(one(base('a', [['price', '4200', 'MXN']]))!.price, { amount: 4200, currency: 'MXN' })
  assert.deepEqual(one(base('b', [['price', '15', 'EUR', 'month']]))!.price, { amount: 15, currency: 'EUR' })
  assert.deepEqual(one(base('c', [['price', '15', 'EUR', 'M']]))!.price, { amount: 15, currency: 'EUR' })
  assert.deepEqual(one(base('d', [['price', '0', 'MXN']]))!.price, { amount: 0, currency: 'MXN' })
  assert.deepEqual(one(base('e', [['price', '180000', 'sats']]))!.price, { amount: 180000, currency: 'sats' })
  assert.equal(one(base('f', [['price', '-5', 'MXN']]))!.price, undefined)
  assert.equal(one(base('g', [['price', 'free', 'MXN']]))!.price, undefined)
  assert.equal(one(base('h', [['price', '10']]))!.price, undefined)
})

test('only https image urls survive', () => {
  const hostile = one(base('x', [
    ['image', 'javascript:alert(1)'],
    ['image', 'data:text/html,<script>alert(1)</script>'],
    ['image', 'http://insecure.example/photo.jpg'],
    ['image', 'https://blossom.band/ok.jpg', '1200x900'],
  ]))!
  assert.equal(hostile.images.length, 1)
  assert.deepEqual(hostile.images[0], { url: 'https://blossom.band/ok.jpg', w: 1200, h: 900 })
})

test('image dimensions are optional and Gamma sort order is honoured', () => {
  // Gamma spec.md:135 — an absent dimension is the empty string, the 4th element is sort order
  const item = one(base('x', [
    ['image', 'https://b/third.jpg', '', '30'],
    ['image', 'https://b/first.jpg', '800x600', '10'],
    ['image', 'https://b/second.jpg', '800x600', '20'],
  ]))!
  assert.deepEqual(item.images.map(i => i.url), ['https://b/first.jpg', 'https://b/second.jpg', 'https://b/third.jpg'])
  assert.equal(item.images[2]!.w, undefined)
})

test('srcset builds from thumbs plus image and takes its box from real dimensions', () => {
  const item = one(base('x', [
    ['image', 'https://b/full.jpg', '1200x900'],
    ['thumb', 'https://b/mid.jpg', '480x360'],
    ['thumb', 'https://b/small.jpg', '160x120'],
  ]))!
  const s = srcset(item)!
  assert.equal(s.src, 'https://b/full.jpg')
  assert.equal(s.srcset, 'https://b/small.jpg 160w, https://b/mid.jpg 480w, https://b/full.jpg 1200w')
  assert.equal(s.aspect, '1200 / 900')
  // no dimensions anywhere: still renders, with a fallback box and no srcset
  const bare = one(base('y', [['image', 'https://b/one.jpg']]))!
  assert.deepEqual(srcset(bare), { src: 'https://b/one.jpg', srcset: undefined, aspect: '4 / 3' })
  assert.equal(srcset(one(base('z'))!), undefined)
})

test('control characters and bidi overrides are stripped from text', () => {
  const item = one(listing([
    ['d', 'x'],
    ['title', 'Couch\u202E gnihtemos\u202C\u0007'],
    ['summary', '  spaced  '],
  ]))!
  assert.equal(item.title.includes('\u202E'), false, 'RLO can fake a title')
  assert.equal(item.title.includes('\u202C'), false)
  assert.equal(item.title.includes('\u0007'), false)
  assert.equal(item.title, 'Couch gnihtemos')
  assert.equal(item.summary, 'spaced')
  // emoji sequences use ZWJ (200D) and must survive
  assert.equal(one(listing([['d', 'y'], ['title', 'Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}']]))!.title,
    'Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}')
})

test('markup in a title stays inert text, never markup', () => {
  // render.ts only ever assigns via textContent/append, so this string can reach the DOM
  // safely. The parser's job is to not silently mangle it into something else.
  const item = one(base('x'))!
  const nasty = one(listing([['d', 'y'], ['title', '<img src=x onerror=alert(1)>']]))!
  assert.equal(nasty.title, '<img src=x onerror=alert(1)>')
  assert.equal(typeof item.title, 'string')
})

test('only the newest version of an addressable event survives, ties on lowest id', () => {
  const old = finalizeEvent({ kind: 30402, created_at: 100, tags: [['d', 'couch'], ['title', 'Old'], ['stock', '1']], content: '' }, sk)
  const fresh = finalizeEvent({ kind: 30402, created_at: 200, tags: [['d', 'couch'], ['title', 'New'], ['stock', '0']], content: '' }, sk)
  const parsed = parseListings([fresh, old], PK)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]!.title, 'New')
  assert.equal(parsed[0]!.sold, true, 'a stale event must not resurrect a sold item')

  const tieA = finalizeEvent({ kind: 30402, created_at: 300, tags: [['d', 'tie'], ['title', 'A']], content: 'a' }, sk)
  const tieB = finalizeEvent({ kind: 30402, created_at: 300, tags: [['d', 'tie'], ['title', 'B']], content: 'b' }, sk)
  const winner = tieA.id < tieB.id ? 'A' : 'B'
  assert.equal(parseListings([tieA, tieB], PK)[0]!.title, winner)
})

test('a sale collection keeps only well-formed product coordinates', () => {
  const sale = parseSales([finalizeEvent({
    kind: 30405,
    created_at: 1,
    tags: [
      ['d', 'yardsale'],
      ['title', 'Moving Sale'],
      ['a', `30402:${PK}:couch`],
      ['a', '30402:not-a-pubkey:bike'],
      ['a', 'garbage'],
      ['a', `30405:${PK}:other-collection`],
    ],
    content: '',
  }, sk)], PK)[0]!
  assert.deepEqual(sale.itemRefs, [`30402:${PK}:couch`])
})

test('items render in the order the collection lists them, strays last', () => {
  const items = parseListings([base('bike'), base('couch'), base('unlisted')], PK)
  const sale = parseSales([finalizeEvent({
    kind: 30405,
    created_at: 1,
    tags: [['d', 's'], ['title', 'S'], ['a', `30402:${PK}:couch`], ['a', `30402:${PK}:bike`]],
    content: '',
  }, sk)], PK)[0]!
  assert.deepEqual(orderBySale(items, sale).map(i => i.d), ['couch', 'bike', 'unlisted'])
})

// --- slice 2: the Buy button's gate ------------------------------------------------------
// The same real noffer offer.test.ts uses: minted by the live Lightning.Pub for the fixture's
// `plants` item at a fixed 6000 sats, encoded by the reference SDK.
const OFFER_6000 =
  'noffer1qszqqqqhwqpszqqzgserxvrzvvcx2vt9v43kgwf4xsurxerxx93rvc358yunqcf3xyukyvmxx4jkgdf4v4snwwrrvejkvenxxscnyvt9x43rjefn8y6xgvenxvuxgeqpr9mhxue69uhhyetvv9ujumrfva58gmnfdenjuur4vgqzq0c2hedfg3hccr2zl7p7x9ne9j3e8vvjpjakahjswg6s29spt0huyqj43q'

test('an item is buyable only when its listed price and its offer are the same number', () => {
  const at = (amount: string, currency: string, extra: string[][] = []) =>
    one(base('x', [['price', amount, currency], ['clink_offer', OFFER_6000], ...extra]))!

  assert.equal(at('6000', 'sats').offer?.priceSats, 6000)
  assert.equal(at('6000', 'sat').offer?.priceSats, 6000, 'singular "sat" is the same currency')

  // The whole point of the check: a listing that advertises one price and points at an offer
  // priced differently is not buyable at all, in either direction.
  assert.equal(at('5999', 'sats').offer, undefined)
  assert.equal(at('60000', 'sats').offer, undefined)

  // No oracle, so no fiat purchase (/CLAUDE.md rule 1). Cash at the table instead.
  assert.equal(at('120', 'MXN').offer, undefined)
  assert.equal(at('6000', 'USD').offer, undefined)
})

test('a sold or unpriced or unpayable item gets no offer', () => {
  const with_ = (tags: string[][]) => one(base('x', [['clink_offer', OFFER_6000], ...tags]))!
  assert.equal(with_([['price', '6000', 'sats'], ['status', 'sold']]).offer, undefined)
  assert.equal(with_([['price', '6000', 'sats'], ['stock', '0']]).offer, undefined)
  assert.equal(with_([]).offer, undefined, 'no price tag')
  assert.equal(with_([['price', '0', 'sats']]).offer, undefined, 'free')
  // Lightning.Pub will not invoice below 10 sats, so a Buy button there is a button that fails.
  assert.equal(with_([['price', '9', 'sats']]).offer, undefined)
  assert.equal(with_([['price', '10', 'sats']]).offer, undefined, '10 sats, but the offer says 6000')
})

test('an unparseable clink_offer tag leaves the item unbuyable, never half-parsed', () => {
  const with_ = (raw: string) => one(base('x', [['price', '6000', 'sats'], ['clink_offer', raw]]))!
  assert.equal(with_('not-an-offer').offer, undefined)
  assert.equal(with_(OFFER_6000.slice(0, -4)).offer, undefined)
  assert.equal(with_('').offer, undefined)
  // An item with no tag at all is the slice-1 state, and must simply have no Buy button.
  assert.equal(one(base('y', [['price', '6000', 'sats']]))!.offer, undefined)
})
