// Slice 7: turning an oversell into money in the buyer's wallet. Three separable problems, and
// they are separate here because only the first two can be tested without spending sats.
//
//   1. WHICH settled invoices are owed a refund          — `oversold`, pure
//   2. Turning the buyer's stored pointer into a BOLT11  — `resolvePointer`, network
//   3. Not paying the same one twice                     — the journal, below
//
// The payment itself is ./ndebit.ts. This file never signs and never pays.
//
// NEVER LOG A REFUND POINTER. A `refund_pointer` is a credential addressed to the buyer's wallet
// — an ndebit, or a Lightning address that identifies a person. /CLAUDE.md says not to log
// payloads carrying one, /spike/sales-report.ts prints presence rather than value, and the
// journal below stores the *kind* of pointer and never the pointer. The one place a value
// appears is inside `resolvePointer`, in memory, for as long as it takes to fetch an invoice.
//
// ONE DELIBERATE EXCEPTION, drawn here rather than discovered later: an LNURL failure names the
// **host** — `ln.tips`, `walletofsatoshi.com` — and never the name half. The host is the wallet
// provider and is what makes a queued row actionable ("their server is down" is a different
// problem from "you typed it wrong"); the name half is what identifies the person, and it is
// never written, never printed, and never leaves this file. `new URL(url).host` is the only thing
// that crosses that line, and it is the only thing that should.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { closeBuy, requestInvoice } from '../storefront/src/buy.ts'
import { decodeNoffer, invoiceSats, LN_ADDRESS } from '../storefront/src/offer.ts'

// structs.proto:902-908 — OfferInvoice { invoice, offer_id, paid_at_unix, amount, data }, where
// `data` is the validated `payer_data` the buyer supplied at request time and the node stored on
// the invoice (/docs/spike-findings.md §6).
export type Settled = {
  invoice: string
  offer_id: string
  paid_at_unix: number
  amount: number
  data?: Record<string, string>
}

/**
 * Which settled invoices are oversells, in the order they should be refunded.
 *
 * FIRST COME, FIRST SERVED, and it has to be deterministic rather than merely reasonable. The
 * watcher recomputes this from the node on every poll and after every restart (spec §8 — the
 * node holds the state, we hold none), so if this function ranked two invoices differently on
 * two runs it would refund one buyer, restart, and then decide a *different* buyer was the
 * oversold one. The first `units` payments keep their goods; everything after is owed money.
 *
 * Sorted by `paid_at_unix`, then by the invoice string to break ties. Two settlements in the
 * same second is exactly the sold-out race this slice exists for (spec §7.3), so the tiebreak is
 * load-bearing and not decoration — it just has to be stable, not fair, because at that
 * resolution there is no fair.
 */
export const oversold = (invoices: Settled[], units: number): Settled[] => {
  const seen = new Map<string, Settled>()
  for (const row of invoices) {
    // The node is not trusted input either — same bounds as watch-sales.ts and sales-report.ts.
    if (typeof row?.invoice !== 'string' || row.invoice.length > 4_000) continue
    if (!(Number(row.paid_at_unix) > 0)) continue
    if (!(Number(row.amount) > 0)) continue
    if (!seen.has(row.invoice)) seen.set(row.invoice, row) // the settled invoice is the key
  }
  const settled = [...seen.values()].sort(
    (a, b) => a.paid_at_unix - b.paid_at_unix || (a.invoice < b.invoice ? -1 : 1),
  )
  return settled.slice(Math.max(0, units))
}

// --- the journal ----------------------------------------------------------------------------
//
// A REFUND IS THE PROJECT'S FIRST WRITE, and that is why this file exists at all.
//
// Slice 3 was pleased to persist nothing: remaining stock is recomputed from the node every
// poll, so a restart recomputes it and a replayed request that never became a payment cannot
// move it (spec §8). That works because reading is idempotent for free. Paying is not. The
// failure is one sentence: the watcher pays a refund, crashes before recording it, restarts,
// recomputes the same oversell from the node, and pays it again. The node has no
// "already refunded" field on an invoice, so there is nowhere on the node for that state to live.
//
// THE CANDIDATE THAT WAS TRIED FIRST, AND WHY IT COLLAPSED. CLINK's `k1` is a single-use session
// identifier scoped to the pointer, consumed on payout, duplicates refused
// (/docs/clink-notes.md §3.3). Deriving it from the settled invoice would have made a double
// refund something the node refuses. The slice brief marked the load-bearing part `UNVERIFIED`
// and asked for it to be read from source rather than inferred. It was, on 2026-08-21:
// Lightning.Pub's `K1Debouncer` is an in-memory array with a **5-minute TTL**, swept once a
// minute, lost entirely on restart (debitManager.ts:19-37). The source comment says so in as
// many words. So `k1` covers a crash loop and nothing slower, and it is kept as a second layer
// (./ndebit.ts `k1For`) rather than as the answer.
//
// SO: a file, keyed on the settled invoice — which is the settlement identifier /CLAUDE.md's
// idempotency rule actually names. It is written BEFORE the payment and updated after, because
// the dangerous state is not "crashed after paying", it is "crashed while paying". A row left
// `pending` means we do not know whether money moved, and the watcher will NOT retry it: it
// prints it, every tick, until a human looks at the node. Guessing in either direction is
// wrong — retrying might double-pay, dropping it might strand a buyer.
export type RefundState =
  | 'pending' // sent to the node, no answer yet. Unknown. Never auto-retried
  | 'paid' // the node acknowledged
  | 'failed' // the node declined, or we could not build a payment. Retried on the next tick
  | 'queued' // no usable pointer, or resolution failed. Needs a human; never auto-retried

export type RefundRecord = {
  invoice: string // the settled invoice: the key, and the idempotency key
  d: string
  sats: number
  state: RefundState
  at: number
  // The KIND of pointer, never the pointer. 'noffer' | 'address' | 'none'.
  pointer: string
  note?: string
  // Whether the ACK carried a preimage, not the preimage. Recorded because its absence proves
  // nothing (/docs/spike-findings.md §5) and somebody will eventually ask.
  preimage?: boolean
}

export type Journal = Record<string, RefundRecord>

export const readJournal = (path: string): Journal => {
  if (!existsSync(path)) return {}
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Journal) : {}
  } catch {
    // A corrupt journal must not read as an empty one — an empty one means "nothing has been
    // refunded", which is the exact belief that double-pays. Refuse to run instead.
    throw new Error(
      `${path} exists but is not readable JSON. It is the only record of which refunds have been ` +
        `paid; refusing to start rather than treat it as empty. Move it aside deliberately if you ` +
        `mean to, and reconcile against the node first.`,
    )
  }
}

/**
 * Write the journal, atomically.
 *
 * Rename-over-temp rather than a plain write: a crash mid-`writeFileSync` on the file that
 * records what has already been paid would leave a truncated JSON document, which `readJournal`
 * then refuses to start on. One rename is cheaper than that conversation.
 */
export const writeJournal = (path: string, journal: Journal) => {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

/** Everything the watcher must not act on again: paid, in flight, or waiting for a human. */
export const settledByUs = (journal: Journal, invoice: string): RefundRecord | undefined => {
  const row = journal[invoice]
  return row && row.state !== 'failed' ? row : undefined
}

// --- turning a pointer into a BOLT11 --------------------------------------------------------

export type Resolved = { ok: true; bolt11: string } | { ok: false; error: string; queue: boolean }

/**
 * The LNURL-pay URL for a Lightning address, or null.
 *
 * THIS IS THE ONE THIRD-PARTY SERVER IN THE PROJECT, and the slice owns the decision rather than
 * working around it. It is not *our* server, so it is not a /CLAUDE.md rule 1 violation — but it
 * is a dependency nothing else here has, it is unauthenticated, and it is the first time a
 * refund's success depends on somebody else's uptime. It is in because the storefront's own
 * placeholder is `you@yourwallet.com`, which makes an address the common case rather than the
 * edge one, and because all three settled invoices on this node today carry one.
 *
 * What keeps it honest: a failure here is a `queued` journal row and a line the watcher prints
 * on every tick, not a swallowed error. A dead LNURL host becomes something the seller can see
 * and hand money over about at the table.
 *
 * The line to say on stage, because a judge will find it otherwise: a Lightning address is a
 * hostname, and a hostname is a server. The noffer path has no server in it at all.
 */
export const lnurlpUrl = (address: string): string | null => {
  if (!LN_ADDRESS.test(address)) return null
  const at = address.lastIndexOf('@')
  const name = address.slice(0, at)
  const host = address.slice(at + 1).toLowerCase()
  // Path-traversal in the name half would otherwise let `../../x@host` address an arbitrary path
  // on that host. encodeURIComponent is the whole guard and it is enough: the result cannot
  // contain `/` or `.` runs that a path parser would collapse.
  return `https://${host}/.well-known/lnurlp/${encodeURIComponent(name)}`
}

// LUD-06 payRequest, the subset we need. Deliberately re-validated rather than destructured off
// a trusted response: this JSON came from a host named by a stranger's payment pointer, and the
// `callback` in it is the URL we are about to ask for an invoice.
const payRequestCallback = (body: unknown, msat: number): string | null => {
  const o = body as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return null
  if (o.tag !== 'payRequest') return null
  const callback = typeof o.callback === 'string' ? o.callback : ''
  if (!callback.startsWith('https://') || callback.length > 2_000) return null
  const min = Number(o.minSendable)
  const max = Number(o.maxSendable)
  // Bounds are the host's, and a host that will not take this amount must be refused here rather
  // than answering with an invoice for a different one.
  if (!Number.isFinite(min) || !Number.isFinite(max) || msat < min || msat > max) return null
  try {
    const url = new URL(callback)
    if (url.protocol !== 'https:') return null
    url.searchParams.set('amount', String(msat))
    return url.toString()
  } catch {
    return null
  }
}

const FETCH_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 64 * 1024

// A 4xx is the host saying "this address does not exist here", which no amount of retrying fixes;
// a 5xx or a socket error is the host having a bad minute. They need opposite handling — one is a
// human's problem and one is the next tick's — so the distinction is carried out of here rather
// than flattened into "the fetch failed".
class PermanentHttpError extends Error {}

const getJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    const err = res.status >= 400 && res.status < 500 ? new PermanentHttpError(`HTTP ${res.status}`) : new Error(`HTTP ${res.status}`)
    throw err
  }
  const text = await res.text()
  if (text.length > MAX_BODY_BYTES) throw new Error('response too large')
  return JSON.parse(text)
}

/**
 * Ask the buyer's wallet for an invoice for exactly what they paid.
 *
 * Two completely different resolutions behind one call, which is the point — the caller has an
 * oversell and an amount, not a protocol preference.
 *
 * `expectSats` is checked against the invoice that comes back in BOTH paths. On the noffer side
 * storefront/src/buy.ts does it for us (it is the same check that stops a seller's node quoting
 * a buyer the wrong price, run in the opposite direction); on the LNURL side it is done here.
 * A refund for more than the buyer paid is money leaving the node that no sale created.
 */
export const resolvePointer = async (pointer: string, expectSats: number): Promise<Resolved> => {
  if (typeof pointer !== 'string' || !pointer.trim()) {
    return { ok: false, error: 'no refund pointer on the settled invoice', queue: true }
  }
  const raw = pointer.trim()

  // --- an noffer: a kind 21001 request, which is storefront/src/buy.ts with the roles swapped.
  // The watcher becomes the paying client and the BUYER's node is the service. Same module the
  // storefront ships, unmodified, because a second implementation of the request that decides
  // where money goes is the last thing this project needs.
  const offer = decodeNoffer(raw)
  if (offer) {
    // buy.ts mints an ephemeral key per request by design, and that is the right posture here
    // too: the refund is between the payer's key and the buyer's service, and reusing the refund
    // key would let the buyer's node link every refund this seller has ever sent. The settlement
    // receipt comes back encrypted to whoever signed (/docs/spike-findings.md §5), and we do not
    // want it — the node's own ACK is what tells us the money left.
    const outcome = await requestInvoice(offer, {}, expectSats, 'Refund', () => {})
    // buy.ts keeps a subscription open for the receipt after a successful request. Nothing here
    // reads it, and a long-running watcher would otherwise accumulate one per refund.
    closeBuy()
    if (!outcome.ok) {
      // A code 1 naming required `payer_data` keys is the interesting failure: the buyer's own
      // offer demands fields we have no way to supply. That is a human's problem, not a retry.
      const keys = 'payerData' in outcome && outcome.payerData?.length ? ` (it requires ${outcome.payerData.join(', ')})` : ''
      return { ok: false, error: `the buyer's node declined: ${outcome.error}${keys}`, queue: outcome.code === 1 }
    }
    return { ok: true, bolt11: outcome.bolt11 }
  }

  // --- a Lightning address: LNURL-pay over HTTPS, i.e. somebody else's server.
  const url = lnurlpUrl(raw)
  if (!url) {
    // Neither an noffer nor an address. The page validates both shapes before it will request an
    // invoice, so reaching here means the payment did not come through our page — a raw-QR payer,
    // which spec §7.3 already says forfeits the automatic refund.
    return { ok: false, error: 'the stored pointer is neither an noffer nor a Lightning address', queue: true }
  }

  const msat = expectSats * 1_000
  try {
    const callback = payRequestCallback(await getJson(url), msat)
    if (!callback) {
      return { ok: false, error: `${new URL(url).host} did not answer with a usable LNURL-pay request for ${expectSats} sats`, queue: true }
    }
    const body = (await getJson(callback)) as Record<string, unknown> | null
    const bolt11 = typeof body?.pr === 'string' ? body.pr.trim() : ''
    if (!bolt11) {
      const reason = typeof body?.reason === 'string' ? `: ${body.reason.slice(0, 200)}` : ''
      return { ok: false, error: `${new URL(url).host} returned no invoice${reason}`, queue: true }
    }
    // The same check buy.ts makes on the seller's node, made here on the buyer's host. `^lnbc`
    // as of this slice's Phase 0, so an invoice on the wrong chain dies here rather than at the
    // node. An amountless invoice reads as null and is refused, never as zero.
    const sats = invoiceSats(bolt11)
    if (sats !== expectSats) {
      return {
        ok: false,
        error: `invoice is for ${sats === null ? 'an unreadable amount' : `${sats} sats`}, not the ${expectSats} paid`,
        queue: true,
      }
    }
    return { ok: true, bolt11 }
  } catch (err) {
    // A host that is down, slow, or serving nonsense gets another go — "the server was rebooting"
    // is the common case and the next attempt is minutes away. A 4xx does not: the host answered,
    // and what it said was that this address is not one of theirs. That is a person's problem.
    return {
      ok: false,
      error: `${new URL(url).host}: ${String(err).slice(0, 120)}`,
      queue: err instanceof PermanentHttpError,
    }
  }
}
