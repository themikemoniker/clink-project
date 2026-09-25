// The ladder is what lets the watcher publish inventory without holding a key, so the ladder is
// the thing with a test. Run: npm test  (in /spike)
//
// Same style and same runner as storefront/src/listing.test.ts: node --test, node:assert, no
// framework. Fixtures are signed with a key generated per run and held only in memory — the
// narrowest form of the /CLAUDE.md rule-2 exception, and the only way to prove that a tampered
// step is actually rejected rather than merely looking rejected.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { parseListings } from '../storefront/src/listing.ts'
import * as nip44 from 'nostr-tools/nip44'
import {
  atStock,
  chooseLadder,
  isStale,
  ladderD,
  nofferOf,
  parseLadder,
  targetStock,
  unitsOf,
  type Rung,
} from './ladder.ts'

const sk = generateSecretKey()
const PK = getPublicKey(sk)
const NOFFER = 'noffer1qszqqqr4xqpszqqzgsmrqcekxcukxdnyvdjrxdtyv5erwcmzxvengvpcvyerydpjxgurqvecx43nve3jxgckzwfnx5enqd3kx5mxzwtxxgmkgc33vgcrsce5vfjkgwgpr9mhxue69uhhyetvv9ujumrfva58gmnfdenjuur4vgqzq0c2hedfg3hccr2zl7p7x9ne9j3e8vvjpjakahjswg6s29spt0hul9pz0s'

const tags = (stock?: string): string[][] => [
  ['d', 'yardsale-lamp'],
  ['title', 'Brass floor lamp'],
  ['price', '30000', 'sats'],
  ...(stock === undefined ? [] : [['stock', stock]]),
  ['status', 'active'],
  ['clink_offer', NOFFER],
]

// What seed-listings.ts does, reproduced so the test exercises the real shape.
const ladderFor = (base: string[][], units: number, now = 1_700_000_000): Event[] =>
  Array.from({ length: units }, (_, i) =>
    finalizeEvent({ kind: 30402, created_at: now + i + 1, tags: atStock(base, units - i - 1), content: '' }, sk),
  )

test('units default to one when the seller wrote no stock tag', () => {
  assert.equal(unitsOf(undefined), 1)
  assert.equal(unitsOf('3'), 3)
})

test('a step moves stock and status together, and both parse as the storefront reads them', () => {
  const steps = ladderFor(tags('3'), 3)
  const stock = steps.map(s => parseListings([s], PK)[0]!.stock)
  const sold = steps.map(s => parseListings([s], PK)[0]!.sold)
  assert.deepEqual(stock, [2, 1, 0])
  assert.deepEqual(sold, [false, false, true])
})

test('an item with no stock tag still reaches sold, via status alone', () => {
  const [step] = ladderFor(tags(), 1)
  const parsed = parseListings([step!], PK)[0]!
  assert.equal(parsed.stock, undefined, 'no stock tag invented')
  assert.equal(parsed.sold, true)
})

test('the sold step carries no payable offer', () => {
  const steps = ladderFor(tags('2'), 2)
  assert.ok(parseListings([steps[0]!], PK)[0]!.offer, 'still for sale, still buyable')
  assert.equal(parseListings([steps[1]!], PK)[0]!.offer, undefined, 'sold: §7.4(a), the offer goes')
  assert.equal(steps[1]!.tags.some(t => t[0] === 'clink_offer'), false, 'and the tag goes with it')
})

test('created_at strictly increases as stock falls, so availability cannot run backwards', () => {
  const steps = ladderFor(tags('4'), 4)
  const times = steps.map(s => s.created_at)
  assert.deepEqual([...times].sort((a, b) => a - b), times)
  assert.equal(new Set(times).size, times.length, 'no ties — NIP-01 would break them on event id')

  // NIP-01 newest-per-address is what makes an out-of-order publish a no-op. Hand the parser
  // the whole ladder shuffled and it must still answer with the last state.
  const shuffled = [steps[2]!, steps[0]!, steps[3]!, steps[1]!]
  const survivors = parseListings(shuffled, PK)
  assert.equal(survivors.length, 1)
  assert.equal(survivors[0]!.sold, true)
})

test('a tampered step is rejected, cached verification and all', () => {
  const [step] = ladderFor(tags('1'), 1)
  assert.equal(parseListings([step!], PK).length, 1)

  // The watcher loads the ladder from a file, so this is the realistic tamper: edit the JSON.
  const edited = JSON.parse(JSON.stringify(step))
  edited.tags = edited.tags.map((t: string[]) => (t[0] === 'price' ? ['price', '1', 'sats'] : t))
  assert.equal(parseListings([edited], PK).length, 0)

  // And the in-process spread, which carries nostr-tools' cached `verified` symbol with it and
  // would otherwise be waved straight through (/docs/spike-findings.md §13.10).
  assert.equal(parseListings([{ ...step!, content: 'tampered' }], PK).length, 0)
})

test('a step signed by anyone but the seller is rejected', () => {
  const theirs = finalizeEvent(
    { kind: 30402, created_at: 1_700_000_009, tags: atStock(tags('1'), 0), content: '' },
    generateSecretKey(),
  )
  assert.equal(parseListings([theirs], PK).length, 0)
})

test('stock is units minus settled invoices, clamped at zero', () => {
  assert.equal(targetStock(3, 0), 3)
  assert.equal(targetStock(3, 2), 1)
  assert.equal(targetStock(3, 3), 0)
  assert.equal(targetStock(3, 9), 0, 'an oversell is slice 7 refund territory, not negative stock')
  assert.equal(targetStock(1, -5), 1, 'a node answering nonsense must not resurrect an item')
})

test('a ladder cut from a superseded listing is refused, because publishing it fails silently', () => {
  // Slice 6's edit flow made this reachable. The rungs are newer than the listing they were cut
  // from — that is what makes availability monotone — so an EDIT, which publishes a listing
  // newer than all of them, inverts it. The relay then answers OK to a rung and stores nothing,
  // and the item stays for sale after it sold, with a clean "3/4 relays" line in the log.
  const rungs = [{ created_at: 1_700_000_001 }, { created_at: 1_700_000_002 }, { created_at: 1_700_000_003 }]

  assert.equal(isStale(rungs, 1_700_000_000), false, 'the listing these were cut from')
  assert.equal(isStale(rungs, 1_700_000_002), false, 'mid-sale: the live listing IS a rung')
  assert.equal(isStale(rungs, 1_700_000_003), false, 'sold out: the live listing is the last rung')
  assert.equal(isStale(rungs, 1_700_000_004), true, 'edited after the ladder was cut')

  // A relay that answered with nothing is not evidence of a stale ladder. The remedy for a
  // down relay is waiting; the remedy for a stale ladder is re-publishing. Confusing them
  // stops a working sale.
  assert.equal(isStale(rungs, undefined), false)
  // A single-unit item has exactly one rung, and it is the common case at a yard sale.
  assert.equal(isStale([{ created_at: 1_700_000_001 }], 1_700_000_002), true)
})

test('a one-of-a-kind item is watchable, which is the case inference used to lose', () => {
  // The common case at a yard sale, and it was silently unwatched until 2026-08-21: an item with
  // one unit has exactly ONE rung — the stock-0 one — and `atStock` strips `clink_offer` there by
  // design. Inferring the offer from a rung therefore found nothing, the watcher skipped the item
  // entirely, it sold, and the storefront kept its Buy button up. (/docs/known-defects.md)
  const ON_FILE = 'noffer1writtenbywhoevercutthisladder'
  const one = { noffer: ON_FILE, steps: [{ tags: atStock(tags('1'), 0) }] }
  assert.equal(one.steps[0]!.tags.some(t => t[0] === 'clink_offer'), false, 'the sold rung advertises nothing')
  assert.equal(nofferOf(one), ON_FILE)
  assert.equal(nofferOf({ steps: one.steps }), undefined, 'and this is what it used to be: nothing')

  // A ladder cut before the field existed still resolves, through the rung tag on a multi-unit
  // item and through .offers.json otherwise. Additive, so no file has to be re-cut to be safe.
  const three = [2, 1, 0].map(n => ({ tags: atStock(tags('3'), n) }))
  assert.equal(nofferOf({ steps: three }), NOFFER, 'a multi-unit item was always fine')
  assert.equal(nofferOf({ steps: one.steps }, 'noffer1fromoffersjson'), 'noffer1fromoffersjson')
  assert.equal(nofferOf({ steps: [] }), undefined, 'nothing to watch is not the same as watching nothing')

  // The file wins over the tag: an edit that re-priced the item re-minted the offer, and the
  // freshly cut ladder is the one that knows which offer the new listing actually points at.
  assert.equal(nofferOf({ noffer: ON_FILE, steps: three }), ON_FILE)
})

// --- M1: the ladder over a relay (2026-09-25) --------------------------------------------------
//
// What is provable offline is the `d` scheme, every bound on a payload that decrypted, every
// branch of the precedence rule, and that a real NIP-44 round trip between two ephemeral keys
// survives the parse. What is NOT provable here is the four-relay round trip, which is
// `check-ladder-relay.ts` on demand, and publishing a ladder as the real seller, which needs the
// keyed machine.
//
// The keys below are generated per run and held only in memory, the same narrow rule-2 exception
// the rest of this file already takes.

test('M1: the ladder d is derived from the item d, and collides with neither reserved name', () => {
  assert.equal(ladderD('yardsale-2026-08-lamp'), 'lamppost-ladder-yardsale-2026-08-lamp')
  // `notes.ts` takes `lamppost-shop`; CLINK Beacon reserves `clink-*` on this kind
  // (clink-beacon.md:195) and the running Pub publishes a legacy `Lightning.Pub`.
  assert.equal(ladderD('x').startsWith('clink-'), false)
  assert.notEqual(ladderD('x'), 'lamppost-shop')
  assert.notEqual(ladderD('x'), 'Lightning.Pub')
  // One event per item, so two items never share a d.
  assert.notEqual(ladderD('yardsale-2026-08-lamp'), ladderD('yardsale-2026-08-mugs'))
  // And two sales never share one either, which is what keeps M6 from colliding.
  assert.notEqual(ladderD('yardsale-2026-09-lamp'), ladderD('yardsale-2026-08-lamp'))
})

// A ladder payload that is exactly what publish.ts writes, built from real signed rungs so the
// parse is exercised against the shape it will actually meet rather than a hand-rolled object.
const realRung = (units: number): { units: number; noffer: string; steps: Event[] } => ({
  units,
  noffer: NOFFER,
  steps: Array.from({ length: units }, (_, i) =>
    finalizeEvent({ kind: 30402, created_at: 1_700_000_000 + i + 1, tags: atStock(tags(String(units)), units - i - 1), content: '' }, sk),
  ),
})

test('M1: a ladder payload publish.ts would write survives the parse unchanged', () => {
  const rung = realRung(3)
  const parsed = parseLadder(JSON.stringify(rung))
  assert.ok(parsed)
  assert.equal(parsed.units, 3)
  assert.equal(parsed.noffer, NOFFER)
  assert.equal(parsed.steps.length, 3)
  // Same bytes on the relay as in the file, which is what makes precedence a straight swap and
  // keeps there being one parser rather than two.
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), JSON.parse(JSON.stringify(rung)))
  // And the rungs still go through the real door afterwards: parseLadder asserts nothing about a
  // signature, `stepFor` does, so a parsed step must still verify.
  const verified = parseListings([parsed.steps[0] as unknown as Event], PK)[0]
  assert.ok(verified, 'a parsed rung must still survive the storefront parser that stepFor uses')
})

test('M1: a corrupt or oversized payload reads as NO ladder rather than throwing', () => {
  // Never throws: this runs inside the watcher's tick, and the watcher is the only thing
  // republishing stock. A bad payload costs one unwatched item, not the process.
  for (const bad of [
    undefined, null, 42, '', 'not json', '[]', '"a string"', 'null',
    '{}', // no units, no steps
    JSON.stringify({ units: 1 }), // no steps
    JSON.stringify({ units: 1.5, steps: [] }),
    // A field of the WRONG TYPE, not merely the wrong value. These two do NOT bite: measured
    // 2026-09-25, `Number.isSafeInteger` already rejects a string, so removing the `typeof` guards
    // beside it changes no outcome here. They are kept as regression documentation, and they are
    // recorded as not-biting rather than presented as the thing that caught the cast — what caught
    // that was `tsc` in /builder.
    JSON.stringify({ units: '1', steps: [] }),
    JSON.stringify({ units: 1, steps: [{ id: 'x', pubkey: 'p', sig: 'y', kind: 30402, created_at: 'soon', tags: [], content: '' }] }),
    JSON.stringify({ units: -1, steps: [] }),
    JSON.stringify({ units: 100_000, steps: [] }), // over MAX_STEPS
    JSON.stringify({ units: 0, steps: {} }), // steps not an array
    JSON.stringify({ units: 1, steps: [null] }),
    JSON.stringify({ units: 1, steps: ['a string'] }),
    JSON.stringify({ units: 1, steps: [{ id: 'x' }] }), // no sig
    // A step with no `pubkey` is the defect this file's round-trip test caught in the first
    // draft of `parseLadder`: without it `stepFor`'s verification cannot run at all.
    JSON.stringify({ units: 1, steps: [{ id: 'x', sig: 'y', kind: 30402, created_at: 1, tags: [], content: '' }] }),
    JSON.stringify({ units: 1, steps: [{ id: 'x', sig: 'y', kind: 30402, created_at: 1, tags: 'no', content: '' }] }),
    JSON.stringify({ units: 1, steps: [{ id: 'x', sig: 'y', kind: 30402, created_at: 1, tags: [[1]], content: '' }] }),
    JSON.stringify({ units: 1, steps: [{ id: 'x', sig: 'y', kind: 30402, created_at: 1.5, tags: [], content: '' }] }),
    JSON.stringify({ ...realRung(1), noffer: 'n'.repeat(3_000) }),
    'x'.repeat(65_536), // over NIP-44's own plaintext ceiling, so it was never a NIP-44 payload
  ]) {
    assert.equal(parseLadder(bad), null, `should refuse: ${String(bad).slice(0, 60)}`)
  }
})

test('M1: a ladder whose step count disagrees with its own units is refused once, not every tick', () => {
  // `stepFor` indexes `steps[units - target - 1]`. A disagreement here throws there instead, one
  // tick at a time, for the rest of the sale. So it dies at the parse.
  const rung = realRung(3)
  assert.equal(parseLadder(JSON.stringify({ ...rung, units: 4 })), null)
  assert.equal(parseLadder(JSON.stringify({ ...rung, steps: rung.steps.slice(0, 2) })), null)
  // The honest zero case: no units, no rungs, and that parses fine. A stock-0 item is published
  // sold and has no ladder to walk.
  assert.deepEqual(parseLadder(JSON.stringify({ units: 0, steps: [] })), { units: 0, noffer: undefined, steps: [] })
})

test('M1: the ladder survives a real NIP-44 round trip to a DIFFERENT key', () => {
  // The whole reason M1 needs a third key: the watcher decrypts, so encrypt-to-self would require
  // the watcher to hold the seller's private key. Proven here with two separate keys rather than
  // asserted: seller encrypts to watcher, watcher decrypts with (its own private, seller public).
  const watcherSk = generateSecretKey()
  const watcherPk = getPublicKey(watcherSk)
  assert.notEqual(watcherPk, PK)

  const rung = realRung(2)
  const toWatcher = nip44.v2.utils.getConversationKey(sk, watcherPk)
  const ciphertext = nip44.v2.encrypt(JSON.stringify(rung), toWatcher)

  const atWatcher = nip44.v2.utils.getConversationKey(watcherSk, PK)
  const parsed = parseLadder(nip44.v2.decrypt(ciphertext, atWatcher))
  assert.ok(parsed)
  assert.equal(parsed.steps.length, 2)
  assert.equal(parsed.noffer, NOFFER)

  // And a third party who is neither seller nor watcher cannot open it, which is what stops the
  // rungs advertising the lowest stock on every item.
  const strangerSk = generateSecretKey()
  assert.throws(() => nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(strangerSk, PK)))
})

test('M1: precedence — the relay wins when it decrypts, the file is the cold-start fallback', () => {
  const relay = realRung(3) as unknown as Rung
  const file = realRung(1) as unknown as Rung

  // The four rules from the design, in order.
  assert.deepEqual(chooseLadder(relay, file, false), { rung: relay, source: 'relay', degraded: false })
  assert.deepEqual(chooseLadder(null, file, false), { rung: file, source: 'file', degraded: false })
  assert.deepEqual(chooseLadder(null, null, false), { rung: null, source: 'none', degraded: false })

  // THE BRANCH THAT MATTERS. A failed read must not read as a stale ladder
  // (`watch-sales.ts:204`), so the file wins and `degraded` is what makes it loud.
  assert.deepEqual(chooseLadder(null, file, true), { rung: file, source: 'file', degraded: true })
  // Even when the relay did produce something: the read may have been partial, and nothing here
  // knows how much was missing.
  assert.deepEqual(chooseLadder(relay, file, true), { rung: file, source: 'file', degraded: true })
  // With no file at all, an authentic relay copy still beats not watching the item.
  assert.deepEqual(chooseLadder(relay, null, true), { rung: relay, source: 'relay', degraded: true })
  // And with neither, the item is not watched and is named in the startup report.
  assert.deepEqual(chooseLadder(null, null, true), { rung: null, source: 'none', degraded: true })
})
