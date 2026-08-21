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
// Usage: node watch-sales.ts [--nprofile <path|nprofile1…>] [--relays wss://a,wss://b] [--once]
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SimplePool, getPublicKey, type Event } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils.js'
import { decodeNoffer } from '../storefront/src/offer.ts'
import { parseListings } from '../storefront/src/listing.ts'
import { SALE_RELAYS } from './fixture.ts'
import { targetStock } from './ladder.ts'
import { arg, connectPub } from './pub-rpc.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = join(HERE, '.dev-key')
const OFFERS_FILE = join(HERE, '.offers.json')
const LADDER_FILE = join(HERE, '.ladder.json')

// ponytail: fixed 5s poll. A yard sale settles a handful of invoices an hour and this is the
// seller's own node's relay; if that ever stops being true, the upgrade is the live feed as a
// nudge with this call still doing the attribution.
const POLL_MS = 5_000
// The node is not trusted input either. A yard sale does not have this many settled invoices.
const MAX_INVOICES = 5_000
const ONCE = process.argv.includes('--once')
const RELAYS = arg('relays', SALE_RELAYS.join(',')).split(',')

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE} — run seed-listings.ts first`)
if (!existsSync(OFFERS_FILE)) throw new Error(`no ${OFFERS_FILE} — run mint-offers.ts first`)
if (!existsSync(LADDER_FILE)) throw new Error(`no ${LADDER_FILE} — run seed-listings.ts first`)

const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const SELLER = getPublicKey(sk)

type Minted = { noffer: string; price_sats: number }
type Rung = { units: number; steps: Event[] }
const minted: Record<string, Minted> = JSON.parse(readFileSync(OFFERS_FILE, 'utf8'))
const ladder: Record<string, Rung> = JSON.parse(readFileSync(LADDER_FILE, 'utf8'))

// The offer id is read out of the noffer the *published listing* points at, not out of a
// separate config, so the thing we watch is by construction the thing a buyer would pay.
const watching = Object.entries(ladder).flatMap(([d, rung]) => {
  const offer = minted[d] && decodeNoffer(minted[d]!.noffer)
  if (!offer) {
    console.log(`# ${d}: no decodable offer in ${OFFERS_FILE} — not watching`)
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
console.log(`# watching ${watching.length} item(s): ${watching.map(w => `${w.d}(${w.rung.units})`).join(' ')}\n`)

const pool = new SimplePool()

// A settled invoice is one the node says was paid. Everything here is bounded and re-checked
// rather than destructured off a trusted response: this is the number that decides whether an
// item is still for sale.
const settledCount = (res: unknown, offerId: string): number => {
  const rows = (res as { invoices?: unknown }).invoices
  if (!Array.isArray(rows)) return 0
  const seen = new Set<string>()
  for (const row of rows.slice(0, MAX_INVOICES)) {
    if (typeof row?.invoice !== 'string' || row.invoice.length > 4_000) continue
    if (row.offer_id !== offerId) continue // GetOfferInvoices filters by it; verify anyway
    if (!(Number(row.paid_at_unix) > 0)) continue // include_unpaid:false already means this
    seen.add(row.invoice) // the settled invoice IS the idempotency key
  }
  return seen.size
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

const tick = async () => {
  for (const { d, rung, offerId } of watching) {
    let sold: number
    try {
      // structs.proto:893-896 — { offer_id, include_unpaid }. include_unpaid:false makes the
      // storage layer filter on paid_at_unix > 0 (paymentStorage.ts:527-533), i.e. exactly the
      // settled set for this one item's offer.
      sold = settledCount(await rpc('GetUserOfferInvoices', { offer_id: offerId, include_unpaid: false }), offerId)
    } catch (err) {
      console.log(`# ${new Date().toISOString()} ${d}: ${String(err).slice(0, 120)}`)
      continue
    }

    if (lastSold.get(d) === sold) continue

    if (sold > rung.units) {
      // Oversold: two buyers reached the last unit (/docs/spec.md §7.3). Slice 7 is the
      // automatic refund; until it exists this is the loud line that tells the seller to hand
      // money back at the table. The pointer to send it to is in this item's stored
      // `payer_data` — which is why this watcher does NOT delete the depleted offer. See the
      // note under `watching` above.
      console.log(`# ${d}: OVERSOLD — ${sold} settled against ${rung.units} unit(s). Refund owed.`)
    }

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
if (ONCE) {
  pool.close(RELAYS)
  close()
  process.exit(0)
}
console.log(`# polling every ${POLL_MS / 1000}s — ctrl-c to stop`)
setInterval(() => void tick().catch(err => console.log(`# tick failed: ${String(err).slice(0, 160)}`)), POLL_MS)
