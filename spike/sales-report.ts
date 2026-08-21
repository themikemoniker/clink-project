// Slice 6 — what has actually sold, in money rather than in stock counts.
//
// WHY THIS IS A SCRIPT AND NOT A BUTTON, because that is the whole finding and it is the reason
// slice 6 lost a bullet:
//
//   * CLINK Manage's only resource is `"offer"`, with actions create/update/get/list/delete
//     (/docs/clink-notes.md §4, clink-manage.md:29 and :33-92). `managementManager.ts:115-134`
//     on the running node switches on exactly those five and answers GFY 1 to anything else.
//     **There is no invoice resource and no settlement resource anywhere in CLINK.**
//   * Settled invoices live behind `GetUserOfferInvoices`, and `nostrMiddleware.ts:52-80` routes
//     that only from an event that is not 21001/21002/21003 — the native kind 21000 RPC. Kind
//     21000 is decrypted with Lightning.Pub's own v1 envelope, keyed on sha256 of the raw ECDH
//     x-coordinate (`nostrPool.ts:110-113`), and NIP-46 exposes no raw-ECDH method
//     (/docs/spike-findings.md §13.18).
//
// So the seller's own browser, holding only a Signer, **cannot read the seller's sales**. Handing
// it a raw node key instead would break /CLAUDE.md rules 2 and 3 at once and give a web page
// spend authority, because Lightning.Pub has no observer scope — the credential that reads
// operations can also call `PayInvoice` (findings §10). This runs where the key already is,
// which is the honest place for it. /docs/spike-findings.md §13.25.
//
// KEY HANDLING NOTICE — same exception as seed-listings.ts and mint-offers.ts. This reads
// /spike/.dev-key, the throwaway seller identity that also owns the Lightning.Pub account. It is
// read-only in intent and NOT read-only in authority; nothing here calls anything that moves
// money, and nothing here should ever be given a reason to.
//
// It never prints a refund pointer. A buyer's `refund_pointer` is an ndebit — a credential
// addressed to their wallet — and /CLAUDE.md says not to log payloads carrying one. Presence is
// what a seller needs to know; the value is slice 7's business and stays on the node.
//
// Usage: node sales-report.ts [--nprofile <path|nprofile1…>] [--json]
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils.js'
import { REFUND_POINTER } from './fixture.ts'
import { arg, connectPub } from './pub-rpc.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = join(HERE, '.dev-key')
const LADDER_FILE = join(HERE, '.ladder.json')
const JSON_OUT = process.argv.includes('--json')

// The node is not trusted input. A yard sale does not have this many settled invoices.
const MAX_INVOICES = 5_000

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE} — run seed-listings.ts first`)
const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())

const ladder: Record<string, { units: number }> = existsSync(LADDER_FILE)
  ? JSON.parse(readFileSync(LADDER_FILE, 'utf8'))
  : {}

const { appPub, relays, rpc, close } = connectPub(
  sk,
  arg('nprofile', join(homedir(), 'lightning_pub', 'app.nprofile')),
)

type OfferConfig = { offer_id: string; label: string; price_sats: number; default_offer: boolean }
type OfferInvoice = { invoice: string; offer_id: string; paid_at_unix: number; amount: number; data?: Record<string, string> }
type Row = { label: string; priceSats: number; units?: number; settled: number; sats: number; last?: number; withPointer: number }

// Native `GetUserOffers` sees every offer on the account, whichever transport minted it — Manage
// `list` would see only its own requestor's (findings §13.20), which is exactly the wrong half
// for a report. NEVER the default offer: its offer_id IS the account pointer (findings §3).
const offers: OfferConfig[] = ((await rpc('GetUserOffers', {})).offers ?? []).filter(
  (o: OfferConfig) => !o.default_offer,
)

const rows: Row[] = []
for (const offer of offers) {
  // structs.proto:893-896 — { offer_id, include_unpaid }. include_unpaid:false makes the storage
  // layer filter on paid_at_unix > 0 (paymentStorage.ts:527-533): exactly the settled set.
  const res = await rpc('GetUserOfferInvoices', { offer_id: offer.offer_id, include_unpaid: false })
  const raw: unknown = (res as { invoices?: unknown }).invoices
  const invoices: OfferInvoice[] = Array.isArray(raw) ? raw.slice(0, MAX_INVOICES) : []

  // structs.proto:902-908 — OfferInvoice { invoice, offer_id, paid_at_unix, amount, data }. The
  // settled invoice is the idempotency key everywhere else in this project (spec §8), so it is
  // what dedupes here too: a relay replay cannot inflate a total that counts distinct invoices.
  const seen = new Map<string, OfferInvoice>()
  for (const row of invoices) {
    if (typeof row?.invoice !== 'string' || row.invoice.length > 4_000) continue
    if (row.offer_id !== offer.offer_id) continue
    if (!(Number(row.paid_at_unix) > 0)) continue
    if (!seen.has(row.invoice)) seen.set(row.invoice, row)
  }
  const settled = [...seen.values()]

  rows.push({
    label: offer.label,
    priceSats: offer.price_sats,
    units: ladder[offer.label]?.units,
    settled: settled.length,
    sats: settled.reduce((n, row) => n + (Number(row.amount) > 0 ? Number(row.amount) : 0), 0),
    last: settled.reduce((n, row) => Math.max(n, Number(row.paid_at_unix) || 0), 0) || undefined,
    // Presence only. The value is a buyer's ndebit and does not belong in a log.
    withPointer: settled.filter(row => typeof row.data?.[REFUND_POINTER] === 'string' && row.data[REFUND_POINTER]).length,
  })
}

rows.sort((a, b) => b.sats - a.sats || a.label.localeCompare(b.label))
const total = rows.reduce((n, r) => n + r.sats, 0)
const count = rows.reduce((n, r) => n + r.settled, 0)

if (JSON_OUT) {
  console.log(JSON.stringify({ rows, total, count }, null, 2))
} else {
  console.log(`# node ${appPub.slice(0, 12)}… on ${relays.join(', ')}`)
  console.log(`# acting as ${nip19.npubEncode(getPublicKey(sk))}`)
  console.log(`# ${offers.length} purpose-made offer(s); the account's default offer is never listed\n`)
  console.log('item                            price   sold   sats in   refundable   last settled')
  for (const r of rows) {
    const of = r.units === undefined ? '' : `/${r.units}`
    console.log(
      r.label.padEnd(30) +
        String(r.priceSats).padStart(7) +
        `${r.settled}${of}`.padStart(7) +
        String(r.sats).padStart(10) +
        `${r.withPointer}/${r.settled}`.padStart(13) +
        '   ' +
        (r.last ? new Date(r.last * 1000).toISOString() : '—'),
    )
  }
  console.log(`\n# ${count} settled invoice(s), ${total} sats received`)
  if (rows.some(r => r.settled > r.withPointer)) {
    console.log('# some settled invoices carry no refund pointer — an oversell on those cannot be paid back')
  }
  const over = rows.filter(r => r.units !== undefined && r.settled > r.units)
  for (const r of over) console.log(`# OVERSOLD ${r.label}: ${r.settled} settled against ${r.units} unit(s). Refund owed.`)
  if (!existsSync(LADDER_FILE)) console.log(`# no ${LADDER_FILE}, so "sold of how many" is unknown — that number is only in the ladder`)
}

close()
process.exit(0)
