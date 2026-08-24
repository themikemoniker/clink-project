// Slice 7. The two decisions on the refund path that can be tested without spending a sat: which
// settled invoice is owed money, and whether a pointer decodes to something payable.
//
// Same runner and style as ladder.test.ts — `npm test`, node --test, no framework. What this
// cannot cover is the payment itself; that is spike/check-refund.ts, which proves the node's cap
// and kill switch against the real node before any refund runs unattended.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bech32 } from '@scure/base'
import { decodeNdebit, k1For } from './ndebit.ts'
import {
  inFlightGuard,
  lnurlpUrl,
  matchingPayments,
  oversold,
  recordRefund,
  settledByUs,
  type Journal,
  type Settled,
} from './refund.ts'

const utf8 = (s: string) => new TextEncoder().encode(s)
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)
const hexBytes = (h: string) => new Uint8Array(h.match(/../g)!.map(b => parseInt(b, 16)))

const SERVICE = '3f0abe5a9446f8c0d42ff83e316792ca393b1920cbb6ede5072350516015befc'
const RELAY = 'wss://relay.lightning.pub'
const POINTER = 'db5acc4e1f2a3b4c5d6e7f8091a2b3c4'
const K1 = 'a'.repeat(64)

const encode = (tlv: Record<number, Uint8Array>, prefix = 'ndebit'): string => {
  const parts: number[] = []
  for (const [t, v] of Object.entries(tlv)) parts.push(Number(t), v.length, ...v)
  return bech32.encode(prefix, bech32.toWords(new Uint8Array(parts)), 5_000)
}

const OK = { 0: hexBytes(SERVICE), 1: utf8(RELAY), 2: utf8(POINTER) }

// --- decodeNdebit ---------------------------------------------------------------------------
// The third of three CLINK bech32 TLV pointers. It shares its TLV loop with the other two
// (storefront/src/offer.ts `parseTLV`), so these tests are about the ndebit-SPECIFIC rules:
// TLV 3, and the fact that TLV 2 is optional here where nmanage requires it.

test('an ndebit pointer decodes to its TLVs', () => {
  const node = decodeNdebit(encode(OK))!
  assert.equal(node.pubkey, SERVICE)
  assert.equal(node.relay, RELAY)
  assert.equal(node.pointer, POINTER)
  assert.equal(node.k1, undefined) // a static pointer carries no session
})

test('TLV 3 is a 32-byte session identifier, and any other length is a corrupt pointer', () => {
  // clink-debits.md:19-22 via /docs/clink-notes.md §3.1, and the reference encoder agrees — it
  // throws `raw K1 buffer should be 32 bytes` (@shocknet/clink-sdk nip19Extension.js).
  const session = decodeNdebit(encode({ ...OK, 3: hexBytes(K1) }))!
  assert.equal(session.k1, K1)
  assert.equal(session.k1!.length, 64) // lowercase hex of 32 bytes

  // Dropping a malformed k1 instead of rejecting would silently turn a single-use pointer into a
  // reusable one — clink-debits.md:167-171 says a wallet MUST set k1 when TLV 3 is present.
  assert.equal(decodeNdebit(encode({ ...OK, 3: bytes(31) })), null)
  assert.equal(decodeNdebit(encode({ ...OK, 3: bytes(33) })), null)
  assert.equal(decodeNdebit(encode({ ...OK, 3: bytes(3) })), null)
})

test('an ndebit needs a service key and a relay, and nothing else is required', () => {
  // TLV 2 is optional in the ndebit spec, unlike nmanage where this node demands one. A pointer
  // without it is legal and decodes; whether the NODE will act on it is a separate question,
  // answered by doNdebit with GFY 1 (debitManager.ts:252-255).
  const noPointer = decodeNdebit(encode({ 0: hexBytes(SERVICE), 1: utf8(RELAY) }))!
  assert.equal(noPointer.pointer, undefined)
  assert.equal(noPointer.pubkey, SERVICE)

  assert.equal(decodeNdebit(encode({ 1: utf8(RELAY), 2: utf8(POINTER) })), null) // no service key
  assert.equal(decodeNdebit(encode({ ...OK, 0: bytes(31) })), null)
  assert.equal(decodeNdebit(encode({ ...OK, 1: utf8('http://relay.example') })), null)
  assert.equal(decodeNdebit(encode({ ...OK, 1: new Uint8Array(0) })), null)
})

test('only ndebit pointers are accepted, and a corrupted one decodes to nothing', () => {
  // An noffer, an nmanage and an ndebit share their first three TLVs. Ignoring the HRP would let
  // an item's public offer pointer be read as a debit authority over the seller's account.
  assert.equal(decodeNdebit(encode(OK, 'noffer')), null)
  assert.equal(decodeNdebit(encode(OK, 'nmanage')), null)
  assert.equal(decodeNdebit(''), null)
  assert.equal(decodeNdebit('ndebit1'), null)
  assert.equal(decodeNdebit(null as unknown as string), null)

  const real = encode(OK)
  const flipped = real.slice(0, 30) + (real[30] === 'q' ? 'p' : 'q') + real.slice(31)
  assert.equal(decodeNdebit(flipped), null)
  assert.equal(decodeNdebit(real.slice(0, -1)), null)
  assert.deepEqual(decodeNdebit(`  ${real}\n`), decodeNdebit(real)) // pasted from a file
})

test('the k1 for a refund is derived from the settled invoice, not generated', () => {
  // Deterministic, so a crash-loop restart re-derives the same one and the node refuses the
  // duplicate. 64-char lowercase hex, which is the shape clink-debits.md:132-156 requires.
  const invoice = 'lnbc10u1p4g0e2fpp5kzfruw7xkmvwd0vr9jtvu6'
  assert.equal(k1For(invoice), k1For(invoice))
  assert.match(k1For(invoice), /^[0-9a-f]{64}$/)
  assert.notEqual(k1For(invoice), k1For(invoice + 'x'))
})

// --- oversold -------------------------------------------------------------------------------

const paid = (invoice: string, at: number, amount = 1_000): Settled => ({
  invoice,
  offer_id: 'offer-1',
  paid_at_unix: at,
  amount,
  data: { refund_pointer: 'buyer@example.com' },
})

test('the first `units` payments keep their goods and the rest are owed money', () => {
  const rows = [paid('inv-a', 100), paid('inv-b', 200), paid('inv-c', 300)]
  assert.deepEqual(oversold(rows, 3).map(r => r.invoice), [])
  assert.deepEqual(oversold(rows, 2).map(r => r.invoice), ['inv-c'])
  assert.deepEqual(oversold(rows, 1).map(r => r.invoice), ['inv-b', 'inv-c'])
  // A one-of-a-kind item that sold twice is the whole sold-out race (spec §7.3).
  assert.deepEqual(oversold([paid('inv-a', 100), paid('inv-b', 101)], 1).map(r => r.invoice), ['inv-b'])
  // Nothing sold, nothing owed.
  assert.deepEqual(oversold([], 3), [])
})

test('the ordering is stable across restarts, including at the same timestamp', () => {
  // This is the property that matters, not fairness. The watcher recomputes from the node on
  // every poll and after every restart, so an unstable sort would refund one buyer, restart, and
  // then decide a different buyer was the oversold one — double-paying the first.
  const same = [paid('inv-z', 500), paid('inv-a', 500), paid('inv-m', 500)]
  const first = oversold(same, 1).map(r => r.invoice)
  const shuffled = oversold([same[1]!, same[2]!, same[0]!], 1).map(r => r.invoice)
  assert.deepEqual(first, shuffled)
  assert.deepEqual(first, ['inv-m', 'inv-z']) // 'inv-a' is earliest by the tiebreak, so it keeps

  // And time still beats the tiebreak.
  assert.deepEqual(oversold([paid('inv-z', 100), paid('inv-a', 200)], 1).map(r => r.invoice), ['inv-a'])
})

test('the node is not trusted input, and a replay cannot invent an oversell', () => {
  // The settled invoice is the idempotency key everywhere in this project (spec §8). A relay or
  // an RPC that hands back the same row twice must not turn one sale into two.
  const dupes = [paid('inv-a', 100), paid('inv-a', 100), paid('inv-a', 100)]
  assert.deepEqual(oversold(dupes, 1), [])

  // Rows that cannot be acted on are dropped rather than refunded blind.
  const junk = [
    { invoice: 'inv-ok', offer_id: 'offer-1', paid_at_unix: 100, amount: 1_000 },
    { invoice: 'unpaid', offer_id: 'offer-1', paid_at_unix: 0, amount: 1_000 },
    { invoice: 'zero', offer_id: 'offer-1', paid_at_unix: 100, amount: 0 },
    { invoice: 'x'.repeat(5_000), offer_id: 'offer-1', paid_at_unix: 100, amount: 1_000 },
    { offer_id: 'offer-1', paid_at_unix: 100, amount: 1_000 },
  ] as Settled[]
  assert.deepEqual(oversold(junk, 0).map(r => r.invoice), ['inv-ok'])
})

// --- the journal ----------------------------------------------------------------------------

test('anything but a failure stops the watcher acting on that invoice again', () => {
  const journal: Journal = {
    'inv-paid': { invoice: 'inv-paid', d: 'mugs', sats: 1_000, state: 'paid', at: 1, pointer: 'address' },
    'inv-pending': { invoice: 'inv-pending', d: 'mugs', sats: 1_000, state: 'pending', at: 1, pointer: 'address' },
    'inv-queued': { invoice: 'inv-queued', d: 'mugs', sats: 1_000, state: 'queued', at: 1, pointer: 'none' },
    'inv-failed': { invoice: 'inv-failed', d: 'mugs', sats: 1_000, state: 'failed', at: 1, pointer: 'address' },
  }
  assert.equal(settledByUs(journal, 'inv-paid')?.state, 'paid')
  // `pending` is the one that matters: it means we sent a payment and never heard back, so
  // whether money moved is unknown. Retrying might double-pay and dropping it might strand a
  // buyer, so the watcher does neither — it prints it until a human looks at the node.
  assert.equal(settledByUs(journal, 'inv-pending')?.state, 'pending')
  assert.equal(settledByUs(journal, 'inv-queued')?.state, 'queued')
  // Only an outright decline is retried, because nothing was paid.
  assert.equal(settledByUs(journal, 'inv-failed'), undefined)
  assert.equal(settledByUs(journal, 'never-seen'), undefined)
})

// --- item 1 (2026-08-24): the double refund, both halves -------------------------------------
//
// THIS IS THE TEST THE FIRST 27 DID NOT HAVE, and its absence is the whole reason the bug
// survived them. `watch-sales.ts --once` runs one `await tick()` and exits without installing a
// timer, so nothing in a test can drive the interval that raced. What can be driven is the shape
// underneath it: read the journal, do something slow, write, pay. That is `fakeTick` below, and
// the second test asserts it really does double-pay when the guard is taken away — otherwise the
// first test would be asserting nothing at all.

const tmpJournal = () => join(mkdtempSync(join(tmpdir(), 'clink-refund-')), '.refunds.json')

const row = (state: Journal[string]['state'], note?: string): Journal[string] => ({
  invoice: 'inv-oversold',
  d: 'yardsale-2026-08-mugs',
  sats: 1_000,
  state,
  at: 1_787_000_000,
  pointer: 'address',
  ...(note === undefined ? {} : { note }),
})

/**
 * The refund loop's real ordering, with the network replaced by a timer.
 *
 * The gap that matters is between `settledByUs` and the first `recordRefund`: in the watcher that
 * gap is `resolvePointer`, two sequential LNURL fetches at a 10s timeout each, against a 5s poll.
 * Nothing marks the invoice as in-flight until after it.
 */
const fakeTick = (journal: Journal, path: string, paid: string[]) => async () => {
  if (settledByUs(journal, 'inv-oversold')) return
  await new Promise(resolve => setTimeout(resolve, 5)) // resolvePointer
  recordRefund(journal, path, row('pending', 'sent, awaiting the node'))
  paid.push('inv-oversold') // payDebit
  recordRefund(journal, path, row('paid', 'the node acknowledged'))
}

test('two overlapping ticks refund an oversell once, not twice', async () => {
  const journal: Journal = {}
  const paid: string[] = []
  const tick = inFlightGuard(fakeTick(journal, tmpJournal(), paid))
  await Promise.all([tick(), tick()])
  assert.deepEqual(paid, ['inv-oversold'])
  assert.equal(journal['inv-oversold']!.state, 'paid')
})

test('and the same two ticks without the guard pay twice, so the race is real', async () => {
  const journal: Journal = {}
  const paid: string[] = []
  const tick = fakeTick(journal, tmpJournal(), paid)
  await Promise.all([tick(), tick()])
  assert.deepEqual(paid, ['inv-oversold', 'inv-oversold'])
})

test('a late refusal cannot downgrade a paid row', () => {
  // The second half of the same bug. Both ticks send the identical derived k1, the node's
  // debouncer refuses the loser, and the loser's write used to land `failed` on top of `paid` —
  // which `settledByUs` treats as retryable, six minutes later, with a k1 the debouncer has swept.
  const journal: Journal = {}
  const path = tmpJournal()
  recordRefund(journal, path, row('paid', 'the node acknowledged'))
  recordRefund(journal, path, row('failed', 'GFY 1: K1 already processed'))
  assert.equal(journal['inv-oversold']!.state, 'paid')
  assert.equal(journal['inv-oversold']!.note, 'the node acknowledged')
  // On disk too, because the disk is the copy that survives the restart this guards against.
  assert.equal(JSON.parse(readFileSync(path, 'utf8'))['inv-oversold'].state, 'paid')
  assert.equal(settledByUs(journal, 'inv-oversold')?.state, 'paid')
})

test('every other transition still lands, because only paid is terminal', () => {
  // The guard has to be exactly one state wide. `pending` -> `paid` is what item 9's startup
  // reconcile does after a human confirms, and `failed` -> `pending` is an ordinary retry; a
  // wider guard would silently break both, which is the same class of bug as the one being fixed.
  const journal: Journal = {}
  const path = tmpJournal()
  recordRefund(journal, path, row('failed', 'the host was down'))
  recordRefund(journal, path, row('pending', 'sent, awaiting the node'))
  assert.equal(journal['inv-oversold']!.state, 'pending')
  recordRefund(journal, path, row('paid', 'confirmed against the node'))
  assert.equal(journal['inv-oversold']!.state, 'paid')
})

// --- lnurlpUrl ------------------------------------------------------------------------------

test('a Lightning address becomes an LNURL-pay URL, and only over https', () => {
  assert.equal(lnurlpUrl('bob@example.com'), 'https://example.com/.well-known/lnurlp/bob')
  assert.equal(lnurlpUrl('bob@ln.tips'), 'https://ln.tips/.well-known/lnurlp/bob') // 2-char TLD
  assert.equal(lnurlpUrl('BOB@Example.COM'), 'https://example.com/.well-known/lnurlp/BOB')
})

test('a pointer that is not an address does not become a URL', () => {
  assert.equal(lnurlpUrl('noffer1qszqqqqhwqpszqq'), null)
  assert.equal(lnurlpUrl('not an address'), null)
  assert.equal(lnurlpUrl('bob@'), null)
  assert.equal(lnurlpUrl('@example.com'), null)
  assert.equal(lnurlpUrl('bob@example'), null) // no TLD
  assert.equal(lnurlpUrl(''), null)
})

test('the name half cannot escape the well-known path', () => {
  // The address regex bounds the name at 64 characters and forbids whitespace and `@` — it does
  // NOT forbid `/` or `.`, so `../../admin@host` is a "valid" Lightning address as far as shape
  // goes. Without encoding it would address an arbitrary path on a host named by a stranger's
  // payment pointer, and we would then ask that path for an invoice and pay it.
  // `encodeURIComponent` is the entire guard, so this is the test that it is actually applied.
  const url = lnurlpUrl('../../admin@example.com')!
  assert.equal(url, 'https://example.com/.well-known/lnurlp/..%2F..%2Fadmin')
  assert.equal(new URL(url).pathname, '/.well-known/lnurlp/..%2F..%2Fadmin')
  assert.equal(url.includes('/../'), false)

  // A query string cannot be smuggled in either — it would otherwise reach the host as real
  // parameters rather than as part of the name.
  assert.equal(lnurlpUrl('bob?amount=1@example.com'), 'https://example.com/.well-known/lnurlp/bob%3Famount%3D1')
})

// --- reconciling a `pending` row (slice 8) ---------------------------------------------------
//
// This one is a HEURISTIC and the tests are written to keep it honest about that. The node stores
// no link between a debit it paid and the settled invoice that caused it, so amount and time are
// the only handles. Everything below asserts that it stays evidence for a human rather than
// creeping into a decision: no fuzzy amounts, no unbounded window, no confident empty answer.

const op = (over: Partial<{ paidAtUnix: number; amount: number; operationId: string }> = {}) => ({
  paidAtUnix: 1_787_000_000,
  amount: 1000,
  operationId: 'op-1',
  ...over,
})

test('a pending refund matches the node payment of the same amount at about that time', () => {
  const hits = matchingPayments([op(), op({ amount: 6000, operationId: 'op-2' })], 1000, 1_787_000_000)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.operationId, 'op-1')
})

test('the amount must match exactly, because a refund is for what the buyer paid', () => {
  // No tolerance, deliberately. Routing fees are carried in separate fields
  // (structs.proto:641-642) and do not move `amount`, so a near-miss here is a DIFFERENT payment
  // and showing it to a seller as a probable match is worse than showing nothing.
  assert.equal(matchingPayments([op({ amount: 999 })], 1000, 1_787_000_000).length, 0)
  assert.equal(matchingPayments([op({ amount: 1001 })], 1000, 1_787_000_000).length, 0)
})

test('the window is bounded on both sides of the attempt', () => {
  const at = 1_787_000_000
  // Both directions matter: the journal row is written BEFORE the payment, so the node's own
  // timestamp is normally later — but a slow answer is exactly the case that produces a `pending`
  // row, so the window has to be wide enough to contain one and narrow enough to mean something.
  assert.equal(matchingPayments([op({ paidAtUnix: at + 14 * 60 })], 1000, at).length, 1)
  assert.equal(matchingPayments([op({ paidAtUnix: at - 14 * 60 })], 1000, at).length, 1)
  assert.equal(matchingPayments([op({ paidAtUnix: at + 16 * 60 })], 1000, at).length, 0)
  assert.equal(matchingPayments([op({ paidAtUnix: at - 16 * 60 })], 1000, at).length, 0)
})

test('two payments of the same amount both surface, because we cannot tell them apart', () => {
  // The failure mode this protects: picking one and calling it the match. If the node has two
  // 1,000-sat payments in the window then this refund is one of them and the software does not
  // know which, so the seller gets both rows and decides.
  const hits = matchingPayments(
    [op({ operationId: 'later', paidAtUnix: 1_787_000_060 }), op({ operationId: 'earlier' })],
    1000,
    1_787_000_000,
  )
  assert.deepEqual(hits.map(h => h.operationId), ['earlier', 'later'])
})

test('a node answer of the wrong shape reconciles to nothing rather than throwing', () => {
  // Same posture as everywhere else that reads this node: it is not trusted input either. The
  // watcher runs unattended for the length of a yard sale and must not die printing a summary.
  assert.deepEqual(matchingPayments(undefined, 1000, 1), [])
  assert.deepEqual(matchingPayments({ operations: [] }, 1000, 1), [])
  assert.deepEqual(matchingPayments([null, 'nonsense', {}], 1000, 1), [])
  assert.deepEqual(matchingPayments([op({ paidAtUnix: NaN })], 1000, 1), [])
})
