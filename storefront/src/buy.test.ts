// The one thing `requestInvoice` promises that nothing was checking: **it resolves, it does not
// reject.** Every network and protocol path in buy.ts honours that already — one `finish()` per
// branch plus a deadline — and the panel's `render.ts:521` claim was that the Buy form awaits it
// with no `try`, so a rejection leaves the buyer on a permanently disabled form reading "Asking
// the seller's node for an invoice…".
//
// The 2026-08-23 review found the claim real and the trigger narrower than "a rejection": the
// reachable throws are SYNCHRONOUS, before the promise. `decodeNoffer` checks TLV 0 is 32 bytes
// and nothing more, so a `clink_offer` carrying 32 bytes that are not a point on secp256k1 parses
// and then throws inside `getConversationKey`. That is a malformed offer in the seller's own
// listing rather than a dead relay, which is why no amount of network testing found it.
//
// Nothing here opens a socket: the throw happens before the pool is constructed, which is also
// what makes this the regression test rather than a mock of one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestInvoice } from './buy.ts'
import { PRICE_FIXED, type Offer } from './offer.ts'

// A real curve point — the fixture seller's node pubkey, as it appears in every noffer this
// project has minted. The test is only meaningful if the "bad" case differs from a good one.
const ON_CURVE = '3f0abe5a9446f8c0d42ff83e316792ca393b1920cbb6ede5072350516015befc'

// A relay nothing is listening on, so the negative control fails on a refused connection rather
// than on the network. No DNS, no public relay, no waiting out a 20s deadline.
const DEAD_RELAY = 'wss://127.0.0.1:1'

const offer = (pubkey: string): Offer => ({
  pubkey,
  relay: DEAD_RELAY,
  offer: 'db5acc4e1f2a3b4c5d6e7f8091a2b3c4',
  priceType: PRICE_FIXED,
  priceSats: 1_000,
})

test('a malformed offer pubkey does not leave the Buy form permanently disabled', async () => {
  // 32 bytes with no valid y — decodeNoffer accepts it (it checks the length), and
  // getConversationKey does not.
  const outcome = await requestInvoice(offer('f'.repeat(64)), { refund_pointer: 'bob@example.com' }, 1_000, 'Mugs', () => {})
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.code, 0)
  // The form re-enables on any `ok: false`, so resolving IS the fix. What the copy has to do is
  // say whose problem it is — nothing the buyer typed caused this and nothing they can do fixes it.
  assert.match(outcome.ok === false ? outcome.error : '', /payment pointer is unusable/)
  assert.match(outcome.ok === false ? outcome.error : '', /Nothing was sent/)
})

test('and the error carries no curve arithmetic, because it is addressed to a person', async () => {
  const outcome = await requestInvoice(offer('00'.repeat(32)), {}, 1_000, 'Mugs', () => {})
  assert.equal(outcome.ok, false)
  const text = outcome.ok === false ? outcome.error : ''
  for (const leak of ['Point', 'secp', 'sqrt', 'hex', 'Uint8Array']) assert.equal(text.includes(leak), false, leak)
})

test('a pubkey that IS on the curve gets past the prologue', async () => {
  // The negative control. This one gets past the prologue and fails on the refused connection
  // instead — so a test that only asserted "ok: false" above would have passed with the bug still
  // in place.
  const outcome = await requestInvoice(offer(ON_CURVE), {}, 1_000, 'Mugs', () => {})
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && /payment pointer is unusable/.test(outcome.error), false)
})
