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
import {
  atStock,
  chooseLadder,
  isStale,
  LADDER_KIND,
  ladderD,
  listingDOf,
  MAX_LADDER_PLAINTEXT,
  MAX_RUNGS,
  nofferOf,
  parseRung,
  targetStock,
  unitsOf,
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

// ---------------------------------------------------------------------------------------------
// M1: the ladder travels over a relay instead of a USB stick.
//
// Everything below is the keyless half — the part both the builder (which encrypts) and the
// watcher (which decrypts) have to agree on, and none of it touches a private key. The transport
// is the only thing changing; `stepFor` in watch-sales.ts still re-verifies every rung before it
// publishes one, so these tests are about addressing, bounds and precedence, not about trust.

test('the ladder event is addressed to match the listing it belongs to', () => {
  // The ladder `d` mirrors the item's own `d` so the pair is obvious on a relay, and so two sales
  // by the same seller cannot land on one another: NIP-01 replaces on (kind, pubkey, d), so a
  // colliding `d` would silently overwrite the other sale's ladder.
  assert.equal(ladderD('yardsale-2026-08-lamp'), 'lamppost-ladder-yardsale-2026-08-lamp')
  assert.notEqual(ladderD('a'), ladderD('b'))

  // The prefix is clear of both neighbours on this kind. CLINK Beacon reserves `clink-*`
  // (`clink-beacon.md:195`, via /docs/clink-notes.md §6) and the running Lightning.Pub still
  // publishes a legacy `d = "Lightning.Pub"` (`nostrPool.ts:53`); notes.ts takes `lamppost-shop`.
  assert.equal(ladderD('x').startsWith('clink-'), false)
  assert.notEqual(ladderD('x'), 'lamppost-shop') // builder/src/notes.ts:25
  assert.equal(LADDER_KIND, 30078, 'NIP-78 addressable application data, same kind as the notes')
})

test('a ladder payload that did not come from us reads as no ladder, and never throws', () => {
  // The decrypted plaintext is the one genuinely new attack surface M1 adds: everything else on
  // the path is signature-verified before we look at it. Same bounds discipline as `parseNotes`
  // in builder/src/notes.ts, and the same contract — a corrupt payload is "no ladder", not an
  // exception that takes the watcher down mid-sale.
  const good = { units: 3, noffer: 'noffer1abc', steps: [{ created_at: 1 }, { created_at: 2 }] }
  assert.deepEqual(parseRung(JSON.stringify(good)), good, 'a payload we wrote round-trips whole')

  assert.equal(parseRung('not json at all'), undefined)
  assert.equal(parseRung(''), undefined)
  assert.equal(parseRung('null'), undefined)
  assert.equal(parseRung('[]'), undefined, 'an array is not a rung')
  assert.equal(parseRung('"a string"'), undefined)
  assert.equal(parseRung('{}'), undefined, 'no units and no steps is not a rung')
  assert.equal(parseRung(JSON.stringify({ units: 3 })), undefined, 'units without steps')
  assert.equal(parseRung(JSON.stringify({ steps: [] })), undefined, 'steps without units')
  assert.equal(parseRung(JSON.stringify({ units: 'three', steps: [] })), undefined)
  assert.equal(parseRung(JSON.stringify({ units: -1, steps: [{}] })), undefined, 'negative units')
  assert.equal(parseRung(JSON.stringify({ units: 1, steps: {} })), undefined, 'steps must be a list')
  assert.equal(parseRung(JSON.stringify({ units: 1, steps: ['not an event'] })), undefined)
  assert.equal(parseRung(JSON.stringify({ units: 1, steps: [{}], noffer: 42 })), undefined)

  // Bounded by size and by count, so a relay cannot hand us something that costs more to reject
  // than to accept. The fattest real item in the Mérida sale is 19,906 bytes.
  assert.equal(parseRung('x'.repeat(MAX_LADDER_PLAINTEXT + 1)), undefined, 'oversized plaintext')
  const tooMany = { units: 1, steps: Array.from({ length: MAX_RUNGS + 1 }, () => ({ created_at: 1 })) }
  assert.equal(parseRung(JSON.stringify(tooMany)), undefined, 'more rungs than any yard sale has')
})

test('precedence: the relay wins when it decrypts, the file is the cold-start fallback', () => {
  // The four branches of the decision, and the reason the middle two are not one branch:
  // watch-sales.ts:345 already binds the rule this must not break — "the relay is down" must not
  // read as "your ladder is stale". A failed read and an absent ladder are different sentences
  // because their remedies are different: one is waiting, the other is publishing.
  const RELAY = { units: 3, steps: [{ created_at: 9 }] }
  const FILE = { units: 2, steps: [{ created_at: 1 }] }

  const fromRelay = chooseLadder(RELAY, FILE, false)
  assert.equal(fromRelay.rung, RELAY, 'a ladder that decrypted outranks the file on disk')
  assert.equal(fromRelay.source, 'relay')
  assert.equal(fromRelay.warn, undefined)

  // A relay that answered with nothing is the ordinary cold start: the seller has not published
  // a ladder over a relay yet, and the file they copied across is still exactly right.
  const coldStart = chooseLadder(undefined, FILE, false)
  assert.equal(coldStart.rung, FILE)
  assert.equal(coldStart.source, 'file')
  assert.equal(coldStart.warn, undefined, 'no relay ladder yet is not a fault worth shouting about')

  // A relay we could not read is a fault, and the file we fall back to may be older than what the
  // seller last published. Watching it is still better than not watching, but it is not silent.
  const failedOver = chooseLadder(undefined, FILE, true)
  assert.equal(failedOver.rung, FILE)
  assert.equal(failedOver.source, 'file')
  assert.match(String(failedOver.warn), /relay/i, 'and it says which half failed')

  const nothing = chooseLadder(undefined, undefined, false)
  assert.equal(nothing.rung, undefined)
  assert.equal(nothing.source, 'none')
  assert.match(String(nothing.warn), /ladder/i, 'an unwatched item has to be named, not skipped')

  const nothingAfterFailure = chooseLadder(undefined, undefined, true)
  assert.equal(nothingAfterFailure.source, 'none')
  assert.match(String(nothingAfterFailure.warn), /relay/i)

  // A relay ladder still wins even when the read was partially broken: one relay answering is
  // enough to know what the seller last published, and three others timing out does not make it
  // less true.
  assert.equal(chooseLadder(RELAY, FILE, true).source, 'relay')
})

test('a ladder d maps back to the item it belongs to, and other 30078s are not ours', () => {
  // The watcher cannot ask for ladders by name: it does not know what the seller has published
  // until it reads them, which is the point of M1. So it subscribes to the seller's 30078s and
  // sorts them out here, which makes this the function that decides what counts as one of ours.
  assert.equal(listingDOf(ladderD('yardsale-2026-08-lamp')), 'yardsale-2026-08-lamp')
  assert.equal(listingDOf(ladderD('a-b-c')), 'a-b-c', 'an item d with its own dashes survives')

  // Kind 30078 is shared ground and the seller's own key writes to it. `lamppost-shop` is the
  // private notes (builder/src/notes.ts:25) and would decrypt for the SELLER but not for us; the
  // reserved `clink-*` names belong to CLINK Beacon. Reading any of them as a ladder would be
  // this watcher inventing an item that does not exist.
  assert.equal(listingDOf('lamppost-shop'), undefined)
  assert.equal(listingDOf('clink-node'), undefined)
  assert.equal(listingDOf('Lightning.Pub'), undefined)
  assert.equal(listingDOf(''), undefined)
  assert.equal(listingDOf('lamppost-ladder-'), undefined, 'the prefix alone names no item')
})
