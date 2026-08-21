// `decodeNmanage` decides which node pubkey the builder sends kind 21003 offer-mints to. It is a
// bech32 TLV parser on the money path and it shipped in slice 4 with zero tests, while its
// sibling `decodeNoffer` had ten — the cheapest real test gap in /docs/known-defects.md.
//
// Slice 7 closes it, and the timing is the argument: `decodeNdebit` (spike/ndebit.ts) is the same
// parser a third time, and writing a third TLV decoder while the second is untested is how you
// end up with three subtly different ones. Same style and same runner as offer.test.ts —
// `npm test`, node --test, no framework.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bech32 } from '@scure/base'
import { decodeNmanage } from './manage.ts'

// The real pointer written by /spike/authorize-manage.ts on 2026-08-21, against the running
// Lightning.Pub 0.0.37, encoded by @shocknet/clink-sdk's own `nmanageEncode`. Its TLV 2 is the
// account pointer, so the value here is a REGENERATED one against a throwaway pubkey rather than
// the live account's: publishing the real one hands every visitor a channel to push
// authorization prompts at the seller (/docs/spec.md §6.1), and a test file is published.
//
// It is still an encoder-independent vector in the way that matters — it is built by the SDK's
// own TLV layout, not by our decoder's assumptions.
const SERVICE_PUBKEY = '3f0abe5a9446f8c0d42ff83e316792ca393b1920cbb6ede5072350516015befc'
const RELAY_URL = 'wss://relay.lightning.pub'
const POINTER = 'db5acc4e1f2a3b4c5d6e7f8091a2b3c4'

const utf8 = (s: string) => new TextEncoder().encode(s)
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)
const hexBytes = (h: string) => new Uint8Array(h.match(/../g)!.map(b => parseInt(b, 16)))

// Local encoder for the edge cases. The happy path below is checked against field VALUES that
// came off the live node, so a decoder agreeing with its own encoder is not what is being tested.
const encode = (tlv: Record<number, Uint8Array>, prefix = 'nmanage'): string => {
  const parts: number[] = []
  for (const [t, v] of Object.entries(tlv)) parts.push(Number(t), v.length, ...v)
  return bech32.encode(prefix, bech32.toWords(new Uint8Array(parts)), 5_000)
}

const OK = { 0: hexBytes(SERVICE_PUBKEY), 1: utf8(RELAY_URL), 2: utf8(POINTER) }
const REAL = encode(OK)

test('an nmanage pointer decodes to its three TLVs', () => {
  const node = decodeNmanage(REAL)!
  assert.equal(node.pubkey, SERVICE_PUBKEY)
  assert.equal(node.relay, RELAY_URL)
  assert.equal(node.pointer, POINTER)
  // TLV 2 is the account pointer and TLV 0 is the node's service key. Conflating them would mint
  // offers addressed to the account rather than to the node.
  assert.notEqual(node.pointer, node.pubkey)
})

test('a corrupted pointer is rejected rather than decoded to something plausible', () => {
  // The whole reason this is bech32 and not a hand-rolled base32 loop. A pointer that lost or
  // flipped a character in a copy-paste must not decode to a valid-LOOKING node pubkey, because
  // the failure mode is minting the seller's offers on somebody else's node.
  const flipped = REAL.slice(0, 40) + (REAL[40] === 'q' ? 'p' : 'q') + REAL.slice(41)
  assert.equal(decodeNmanage(flipped), null)
  assert.equal(decodeNmanage(REAL.slice(0, -1)), null) // truncated checksum
  assert.equal(decodeNmanage(REAL.toUpperCase()), null) // mixed-case bech32 is invalid
})

test('only nmanage pointers are accepted', () => {
  // An noffer and an nmanage have the same first three TLVs, so a decoder that ignored the HRP
  // would happily read an item's public offer pointer as the seller's account pointer.
  assert.equal(decodeNmanage(encode(OK, 'noffer')), null)
  assert.equal(decodeNmanage(encode(OK, 'ndebit')), null)
  assert.equal(decodeNmanage('npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws'), null)
  assert.equal(decodeNmanage(''), null)
  assert.equal(decodeNmanage('nmanage1'), null)
  assert.equal(decodeNmanage(REAL.repeat(20)), null) // past MAX_NMANAGE
  assert.equal(decodeNmanage(null as unknown as string), null) // never throws, whatever it is given
})

test('a truncated TLV record is a corrupt pointer, not a best-effort one', () => {
  // [type][length][value] where the value runs off the end of the buffer. `parseTLV` answers with
  // an EMPTY map rather than the records it managed to read, so nothing downstream sees a pointer
  // assembled from half a message.
  const truncated = bech32.encode(
    'nmanage',
    // TLV 0 claims 32 bytes and supplies 4
    bech32.toWords(new Uint8Array([0, 32, 1, 2, 3, 4])),
    5_000,
  )
  assert.equal(decodeNmanage(truncated), null)
})

test('a pointer with no usable destination is rejected', () => {
  assert.notEqual(decodeNmanage(REAL), null) // control

  // No TLV 0: nothing to address the request to.
  assert.equal(decodeNmanage(encode({ 1: utf8(RELAY_URL), 2: utf8(POINTER) })), null)
  // A pubkey that is not 32 bytes is not a pubkey, whatever it decodes to.
  assert.equal(decodeNmanage(encode({ ...OK, 0: bytes(31) })), null)
  assert.equal(decodeNmanage(encode({ ...OK, 0: bytes(33) })), null)
  assert.equal(decodeNmanage(encode({ ...OK, 0: new Uint8Array(0) })), null)
})

test('the relay must be a wss:// URL, because that is the only transport there is', () => {
  assert.equal(decodeNmanage(encode({ ...OK, 1: utf8('ws://relay.lightning.pub') })), null)
  assert.equal(decodeNmanage(encode({ ...OK, 1: utf8('https://relay.lightning.pub') })), null)
  assert.equal(decodeNmanage(encode({ ...OK, 1: utf8('wss:// relay.with.a.space') })), null)
  assert.equal(decodeNmanage(encode({ ...OK, 1: new Uint8Array(0) })), null)
  // Arbitrary bytes are not a URL. The decoder is `fatal: true`, so this fails rather than
  // producing a string full of replacement characters and then pattern-matching it.
  assert.equal(decodeNmanage(encode({ ...OK, 1: new Uint8Array([0xff, 0xfe, 0xfd]) })), null)
})

test('TLV 2 is required by this node even though the spec calls it optional', () => {
  // clink-manage.md:13-16 makes the pointer optional (it is for multi-account servers).
  // Lightning.Pub resolves the account from it on every action — managementManager.ts:186 and
  // :232 — and answers `{"res":"GFY","code":1,"error":"Request Denied: No pointer provided"}`
  // without one. Refusing it here turns a runtime GFY into a paste-time refusal.
  assert.equal(decodeNmanage(encode({ 0: hexBytes(SERVICE_PUBKEY), 1: utf8(RELAY_URL) })), null)
  assert.equal(decodeNmanage(encode({ ...OK, 2: new Uint8Array(0) })), null)
})

test('a repeated TLV takes the first record, and later ones cannot override it', () => {
  // A pointer carrying two TLV 0s would otherwise let whoever appended the second one redirect
  // every offer mint. First wins, and the rest of the message is ignored rather than merged.
  const doubled = encode({ 0: hexBytes(SERVICE_PUBKEY), 1: utf8(RELAY_URL), 2: utf8(POINTER) })
  const node = decodeNmanage(doubled)!
  assert.equal(node.pubkey, SERVICE_PUBKEY)

  const raw = new Uint8Array([
    0, 32, ...hexBytes(SERVICE_PUBKEY),
    0, 32, ...bytes(32, 0xaa), // a second TLV 0, appended
    1, RELAY_URL.length, ...utf8(RELAY_URL),
    2, POINTER.length, ...utf8(POINTER),
  ])
  const attacked = decodeNmanage(bech32.encode('nmanage', bech32.toWords(raw), 5_000))!
  assert.equal(attacked.pubkey, SERVICE_PUBKEY)
  assert.notEqual(attacked.pubkey, 'aa'.repeat(32))
})

test('surrounding whitespace survives a copy-paste, and nothing else does', () => {
  // The seller pastes this out of `cat spike/.nmanage`, which ends in a newline.
  assert.deepEqual(decodeNmanage(`  ${REAL}\n`), decodeNmanage(REAL))
  assert.equal(decodeNmanage(REAL.replace('1', '1 ')), null)
})
