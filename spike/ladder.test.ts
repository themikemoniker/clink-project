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
import { atStock, targetStock, unitsOf } from './ladder.ts'

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
