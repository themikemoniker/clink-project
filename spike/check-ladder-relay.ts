// Spike: does an M1 ladder actually survive a round trip over four public relays?
//
// Same contract as check-deploy.ts and check-manage.ts: it imports the shipped modules rather than
// re-implementing them, so if this file and the builder ever disagree, this file is wrong. The
// event is built the way `builder/src/watcher.ts` builds it and read the way
// `spike/watch-sales.ts` reads it.
//
// WHY IT EXISTS. `ladder.test.ts` proves the `d` scheme, every bound on the payload, all six
// branches of precedence, and a NIP-44 round trip between two keys. None of that touches a relay,
// and the thing M1 actually claims is that an edit reaches the watcher WITHOUT a human moving a
// file. Between those two is a list of things only a relay can answer: whether a relay stores a
// kind 30078 at all, whether it replaces on (kind, pubkey, `d`) the way NIP-01 says, whether
// NIP-44 ciphertext survives the JSON round trip byte for byte, and whether a ~20 KB event is
// inside the limits these four relays enforce.
//
// COSTS NOTHING AND NEEDS NO SELLER KEY. Both keys are generated per run and held only in memory,
// which is the narrowest form of the /CLAUDE.md rule-2 exception and the same one ladder.test.ts
// takes. Nothing it publishes is addressed to the real seller, so nothing it writes can touch the
// live sale: the events are authored by a throwaway pubkey nobody reads.
//
// Usage:
//   node check-ladder-relay.ts [--relays wss://a,wss://b] [--units 3] [--pad 20000]
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import { npubEncode } from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'
import { parseListings } from '../storefront/src/listing.ts'
import { atStock } from './ladder.ts'
import { LADDER_KIND, chooseLadder, ladderD, parseLadder, type Rung } from './ladder.ts'
import { SALE_RELAYS } from './fixture.ts'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]!
}
const RELAYS = arg('relays', SALE_RELAYS.join(',')).split(',')
const UNITS = Number(arg('units', '3'))
// Padding in the listing content, to put the event near the size a photo-carrying item reaches.
// The M1 brief measured the fattest real item at 19,906 bytes, 30% of NIP-44's plaintext ceiling.
const PAD = Number(arg('pad', '20000'))

const sellerSk = generateSecretKey()
const SELLER = getPublicKey(sellerSk)
const watcherSk = generateSecretKey()
const WATCHER = getPublicKey(watcherSk)

const D = 'checkladder-2026-09-lamp'
const ok = (label: string, good: boolean, detail = '') => {
  console.log(`${good ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!good) process.exitCode = 1
}

console.log(`# throwaway seller ${npubEncode(SELLER)}`)
console.log(`# throwaway watcher ${npubEncode(WATCHER)}`)
console.log(`# relays ${RELAYS.join(', ')}\n`)

// --- 1. build the ladder exactly as the builder would ------------------------------------------
const tags = (stock: string): string[][] => [
  ['d', D],
  ['title', 'Brass floor lamp'],
  ['price', '30000', 'sats'],
  ['stock', stock],
  ['status', 'active'],
]
const now = Math.floor(Date.now() / 1000)
const steps: Event[] = Array.from({ length: UNITS }, (_, i) =>
  finalizeEvent(
    { kind: 30402, created_at: now + i + 1, tags: atStock(tags(String(UNITS)), UNITS - i - 1), content: 'x'.repeat(Math.floor(PAD / UNITS)) },
    sellerSk,
  ),
)
const rung: Rung = { units: UNITS, steps: steps as Rung['steps'] }
const plaintext = JSON.stringify(rung)
console.log(`# payload ${plaintext.length} bytes, ${((plaintext.length / 65_535) * 100).toFixed(1)}% of NIP-44's plaintext ceiling`)
ok('the payload is under NIP-44’s plaintext ceiling', plaintext.length <= 65_535, `${plaintext.length} <= 65535`)

const event = finalizeEvent(
  {
    kind: LADDER_KIND,
    created_at: now,
    tags: [['d', ladderD(D)]],
    content: nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(sellerSk, WATCHER)),
  },
  sellerSk,
)
console.log(`# event ${JSON.stringify(event).length} bytes on the wire, d=${ladderD(D)}\n`)

// --- 2. publish it ------------------------------------------------------------------------------
const pool = new SimplePool()
const settled = await Promise.allSettled(
  pool.publish(RELAYS, event).map(p => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000))])),
)
settled.forEach((r, i) => console.log(`${r.status === 'fulfilled' ? 'ok  ' : 'FAIL'} published to ${RELAYS[i]}${r.status === 'rejected' ? ` — ${String(r.reason)}` : ''}`))
const accepted = settled.filter(r => r.status === 'fulfilled').length
ok('at least one relay accepted the ladder', accepted > 0, `${accepted}/${RELAYS.length}`)
console.log()

// --- 3. read it back, the way the watcher does --------------------------------------------------
// Discovery rather than a fixed `d`: this is the query `watch-sales.ts` runs, so it also checks
// that a ladder is FINDABLE by a watcher that was told only the seller's pubkey.
const back = await pool.querySync(RELAYS, { kinds: [LADDER_KIND], authors: [SELLER] })
ok('the ladder comes back from a discovery query', back.length > 0, `${back.length} event(s)`)
const found = back.find(ev => ev.tags.find(t => t[0] === 'd')?.[1] === ladderD(D))
ok('it carries the d tag we published', !!found)
if (!found) {
  pool.close(RELAYS)
  process.exit(1)
}
ok('its signature verifies', verifyEvent(found))
ok('the ciphertext survived the round trip byte for byte', found.content === event.content)

// --- 4. decrypt and diff ------------------------------------------------------------------------
let decrypted: string | null = null
try {
  decrypted = nip44.v2.decrypt(found.content, nip44.v2.utils.getConversationKey(watcherSk, SELLER))
} catch (err) {
  ok('the watcher can decrypt it', false, String(err))
}
ok('the watcher can decrypt it', decrypted !== null)
ok('the plaintext is identical to what went in', decrypted === plaintext)

const parsed = decrypted === null ? null : parseLadder(decrypted)
ok('it survives the bounded parse', !!parsed)
ok('units round-tripped', parsed?.units === UNITS, `${parsed?.units} vs ${UNITS}`)
ok('every rung round-tripped', parsed?.steps.length === UNITS)
// The third trust layer, unchanged by M1: a rung off a relay still goes through the storefront's
// own parser before anything would publish it.
const verifiedRungs = (parsed?.steps ?? []).filter(step => parseListings([step as unknown as Event], SELLER).length === 1)
ok('every rung still verifies through the storefront parser', verifiedRungs.length === UNITS, `${verifiedRungs.length}/${UNITS}`)

// A stranger must not be able to read it, because the rungs would otherwise advertise the lowest
// stock on every item in the sale.
let strangerRead = false
try {
  nip44.v2.decrypt(found.content, nip44.v2.utils.getConversationKey(generateSecretKey(), SELLER))
  strangerRead = true
} catch {
  strangerRead = false
}
ok('a third key CANNOT read it', !strangerRead)

// --- 5. replacement, which is what makes an edit self-healing -----------------------------------
// NIP-01 keeps one event per (kind, pubkey, `d`). If a relay did not honour that for kind 30078,
// a restock would leave the watcher choosing between two ladders.
const replacement = finalizeEvent(
  {
    kind: LADDER_KIND,
    created_at: now + 10,
    tags: [['d', ladderD(D)]],
    content: nip44.v2.encrypt(JSON.stringify({ units: 1, steps: [steps[UNITS - 1]] }), nip44.v2.utils.getConversationKey(sellerSk, WATCHER)),
  },
  sellerSk,
)
await Promise.allSettled(
  pool.publish(RELAYS, replacement).map(p => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000))])),
)
const after = await pool.querySync(RELAYS, { kinds: [LADDER_KIND], authors: [SELLER] })
const current = after.filter(ev => ev.tags.find(t => t[0] === 'd')?.[1] === ladderD(D))
const newest = [...current].sort((a, b) => b.created_at - a.created_at)[0]
ok('the replacement is what a fresh read returns', newest?.id === replacement.id)
const reparsed = newest
  ? parseLadder(nip44.v2.decrypt(newest.content, nip44.v2.utils.getConversationKey(watcherSk, SELLER)))
  : null
ok('the replaced ladder has the new unit count', reparsed?.units === 1, `${reparsed?.units} vs 1`)
// Reported rather than asserted: a relay that keeps both is not breaking anything here, because the
// watcher sorts newest-first for exactly this reason, but it IS worth knowing which ones do.
console.log(`#   ${current.length} event(s) still held under that d across ${RELAYS.length} relays (1 means every relay replaced)`)

// --- 6. precedence, on real events --------------------------------------------------------------
// The same rule `ladder.test.ts` proves in the abstract, applied to what actually came back.
ok('a relay ladder beats a file one', chooseLadder(reparsed, rung, false).source === 'relay')
ok('a failed relay read falls back to the file', chooseLadder(reparsed, rung, true).source === 'file')
ok('a failed read with no file is marked degraded', chooseLadder(reparsed, null, true).degraded === true)

pool.close(RELAYS)
console.log(`\n# nothing here touched the live sale: both keys were generated for this run and are gone.`)
