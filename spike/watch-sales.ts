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
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SimplePool, getPublicKey, type Event } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils.js'
import { decodeNoffer } from '../storefront/src/offer.ts'
import { parseListings } from '../storefront/src/listing.ts'
import { REFUND_POINTER, SALE_RELAYS } from './fixture.ts'
import { isStale, nofferOf, targetStock } from './ladder.ts'
import { decodeNdebit, k1For, payDebit, type DebitPointer } from './ndebit.ts'
import {
  matchingPayments,
  oversold,
  readJournal,
  resolvePointer,
  settledByUs,
  writeJournal,
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

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE} — pass --key <file>, or run seed-listings.ts first`)
if (!existsSync(OFFERS_FILE)) throw new Error(`no ${OFFERS_FILE} — run mint-offers.ts first`)
if (!existsSync(LADDER_FILE)) throw new Error(`no ${LADDER_FILE} — run seed-listings.ts first`)

const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const SELLER = getPublicKey(sk)

// The refund half loads only when armed, and it refuses to start half-configured rather than
// discovering at the first oversell that it cannot pay. An oversell is the one moment this
// process exists for; finding out then that the grant was never made is finding out too late.
let refundSk = new Uint8Array()
let debitNode: DebitPointer = { pubkey: '', relay: '' }
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
const ladder: Record<string, Rung> = JSON.parse(readFileSync(LADDER_FILE, 'utf8'))

// The offer id comes out of the ladder file itself, not a separate config, so the thing we watch
// is by construction the thing a buyer would pay. Three sources in descending authority, and the
// reasoning — including which one used to lose every one-of-a-kind item — is in ./ladder.ts.
let watching = Object.entries(ladder).flatMap(([d, rung]) => {
  const noffer = nofferOf(rung, minted[d]?.noffer)
  const offer = noffer && decodeNoffer(noffer)
  if (!offer) {
    console.log(`# ${d}: no decodable offer in its ladder or ${OFFERS_FILE} — not watching`)
    return []
  }
  return [{ d, rung, offerId: offer.offer }]
})
if (watching.length === 0) throw new Error('nothing to watch — run mint-offers.ts then seed-listings.ts')

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
      `the item would stay on sale after it sold. Download .ladder.json from the builder again ` +
      `and restart. NOT WATCHING.`,
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
  journal[row.invoice] = {
    invoice: row.invoice,
    d,
    sats,
    state,
    at: Math.floor(Date.now() / 1000),
    pointer, // the KIND of pointer, never the pointer
    note,
    ...(preimage === undefined ? {} : { preimage }),
  }
  writeJournal(JOURNAL_FILE, journal)
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

await tick()
if (REFUNDS) await summarise()
if (ONCE) {
  pool.close(RELAYS)
  close()
  process.exit(0)
}
console.log(`# polling every ${POLL_MS / 1000}s — ctrl-c to stop`)
setInterval(() => void tick().catch(err => console.log(`# tick failed: ${String(err).slice(0, 160)}`)), POLL_MS)
// Anything owed and unpaid, reprinted on a slow loop. A `queued` refund is money the seller still
// owes a buyer, and a line that scrolled past forty minutes ago does not tell them that.
if (REFUNDS) setInterval(() => void summarise().catch(() => {}), 5 * 60_000)
