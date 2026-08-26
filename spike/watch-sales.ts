// Slice 3: the shop watcher. Observes settlement on the seller's own node and republishes the
// kind 30402 with updated stock/status, so a page loaded later sees what is actually left.
//
// IT HOLDS NO SIGNING KEY. The events it publishes were signed by the seller at seed time —
// see ./ladder.ts for why that is the answer to "the watcher must republish as the seller but
// must not be the seller" (/CLAUDE.md rule 2). This process can publish only states the seller
// already authorised, and it cannot run availability backwards (created_at is monotone).
//
// It does hold a node credential, and that one is not free: `auth_type = "User"` is NOT
// read-only — the same key can call PayInvoice (/docs/spike-findings.md §10). Today it is the
// seller's own throwaway .dev-key because the fixture seller and the node account are one
// identity. Slice 7 adds refunds and MUST NOT reuse this key: the refund path is a kind 21002
// debit from a separate watcher key under a node-enforced frequency cap (spec §12).
//
// HOW IT OBSERVES, and this corrects the ranking in /docs/spec.md §7.2. That section ranks
// `GetLiveUserOperations` first. It cannot be first, for a reason only visible in the proto:
// `UserOperation` (structs.proto:634-646) carries paidAtUnix, amount, operationId, internal,
// and `identifier` — which for a settled invoice is the bolt11 (paymentSideEffects.ts:36) —
// but it carries **no offer_id**. Per-item attribution is exactly what a storefront needs, so
// the live feed would have to be followed by this same call to answer "which item?". Polling
// `GetUserOfferInvoices` is therefore not the fallback, it is the only answer that stands
// alone. It is also the restart-safe one: the live feed pushes once, so a watcher that was
// asleep never learns, while this returns the whole settled set every time.
//
// IDEMPOTENCY. The key is the settled invoice, never the request event id — relays replay
// kind 21001 requests and a replay is indistinguishable from a fresh one
// (/docs/spike-findings.md §13.1). We do not even persist the seen set: stock is derived from
// the *count of distinct settled invoices the node reports*, so the node holds the state, a
// restart recomputes it, and a replayed request that never became a payment cannot move it.
//
// THE HONEST CAVEAT, say it in the demo: availability is only as fresh as this process. A page
// loaded while it is down shows stale stock. That is inherent to a serverless storefront, not
// a bug to hide.
//
// SLICE 7 ADDED THE ONLY THING HERE THAT SPENDS. Read the block above `refundOversells` before
// changing anything below it. The short version: refunds are off unless `--refunds` is passed,
// they are capped by the node rather than by this file, and the seller revokes them with
// `node authorize-refunds.ts --revoke` without touching this process.
//
// TWO KEYS, DELIBERATELY DIFFERENT, and this is /docs/spec.md §12 rather than fastidiousness.
// The observe key is .dev-key, which is the seller's identity and owns the node account — and
// "User" scope is not read-only, so it could call PayInvoice. The refund key is .refund-key,
// which owns nothing and can only ask the node to pay an invoice up to the grant's cap. The
// watcher holding one key that both watches and spends would make the cap decorative.
//
// Usage: node watch-sales.ts [--key <file>] [--nprofile <path|nprofile1…>] [--relays wss://a,wss://b] [--once]
//                            [--refunds]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SimplePool, generateSecretKey, getPublicKey, nip19, nip44, type Event } from 'nostr-tools'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decodeNoffer } from '../storefront/src/offer.ts'
import { parseListings } from '../storefront/src/listing.ts'
import { REFUND_POINTER, SALE_RELAYS } from './fixture.ts'
import { chooseLadder, isStale, LADDER_KIND, listingDOf, nofferOf, parseRung, targetStock } from './ladder.ts'
import { decodeNdebit, k1For, payDebit, type DebitPointer } from './ndebit.ts'
import {
  inFlightGuard,
  matchingPayments,
  oversold,
  readJournal,
  reconcile,
  recordRefund,
  resolvePointer,
  settledByUs,
  type Journal,
  type Outgoing,
  type RefundState,
  type Settled,
} from './refund.ts'
import { arg, connectPub } from './pub-rpc.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
// One watcher process per seller, because every file below belongs to ONE Lightning.Pub account:
// the ladder republishes that seller's listings, the journal records which of that seller's
// oversells have been paid back, and the debit grant is issued against that seller's account
// pointer. Sharing any of them across sellers is not a smaller deployment, it is a watcher
// republishing one npub's stock under another's key, or a refund debited from the wrong account.
// So ALL FIVE derive from `--key`; none of them is a separate flag that can be forgotten.
const KEY = arg('key', '.dev-key')
const suffixed = (name: string) => join(HERE, KEY === '.dev-key' ? name : `${KEY}${name}`)
const KEY_FILE = join(HERE, KEY)
const OFFERS_FILE = suffixed('.offers.json')
const LADDER_FILE = suffixed('.ladder.json')
const REFUND_KEY_FILE = suffixed('.refund-key')
const NDEBIT_FILE = suffixed('.ndebit')
const JOURNAL_FILE = suffixed('.refunds.json')
const WATCHER_KEY_FILE = suffixed('.watcher-key')

// ponytail: fixed 5s poll. A yard sale settles a handful of invoices an hour and this is the
// seller's own node's relay; if that ever stops being true, the upgrade is the live feed as a
// nudge with this call still doing the attribution.
const POLL_MS = 5_000
// The node is not trusted input either. A yard sale does not have this many settled invoices.
const MAX_INVOICES = 5_000
const ONCE = process.argv.includes('--once')
// OFF BY DEFAULT, and the flag is the whole safety story that is ours rather than the node's.
// Every `node watch-sales.ts` in the docs, the runbook and three slices of muscle memory keeps
// meaning exactly what it meant in slice 3: observe and republish, spend nothing.
const REFUNDS = process.argv.includes('--refunds')
// How long a FAILED refund waits before it is tried again. Not a politeness delay: a failed debit
// still consumed its k1 at the node, the k1 is derived from the settled invoice and so is
// identical on a retry, and Lightning.Pub's k1 debouncer holds it in memory for 5 minutes
// (K1_MAX_AGE, debitManager.ts:23). Retrying inside that window answers "K1 already processed"
// and tries nothing. Six minutes clears it with a minute to spare.
const RETRY_AFTER_S = 6 * 60
const RELAYS = arg('relays', SALE_RELAYS.join(',')).split(',')

// --- M1: the key ladders are encrypted TO -----------------------------------------------------
//
// KEY HANDLING NOTICE. This is the third key this process touches and by far the smallest, and it
// is deliberately not either of the other two.
//
//   * NOT .dev-key. That is the seller's identity and owns the node account. Encrypting ladders
//     to it would mean the watcher needs the seller's private key to open them, which turns
//     today's coincidence (the fixture seller and the node account are one identity) into a
//     permanent requirement. /docs/spec.md §12 says these should be separate keys where possible.
//   * NOT .refund-key. That is the spend credential under a node-enforced cap, and the TWO KEYS
//     block above is explicit that the watcher's keys are deliberately different.
//
// MINTED HERE and never by the builder: /CLAUDE.md rule 2 says a private key is generated where
// it is used, and the builder is a browser that must never hold one. gitignored, chmod 600.
//
// WHAT IT CAN DO: decrypt availability ladders that the seller published for it. That is all. It
// owns nothing, spends nothing, signs nothing, and appears in no published event. A stolen copy
// reveals the seller's stock, which is worth hiding, and confers no authority at all.
//
// It prints BEFORE the checks below on purpose. A seller setting this up for the first time needs
// the npub to paste into the builder, and needing a running node to be told it would be a
// bootstrap that never starts. `--watcher-key` prints it and exits, for the same reason.
if (!existsSync(WATCHER_KEY_FILE)) {
  writeFileSync(WATCHER_KEY_FILE, bytesToHex(generateSecretKey()), { mode: 0o600 })
  console.log(`# minted ${WATCHER_KEY_FILE} — a new watcher key. Ladders already published to an`)
  console.log(`#   OLDER watcher key cannot be read with it; re-publish those items from the builder.`)
}
const watcherSk = hexToBytes(readFileSync(WATCHER_KEY_FILE, 'utf8').trim())
const WATCHER = getPublicKey(watcherSk)
console.log(`# watcher key ${nip19.npubEncode(WATCHER)}`)
console.log(`#   paste that into the builder's "Watcher key" box to stop copying .ladder.json by hand`)
if (process.argv.includes('--watcher-key')) process.exit(0)

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE} — pass --key <file>, or run seed-listings.ts first`)
if (!existsSync(OFFERS_FILE)) throw new Error(`no ${OFFERS_FILE} — run mint-offers.ts first`)

const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const SELLER = getPublicKey(sk)

// The refund half loads only when armed, and it refuses to start half-configured rather than
// discovering at the first oversell that it cannot pay. An oversell is the one moment this
// process exists for; finding out then that the grant was never made is finding out too late.
let refundSk = new Uint8Array()
let debitNode: DebitPointer = { pubkey: '', relay: '' }
// Whether the FILE was there, which `readJournal` cannot tell you afterwards — it answers `{}` for
// both "absent" and "empty". Item 9's loudest refusal turns on exactly that distinction.
const JOURNAL_EXISTED = existsSync(JOURNAL_FILE)
const journal: Journal = REFUNDS ? readJournal(JOURNAL_FILE) : {}
if (REFUNDS) {
  if (!existsSync(REFUND_KEY_FILE)) throw new Error(`--refunds needs ${REFUND_KEY_FILE} — run authorize-refunds.ts first`)
  if (!existsSync(NDEBIT_FILE)) throw new Error(`--refunds needs ${NDEBIT_FILE} — run authorize-refunds.ts first`)
  refundSk = hexToBytes(readFileSync(REFUND_KEY_FILE, 'utf8').trim())
  const decoded = decodeNdebit(readFileSync(NDEBIT_FILE, 'utf8').trim())
  if (!decoded) throw new Error(`${NDEBIT_FILE} does not decode — re-run authorize-refunds.ts`)
  debitNode = decoded
  if (getPublicKey(refundSk) === SELLER) {
    throw new Error('the refund key IS the seller key. The whole point is that it is not — /docs/spec.md §12')
  }
}

type Minted = { noffer: string; price_sats: number }
type Rung = { units: number; noffer?: string; steps: Event[] }
const minted: Record<string, Minted> = JSON.parse(readFileSync(OFFERS_FILE, 'utf8'))
// M1: the file is now the FALLBACK, not the source. It is still read first because reading it
// costs nothing and because it is what makes a cold start work before the seller has ever
// published a ladder over a relay. It is no longer required to exist, and it is not deleted.
const fileLadder: Record<string, Rung> = existsSync(LADDER_FILE)
  ? JSON.parse(readFileSync(LADDER_FILE, 'utf8'))
  : {}

// WHY THIS DOES NOT DELETE A DEPLETED ITEM'S OFFER, against /docs/spec.md §7.4(a).
// §7.4(a) makes "delete the offer on depletion" v1's strict mode, and it is one RPC from here —
// but reading what deletion actually does rules it out for now. `DeleteUserOffer` drops the
// `UserOffer` row (offerStorage.ts:27-29) and nothing else; the settled invoices survive with
// their `offer_id` intact. The problem is who can still read them:
//   * `GetUserOfferInvoices` looks the offer up first and throws "Offer not found" when it is
//     gone (offerManager.ts:89-93). Deleting the offer therefore blinds this watcher to the
//     item exactly when the late settlement it needs to see would arrive.
//   * That call is also the ONLY way the stored `payer_data` leaves the node — the sole other
//     reader is the offer's own settlement `callback_url` (paymentSideEffects.ts:27), which our
//     offers leave empty. So deleting the offer permanently destroys the buyer's refund pointer
//     for every invoice under it.
// An oversell is precisely a payment that settles after depletion, and slice 7 exists to refund
// it. Shipping a sellout that throws the refund pointer away would break the slice that has to
// send the money back. Strict mode needs a mechanism that does not take the invoice history
// with it — recorded in /docs/spike-findings.md §13.17.

const { appPub, relays: nodeRelays, rpc, close } = connectPub(
  sk,
  arg('nprofile', join(homedir(), 'lightning_pub', 'app.nprofile')),
)
console.log(`# node ${appPub.slice(0, 12)}… on ${nodeRelays.join(', ')}`)
console.log(`# publishing listing updates to ${RELAYS.join(', ')}`)
console.log(
  REFUNDS
    ? `# REFUNDS ARMED — oversells are paid automatically from ${getPublicKey(refundSk).slice(0, 16)}…, capped by the node.\n` +
        `#   journal ${JOURNAL_FILE}   kill switch: node authorize-refunds.ts --revoke`
    : `# refunds OFF. An oversell will be logged and nothing will be paid. Pass --refunds to arm them.`,
)

const pool = new SimplePool()

// --- M1: WHERE THE LADDER COMES FROM ----------------------------------------------------------
//
// It used to come from a file the seller downloaded in a browser, carried to this machine, and
// restarted this process to load. Every edit cost that, and restock is an edit. Miss the step and
// either `isStale` below refuses to watch the item, or this process publishes rungs the relay
// silently drops and the item stays on sale after it sold.
//
// Now it arrives as one encrypted kind 30078 per item, authored by the seller and NIP-44
// encrypted to the watcher key above. Three things make that safe to act on, and the third is the
// one that was already here:
//
//   1. The filter is `authors: [SELLER]` and nostr-tools verifies signatures, so only the
//      seller's own events arrive at all.
//   2. Decryption with (watcher private, seller public) succeeds only if the seller encrypted it.
//   3. `stepFor` below re-verifies every rung against the live listing before publishing it,
//      under "Never publish an event on the strength of where it was loaded from". So arriving
//      over a relay buys a rung no authority that arriving in a file did not.
//
// What that leaves genuinely new is the JSON inside, which `parseRung` bounds.
const readRelayLadders = async (): Promise<{ ladders: Map<string, Rung>; failed: boolean; undecryptable: number }> => {
  const ladders = new Map<string, Rung>()
  let undecryptable = 0
  let events: Event[]
  try {
    events = await pool.querySync(RELAYS, { kinds: [LADDER_KIND], authors: [SELLER] })
  } catch {
    // "The relays could not be read" and "the seller has published no ladder" are different
    // facts with different remedies, and this is the only place that can still tell them apart.
    return { ladders, failed: true, undecryptable }
  }
  for (const ev of events) {
    const d = ev.tags.find(t => t[0] === 'd')?.[1]
    const item = d === undefined ? undefined : listingDOf(d)
    // Kind 30078 is shared ground. The seller's own private notes live on it and would NOT
    // decrypt to this key, so skipping by `d` first keeps them out of the undecryptable count
    // where they would look like a key mismatch.
    if (!item) continue
    let rung: Rung | undefined
    try {
      rung = parseRung(nip44.decrypt(ev.content, nip44.getConversationKey(watcherSk, SELLER)))
    } catch {
      rung = undefined
    }
    if (!rung) {
      undecryptable++
      continue
    }
    // NIP-01 keeps one event per (kind, pubkey, d), but relays disagree about which, so take the
    // newest of whatever came back rather than the first, exactly as `loadNotes` does.
    const seen = ladders.get(item)
    if (!seen || ev.created_at > (seen as Rung & { at?: number }).at!) {
      ladders.set(item, Object.assign(rung, { at: ev.created_at }))
    }
  }
  return { ladders, failed: false, undecryptable }
}

const relay = await readRelayLadders()
if (relay.failed) {
  console.log(`# COULD NOT READ LADDERS FROM ${RELAYS.length} RELAYS. Falling back to ${LADDER_FILE}.`)
} else if (relay.undecryptable > 0) {
  // The likeliest cause by far, and it is silent otherwise: this process minted a fresh
  // .watcher-key (a new clone, a deleted file) while the builder is still encrypting to the old
  // one. It reads as "no ladder on the relays" and would quietly fall back to a stale file.
  console.log(
    `# ${relay.undecryptable} ladder event(s) from this seller DID NOT DECRYPT with this watcher ` +
      `key. The builder is almost certainly publishing to a different key: paste the npub above ` +
      `into it and re-publish those items.`,
  )
}

// Per item, and the file is kept rather than deleted. `chooseLadder` is pure and tested for every
// branch, including the one where the relay read failed, because that branch is the one that must
// not read as "your ladder is stale" (see below).
const ladder: Record<string, Rung> = {}
const unwatched: string[] = []
// The item set is the union of THREE sources, not two. Building it from the two ladder sources
// alone would make "neither" unreachable by construction: an item can only be missing a ladder if
// something else already told us it exists. `.offers.json` is that something else, and an item
// with a minted offer and no ladder anywhere is precisely the one worth naming, because it is
// payable and unwatched, which is how a sold item stays on sale.
for (const d of new Set([...relay.ladders.keys(), ...Object.keys(fileLadder), ...Object.keys(minted)])) {
  const chosen = chooseLadder(relay.ladders.get(d), fileLadder[d], relay.failed)
  if (chosen.warn) console.log(`# ${d}: ${chosen.warn}`)
  if (chosen.rung) ladder[d] = chosen.rung
  else unwatched.push(d)
}
const fromRelay = Object.keys(ladder).filter(d => relay.ladders.has(d)).length
console.log(
  `# ladders: ${fromRelay} from the relays, ${Object.keys(ladder).length - fromRelay} from ` +
    `${LADDER_FILE}${unwatched.length ? `, ${unwatched.length} with none at all (${unwatched.join(' ')})` : ''}`,
)

// The offer id comes out of the ladder itself, not a separate config, so the thing we watch is by
// construction the thing a buyer would pay. Three sources in descending authority, and the
// reasoning — including which one used to lose every one-of-a-kind item — is in ./ladder.ts.
const withOffer = (entries: [string, Rung][]) =>
  entries.flatMap(([d, rung]) => {
    const noffer = nofferOf(rung, minted[d]?.noffer)
    const offer = noffer && decodeNoffer(noffer)
    if (!offer) {
      console.log(`# ${d}: no decodable offer in its ladder or ${OFFERS_FILE} — not watching`)
      return []
    }
    return [{ d, rung, offerId: offer.offer }]
  })

let watching = withOffer(Object.entries(ladder))
if (watching.length === 0) {
  throw new Error(
    `nothing to watch — no ladder arrived from the relays and ${LADDER_FILE} has none either. ` +
      `Publish an item from the builder with this watcher's npub pasted in, or run mint-offers.ts ` +
      `then seed-listings.ts.`,
  )
}


// IS THIS LADDER STILL THE LADDER FOR THESE LISTINGS? Slice 6 made this question real, and the
// failure it prevents is silent, which is the worst kind on the money path.
//
// The rungs are pre-signed with `created_at` increasing as stock falls (./ladder.ts), so they
// are newer than the listing they were cut from and NIP-01 keeps them when they are published.
// Edit the item and the new listing is newer than every rung of the OLD ladder. Publishing one
// then does nothing at the relay — and does it *successfully*: a relay that already holds a
// newer replaceable event still answers OK, so `publish()` counts it, this process logs
// "3/4 relays", and the item stays advertised as available for the rest of the sale. That is an
// oversell with a clean log next to it, and slice 7 does not exist yet to refund it.
//
// So: read what is actually on the relays and refuse, loudly, to watch an item whose ladder has
// been superseded. Equal timestamps are fine — that is a sold-out item whose last rung IS the
// live listing. Only items with a live listing are judged; relays that answered with nothing
// leave everything alone, because "the relay is down" must not read as "your ladder is stale".
const live = new Map(
  parseListings(await pool.querySync(RELAYS, { kinds: [30402], authors: [SELLER] }), SELLER).map(
    item => [item.d, item.created_at],
  ),
)
const stale = watching.filter(({ d, rung }) => isStale(rung.steps, live.get(d)))
for (const { d } of stale) {
  console.log(
    `# ${d}: STALE LADDER — the listing on the relays is newer than every rung here, so this ` +
      `item was edited after its ladder was cut. Publishing a rung would be a silent no-op and ` +
      `the item would stay on sale after it sold. Publish the item again from the builder with ` +
      `this watcher's npub pasted in and the new ladder arrives here by itself. NOT WATCHING.`,
  )
}
watching = watching.filter(w => !stale.includes(w))
if (watching.length === 0) throw new Error('nothing left to watch — every ladder is stale or unminted')
console.log(`# watching ${watching.length} item(s): ${watching.map(w => `${w.d}(${w.rung.units})`).join(' ')}\n`)

// A settled invoice is one the node says was paid. Everything here is bounded and re-checked
// rather than destructured off a trusted response: these are the rows that decide whether an item
// is still for sale and, as of slice 7, who is owed money back.
//
// Slice 7 turned this from a count into the rows themselves. The count is still all the
// availability half needs — `oversold(rows, 0).length` — but the refund half needs `amount` and
// the stored `payer_data`, and re-fetching them would be a second call answering the same
// question. Deduping and ordering live in ./refund.ts `oversold`, which is the tested one.
const settledRows = (res: unknown, offerId: string): Settled[] => {
  const rows = (res as { invoices?: unknown }).invoices
  if (!Array.isArray(rows)) return []
  return rows
    .slice(0, MAX_INVOICES)
    .filter(row => row?.offer_id === offerId) // GetUserOfferInvoices filters by it; verify anyway
}

// Never publish an event on the strength of where it was loaded from. The ladder is a file on
// disk; it goes through the same door the storefront makes every relay event go through, which
// verifies the signature (after deleting nostr-tools' cached `verified` symbol — findings
// §13.10) and re-parses stock/status out of the tags rather than trusting our own index.
const stepFor = (d: string, rung: Rung, target: number): Event => {
  const step = rung.steps[rung.units - target - 1]
  if (!step) throw new Error(`${d}: no pre-signed step for stock ${target}`)
  const parsed = parseListings([step], SELLER)[0]
  if (!parsed || parsed.d !== d) throw new Error(`${d}: pre-signed step failed verification`)
  if (parsed.sold !== (target === 0)) throw new Error(`${d}: step for stock ${target} disagrees on sold`)
  if (target > 0 && parsed.stock !== undefined && parsed.stock !== target) {
    throw new Error(`${d}: step says stock ${parsed.stock}, expected ${target}`)
  }
  return step
}

const publish = async (ev: Event) => {
  const results = await Promise.allSettled(
    pool.publish(RELAYS, ev).map(p =>
      Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000))]),
    ),
  )
  return results.filter(r => r.status === 'fulfilled').length
}

// The last settled-invoice count we acted on, per item. Publishing is driven by this changing,
// so a poll that says the same thing as the last poll costs one RPC and nothing else.
const lastSold = new Map<string, number>()

// --- slice 7: the refund ---------------------------------------------------------------------
//
// THIS IS THE FIRST THING IN THE PROJECT THAT MOVES MONEY OUT. Everything above either reads the
// node or republishes an event the seller signed at their desk. Three guards sit under it, and
// only one of them is ours:
//
//   * THE NODE'S CAP. A frequency rule on the debit grant, summed over the interval and checked
//     inside the payment transaction (assertDebitFrequency, debitManager.ts:376-401). A bug here
//     costs at most one interval's cap. Proved firing by ./check-refund.ts.
//   * THE NODE'S KILL SWITCH. `BanDebit`, also checked in-transaction, so it stops a payment
//     already in flight. `node authorize-refunds.ts --revoke`.
//   * THE JOURNAL, which is ours, and is the only one of the three that stops a DOUBLE refund
//     rather than an oversized one. See ./refund.ts for why the node cannot hold this state and
//     why CLINK's `k1` is a second layer rather than the answer.
//
// And one more, which is not a guard so much as an admission: `--refunds`. Without it this
// process is exactly what slice 3 shipped and cannot spend. A watcher that starts paying because
// somebody restarted it is not a thing to build by accident.
//
// ITEM 9's snapshot: what the node had already sent when this process started. Read once, at
// startup, because the question it answers is "did a PREVIOUS run already pay this?" — anything
// this run pays is in the journal. See the reconcile block below `summarise`.
let outgoingAtStart: Outgoing[] = []

const refundOversells = async (d: string, rows: Settled[], units: number) => {
  for (const row of oversold(rows, units)) {
    const done = settledByUs(journal, row.invoice)
    if (done) {
      // `pending` is the dangerous one and it never resolves itself: we sent a payment and never
      // heard back, so whether money moved is unknown. Retrying might double-pay; dropping it
      // might strand a buyer. So it is neither — it is printed, every tick, until a human
      // reconciles against the node. That is the loud, persistent, seller-visible answer.
      if (done.state !== 'paid') {
        console.log(`# ${d}: REFUND ${done.state.toUpperCase()} for a ${done.sats} sat sale — ${done.note ?? ''}`)
        if (done.state === 'pending') {
          console.log(`#   this one was SENT and never acknowledged. Check the node's outgoing payments before rerunning.`)
        }
      }
      continue
    }

    // A previously failed attempt. Retried, but not every five seconds: a failed debit still
    // consumed its k1 at the node (DedupeK1 runs before any validation, debitManager.ts:258-262,
    // which diverges from clink-debits.md:167-171), and that k1 is deterministic, so an immediate
    // retry would collide with itself for the debouncer's 5-minute TTL and answer "K1 already
    // processed" rather than trying anything.
    const previous = journal[row.invoice]
    const now = Math.floor(Date.now() / 1000)
    if (previous && now - previous.at < RETRY_AFTER_S) continue

    const pointer = row.data?.[REFUND_POINTER]
    const kind = !pointer ? 'none' : decodeNoffer(pointer) ? 'noffer' : 'address'
    const sats = Number(row.amount)
    if (!(sats > 0)) continue

    // ITEM 9: no journal row at all, and the node has already sent something that looks like this
    // refund. That is the lost-journal case — a deleted file, a restored backup, a second machine
    // — and paying again is the exact loss the journal exists to prevent. So it BLOCKS and says
    // why, rather than paying. This is a refusal, so it acts with no human, which is the asymmetry
    // the reconcile is built on: refusing costs a delay, deciding costs a payment.
    //
    // Matched against the SETTLEMENT's own time rather than a journal row's `at`, because there is
    // no row — a refund is sent after the sale it refunds, so the settled invoice is the only
    // anchor available. Amount and time only; the node stores no link back to the sale.
    if (!journal[row.invoice]) {
      const already = matchingPayments(outgoingAtStart, sats, Number(row.paid_at_unix))
      if (already.length > 0) {
        record(row, d, sats, kind, 'queued', `the node already has ${already.length} outgoing payment(s) of ${sats} sats near this sale, and there is no journal row — NOT paying again`)
        console.log(`# ${d}: REFUND BLOCKED — ${already.length} outgoing payment(s) of ${sats} sats near this sale and no journal row.`)
        for (const o of already) {
          console.log(`#     ${new Date(Number(o.paidAtUnix) * 1000).toISOString()}  ${o.operationId}${o.internal ? '  (internal)' : ''}`)
        }
        console.log(`#   This is the lost-journal case. Confirm against the node before doing anything: if it was NOT refunded, pay it by hand.`)
        continue
      }
    }

    // NEVER LOG THE POINTER — /CLAUDE.md. The kind is what a seller needs to see.
    const said = kind === 'noffer' ? 'an noffer' : kind === 'address' ? 'a Lightning address' : 'no pointer at all'
    console.log(`# ${d}: refunding ${sats} sats to ${said}…`)

    const resolved = await resolvePointer(pointer ?? '', sats)
    if (!resolved.ok) {
      // `queue: true` means a human is needed — no usable pointer, or the buyer's own node/host
      // declined in a way retrying will not fix. `queue: false` is a transient host failure and
      // gets another go on the next tick after the retry window.
      record(row, d, sats, kind, resolved.queue ? 'queued' : 'failed', resolved.error)
      console.log(`#   ${resolved.queue ? 'QUEUED — NEEDS YOU' : 'failed, will retry'}: ${resolved.error}`)
      continue
    }

    // WRITE THE INTENT BEFORE THE PAYMENT. The dangerous crash is not "after paying", it is
    // "while paying" — and a journal written after the fact cannot tell those apart. `pending`
    // means unknown, and unknown is never retried automatically.
    record(row, d, sats, kind, 'pending', 'sent, awaiting the node')

    const paid = await payDebit(refundSk, debitNode, {
      bolt11: resolved.bolt11,
      amountSats: sats,
      // Derived from the settled invoice, so a crash-loop restart re-derives the same one and the
      // node refuses the duplicate. Five minutes of cover, in memory — ./ndebit.ts `k1For`.
      k1: k1For(row.invoice),
    })

    if (paid.ok) {
      record(row, d, sats, kind, 'paid', 'the node acknowledged', paid.preimage !== undefined)
      console.log(`#   REFUNDED ${sats} sats.${paid.preimage === undefined ? ' (no preimage — which proves nothing either way, findings §5)' : ''}`)
      continue
    }

    // code 0 is ours and means we never heard back, so the row stays `pending` — unknown, not
    // failed. Anything else is the node saying no, which means nothing was paid and the row can
    // safely go back to `failed` to be retried.
    if (paid.code === 0) {
      record(row, d, sats, kind, 'pending', paid.error)
      console.log(`#   NO ANSWER — leaving this UNKNOWN rather than guessing: ${paid.error}`)
      continue
    }
    const capped = paid.code === 5 && paid.range ? ` The node's cap is ${paid.range.max} sats per interval.` : ''
    record(row, d, sats, kind, 'failed', `GFY ${paid.code}: ${paid.error}`)
    console.log(`#   the node declined, GFY ${paid.code}: ${paid.error}${capped}`)
    if (paid.code === 1) {
      console.log(`#   code 1 usually means the grant is banned or missing. Run: node authorize-refunds.ts --show`)
    }
  }
}

const record = (
  row: Settled,
  d: string,
  sats: number,
  pointer: string,
  state: RefundState,
  note: string,
  preimage?: boolean,
) => {
  // MONOTONIC — ./refund.ts `recordRefund` drops this write if the row is already `paid`. The
  // invariant is the journal's rather than this call site's, so the startup reconcile and anything
  // added later cannot downgrade a settled row either.
  recordRefund(journal, JOURNAL_FILE, {
    invoice: row.invoice,
    d,
    sats,
    state,
    at: Math.floor(Date.now() / 1000),
    pointer, // the KIND of pointer, never the pointer
    note,
    ...(preimage === undefined ? {} : { preimage }),
  })
}

// The node's recent outgoing payments, for reconciling a `pending` row against reality.
//
// structs.proto:616-624 — GetUserOperationsRequest is SIX cursors and a size, and
// paymentManager.ts:1130-1135 dereferences every one of them (`req.latestOutgoingInvoice.id`)
// with no default. A request missing any cursor throws inside the node rather than answering, so
// they are all sent as zeros, which means "from the beginning".
//
// Note `latestOutgoingUserToUserPayemnts` in the RESPONSE. The typo is the node's
// (structs.proto:657) and reading the correctly-spelled key gets undefined.
const CURSOR = { ts: 0, id: 0 }
const outgoingPayments = async (): Promise<Outgoing[]> => {
  const res = (await rpc('GetUserOperations', {
    latestIncomingInvoice: CURSOR,
    latestOutgoingInvoice: CURSOR,
    latestIncomingTx: CURSOR,
    latestOutgoingTx: CURSOR,
    latestIncomingUserToUserPayment: CURSOR,
    latestOutgoingUserToUserPayment: CURSOR,
    max_size: 100,
  })) as Record<string, { operations?: Outgoing[] }>
  // A refund leaves as an outgoing invoice payment. The user-to-user list is included because an
  // internal transfer between two accounts on this same node lands there instead, and a buyer
  // whose wallet is also on this Pub is not a hypothetical on a demo machine.
  return [
    ...(res.latestOutgoingInvoiceOperations?.operations ?? []),
    ...(res.latestOutgoingUserToUserPayemnts?.operations ?? []),
  ]
}

// Everything still owed, printed on a schedule rather than once, because a line that scrolled
// away an hour ago is not an answer to "who is owed money".
//
// SLICE 8 ADDED THE RECONCILIATION HALF. A `pending` row is the one the watcher will never
// resolve on its own — it is printed until a human checks the node — so the least this can do is
// print what the node has that looks like it. Amount and time are all there is to match on: the
// node stores no link back to the settled invoice that caused a debit. So it is evidence, it says
// so, and nothing in this file branches on it.
const summarise = async () => {
  const open = Object.values(journal).filter(r => r.state !== 'paid')
  if (open.length === 0) return
  console.log(`\n# ${open.length} REFUND(S) NOT PAID — ${JOURNAL_FILE}`)
  for (const r of open) {
    console.log(`#   ${r.state.padEnd(7)} ${r.d.padEnd(28)} ${String(r.sats).padStart(7)} sats  ${r.pointer.padEnd(8)} ${r.note ?? ''}`)
  }
  console.log('#   `queued` and `pending` need a person. Hand the money over at the table if you must.')

  const pending = open.filter(r => r.state === 'pending')
  if (pending.length === 0) return console.log('')
  let ops: Outgoing[]
  try {
    ops = await outgoingPayments()
  } catch (err) {
    console.log(`#   (could not read the node's outgoing payments: ${String(err).slice(0, 100)})\n`)
    return
  }
  for (const r of pending) {
    const hits = matchingPayments(ops, r.sats, r.at)
    console.log(`#   ${r.d} — ${hits.length} outgoing payment(s) of ${r.sats} sats near that time:`)
    for (const o of hits) {
      console.log(`#     ${new Date(Number(o.paidAtUnix) * 1000).toISOString()}  ${o.operationId}${o.internal ? '  (internal)' : ''}`)
    }
    console.log(
      hits.length === 0
        ? '#     nothing matched, which SUGGESTS the debit never left. It is not proof.'
        : '#     MATCHED ON AMOUNT AND TIME ONLY — the node stores no link to the sale. Confirm before acting.',
    )
  }
  console.log('')
}

const tick = async () => {
  for (const { d, rung, offerId } of watching) {
    let rows: Settled[]
    try {
      // structs.proto:893-896 — { offer_id, include_unpaid }. include_unpaid:false makes the
      // storage layer filter on paid_at_unix > 0 (paymentStorage.ts:527-533), i.e. exactly the
      // settled set for this one item's offer.
      rows = settledRows(await rpc('GetUserOfferInvoices', { offer_id: offerId, include_unpaid: false }), offerId)
    } catch (err) {
      console.log(`# ${new Date().toISOString()} ${d}: ${String(err).slice(0, 120)}`)
      continue
    }
    // `oversold(rows, 0)` is every distinct settled invoice for this item, deduped on the invoice
    // string — the settled invoice IS the idempotency key (spec §8).
    const sold = oversold(rows, 0).length

    if (sold > rung.units) {
      // Oversold: two buyers reached the last unit (/docs/spec.md §7.3). This used to be only a
      // loud line telling the seller to hand money back at the table; slice 7 makes it the
      // refund. The pointer to send it to is in this item's stored `payer_data` — which is why
      // this watcher does NOT delete the depleted offer. See the note under `watching` above.
      //
      // Run BEFORE the `lastSold` early-out below, because a refund can fail on a tick where the
      // settled count has not moved: a queued LNURL host comes back up, a `failed` row passes its
      // retry window. Availability is driven by the count changing; refunds are driven by the
      // journal, and they are different clocks.
      console.log(`# ${d}: OVERSOLD — ${sold} settled against ${rung.units} unit(s). Refund owed.`)
      if (REFUNDS) await refundOversells(d, rows, rung.units)
    }

    if (lastSold.get(d) === sold) continue

    const target = targetStock(rung.units, sold)
    if (target === rung.units) {
      lastSold.set(d, sold) // nothing has sold; the seeded listing is already right
      continue
    }

    // Record the count only once a relay has actually taken the update. Marking it before
    // publishing meant one failed publish — a rejected relay, a bad rung, a timeout — left the
    // item advertised as available forever, because the next poll sees the same count and skips.
    // A sold-out item with a live Buy button is the oversell slice 7 does not yet exist to
    // refund. Republishing the same signed event is a no-op at the relay, so retrying is free.
    let ok = 0
    try {
      ok = await publish(stepFor(d, rung, target))
    } catch (err) {
      console.log(`# ${d}: ${String(err).slice(0, 160)} — will retry`)
      continue
    }
    if (ok === 0) {
      console.log(`# ${d}: no relay accepted stock ${target} — will retry`)
      continue
    }
    lastSold.set(d, sold)
    console.log(`# ${new Date().toISOString()} ${d}: ${sold} sold -> stock ${target}${target === 0 ? ' (SOLD)' : ''}, ${ok}/${RELAYS.length} relays`)
  }
}

// --- item 9: reconcile the journal against the node, before anything can spend ---------------
//
// THE NON-TTY DECISION, made deliberately and written here because it is the first thing the next
// reader will ask. A daemon under launchd has no stdin, so the prompt below cannot be answered,
// and a prompt that silently defaults is worse than either answer.
//
// **A non-TTY start RUNS, transitions nothing, and says so loudly on every pending row.**
//
// Refusing to start was the other defensible option and it is the wrong one here, because of what
// this process does when it is NOT refunding. The watcher is also slice 3's watcher: it observes
// settlement and republishes availability. Stop it and items stay advertised as available after
// they sell, which is an oversell — a NEW loss, and the exact one this whole slice exists to
// refund. Weighed against that, what the prompt actually buys is nothing that money turns on: a
// `pending` row is ALREADY never retried automatically and never dropped, by design. It is
// reprinted every tick and every five minutes until a human looks at the node. So the prompt is an
// upgrade available when a person is present, and its absence returns the row to precisely the
// state the watcher has always kept it in. Nothing is lost by not asking; something is lost by
// refusing to run.
//
// The two REFUSALS below are different and act with no human in either mode, because refusing
// costs a delay and deciding costs a payment.
if (REFUNDS) {
  // If the node cannot be read, we cannot know what it has already sent — and that is exactly the
  // double-pay condition. `tick()` tolerates a node error per item; this does not, because the
  // thing it guards is money leaving.
  try {
    outgoingAtStart = await outgoingPayments()
  } catch (err) {
    throw new Error(
      `--refunds needs the node's outgoing payments at startup and could not read them: ${String(err).slice(0, 160)}. ` +
        `Refusing to arm refunds without knowing what has already been sent — that is the double-pay condition. ` +
        `Run without --refunds to keep publishing availability.`,
    )
  }

  const { refuseToStart, pending } = reconcile(journal, JOURNAL_EXISTED, outgoingAtStart)

  // THE "RESTORED AN OLD FILE" CASE, and it must be loud. No journal at all, and the node has sent
  // money: every oversell this account ever refunded is about to be recomputed as still owed.
  if (refuseToStart) {
    throw new Error(
      `${JOURNAL_FILE} does not exist, but the node reports ${outgoingAtStart.length} outgoing payment(s). ` +
        `That is either a lost journal or a second machine, and starting with --refunds would recompute every ` +
        `oversell this account has already refunded and pay it again. REFUSING.\n` +
        `  Restore the journal, or — after checking the node's outgoing payments against your sales — create an ` +
        `empty one deliberately:  echo '{}' > ${JOURNAL_FILE}\n` +
        `  node sales-report.ts --outgoing${KEY === '.dev-key' ? '' : ` --key ${KEY}`}  lists what the node has sent.`,
    )
  }

  if (pending.length > 0) {
    console.log(`\n# RECONCILE — ${pending.length} refund(s) were SENT and never acknowledged.`)
  }
  for (const { row, hits } of pending) {
    console.log(`#   ${row.d} — ${row.sats} sats, attempted ${new Date(row.at * 1000).toISOString()}`)
    for (const o of hits) {
      console.log(`#     ${new Date(Number(o.paidAtUnix) * 1000).toISOString()}  ${o.operationId}${o.internal ? '  (internal)' : ''}`)
    }
    if (hits.length === 0) {
      console.log(`#     nothing on the node matches it, which SUGGESTS the debit never left. It is not proof.`)
      console.log(`#     Leaving it 'pending'. It is never retried automatically and never dropped.`)
      continue
    }
    console.log(`#     MATCHED ON AMOUNT AND TIME ONLY — the node stores no link back to the sale, so two`)
    console.log(`#     refunds of this amount in the window are indistinguishable. This is evidence, not an answer.`)
    if (!process.stdin.isTTY) {
      console.log(`#     NO TTY, so nobody can answer. Leaving it 'pending' and UNTOUCHED — see the note in this`)
      console.log(`#     file. Run this watcher from a terminal once to settle it, or edit the journal by hand.`)
      continue
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`#     mark it paid? [y/N] `)
    rl.close()
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log(`#     left as 'pending'.`)
      continue
    }
    recordRefund(journal, JOURNAL_FILE, { ...row, state: 'paid', note: 'confirmed against the node by a human at startup' })
    console.log(`#     marked PAID.`)
  }
  if (pending.length > 0) console.log('')
}

await tick()
if (REFUNDS) await summarise()
if (ONCE) {
  pool.close(RELAYS)
  close()
  process.exit(0)
}
// --- M1: RE-CHECK ON EVERY UPDATE, NOT ONLY AT STARTUP ----------------------------------------
//
// This is the half that removes the RESTART, and the restart is half of what M1 is for. Reading
// the ladders once at startup would still leave the seller stopping and starting this process
// after every edit; they would just no longer be carrying a file to it first.
//
// A ladder that arrives here has been re-cut by the builder from the listing it was published
// with, so it supersedes whatever this process was holding for that item. It is NOT trusted any
// further than the startup read was: same decrypt, same bounded parse, same `stepFor`
// verification against the live listing before any rung is published.
pool.subscribe(RELAYS, { kinds: [LADDER_KIND], authors: [SELLER], since: Math.floor(Date.now() / 1000) }, {
  onevent: (ev: Event) => {
    const d = ev.tags.find(t => t[0] === 'd')?.[1]
    const item = d === undefined ? undefined : listingDOf(d)
    if (!item) return // the seller's private notes share this kind; they are not ours to read
    let rung: Rung | undefined
    try {
      rung = parseRung(nip44.decrypt(ev.content, nip44.getConversationKey(watcherSk, SELLER)))
    } catch {
      rung = undefined
    }
    if (!rung) {
      console.log(`# ${item}: a ladder arrived that did not decrypt or did not parse. IGNORED, still watching what we had.`)
      return
    }
    const [next] = withOffer([[item, rung]])
    if (!next) return // withOffer already said why
    const had = watching.find(w => w.d === item)
    watching = [...watching.filter(w => w.d !== item), next]
    // The publish loop is driven by this count CHANGING, so a stale entry here would sit on a new
    // ladder until the item next sold. Dropping it makes the next tick recompute from the node.
    lastSold.delete(item)
    console.log(
      `# ${item}: NEW LADDER over the relay, ${next.rung.units} unit(s). ` +
        (had ? 'Replaces the one held for it.' : 'Now watching it.') +
        ' No file, no restart.',
    )
  },
})

console.log(`# polling every ${POLL_MS / 1000}s — ctrl-c to stop`)
// GUARDED. A refunding tick outlives POLL_MS by design and the second one used to pay the same
// buyer again — ./refund.ts `inFlightGuard` for the whole chain. A skipped poll costs nothing:
// the next one recomputes availability and the oversell set from the node from scratch.
const guardedTick = inFlightGuard(tick)
setInterval(() => void guardedTick().catch(err => console.log(`# tick failed: ${String(err).slice(0, 160)}`)), POLL_MS)
// Anything owed and unpaid, reprinted on a slow loop. A `queued` refund is money the seller still
// owes a buyer, and a line that scrolled past forty minutes ago does not tell them that.
//
// DELIBERATELY NOT GUARDED, and this was decided rather than overlooked. `summarise` is a pure
// reader: it takes a synchronous snapshot of the in-memory journal, makes one `GetUserOperations`
// read, and prints. It writes no row, signs nothing and pays nothing, so overlapping a refunding
// tick — or a previous slow summarise — costs interleaved log lines and a row printed as
// `pending` while its payment is genuinely in flight, which the line it prints already says is
// not proof. Guarding it would instead swallow the five-minute reminder of money still owed on
// exactly the run where the node is answering slowly, and that reminder is the point of it.
if (REFUNDS) setInterval(() => void summarise().catch(() => {}), 5 * 60_000)
