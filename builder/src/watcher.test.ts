// M1's builder half, the part that is provable without a relay: which pastes become a watcher key
// and which are refused.
//
// This is a bound on input that decides WHO CAN READ THE LADDER, which makes it the most
// consequential paste in the app. A ladder encrypted to the wrong key fails silently in the worst
// possible way: it publishes fine, it decrypts for nobody, and the watcher simply never updates
// stock, so the first symptom is an item still on sale after it sold. Refusing at paste time is the
// whole safety story, so every refusal has an assertion.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as nip19 from 'nostr-tools/nip19'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { approvalCount, type Draft } from './listing.ts'
import { watcherPubkey } from './watcher.ts'

const sk = generateSecretKey()
const PK = getPublicKey(sk)
const NPUB = nip19.npubEncode(PK)

test('M1: an npub becomes the hex pubkey the ladder is encrypted to', () => {
  assert.equal(watcherPubkey(NPUB), PK)
  // Pasted out of a terminal, so surrounding whitespace is the normal case rather than the edge.
  assert.equal(watcherPubkey(`  ${NPUB}\n`), PK)
})

test('M1: everything that is not an npub is refused, including a valid hex pubkey', () => {
  for (const bad of [
    '',
    '   ',
    'not a key',
    PK, // A RAW HEX PUBKEY IS REFUSED ON PURPOSE. It is the correct value in the wrong format, and
    // accepting it would drop the one protection this field has: hex carries no checksum, so a
    // single mistyped character is a valid-looking key belonging to nobody and the ladder would
    // encrypt to it silently. The npub's bech32 checksum turns that into an error at paste time.
    nip19.nsecEncode(sk), // an nsec: the seller pasting their own secret key must never be stored
    nip19.noteEncode('a'.repeat(64)),
    'npub1', // the prefix alone
    'npub1nonsense',
    `${NPUB}x`, // one character too many, which is exactly what the checksum is for
    NPUB.slice(0, -1), // and one too few
    NPUB.replace(/.$/, c => (c === 'a' ? 'b' : 'a')), // a single flipped character
  ]) {
    assert.equal(watcherPubkey(bad), null, `should refuse: ${bad.slice(0, 24)}`)
  }
})

test('M1: an nsec is refused, so a seller cannot paste their signing key into this field', () => {
  // Worth its own assertion rather than one entry in a list. The field sits next to the node
  // pointer and asks for "your watcher key", and /CLAUDE.md rule 2 says no private key exists
  // anywhere in this codebase outside a Signer. `nip19.decode` would happily hand back an nsec's
  // bytes, and being stored in `localStorage` is where they would go.
  //
  // MEASURED 2026-09-25, because the first version of this comment named the wrong guard: TWO
  // checks refuse it, the `npub1` prefix and `decoded.type === 'npub'`, and EITHER ALONE IS
  // ENOUGH. Deleting one keeps every assertion here green; deleting both fails this test and the
  // one above. So this is redundancy on purpose rather than one load-bearing line, and no single
  // mutation can show which did the work, because neither has to.
  assert.equal(watcherPubkey(nip19.nsecEncode(sk)), null)
})

const draft = (over: Partial<Draft> = {}): Draft => ({
  slug: 'lamp',
  title: 'Brass floor lamp',
  summary: 'Works.',
  priceSats: 30_000,
  stock: 3,
  alt: '',
  blobs: [],
  servers: [], // required on Draft, and an item with no photos genuinely stored on none
  ...over,
})

test('M1: the ladder event is one more signature, and only when there is a watcher to send it to', () => {
  const d = draft()
  // 1 listing + 3 availability steps, and nothing else on a cash-only item with no photos.
  assert.equal(approvalCount(d, false, 0), 1 + 3)
  assert.equal(approvalCount(d, false, 0, true), 1 + 3 + 1)
  // The count must be exactly one higher, not "higher": the seller is told a number and then
  // asked for that many approvals, and the 2026-08-26 review's whole finding was that those two
  // have to be one number.
  assert.equal(approvalCount(d, false, 0, true) - approvalCount(d, false, 0, false), 1)
  // It rides on top of every other term rather than replacing one.
  assert.equal(approvalCount(d, true, 3, true), 3 + 1 + 1 + 3 + 1)
  // And a fiat item, which never mints an offer, still gets its ladder sent.
  const fiat = draft({ fiat: { currency: 'MXN', amount: 80 }, stock: 1 })
  assert.equal(approvalCount(fiat, true, 0, true), 1 + 1 + 1)
})
