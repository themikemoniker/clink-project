// M1's publish half: the ladder leaves the browser over a relay instead of a downloaded file.
//
// Same runner and same style as the rest of the builder's tests, and the same narrow Signer shim
// deploy.test.ts uses: keys generated per run and held only in memory, which is the narrowest form
// of the /CLAUDE.md rule-2 exception and the only way to prove a round trip actually round-trips.
//
// Nothing here touches a relay. What a relay adds is covered by /spike/check-ladder-relay.ts,
// which is on-demand and runs under a throwaway key.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import { npubEncode } from 'nostr-tools/nip19'
import { LADDER_KIND, ladderD, MAX_LADDER_PLAINTEXT, parseRung } from '../../spike/ladder.ts'
import { ladderEvent, watcherPubkey } from './ladder-relay.ts'
import type { Signer } from './signer.ts'

const sellerSk = generateSecretKey()
const SELLER = getPublicKey(sellerSk)
const watcherSk = generateSecretKey()
const WATCHER = getPublicKey(watcherSk)

const signer: Signer = {
  label: 'test',
  getPublicKey: async () => SELLER,
  signEvent: async (e: EventTemplate) => finalizeEvent(e, sellerSk) as VerifiedEvent,
  nip44Encrypt: async (to, text) => encrypt(text, getConversationKey(sellerSk, to)),
  nip44Decrypt: async (to, ct) => decrypt(ct, getConversationKey(sellerSk, to)),
  close: async () => {},
}

const RUNG = {
  units: 2,
  noffer: 'noffer1qszqqqr4xqpszqqzgsmrqcekxcukxdnyvdjrxdtyv5erwcmzx',
  steps: [
    { id: 'a', kind: 30402, created_at: 2, tags: [['d', 'yardsale-lamp']], content: '', pubkey: SELLER, sig: 'x' },
    { id: 'b', kind: 30402, created_at: 3, tags: [['d', 'yardsale-lamp']], content: '', pubkey: SELLER, sig: 'y' },
  ],
} as unknown as Parameters<typeof ladderEvent>[3]

test('the watcher pubkey is pasted, and anything that is not one is refused before it is trusted', async () => {
  // Paste, not discovery, and this function is the whole reason that distinction is safe. The
  // builder has to know which pubkey to trust BEFORE it encrypts, because encrypting to an
  // attacker's key hands them the lowest stock on every item in the sale.
  assert.equal(watcherPubkey(npubEncode(WATCHER)), WATCHER, 'an npub is what the watcher prints')
  assert.equal(watcherPubkey(`  ${npubEncode(WATCHER)}  `), WATCHER, 'pasting picks up whitespace')
  assert.equal(watcherPubkey(WATCHER), WATCHER, 'raw hex too, the way check-admin.ts takes either')

  assert.equal(watcherPubkey(''), undefined)
  assert.equal(watcherPubkey('   '), undefined)
  assert.equal(watcherPubkey('not an npub'), undefined)
  assert.equal(watcherPubkey('npub1obviouslynotvalid'), undefined, 'a bad checksum is not a key')
  assert.equal(watcherPubkey(WATCHER.slice(0, 63)), undefined, 'a truncated hex key is not a key')
  assert.equal(watcherPubkey(`${WATCHER}ff`), undefined, 'nor is an overlong one')
  assert.equal(watcherPubkey('g'.repeat(64)), undefined, 'nor 64 characters that are not hex')

  // An nsec pasted into the wrong box must not be quietly accepted and encrypted to. It is the
  // one paste error that would put a private key in this field, so it gets its own refusal.
  assert.equal(watcherPubkey('nsec1' + 'q'.repeat(58)), undefined, 'an nsec is not a pubkey')
})

test('the ladder leaves the browser encrypted, and only the watcher can open it', async () => {
  const event = await ladderEvent(signer, WATCHER, 'yardsale-2026-08-lamp', RUNG)

  assert.equal(event.kind, LADDER_KIND)
  assert.deepEqual(event.tags, [['d', ladderD('yardsale-2026-08-lamp')]], 'the d tag and nothing else')
  assert.equal(event.pubkey, SELLER, 'authored by the seller, so the watcher can filter on authors')

  // THE POINT OF THE WHOLE EVENT. The rungs are signed public kind 30402s; publishing them raw
  // would immediately advertise the lowest stock on every item (/README.md, M1). So the payload
  // must not be legible on the relay, and the assertion is on the actual content, not on the
  // fact that we called an encrypt function.
  assert.ok(!event.content.includes('noffer1'), 'the offer is not readable on the relay')
  assert.ok(!event.content.includes('yardsale-lamp'), 'nor is the item it belongs to')
  assert.ok(!event.content.includes('"units"'), 'nor the shape of the payload')

  // The watcher opens it with its own key and the seller's public one, and gets back exactly the
  // bytes that went in: same payload on the relay as in the file, so precedence is a straight
  // swap and there is one parser rather than two.
  const plaintext = decrypt(event.content, getConversationKey(watcherSk, SELLER))
  assert.deepEqual(parseRung(plaintext), RUNG, 'what the watcher parses is what the builder sent')

  // And nobody else can, including the seller's own reader: this is encrypted to the watcher, not
  // to self the way builder/src/notes.ts is.
  const eve = generateSecretKey()
  assert.throws(() => decrypt(event.content, getConversationKey(eve, SELLER)), 'a third key opens nothing')
})

test('an item too fat to encrypt is refused here, not dropped silently by the watcher later', async () => {
  // The binding cap on this whole design is NIP-44's 65,535-byte plaintext ceiling, not a relay's
  // event size limit (measured 2026-08-23: nos.lol allows 131,072, damus and primal about a
  // million). It is also the measurement that made M1 one event per item rather than one for the
  // shop: the whole Mérida sale with photos is 57,741 bytes, 88.1% of the ceiling, and breaks at
  // about nine items, while its fattest single item is 19,906 bytes, 30% of it.
  //
  // The watcher's `parseRung` already refuses an oversized payload, but that refusal happens on
  // another machine, hours later, and reads as "this item has no ladder". The seller is standing
  // right here, so the seller is who gets told.
  const fat = { units: 1, steps: [{ content: 'x'.repeat(MAX_LADDER_PLAINTEXT) }] } as unknown as Parameters<typeof ladderEvent>[3]
  await assert.rejects(
    () => ladderEvent(signer, WATCHER, 'yardsale-2026-08-jabon', fat),
    /yardsale-2026-08-jabon.*bytes/s,
    'and it names the item, because a sale has several and only one of them is too big',
  )

  // The limit is a limit, not a suggestion: what fits still goes out.
  const snug = { units: 1, steps: [{ content: 'x'.repeat(1_000) }] } as unknown as Parameters<typeof ladderEvent>[3]
  assert.equal((await ladderEvent(signer, WATCHER, 'yardsale-2026-08-lamp', snug)).kind, LADDER_KIND)
})
