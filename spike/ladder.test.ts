// The ladder is what lets the watcher publish inventory without holding a key, so the ladder is
// the thing with a test. Run: npm test  (in /spike)
//
// Same style and same runner as storefront/src/listing.test.ts: node --test, node:assert, no
// framework. Fixtures are signed with a key generated per run and held only in memory — the
// narrowest form of the /CLAUDE.md rule-2 exception, and the only way to prove that a tampered
// step is actually rejected rather than merely looking rejected.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { matchFilter } from 'nostr-tools/filter'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { parseListings } from '../storefront/src/listing.ts'
import {
  admitLive,
  atStock,
  chooseLadder,
  isStale,
  LADDER_KIND,
  ladderD,
  ladderStamps,
  ladderWindow,
  listingDOf,
  MAX_LADDER_PLAINTEXT,
  MAX_RUNGS,
  nofferOf,
  parseRung,
  type Rung,
  soldCounts,
  type Stamp,
  startupStamps,
  stampOf,
  supersedes,
  targetStock,
  unitsOf,
} from './ladder.ts'
import { oversold, type Settled } from './refund.ts'

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
  // Compared as it travels: `finalizeEvent` marks a step `Symbol(verified)`, which no JSON carries.
  const good = JSON.parse(JSON.stringify({ units: 3, noffer: 'noffer1abc', steps: ladderFor(tags('3'), 3) }))
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

test('a payload whose steps are not events reads as no ladder, and nothing downstream can throw on what does parse', () => {
  // `nofferOf` and `isStale` both read the steps before `stepFor` verifies a signature: the first
  // via `withOffer` at watcher startup, the second in the stale check. So a rung `parseRung`
  // returns has to be safe for both. Every case has no `noffer`, so `nofferOf` really reaches the
  // steps, and every built case is a real signed step with exactly one field broken.
  const real: Event[] = JSON.parse(JSON.stringify(ladderFor(tags('3'), 3))) // as it travels, as above
  const broken = (patch: Record<string, unknown>, drop?: string): string => {
    const step: Record<string, unknown> = { ...real[0]!, ...patch }
    if (drop) delete step[drop]
    return JSON.stringify({ units: 1, steps: [step] })
  }
  const cases: [string, string][] = [
    ['{"units":1,"steps":[{}]}', 'the item\'s repro: an object that is not an event'],
    [broken({ tags: 'x' }), 'tags that are not a list'],
    [broken({ tags: [null] }), 'a tag that is not a list'],
    [broken({ tags: [['clink_offer', 5]] }), 'a tag value that is not a string'],
    [broken({}, 'created_at'), 'no created_at'],
    [broken({ created_at: '1700000001' }), 'created_at as a string'],
    // By hand: JSON.stringify(Infinity) is null, and JSON.parse('1e999') is Infinity.
    [broken({ created_at: 0 }).replace('"created_at":0', '"created_at":1e999'), 'created_at past any safe integer'],
  ]
  assert.ok(cases[6]![0].includes('"created_at":1e999'), 'the 1e999 case was really written')

  for (const [payload, why] of cases) {
    const rung = parseRung(payload)
    // The whole path, not just the parser: whatever does get through must not throw downstream.
    if (rung !== undefined) {
      assert.doesNotThrow(() => nofferOf(rung), `nofferOf on ${why}`)
      assert.doesNotThrow(() => isStale(rung.steps, 1_700_000_000), `isStale on ${why}`)
    }
    assert.equal(rung, undefined, why)
  }

  // And what does parse is still judged: steps strictly older than the listing are stale.
  const old = parseRung(JSON.stringify({ units: 3, steps: real }))!
  assert.equal(isStale(old.steps, 1_700_000_004), true, 'every step is older than the listing')
  assert.equal(isStale(old.steps, 1_700_000_003), false, 'equal is not stale')

  // A real signed ladder, with and without `noffer`, round-trips whole and yields its offer.
  for (const rung of [{ units: 3, steps: real }, { units: 3, noffer: NOFFER, steps: real }]) {
    const parsed = parseRung(JSON.stringify(rung))
    assert.deepEqual(parsed, rung)
    assert.equal(nofferOf(parsed!), NOFFER)
  }
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

// The watcher's tick awaits the node (GetUserOfferInvoices), maybe a refund, and a publish before
// it writes the sold count, and the ladder subscription can fire during any of them. A timer
// stands in for those awaits, as refund.test.ts `fakeTick` does, so the interleaving is real.
const awaitNode = () => new Promise(resolve => setTimeout(resolve, 5))

test('a tick in flight when a new ladder arrives cannot write its count back', async () => {
  const counts = soldCounts()
  const tick = async () => {
    const gen = counts.generation('lamp') // top of tick, before the first await
    await awaitNode()
    return counts.record('lamp', gen, 1) // the count computed against the OLD rung
  }
  const newLadder = async () => {
    await new Promise(resolve => setTimeout(resolve, 1)) // lands while the tick is awaiting
    counts.invalidate('lamp')
  }
  const [recorded] = await Promise.all([tick(), newLadder()])
  assert.equal(recorded, false, 'the stale count is refused')
  assert.equal(counts.get('lamp'), undefined, 'so the next tick finds no count and recomputes')
})

test('and the same interleaving on a bare Map keeps the stale count, so the race is real', async () => {
  // What watch-sales.ts did before: `lastSold.delete` in the callback, `lastSold.set` after the
  // await. The next tick sees count 1 again and skips the new ladder.
  const lastSold = new Map<string, number>()
  const tick = async () => {
    await awaitNode()
    lastSold.set('lamp', 1)
  }
  const newLadder = async () => {
    await new Promise(resolve => setTimeout(resolve, 1))
    lastSold.delete('lamp')
  }
  await Promise.all([tick(), newLadder()])
  assert.equal(lastSold.get('lamp'), 1, 'second tick skipped new ladder')
})

test('an item replaced while another item is awaiting keeps its round generation, and is refused', async () => {
  // The tick walks the array it started with, so it reaches B's OLD entry after B was replaced.
  // Generations taken together at the top of the round are what make that write refusable.
  const counts = soldCounts()
  const round = ['a', 'b'].map(d => ({ d, gen: counts.generation(d) }))
  const results: Record<string, boolean> = {}
  const tick = async () => {
    for (const { d, gen } of round) {
      await awaitNode()
      results[d] = counts.record(d, gen, 2)
    }
  }
  const replaceB = async () => {
    await new Promise(resolve => setTimeout(resolve, 1)) // while a's await is pending
    counts.invalidate('b')
  }
  await Promise.all([tick(), replaceB()])
  assert.equal(results.b, false, 'b was recorded against a ladder that no longer exists')
  assert.equal(counts.get('b'), undefined)
  assert.equal(results.a, true, 'a was not replaced, so its count stands')
  assert.equal(counts.get('a'), 2)
})

test('with no new ladder, a tick records its count and the next tick sees it', async () => {
  const counts = soldCounts()
  const gen = counts.generation('lamp')
  await awaitNode()
  assert.equal(counts.record('lamp', gen, 3), true)
  assert.equal(counts.get('lamp'), 3)
})

// The refund path is the same race with money on it. watch-sales.ts `tick` reads the settled rows,
// then `refundOversells` pays `oversold(rows, rung.units)`, one `payDebit` await per row. Units 1,
// A paid first: B is owed under the old ladder. A ladder with units 2 lands mid-await: B is not.
const sale = (invoice: string, paid_at_unix: number): Settled => ({ invoice, offer_id: 'o1', paid_at_unix, amount: 21 })
const newLadder = (counts: ReturnType<typeof soldCounts>) => async () => {
  await new Promise(resolve => setTimeout(resolve, 1)) // lands while the tick is awaiting
  counts.invalidate('lamp')
}

test('a refund decided against a ladder replaced mid-await pays nobody', async () => {
  const counts = soldCounts()
  const rows = [sale('A', 1), sale('B', 2)]
  const tick = async (): Promise<string[]> => {
    const gen = counts.generation('lamp') // top of tick, before the first await
    await awaitNode()
    if (!counts.current('lamp', gen)) return []
    return oversold(rows, 1).map(r => r.invoice)
  }
  const [refunded] = await Promise.all([tick(), newLadder(counts)()])
  assert.deepEqual(refunded, [], 'nobody is refunded against the replaced rung')
  assert.deepEqual(oversold(rows, 2), [], 'and the next tick, on the new rung, owes nobody either')
})

test('and the same interleaving without the check refunds B, so the race is real', async () => {
  const counts = soldCounts()
  const rows = [sale('A', 1), sale('B', 2)]
  const tick = async (): Promise<string[]> => {
    await awaitNode()
    return oversold(rows, 1).map(r => r.invoice)
  }
  const [refunded] = await Promise.all([tick(), newLadder(counts)()])
  assert.deepEqual(refunded, ['B'], 'B is paid a refund it is not owed under the ladder now held')
  assert.equal(counts.generation('lamp'), 1, 'and the new ladder really did land during the await')
})

// `refundOversells` in miniature: the check at the top of each row, one await per payment.
const refundLoop = async (counts: ReturnType<typeof soldCounts>, gen: number, rows: Settled[], units: number) => {
  const paid: string[] = []
  for (const row of oversold(rows, units)) {
    if (!counts.current('lamp', gen)) return paid
    await awaitNode() // payDebit
    paid.push(row.invoice)
  }
  return paid
}

test('a ladder replaced between two refund payments stops the second', async () => {
  const counts = soldCounts()
  const rows = [sale('A', 1), sale('B', 2), sale('C', 3)]
  const gen = counts.generation('lamp')
  const [paid] = await Promise.all([refundLoop(counts, gen, rows, 1), newLadder(counts)()]) // during B's await
  assert.deepEqual(paid, ['B'], 'B was already sent when the ladder landed; C was decided after it and is not')
})

test('with no new ladder, every oversold buyer is refunded', async () => {
  const counts = soldCounts()
  const rows = [sale('A', 1), sale('B', 2), sale('C', 3)]
  const paid = await refundLoop(counts, counts.generation('lamp'), rows, 1)
  assert.deepEqual(paid, ['B', 'C'])
})

// watch-sales.ts `tick` after the refunds: the recheck at :710, the count early-out, one await per publish.
const tickTail = async (
  counts: ReturnType<typeof soldCounts>,
  gen: number,
  rows: Settled[],
  units: number,
  published: number[],
  recheck = true,
) => {
  await refundLoop(counts, gen, rows, units)
  if (recheck && !counts.current('lamp', gen)) return
  const sold = oversold(rows, 0).length
  if (counts.get('lamp') === sold) return
  const target = targetStock(units, sold)
  await awaitNode() // publish
  published.push(target)
  counts.record('lamp', gen, sold)
}

test('a ladder landing during the refunds publishes nothing for the old rung', async () => {
  const counts = soldCounts()
  const rows = [sale('A', 1), sale('B', 2), sale('C', 3)]
  const gen = counts.generation('lamp') // top of tick, before the first await
  const published: number[] = []
  await Promise.all([tickTail(counts, gen, rows, 1, published), newLadder(counts)()]) // during B's await
  assert.deepEqual(published, [], 'no stock step is published against the replaced rung')
  assert.equal(counts.get('lamp'), undefined, 'and no count is kept, so the next tick recomputes')
  assert.equal(counts.generation('lamp'), 1, 'and the new ladder really did land during the refunds')
})

test("and the same interleaving without the recheck publishes the old rung's stock 0, so the race is real", async () => {
  // `invalidate` deleted the count, so the `counts.get === sold` early-out cannot stand in for :710.
  const counts = soldCounts()
  const rows = [sale('A', 1), sale('B', 2), sale('C', 3)]
  const gen = counts.generation('lamp')
  const published: number[] = []
  await Promise.all([tickTail(counts, gen, rows, 1, published, false), newLadder(counts)()])
  assert.deepEqual(published, [0], 'the old rung\'s sold step goes out after the new ladder landed')
})

test('with no new ladder, the tick publishes the stock step after the refunds', async () => {
  const counts = soldCounts()
  const rows = [sale('A', 1), sale('B', 2), sale('C', 3)]
  const published: number[] = []
  await tickTail(counts, counts.generation('lamp'), rows, 1, published)
  assert.deepEqual(published, [0])
  assert.equal(counts.get('lamp'), 3)
})

test('tick rechecks the ladder generation between the refunds and the publish', () => {
  // The models above cannot see watch-sales.ts, and `tick` cannot be imported: the file runs at
  // import (see the note above `tmpJournal` in refund.test.ts). So this reads the source, and fails
  // if the recheck is deleted or moved out from between the refunds and the publish.
  const src = readFileSync(new URL('./watch-sales.ts', import.meta.url), 'utf8')
  const start = src.indexOf('const tick = async () => {')
  assert.ok(start >= 0, 'tick is where this test expects it')
  const end = src.indexOf('\n}\n', start)
  assert.ok(end > start, 'and its body ends')
  const body = src.slice(start, end)

  const refunds = body.indexOf('refundOversells(d, rows, rung.units, gen)')
  assert.ok(refunds >= 0, 'tick refunds against the round generation')
  // From `refunds`, because the post-read check (:689) has the same `counts.current(d, gen)` text.
  const recheck = body.indexOf('if (!counts.current(d, gen)) continue', refunds)
  assert.ok(recheck > refunds, 'the generation is rechecked after the refunds')
  const publish = body.indexOf('publish(stepFor(')
  assert.ok(publish >= 0, 'tick publishes a step')
  assert.ok(recheck < publish, 'and before the publish')
})

// A delayed older ladder must not replace a newer one. Relays delay and replay, so the live
// subscription can deliver the ladder from created_at 100 after the one from 200, and before
// `supersedes` it replaced unconditionally while the startup read compared timestamps. Each event
// is real and signed, so its id is a real id and the tie-break below is the one a relay would see.
const ladderEvent = (created_at: number, units: number, tag = '', steps: Event[] = []) =>
  finalizeEvent(
    {
      kind: LADDER_KIND,
      created_at,
      tags: [['d', ladderD('lamp')]],
      // The payload as it reads after NIP-44 decryption. `tag` makes two events at one timestamp
      // different events; parseRung ignores it. `steps` defaults to none, which `isStale` reads as
      // stale against any defined listing time, so only tests that pass real steps pass `publishedAt`.
      content: JSON.stringify({ units, noffer: NOFFER, steps, tag }),
    },
    sk,
  )

// The subscription callback's sequence, in its order: parse, `admitLive` (compare, then staleness
// against `publishedAt`, the listing time startup read), offer check, replace, then record the
// stamp. `offerOk` stands in for `withOffer`, which can drop a ladder after it compared as newer.
// `publishedAt` undefined is "no live listing", which `isStale` never judges.
type Outcome = 'unparsed' | 'older' | 'stale' | 'no-offer' | 'adopted'
const deliverWhy = (
  held: Map<string, Rung>,
  stamps: ReturnType<typeof ladderStamps>,
  ev: Event,
  offerOk = true,
  publishedAt?: number,
): Outcome => {
  const rung = parseRung(ev.content)
  if (!rung) return 'unparsed'
  const admitted = admitLive(stamps.get('lamp'), ev, rung.steps, publishedAt)
  if (admitted !== 'newer') return admitted
  if (!offerOk) return 'no-offer'
  held.set('lamp', rung)
  stamps.adopted('lamp', ev)
  return 'adopted'
}
const deliver = (held: Map<string, Rung>, stamps: ReturnType<typeof ladderStamps>, ev: Event, offerOk = true): boolean =>
  deliverWhy(held, stamps, ev, offerOk) === 'adopted'

test('a delayed older ladder does not replace the newer one held', () => {
  const newer = ladderEvent(200, 5)
  const older = ladderEvent(100, 2)
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  assert.equal(deliver(held, stamps, newer), true)
  assert.equal(deliver(held, stamps, older), false, 'the delayed older event is refused')
  assert.equal(held.get('lamp')?.units, 5)
  assert.equal(stamps.get('lamp')?.id, newer.id, 'and what is held is the 200 event, by id')
})

test('and the same two events through an unconditional replace roll the ladder back, so the race is real', () => {
  // What the subscription callback did before: `watching = [...filter, next]`, no comparison.
  const held = new Map<string, Rung>()
  for (const ev of [ladderEvent(200, 5), ladderEvent(100, 2)]) held.set('lamp', parseRung(ev.content)!)
  assert.equal(held.get('lamp')?.units, 2, 'newer units=5 replaced by delayed older units=2')
})

const permutations = <T>(xs: T[]): T[][] =>
  xs.length <= 1
    ? [xs]
    : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]))

test('the startup read and the live subscription pick the same ladder, in every delivery order', () => {
  const older = ladderEvent(100, 2)
  const tieA = ladderEvent(200, 5, 'a')
  const tieB = ladderEvent(200, 7, 'b')
  const events = [older, tieA, tieB, tieA] // a delayed older one, a tie, and the same event twice
  // Computed as listing.test.ts does, not hard-coded and not with the rule under test.
  const winner = tieA.id < tieB.id ? tieA : tieB

  // Startup: the whole array at once, folded as `readRelayLadders` folds it.
  let at: Stamp | undefined
  let startup: Rung | undefined
  for (const ev of events) {
    const rung = parseRung(ev.content)
    if (rung && supersedes(at, ev)) {
      at = stampOf(ev)
      startup = rung
    }
  }
  assert.equal(at?.id, winner.id, 'the tie at 200 goes to the lower id')
  assert.equal(startup?.units, winner === tieA ? 5 : 7)

  // Live: one at a time, in every order.
  const orders = permutations(events)
  assert.equal(orders.length, 24)
  for (const order of orders) {
    const held = new Map<string, Rung>()
    const stamps = ladderStamps()
    for (const ev of order) deliver(held, stamps, ev)
    assert.equal(stamps.get('lamp')?.id, winner.id, `order ${order.map(e => e.created_at).join(',')}`)
    assert.deepEqual(held.get('lamp'), startup)
  }
})

test('the same event again is not newer, so a second relay delivering it changes nothing', () => {
  const ev = ladderEvent(200, 5)
  assert.equal(supersedes(stampOf(ev), ev), false)
})

test('with nothing held, any ladder is newer', () => {
  assert.equal(supersedes(undefined, ladderEvent(100, 2)), true)
})

test('a newer ladder dropped by the offer check leaves the stamp with the ladder still held', () => {
  // Order matters in the callback: compare, withOffer, replace, record. Recording before the
  // offer check would stamp 300 beside the 100 ladder, and the good 200 one would then be refused.
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  const first = ladderEvent(100, 2)
  assert.equal(deliver(held, stamps, first), true)
  assert.equal(deliver(held, stamps, ladderEvent(300, 9), false), false)
  assert.equal(stamps.get('lamp')?.id, first.id)
  const good = ladderEvent(200, 5)
  assert.equal(deliver(held, stamps, good), true, 'older than the dropped one, newer than the held one')
  assert.equal(held.get('lamp')?.units, 5)
  assert.equal(stamps.get('lamp')?.id, good.id)
})

// The gap between the startup query and the subscription. Startup work between the two is
// unbounded (the listings query, a human at the refund prompt, the first tick), and a `since` read
// when the subscription opens drops whatever the seller published meanwhile. `matchFilter` decides
// delivery against the subscription's own filter, so `since` means what nostr-tools makes it mean
// (filter.js: `created_at < since` is dropped) rather than what this test assumes.
const subFilter = (since: number) => ({ kinds: [LADDER_KIND], authors: [PK], since })

// The whole live callback in its order: the startup check first, then `deliver`'s parse, compare,
// offer check, replace and stamp, then the invalidation. `window` undefined is the callback without
// the startup check.
const deliverLive = (
  window: ReturnType<typeof ladderWindow> | undefined,
  held: Map<string, Rung>,
  stamps: ReturnType<typeof ladderStamps>,
  counts: ReturnType<typeof soldCounts>,
  ev: Event,
  publishedAt?: number,
): Outcome | 'seen' => {
  if (window?.seenAtStartup(ev)) return 'seen'
  const outcome = deliverWhy(held, stamps, ev, true, publishedAt)
  if (outcome === 'adopted') counts.invalidate('lamp')
  return outcome
}

test('a ladder published during startup work reaches the subscription', () => {
  let now = 200
  const window = ladderWindow(() => now) // made before the startup query, at t=200
  const first = ladderEvent(100, 2)
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  const counts = soldCounts()
  // The startup query returns the 100 ladder and the item is watched on it.
  window.record(first)
  held.set('lamp', parseRung(first.content)!)
  stamps.adopted('lamp', first)

  const edited = ladderEvent(250, 5) // the seller publishes during startup work
  now = 300 // the subscription opens
  const relay = [first, edited]
  for (const ev of relay.filter(ev => matchFilter(subFilter(window.since), ev))) {
    deliverLive(window, held, stamps, counts, ev)
  }
  assert.equal(stamps.get('lamp')?.id, edited.id, 'the held ladder is the 250 event, by id')
  assert.equal(held.get('lamp')?.units, 5, 'with the 250 event units')
})

test('and the same timeline with since read when the subscription opens loses it, so the gap is real', () => {
  const first = ladderEvent(100, 2)
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  const counts = soldCounts()
  held.set('lamp', parseRung(first.content)!)
  stamps.adopted('lamp', first)

  const edited = ladderEvent(250, 5)
  const now = 300 // what watch-sales.ts did: `since: Math.floor(Date.now() / 1000)` at subscribe
  assert.equal(matchFilter(subFilter(now), edited), false, 'the 250 event is excluded by since=300')
  for (const ev of [first, edited].filter(ev => matchFilter(subFilter(now), ev))) {
    deliverLive(undefined, held, stamps, counts, ev)
  }
  assert.equal(stamps.get('lamp')?.id, first.id, 'still the 100 event')
})

test('a startup event the subscription hands back changes nothing, and a newer one still lands', () => {
  const window = ladderWindow(() => 200)
  // Returned by the startup query in the same second the window was taken, and nothing stamped for
  // it: `ladderWindow` on its own. (watch-sales.ts seeds a stamp for every item startup ruled on,
  // `startupStamps`; the id check is the layer that still holds where no stamp exists.)
  const refused = ladderEvent(200, 3)
  window.record(refused)
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  const counts = soldCounts()
  const gen = counts.generation('lamp')

  assert.equal(matchFilter(subFilter(window.since), refused), true, 'since is inclusive, so it is redelivered')
  assert.equal(deliverLive(window, held, stamps, counts, refused), 'seen')
  assert.equal(stamps.get('lamp'), undefined, 'nothing is held for the item')
  assert.equal(held.has('lamp'), false)
  assert.equal(counts.generation('lamp'), gen, 'and nothing was invalidated')

  const republished = ladderEvent(260, 4)
  assert.equal(deliverLive(window, held, stamps, counts, republished), 'adopted')
  assert.equal(stamps.get('lamp')?.id, republished.id, 'a genuinely new ladder is adopted, by id')
  assert.equal(counts.generation('lamp'), gen + 1, 'and invalidates as before')
})

test('and without the startup check the refused event is adopted, so the overlap is real', () => {
  const refused = ladderEvent(200, 3)
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  const counts = soldCounts()
  assert.equal(supersedes(undefined, refused), true, 'nothing is held, so anything is newer')
  assert.equal(deliverLive(undefined, held, stamps, counts, refused), 'adopted')
  assert.equal(stamps.get('lamp')?.id, refused.id, 'the refused ladder walked back in')
})

// A live ladder gets the checks startup gave it. Startup refuses an item as STALE when every rung is
// older than its live listing, and before `refusedAtStartup` that item held no stamp, so any live
// ladder for it, older or just as stale, was adopted and its rungs published as silent no-ops.
// `PUBLISHED` is the live listing's created_at as startup read it (watch-sales.ts `live`). Steps are
// real signed 30402s from `ladderFor`, so `isStale` judges real created_at values.
const PUBLISHED = 1_700_000_000
const freshSteps = (units: number) => ladderFor(tags(String(units)), units, PUBLISHED) // PUBLISHED+1..
const staleSteps = (units: number) => ladderFor(tags(String(units)), units, PUBLISHED - 100) // all < PUBLISHED

test('an item startup refused as STALE refuses an older live ladder, and anything after it changes nothing', () => {
  const window = ladderWindow(() => 200)
  const refused = ladderEvent(200, 3, '', staleSteps(3))
  window.record(refused)
  assert.equal(isStale(parseRung(refused.content)!.steps, PUBLISHED), true, 'startup did refuse it as STALE')
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  const counts = soldCounts()
  stamps.refusedAtStartup('lamp', refused)
  const gen = counts.generation('lamp')

  const older = ladderEvent(150, 2, '', freshSteps(2))
  assert.equal(isStale(parseRung(older.content)!.steps, PUBLISHED), false, 'so only the stamp can refuse it')
  assert.equal(deliverLive(window, held, stamps, counts, older, PUBLISHED), 'older')
  // And whatever arrives after the refusal: the same older event from another relay, the refused
  // event itself handed back, and a later event cut from the same stale listing (a retried publish).
  assert.equal(deliverLive(window, held, stamps, counts, older, PUBLISHED), 'older')
  assert.equal(deliverLive(window, held, stamps, counts, refused, PUBLISHED), 'seen')
  const retried = ladderEvent(250, 4, '', staleSteps(4))
  assert.equal(deliverLive(window, held, stamps, counts, retried, PUBLISHED), 'stale')
  assert.equal(held.has('lamp'), false, 'nothing is held')
  assert.equal(stamps.get('lamp')?.id, refused.id, 'the stamp is still the refused event, by id')
  assert.equal(counts.generation('lamp'), gen, 'and nothing was invalidated')
})

test('and without the startup stamp the same older ladder is adopted, so the hole is real', () => {
  const older = ladderEvent(150, 2, '', freshSteps(2))
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  const counts = soldCounts()
  assert.equal(deliverLive(undefined, held, stamps, counts, older, PUBLISHED), 'adopted')
  assert.equal(stamps.get('lamp')?.id, older.id, 'the 150 event picked the STALE item back up')
})

test('a stale live ladder is refused with nothing held, and redelivering it changes nothing', () => {
  const ev = ladderEvent(300, 3, '', staleSteps(3))
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  const counts = soldCounts()
  const gen = counts.generation('lamp')
  assert.equal(deliverLive(undefined, held, stamps, counts, ev, PUBLISHED), 'stale')
  assert.equal(deliverLive(undefined, held, stamps, counts, ev, PUBLISHED), 'stale', 'from a second relay')
  assert.equal(held.has('lamp'), false, 'nothing is held')
  assert.equal(stamps.get('lamp'), undefined, 'and no stamp, so a fresh ladder can still land')
  assert.equal(counts.generation('lamp'), gen, 'and nothing was invalidated')
})

test('and the old callback order, supersedes only, adopts that stale ladder, so the check is real', () => {
  // What watch-sales.ts did before `admitLive`: parse, `supersedes`, replace, stamp. No `isStale`.
  const ev = ladderEvent(300, 3, '', staleSteps(3))
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  const rung = parseRung(ev.content)!
  if (supersedes(stamps.get('lamp'), ev)) {
    held.set('lamp', rung)
    stamps.adopted('lamp', ev)
  }
  assert.equal(stamps.get('lamp')?.id, ev.id, 'the stale ladder is held')
  assert.equal(isStale(held.get('lamp')!.steps, PUBLISHED), true, 'and every rung of it is older than the listing')
})

test('a watched item keeps its ladder when a newer but stale one arrives', () => {
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  const counts = soldCounts()
  const watched = ladderEvent(200, 3, '', freshSteps(3))
  assert.equal(deliverLive(undefined, held, stamps, counts, watched, PUBLISHED), 'adopted')
  const gen = counts.generation('lamp')

  const newerStale = ladderEvent(300, 1, '', staleSteps(1))
  assert.equal(supersedes(stamps.get('lamp'), newerStale), true, 'it is newer, so only isStale can refuse it')
  assert.equal(deliverLive(undefined, held, stamps, counts, newerStale, PUBLISHED), 'stale')
  assert.equal(held.get('lamp')?.units, 3, 'the held units are the watched ladder')
  assert.equal(stamps.get('lamp')?.id, watched.id, 'the stamp is the watched event, by id')
  assert.equal(counts.generation('lamp'), gen, 'and nothing was invalidated')
})

test('boundaries: a newest step equal to the listing is admitted, and so is any ladder with no listing', () => {
  // Sold out: the live listing IS the last rung, so the newest step equals PUBLISHED.
  const soldOut = ladderFor(tags('1'), 1, PUBLISHED - 1)
  assert.equal(soldOut[0]!.created_at, PUBLISHED)
  const atListing = ladderEvent(200, 1, '', soldOut)
  assert.equal(admitLive(undefined, atListing, soldOut, PUBLISHED), 'newer')
  assert.equal(deliver(new Map(), ladderStamps(), atListing), true)
  assert.equal(deliverWhy(new Map(), ladderStamps(), atListing, true, PUBLISHED), 'adopted')
  // One second further back is stale, so the boundary above is the real one.
  assert.equal(admitLive(undefined, atListing, ladderFor(tags('1'), 1, PUBLISHED - 2), PUBLISHED), 'stale')

  // No live listing: "the relay is down" is not "stale", even for steps that would be stale.
  const noListing = ladderEvent(200, 3, '', staleSteps(3))
  assert.equal(deliverWhy(new Map(), ladderStamps(), noListing, true, undefined), 'adopted')
})

test('an item refused as STALE still heals on a genuinely newer, fresh ladder', () => {
  const refused = ladderEvent(200, 3, '', staleSteps(3))
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  const counts = soldCounts()
  stamps.refusedAtStartup('lamp', refused)
  assert.equal(deliverLive(undefined, held, stamps, counts, ladderEvent(150, 2, '', freshSteps(2)), PUBLISHED), 'older')
  const gen = counts.generation('lamp')

  const healed = ladderEvent(260, 4, '', freshSteps(4))
  assert.equal(deliverLive(undefined, held, stamps, counts, healed, PUBLISHED), 'adopted')
  assert.equal(stamps.get('lamp')?.id, healed.id, 'the held ladder is the 260 event, by id')
  assert.equal(held.get('lamp')?.units, 4)
  assert.equal(counts.generation('lamp'), gen + 1, 'and the count is invalidated once')
})

// The other refusal reason. `withOffer` drops an item at startup when its ladder has no decodable
// offer, and before `startupStamps` that item held no stamp: a delayed older ladder with a good
// offer was `'newer'` than nothing and was adopted, rolling the item back past the ladder the seller
// last published. `at` here is `readRelayLadders`' map and an empty `watched` is the `withOffer` drop.
test('an item startup dropped for no decodable offer refuses an older live ladder', () => {
  const window = ladderWindow(() => 300)
  const dropped = ladderEvent(300, 3, '', freshSteps(3))
  window.record(dropped)
  const stamps = startupStamps(new Map([['lamp', stampOf(dropped)]]), [])
  assert.equal(stamps.get('lamp')?.id, dropped.id, 'the stamp is the dropped 300 event, by id')
  const held = new Map<string, Rung>()
  const counts = soldCounts()
  const gen = counts.generation('lamp')

  const older = ladderEvent(200, 2, '', freshSteps(2))
  assert.equal(isStale(parseRung(older.content)!.steps, PUBLISHED), false, 'so only the stamp can refuse it')
  assert.equal(deliverLive(window, held, stamps, counts, older, PUBLISHED), 'older')
  assert.equal(held.has('lamp'), false, 'nothing is held')
  assert.equal(counts.generation('lamp'), gen, 'and nothing was invalidated')
  assert.equal(deliverLive(window, held, stamps, counts, dropped, PUBLISHED), 'seen')
  assert.equal(stamps.get('lamp')?.id, dropped.id, 'the stamp is still the dropped event')

  const healed = ladderEvent(360, 4, '', freshSteps(4))
  assert.equal(deliverLive(window, held, stamps, counts, healed, PUBLISHED), 'adopted')
  assert.equal(stamps.get('lamp')?.id, healed.id, 'the item heals on the 360 event, by id')
  assert.equal(held.get('lamp')?.units, 4)
  assert.equal(counts.generation('lamp'), gen + 1)
})

test('and without the startup stamp the same 200 ladder is adopted, so the hole is real', () => {
  const window = ladderWindow(() => 300)
  const dropped = ladderEvent(300, 3, '', freshSteps(3))
  window.record(dropped) // the id check alone, as before: it only knows the exact 300 event
  const older = ladderEvent(200, 2, '', freshSteps(2))
  const held = new Map<string, Rung>()
  const stamps = ladderStamps()
  const counts = soldCounts()
  assert.equal(deliverLive(window, held, stamps, counts, older, PUBLISHED), 'adopted')
  assert.equal(stamps.get('lamp')?.id, older.id, 'the 200 event is held, older than the one startup read')
})

test('a watched item is seeded as adopted, and a file-only item stays unstamped', () => {
  const watchedEv = ladderEvent(300, 3, '', freshSteps(3))
  const stamps = startupStamps(new Map([['lamp', stampOf(watchedEv)]]), ['lamp', 'vase'])
  assert.deepEqual(stamps.get('lamp'), stampOf(watchedEv), 'the stamp is the watched event')
  assert.equal(stamps.get('vase'), undefined, 'watched from the file, so no event to stamp')
  assert.equal(stamps.get('mug'), undefined, 'absent from at and not watched')
  // A failed relay read leaves `at` empty, so nothing is seeded.
  assert.equal(startupStamps(new Map(), ['lamp']).get('lamp'), undefined)
  // And the seeded stamp orders as a held one: the same event again and an older one are refused.
  assert.equal(admitLive(stamps.get('lamp'), watchedEv, freshSteps(3), PUBLISHED), 'older')
  assert.equal(admitLive(stamps.get('lamp'), ladderEvent(200, 2), freshSteps(2), PUBLISHED), 'older')
})
