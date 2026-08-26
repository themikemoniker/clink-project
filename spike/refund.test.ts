// Slice 7. The two decisions on the refund path that can be tested without spending a sat: which
// settled invoice is owed money, and whether a pointer decodes to something payable.
//
// Same runner and style as ladder.test.ts — `npm test`, node --test, no framework. What this
// cannot cover is the payment itself; that is spike/check-refund.ts, which proves the node's cap
// and kill switch against the real node before any refund runs unattended.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, get as httpGet, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bech32 } from '@scure/base'
import { decodeNdebit, k1For } from './ndebit.ts'
import {
  bip353Name,
  getJson,
  hasBip353,
  inFlightGuard,
  isPrivateAddress,
  lnurlpUrl,
  matchingPayments,
  oversold,
  readBounded,
  reconcile,
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

// --- item 4 (2026-08-24): hostile input on the refund path -----------------------------------
//
// The buyer types the pointer, the node stores it, and the seller's watcher then fetches whatever
// host it names and asks that host for an invoice it is about to pay. Both panel claims were
// reproduced against the old code before any of this was written: a 10 MB body arrived whole
// through a 64 KB "bound", and a callback of `https://127.0.0.1:8443/cb` was fetched and parsed.

test('every address an SSRF actually aims at is refused', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3', // loopback
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', // RFC1918
    '169.254.169.254', // link-local, and the cloud metadata endpoint
    '100.64.0.1', // CGNAT
    '0.0.0.0', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '239.255.255.255', '255.255.255.255',
    '::', '::1', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', // an IPv4-mapped form must not launder loopback
    '64:ff9b::7f00:1', // NAT64 carries an embedded v4
    // UNCOMPRESSED SPELLINGS, and every one of these was ALLOWED until 2026-08-24. None starts with
    // `::`, so the prefix rule missed them, and `parseInt('0', 16)` matches none of the masks — the
    // function failed OPEN on plain loopback while its docstring promised it failed closed. The fix
    // is to canonicalise through `new URL` first; these are the cases that prove it stays fixed.
    '0:0:0:0:0:0:0:1', '0::1', '0000:0000:0000:0000:0000:0000:0000:0001',
    '0:0:0:0:0:ffff:127.0.0.1', '0:0:0:0:0:ffff:10.0.0.1',
    // Canonicalising rewrites the dotted mapped forms to hex, so the `::` rule now catches the
    // public ones too. Stricter than before and deliberately: an IPv4-mapped address in a DNS
    // answer for a wallet host is not a thing that happens legitimately.
    '::ffff:8.8.8.8',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be refused`)
  }
})

test('a real wallet host is still reachable, and a non-address fails closed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '100.128.0.1', '2606:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`)
  }
  // Fails closed on anything that is not an address at all, because guessing here is the whole risk.
  for (const junk of ['', 'localhost', 'not-an-ip', '999.1.1.1', '10.0.0']) {
    assert.equal(isPrivateAddress(junk), true, `${junk} should be refused`)
  }
})

test('a body larger than the bound aborts mid-stream instead of being buffered whole', async () => {
  // The reader is exported precisely because this is the only half of the fetch a test can reach:
  // every address a local listener can bind is one isPrivateAddress correctly refuses, which is
  // the vetting working and also why there is no way to drive a whole oversized fetch end to end.
  const MAX = 4 * 1024
  const MB = Buffer.alloc(1024 * 1024, 0x61)
  let written = 0
  const server: Server = createServer((_req, res) => {
    res.on('error', () => {}) // the client hangs up on us on purpose
    res.writeHead(200)
    const pump = () => {
      // Keep offering megabytes until the socket goes away. If the bound were checked after the
      // body, this would run to 32 MB before anything complained.
      if (written >= 32 * 1024 * 1024 || res.destroyed || res.writableEnded) return
      written += MB.length
      if (res.write(MB)) setImmediate(pump)
      else res.once('drain', pump)
    }
    pump()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }

  const res = await new Promise<IncomingMessage>(resolve => httpGet(`http://127.0.0.1:${port}/`, resolve))
  await assert.rejects(() => readBounded(res, MAX), /larger than 4096 bytes/)
  assert.equal(res.destroyed, true, 'the socket is closed rather than left draining')
  server.close()
})

test('a body inside the bound still reads back whole', async () => {
  const server: Server = createServer((_req, res) => res.end('{"tag":"payRequest"}'))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  const res = await new Promise<IncomingMessage>(resolve => httpGet(`http://127.0.0.1:${port}/`, resolve))
  assert.equal(await readBounded(res, 64 * 1024), '{"tag":"payRequest"}')
  server.close()
})

test('the redirect chain is capped, and each hop is re-checked for https', async () => {
  // `hop` is injected only here. redirect: 'follow' used to inherit undici's default of 20 —
  // measured at 21 fetches of a self-redirecting host on 2026-08-24 — and, worse, handed back the
  // FINAL response, so a per-hop address check was not expressible at all.
  let hops = 0
  await assert.rejects(
    () =>
      getJson('https://wallet.example/lnurlp/x', async () => {
        hops++
        return { location: 'https://wallet.example/lnurlp/x', body: '' }
      }),
    /more than 8 redirects/,
  )
  assert.equal(hops, 9, 'the first request plus eight redirects, and then it stops')

  await assert.rejects(
    () => getJson('https://wallet.example/a', async () => ({ location: 'http://wallet.example/b', body: '' })),
    /not https/,
    'a 302 must not be able to downgrade the exchange after the first hop looked fine',
  )

  // A hop that answers with a body ends the chain rather than looping.
  assert.deepEqual(await getJson('https://wallet.example/a', async () => ({ body: '{"tag":"payRequest"}' })), {
    tag: 'payRequest',
  })
})

test('a pointer at a private address is refused, and the refusal never names the person', async () => {
  // Two properties in one assertion, both of them /CLAUDE.md's. The address check refuses before a
  // socket is opened — verified against a live listener on 2026-08-24, which recorded zero
  // connections where the old code recorded one. And a refund pointer identifies a person: the
  // HOST is what makes a queued row actionable, the name half is what must never be written,
  // printed or logged, and the name half is exactly what sits in this URL's path.
  //
  // An IP literal rather than a hostname, so this needs no DNS and cannot go slow or flaky.
  await assert.rejects(
    () => getJson('https://127.0.0.1/.well-known/lnurlp/alice-personal'),
    (err: Error) =>
      /private or reserved address/.test(err.message) &&
      err.message.includes('127.0.0.1') &&
      !err.message.includes('alice-personal'),
  )
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

// --- item 9 (2026-08-24): the startup reconcile ----------------------------------------------
//
// All four cases the brief names, all against a stub, none of them touching the node. The one
// property every assertion is protecting: **this function returns findings, never transitions.**
// The roadmap originally had a matched `pending` row become `paid` with no human, and the
// 2026-08-23 review reversed it — a match on amount and time alone records a refund that may never
// have been sent, and strands the buyer with no row left reprinting to say so.

const pendingRow = (over: Partial<Journal[string]> = {}): Journal[string] => ({
  invoice: 'inv-pending',
  d: 'yardsale-2026-08-mugs',
  sats: 1_000,
  state: 'pending',
  at: 1_787_000_000,
  pointer: 'address',
  ...over,
})

test('a pending row with a matching payment is reported, and NOT transitioned', () => {
  const journal: Journal = { 'inv-pending': pendingRow() }
  const out = reconcile(journal, true, [op({ paidAtUnix: 1_787_000_040 })])
  assert.equal(out.refuseToStart, false)
  assert.equal(out.pending.length, 1)
  assert.equal(out.pending[0]!.hits.length, 1)
  assert.equal(out.pending[0]!.hits[0]!.operationId, 'op-1')
  // The whole point. Reconciling is a read; the row is exactly as it was.
  assert.equal(journal['inv-pending']!.state, 'pending')
})

test('a pending row with no matching payment is reported with no evidence at all', () => {
  const out = reconcile({ 'inv-pending': pendingRow() }, true, [op({ amount: 6_000 }), op({ paidAtUnix: 1_787_099_999 })])
  assert.equal(out.pending.length, 1)
  assert.equal(out.pending[0]!.hits.length, 0)
  assert.equal(out.refuseToStart, false)
})

test('only pending rows are reconciled — paid, failed and queued are somebody else', () => {
  // `paid` is done, `failed` is retried by the ordinary loop, and `queued` is already waiting for
  // a human for a reason the node cannot speak to. Widening this would ask the seller to
  // re-confirm settled history on every restart, which is how a prompt stops being read.
  const journal: Journal = {
    a: pendingRow({ invoice: 'a', state: 'paid' }),
    b: pendingRow({ invoice: 'b', state: 'failed' }),
    c: pendingRow({ invoice: 'c', state: 'queued' }),
    d: pendingRow({ invoice: 'd' }),
  }
  const out = reconcile(journal, true, [op()])
  assert.deepEqual(out.pending.map(p => p.row.invoice), ['d'])
})

test('a missing journal plus outgoing payments refuses to start', () => {
  // The "restored an old file" case. Every oversell this account has already refunded is about to
  // be recomputed from the node as still owed, and paid again.
  assert.equal(reconcile({}, false, [op()]).refuseToStart, true)
  // A missing journal on a node that has never sent anything is a first run, which is fine.
  assert.equal(reconcile({}, false, []).refuseToStart, false)
  // And a journal that exists and happens to be empty is NOT the same thing — readJournal cannot
  // tell those apart, which is why the caller passes existsSync separately.
  assert.equal(reconcile({}, true, [op()]).refuseToStart, false)
})

test('an oversell with no journal row but a matching payment has evidence to block on', () => {
  // The per-oversell half of item 9, which watch-sales.ts drives with the SETTLEMENT's own time
  // rather than a journal row's `at` — there is no row, and a refund is sent after the sale it
  // refunds, so the settled invoice is the only anchor there is.
  const settledAt = 1_787_000_000
  assert.equal(matchingPayments([op({ paidAtUnix: settledAt + 90 })], 1_000, settledAt).length, 1)
  // A refund of a different size near the same sale is a different payment and must not block.
  assert.equal(matchingPayments([op({ amount: 800, paidAtUnix: settledAt + 90 })], 1_000, settledAt).length, 0)
  // Nothing to block on is the ordinary case, and it must not read as evidence.
  assert.equal(matchingPayments([], 1_000, settledAt).length, 0)
})

// --- item 27, first bullet (2026-08-26): say the true reason ---------------------------------
//
// `LN_ADDRESS` cannot tell a BIP-353 address from an LNURL-pay one, so a Phoenix buyer's refund
// pointer resolves to `https://phoenixwallet.me/.well-known/lnurlp/…` against a domain with no A
// or AAAA record at all. The `queued` row used to name DNS, which sends a seller to debug a
// hostname that was never wrong.
//
// WHAT THESE TESTS CANNOT REACH is `resolvePointer`'s branch itself: `fetchHop` is not injectable
// (only `getJson`'s hop is), and every host a test server can bind is one `isPrivateAddress`
// correctly refuses. That branch was driven live instead, and the transcript is in the commit —
// `matt@mattcorallo.com`, a published BIP-353 test vector, returns the new message in 333 ms while
// `nobodyatall@coinos.io` (a real LNURL host) does not. What is provable here is the name we build
// and every bound on the answer, which is the half that hostile input reaches.

test('a Lightning address becomes the BIP-353 name recorded on 2026-08-24, and is folded to lower case', () => {
  assert.equal(bip353Name('matt@mattcorallo.com'), 'matt.user._bitcoin-payment.mattcorallo.com')
  assert.equal(bip353Name('Bob@Example.COM'), 'bob.user._bitcoin-payment.example.com')
})

test('the name half must be ONE ordinary DNS label, because the query is a different zone otherwise', () => {
  // `LN_ADDRESS`'s name half is `[^\s@]{1,64}`: it admits dots, slashes and unicode. `lnurlpUrl`
  // survives that with `encodeURIComponent`; a DNS name has no such escape, so `a.b@host` would
  // ask about `a.b.user._bitcoin-payment.host` — a name the address does not name. Refuse instead.
  assert.equal(bip353Name('a.b@example.com'), null)
  assert.equal(bip353Name('../../admin@example.com'), null)
  assert.equal(bip353Name('bob_smith@example.com'), null)
  assert.equal(bip353Name('-bob@example.com'), null) // a label may not start with a hyphen
  assert.equal(bip353Name('bob-@example.com'), null)
  assert.equal(bip353Name('b'.repeat(64) + '@example.com'), null) // over one label's 63 bytes
  assert.equal(bip353Name('not an address'), null)
  assert.equal(bip353Name('noffer1qszqqqqhwqpszqq'), null)
})

test('an assembled name over 253 bytes is refused rather than sent', () => {
  const domain = `${'d'.repeat(60)}.${'e'.repeat(60)}.${'f'.repeat(60)}.${'g'.repeat(60)}.com`
  assert.equal(`bob.user._bitcoin-payment.${domain}`.length > 253, true)
  assert.equal(bip353Name(`bob@${domain}`), null)
})

test('a record starting with bitcoin: is a BIP-353 address, and its chunks concatenate with nothing between', async () => {
  // Verified live 2026-08-26: `matt.user._bitcoin-payment.mattcorallo.com` arrives as 2 chunks
  // joining to 490 bytes. RFC 1035 character-strings cap at 255, so any real record is split, and
  // joining with a separator would put a gap inside the URI.
  const split = [['bitcoin:bc1qztwy6xen3zdtt7z0vrgapmjtfz8acjkfp5fp7l?lno=lno1zr5qyugq', 'gskrk70kqmuq7v3dnr2']]
  assert.equal(await hasBip353('matt@mattcorallo.com', async () => split), true)
  assert.equal(await hasBip353('bob@example.com', async () => [['BITCOIN:?lno=x']]), true)
  // Split MID-PREFIX, which is the only shape that fails if the chunks are joined with anything
  // at all or if only the first is read. `['bitcoin:…', '…']` would pass either mistake.
  assert.equal(await hasBip353('bob@example.com', async () => [['bitc', 'oin:?lno=x']]), true)
})

test('the zone\'s own rule: a record that does not start with bitcoin: is ignored', async () => {
  // `mattcorallo.com` publishes exactly this as a second TXT record at the same name, which is
  // the rule stated by the zone itself rather than by us.
  const decoy = "as long as it doesn't start with bitcoin:, other records should be ignored"
  assert.equal(await hasBip353('bob@example.com', async () => [[decoy]]), false)
  assert.equal(await hasBip353('bob@example.com', async () => [['lno1zrxq8pjw7qjlm68mtp7e3yvxee']]), false)
  assert.equal(await hasBip353('bob@example.com', async () => [[]]), false)
  assert.equal(await hasBip353('bob@example.com', async () => []), false)
})

test('a DNS answer is hostile input: an oversized one is refused rather than scanned', async () => {
  // The bound is 4 KB across the whole answer. A resolver that hands back megabytes is either
  // compromised or being used to stall the watcher, and either way there is no payment record in
  // there. Note the `bitcoin:` record is LAST, so a bound that is not actually enforced would
  // reach it and return true.
  const flood = [[ 'x'.repeat(255) ].flatMap(c => Array(20).fill(c))]
  assert.equal(await hasBip353('bob@example.com', async () => [...flood, ['bitcoin:?lno=x']]), false)
})

test('and a resolver that answers with thousands of records is capped at sixteen', async () => {
  const many = [...Array(64).fill(['nothing']), ['bitcoin:?lno=x']]
  assert.equal(await hasBip353('bob@example.com', async () => many), false)
})

test('NXDOMAIN is not an error the caller has to handle, it is just "no"', async () => {
  assert.equal(await hasBip353('bob@example.com', async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }), false)
  assert.equal(await hasBip353('bob@example.com', async () => 'not an array' as unknown as string[][]), false)
})

test('a resolver that never answers is bounded by a WALL CLOCK, not by its own timeout', async () => {
  // The same distinction that made `req.setTimeout` a denial of service on this path: a resolver
  // timeout bounds the QUERY, and what needs bounding is the PROMISE. `refundOversells` is awaited
  // inside a tick and `inFlightGuard` DROPS the polls behind it, so an unbounded lookup here stops
  // stock republishing for as long as a hostile resolver cares to hold the socket open.
  const t0 = Date.now()
  assert.equal(await hasBip353('bob@example.com', () => new Promise(() => {})), false)
  const elapsed = Date.now() - t0
  assert.equal(elapsed < 5_000, true, `gave up after ${elapsed} ms`)
})
