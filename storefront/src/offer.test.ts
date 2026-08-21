// offer.ts is the money-path parser: it decides which pubkey a payment request is addressed to
// and whether the invoice that comes back asks for the price the page displayed. Same style and
// same runner as listing.test.ts — `npm test`, node --test, no framework.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bech32 } from '@scure/base'
import { decodeNoffer, invoiceSats, isPointer, PRICE_FIXED, PRICE_SPONTANEOUS } from './offer.ts'

// A real noffer, minted by the running Lightning.Pub 0.0.37 through `AddUserOffer` on
// 2026-08-20 (/spike/mint-offers.ts) and encoded by @shocknet/clink-sdk's own `nofferEncode`.
// The point of a golden vector from the reference encoder is that our decoder is checked
// against the thing that will actually be in the wild, not against our own encoder's opinion.
const REAL =
  'noffer1qszqqqqhwqpszqqzgserxvrzvvcx2vt9v43kgwf4xsurxerxx93rvc358yunqcf3xyukyvmxx4jkgdf4v4snwwrrvejkvenxxscnyvt9x43rjefn8y6xgvenxvuxgeqpr9mhxue69uhhyetvv9ujumrfva58gmnfdenjuur4vgqzq0c2hedfg3hccr2zl7p7x9ne9j3e8vvjpjakahjswg6s29spt0huyqj43q'
const SERVICE_PUBKEY = '3f0abe5a9446f8c0d42ff83e316792ca393b1920cbb6ede5072350516015befc'

// Local encoder for the edge cases the live node will not produce on demand. Deliberately NOT
// used for the happy path — a decoder tested only against its own encoder proves nothing.
const encode = (tlv: Record<number, Uint8Array>): string => {
  const parts: number[] = []
  for (const [t, v] of Object.entries(tlv)) parts.push(Number(t), v.length, ...v)
  return bech32.encode('noffer', bech32.toWords(new Uint8Array(parts)), 5_000)
}
const utf8 = (s: string) => new TextEncoder().encode(s)
const bytes = (n: number) => new Uint8Array(n).fill(7)
const RELAY = utf8('wss://relay.lightning.pub')

test('a real Lightning.Pub noffer decodes to its four TLVs', () => {
  const offer = decodeNoffer(REAL)!
  assert.equal(offer.pubkey, SERVICE_PUBKEY)
  assert.equal(offer.relay, 'wss://relay.lightning.pub')
  assert.equal(offer.priceType, PRICE_FIXED)
  assert.equal(offer.priceSats, 6000) // the fixture's `plants`, authored at 6000 sats
  assert.equal(offer.offer.length > 0, true)
  // TLV 2 is opaque and per-item; it is emphatically not the account pointer, which is what
  // makes publishing it safe. /docs/spike-findings.md §3.
  assert.notEqual(offer.offer, offer.pubkey)
})

test('a corrupted pointer is rejected rather than decoded to something plausible', () => {
  // One character changed mid-string. bech32's checksum exists for exactly this, and a
  // hand-rolled base32 loop without it would hand us a wrong pubkey with a straight face.
  const flipped = REAL.slice(0, 60) + (REAL[60] === 'q' ? 'p' : 'q') + REAL.slice(61)
  assert.equal(decodeNoffer(flipped), null)
  assert.equal(decodeNoffer(REAL.slice(0, -1)), null)
  assert.equal(decodeNoffer(REAL.toUpperCase()), null) // mixed-case bech32 is invalid
})

test('only noffer pointers are accepted', () => {
  assert.equal(decodeNoffer('npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws'), null)
  assert.equal(decodeNoffer('ndebit1' + REAL.slice(7)), null)
  assert.equal(decodeNoffer(''), null)
  assert.equal(decodeNoffer('noffer1'), null)
  assert.equal(decodeNoffer('lnbc60u1p4g08chpp5' + 'q'.repeat(40)), null)
  assert.equal(decodeNoffer(REAL.repeat(20)), null) // past MAX_NOFFER
})

test('a pointer with no usable destination is rejected', () => {
  const ok = { 0: bytes(32), 1: RELAY, 2: utf8('item-1'), 3: new Uint8Array([0]) }
  assert.notEqual(decodeNoffer(encode(ok)), null)

  assert.equal(decodeNoffer(encode({ 1: RELAY, 2: utf8('x') })), null, 'no service pubkey')
  assert.equal(decodeNoffer(encode({ ...ok, 0: bytes(31) })), null, 'short pubkey')
  assert.equal(decodeNoffer(encode({ 0: bytes(32), 2: utf8('x') })), null, 'no relay')
  assert.equal(decodeNoffer(encode({ ...ok, 1: utf8('https://relay.example') })), null, 'not a relay URL')
  assert.equal(decodeNoffer(encode({ ...ok, 1: utf8('ws://insecure.example') })), null, 'plaintext relay')
  assert.equal(decodeNoffer(encode({ 0: bytes(32), 1: RELAY })), null, 'no offer id')
  assert.equal(decodeNoffer(encode({ ...ok, 1: new Uint8Array([0xff, 0xfe]) })), null, 'relay is not UTF-8')
})

test('a truncated TLV record is not read best-effort', () => {
  // Length byte claims 32 bytes of pubkey, four are present.
  const truncated = bech32.encode('noffer', bech32.toWords(new Uint8Array([0, 32, 1, 2, 3, 4])), 5_000)
  assert.equal(decodeNoffer(truncated), null)
})

test('price type defaults to spontaneous when the pointer omits it', () => {
  // clink-offers.md:29 — no TLV 3 and no TLV 4 means Spontaneous. The reference SDK throws
  // here instead; being lenient on receive is the whole posture.
  const bare = decodeNoffer(encode({ 0: bytes(32), 1: RELAY, 2: utf8('item-1') }))!
  assert.equal(bare.priceType, PRICE_SPONTANEOUS)
  assert.equal(bare.priceSats, undefined)
})

test('the price is read big-endian, as the reference encoder writes it', () => {
  const withPrice = (v: number[]) =>
    decodeNoffer(encode({ 0: bytes(32), 1: RELAY, 2: utf8('i'), 3: new Uint8Array([0]), 4: new Uint8Array(v) }))
  assert.equal(withPrice([0, 0, 0x17, 0x70])!.priceSats, 6000) // the 4-byte form Lightning.Pub emits
  assert.equal(withPrice([0x17, 0x70])!.priceSats, 6000) // shorter is still big-endian
  assert.equal(withPrice([0xff, 0xff, 0xff, 0xff])!.priceSats, 4294967295)
  assert.equal(withPrice([1, 2, 3, 4, 5, 6, 7])!.priceSats, undefined) // past a safe integer
})

test('a fiat-denominated offer is refused, because we have no oracle to check it against', () => {
  // clink-offers.md:27 — TLV 5 is a currency code. /CLAUDE.md rule 1 forbids a price oracle, so
  // an offer we cannot price is an offer we cannot show a Buy button for.
  const fiat = encode({ 0: bytes(32), 1: RELAY, 2: utf8('i'), 3: new Uint8Array([1]), 5: utf8('USD') })
  assert.equal(decodeNoffer(fiat), null)
})

test('invoice amounts are read from the BOLT11 human-readable part', () => {
  // A real invoice from the local node, 2026-08-20, for the 6000-sat `plants` offer.
  const real =
    'lnbc60u1p4g08chpp543vhej394h4er3fcdaye7lnvnp3g4ej0j6888e8j6ke33zfstznsdp909shyernv9kx2tfjxqervtfs8qkhqmrpde68xcqzzsxqrrsssp5gv0wp265auuqggmtzz4nss97avajn6gux763f84dx5p0mgmarr7s9qxpqysgqp6lrahqe9x5dxffjdm5u9g7kzlqmpsz0ntt9xvfju4aqm9397xspgj0444uhrmqrtkrhj05k9ry3ugrj8fn49z9636dqzc3uuc8wctcqpts0l4'
  assert.equal(invoiceSats(real), 6000)
  assert.equal(invoiceSats('lnbc10m1' + 'q'.repeat(20)), 1_000_000)
  assert.equal(invoiceSats('lnbc1500n1' + 'q'.repeat(20)), 150)
  assert.equal(invoiceSats('lnbc2100u1' + 'q'.repeat(20)), 210_000)
})

test('an invoice on any chain but mainnet is refused, in both directions', () => {
  // This test inverted in slice 7. It used to assert `lntb60u1…` reads as 6000 sats, "testnet,
  // same rules" — fine while the only thing we did with a BOLT11 was show it to a buyer whose
  // mainnet wallet would refuse it for us. The refund path pays one, and it comes from a
  // stranger's wallet via an LNURL host or an noffer, so the chain has to be checked here.
  assert.equal(invoiceSats('lntb60u1' + 'q'.repeat(20)), null) // testnet
  assert.equal(invoiceSats('lnbcrt60u1' + 'q'.repeat(20)), null) // regtest
  assert.equal(invoiceSats('lnsb60u1' + 'q'.repeat(20)), null) // signet
})

test('an invoice whose amount cannot be trusted reads as null, never as zero', () => {
  // An amountless invoice is the dangerous one: every wallet will happily let the payer type
  // any number into it, so it must never reach the buyer as "the price you were shown".
  assert.equal(invoiceSats('lnbc1' + 'q'.repeat(30)), null)
  assert.equal(invoiceSats('lnbc1n1' + 'q'.repeat(20)), null) // 0.1 sat is not a whole sat
  assert.equal(invoiceSats('lnbc10p1' + 'q'.repeat(20)), null)
  assert.equal(invoiceSats('lnbc0u1' + 'q'.repeat(20)), null)
  assert.equal(invoiceSats('not an invoice'), null)
  assert.equal(invoiceSats('lnbc99999999999999u1' + 'q'.repeat(20)), null)
  assert.equal(invoiceSats(''), null)
})

// --- what counts as a refund pointer ---------------------------------------------------------
//
// `isPointer` moved here from render.ts in slice 8, when /spike/check-buy.ts became a third
// caller. It is not form validation: the page accepts a string with it, the node stores that
// string on a settled invoice forever, and /spike/refund.ts pays whatever it resolves to. A shape
// the page accepts and the watcher cannot pay is a refund that silently never arrives — so there
// is one definition, and this is where it is checked.

test('a refund pointer is a Lightning address or a real noffer, and nothing else', () => {
  assert.equal(isPointer('bob@walletofsatoshi.com'), true)
  assert.equal(isPointer(REAL), true)
  // The bug this file's LN_ADDRESS regex actually shipped: a two-character second-level domain
  // was rejected, which is `ln.tips` and every address like it — a buyer who could not buy.
  assert.equal(isPointer('bob@ln.tips'), true)
  // Trimmed, because a pasted pointer arrives with whitespace and the page trims before sending.
  // Asserted rather than assumed: the same paste-with-a-newline gap was a real defect in
  // decodeNmanage (/docs/known-defects.md, closed by slice 7's Phase 0).
  assert.equal(isPointer('  bob@ln.tips\n'), true)
})

test('a pointer that is neither shape is refused rather than sent to the node', () => {
  assert.equal(isPointer('not a pointer'), false)
  assert.equal(isPointer('bob@'), false)
  assert.equal(isPointer('@host.com'), false)
  assert.equal(isPointer(''), false)
  assert.equal(isPointer('   '), false)
  // A BOLT11 is not a refund pointer. It is a single-use invoice for one amount that will be
  // expired long before an oversell is detected, and accepting one here would look like it worked.
  assert.equal(isPointer('lnbc10u1p4g07g5pp5' + 'q'.repeat(20)), false)
  // Not a string at all — this is a stored value read back off a node, not only form input.
  assert.equal(isPointer(undefined as unknown as string), false)
  assert.equal(isPointer(null as unknown as string), false)
})

test('an noffer with a broken checksum is not a pointer, however address-like it looks', () => {
  // The reason this uses the real decoder rather than a /^noffer1/ shape test: a flipped
  // character passes any regex and addresses a wallet that is not the buyer's.
  assert.equal(isPointer(REAL.slice(0, -1) + (REAL.at(-1) === 'q' ? 'p' : 'q')), false)
  assert.equal(isPointer('noffer1nonsense'), false)
})
