// Spike: does M1's ladder actually survive a round trip through real relays?
//
// Same contract as check-deploy.ts and check-manage.ts: it imports the SHIPPED modules rather
// than re-implementing them, so if this file and the builder ever disagree, this file is wrong.
// `ladderEvent` here is the same function `builder/src/publish.ts` calls, and `parseRung` and
// `chooseLadder` are the same ones `watch-sales.ts` uses.
//
// THE REASON THIS EXISTS. `npm test` proves the encrypt/decrypt round trip and every branch of
// the precedence rule offline, deterministically, in milliseconds. What it cannot prove is that a
// relay will accept a 30078 of this size, hand it back under an `authors` + `#d` filter, and push
// it to a live subscription. Those are the three things M1 replaced a USB stick with.
//
// COSTS NOTHING AND NEEDS NO SELLER KEY. Both keys here are generated per run and thrown away, so
// this proves the mechanism on any machine with a network, including one with no Lightning.Pub
// and no .dev-key. It publishes under a throwaway identity that owns nothing and is never seen
// again. Nothing in the real sale is touched, read, or written.
//
// Usage: node check-ladder-relay.ts [--relays wss://a,wss://b]
import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import { npubEncode } from 'nostr-tools/nip19'
import { ladderEvent, publishLadder, watcherPubkey } from '../builder/src/ladder-relay.ts'
import { chooseLadder, LADDER_KIND, ladderD, listingDOf, parseRung, type Rung } from './ladder.ts'
import type { Signer } from '../builder/src/signer.ts'
import { SALE_RELAYS } from './fixture.ts'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]!
}
const RELAYS = arg('relays', SALE_RELAYS.join(',')).split(',')

let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`)
  if (!ok) failures++
}

// KEY HANDLING NOTICE. Two raw private keys, both generated in memory for this process and never
// written anywhere. This is the narrowest form of the /CLAUDE.md rule-2 exception: no file, no
// config, no log line, and nothing either key signs has any standing after this exits.
const sellerSk = generateSecretKey()
const SELLER = getPublicKey(sellerSk)
const watcherSk = generateSecretKey()
const WATCHER = getPublicKey(watcherSk)

// The same four-method shim deploy.test.ts and check-manage.ts use, over a key held only here.
const signer: Signer = {
  label: 'check-ladder-relay',
  getPublicKey: async () => SELLER,
  signEvent: async (e: EventTemplate) => finalizeEvent(e, sellerSk) as VerifiedEvent,
  nip44Encrypt: async (to, text) => encrypt(text, getConversationKey(sellerSk, to)),
  nip44Decrypt: async (to, ct) => decrypt(ct, getConversationKey(sellerSk, to)),
  close: async () => {},
}

// A rung shaped like a real one, and deliberately FAT. The point of measuring is the ceiling, so a
// 200-byte toy would prove nothing about the size a photo-carrying item actually reaches. The
// fattest real item in the Mérida sale measured 19,906 bytes on 2026-08-26.
const D = `check-ladder-${Date.now()}`
const filler = 'x'.repeat(6_000)
const rung: Rung = {
  units: 3,
  noffer: 'noffer1qszqqqr4xqpszqqzgsmrqcekxcukxdnyvdjrxdtyv5erwcmzxvengvpcvyerydpjxgurqvecx43nve3jx',
  steps: [2, 1, 0].map(n => ({
    id: `${n}`.repeat(64),
    pubkey: SELLER,
    created_at: 1_756_000_000 + n,
    kind: 30402,
    tags: [['d', D], ['stock', String(n)], ['summary', filler]],
    content: filler,
    sig: 'f'.repeat(128),
  })) as unknown as Rung['steps'],
}

console.log(`# seller  ${npubEncode(SELLER)}   (throwaway, generated for this run)`)
console.log(`# watcher ${npubEncode(WATCHER)}  (throwaway, generated for this run)`)
console.log(`# relays  ${RELAYS.join(', ')}\n`)

// --- 1. what the builder does -----------------------------------------------------------------
console.log('# 1. the builder side')
check(watcherPubkey(npubEncode(WATCHER)) === WATCHER, 'the pasted npub decodes to the watcher key')

const event = await ladderEvent(signer, WATCHER, D, rung)
const plaintextBytes = JSON.stringify(rung).length
console.log(`  --   payload ${plaintextBytes} bytes plaintext, ${event.content.length} bytes ciphertext`)
check(event.kind === LADDER_KIND, `kind ${LADDER_KIND}`)
check(event.tags.length === 1 && event.tags[0]![1] === ladderD(D), `one tag, d = ${ladderD(D)}`)
check(!event.content.includes(D), 'the item is NOT readable on the relay')
check(!event.content.includes('noffer1'), 'the offer is NOT readable on the relay')

// --- 2. will four public relays take it? ------------------------------------------------------
console.log('\n# 2. the relays')
const pool = new SimplePool()
const accepted = await publishLadder(pool, event, RELAYS)
check(accepted > 0, `${accepted}/${RELAYS.length} relays accepted a ${event.content.length}-byte 30078`)

// --- 3. what the watcher does -----------------------------------------------------------------
// The real filter: by author and by kind, exactly as watch-sales.ts subscribes, then sorted out
// by `d` because the watcher cannot ask for ladders by name.
console.log('\n# 3. the watcher side')
const back = await pool.querySync(RELAYS, { kinds: [LADDER_KIND], authors: [SELLER] })
check(back.length > 0, `read ${back.length} event(s) back under authors + kind`)

const mine = back.find(ev => listingDOf(ev.tags.find(t => t[0] === 'd')?.[1] ?? '') === D)
check(!!mine, 'and one of them maps back to the item it belongs to')

let decrypted: Rung | undefined
if (mine) {
  decrypted = parseRung(decrypt(mine.content, getConversationKey(watcherSk, SELLER)))
  check(!!decrypted, 'it decrypts with (watcher private, seller public) and survives the bounded parse')
  check(JSON.stringify(decrypted) === JSON.stringify(rung), 'and it is byte-for-byte what went in')
}

// A third key must not be able to read it. This is the property the whole design rests on: the
// rungs inside are signed public listings, and the lowest rung is the seller's lowest stock.
if (mine) {
  let opened = false
  try {
    decrypt(mine.content, getConversationKey(generateSecretKey(), SELLER))
    opened = true
  } catch {
    opened = false
  }
  check(!opened, 'a key that is not the watcher opens nothing')
}

// --- 4. precedence, against what actually came off the wire -----------------------------------
console.log('\n# 4. precedence')
const onDisk: Rung = { units: 1, steps: [] }
check(chooseLadder(decrypted, onDisk, false).source === 'relay', 'the relay ladder outranks the file')
check(chooseLadder(undefined, onDisk, false).source === 'file', 'no relay ladder falls back to the file')
check(chooseLadder(undefined, onDisk, true).warn !== undefined, 'a FAILED read falls back loudly')
check(chooseLadder(undefined, undefined, false).source === 'none', 'neither is not watched')

// --- 5. does a live subscription get pushed an update? ----------------------------------------
// This is the half that removes the RESTART, so proving the query works is not enough.
console.log('\n# 5. the live subscription')
const pushed = await new Promise<boolean>(resolve => {
  const timer = setTimeout(() => {
    sub.close()
    resolve(false)
  }, 15_000)
  const sub = pool.subscribe(RELAYS, { kinds: [LADDER_KIND], authors: [SELLER], since: Math.floor(Date.now() / 1000) }, {
    onevent: ev => {
      if (listingDOf(ev.tags.find(t => t[0] === 'd')?.[1] ?? '') !== D) return
      clearTimeout(timer)
      sub.close()
      resolve(true)
    },
  })
  // Republish AFTER the subscription is open, which is what an edit looks like from here.
  void ladderEvent(signer, WATCHER, D, { ...rung, units: 2 }).then(next => publishLadder(pool, next, RELAYS))
})
check(pushed, 'a re-published ladder reaches an open subscription with no restart')

pool.close(RELAYS)
console.log(`\n# ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
