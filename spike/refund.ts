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
import { lookup } from 'node:dns/promises'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { Readable } from 'node:stream'
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

/**
 * Write one journal row and persist it. **`paid` is terminal.**
 *
 * The write used to be an unconditional `journal[invoice] = {…}` in watch-sales.ts, and that is
 * the second half of the double-refund the 2026-08-21 panel found. Two overlapping ticks both
 * resolve a BOLT11 for the same oversell and both send it; the node's k1 debouncer refuses the
 * loser; the loser's write then lands `failed` on top of the winner's `paid`. `settledByUs`
 * treats `failed` as retryable and `RETRY_AFTER_S` is six minutes — long enough for the
 * debouncer's five-minute TTL to have swept the k1 — so the retry gets a fresh one and pays for
 * real. The journal is the ONLY durable double-refund guard and a late refusal could downgrade it.
 *
 * It lives here rather than at the call site on purpose: the invariant belongs to the journal, so
 * every future writer gets it, including the startup reconcile. Grepped before landing it — the
 * only writer in the tree is watch-sales.ts's `record`, and the only readers of a row's `state`
 * are `settledByUs` and the watcher's own printing (`summarise`, the pending line). **Nothing in
 * this codebase legitimately moves a row OUT of `paid`**, so a blanket return costs nothing; if a
 * flow ever needs to, it needs a new verb rather than this one.
 */
export const recordRefund = (journal: Journal, path: string, row: RefundRecord): void => {
  if (journal[row.invoice]?.state === 'paid') return
  journal[row.invoice] = row
  writeJournal(path, journal)
}

/**
 * Run at most one of these at a time; a call that arrives while one is running is DROPPED.
 *
 * `setInterval(tick, 5_000)` had no guard, and a refunding tick routinely outlives its own timer
 * by design — `resolvePointer` alone is two sequential LNURL fetches at a 10s timeout each. So
 * tick B re-read the journal mid-flight, saw nothing at `settledByUs` because the `pending` row
 * is not written until after that network call, and resolved a second invoice for the same sale.
 *
 * DROPPED RATHER THAN QUEUED. Queueing a skipped poll would build a backlog behind exactly the
 * slow refund that caused the overlap, and the poll is not a job — it recomputes everything from
 * the node each time, so the next one in five seconds sees whatever this one would have.
 *
 * It is here, next to the journal, because the money half is the only half that a double run
 * costs anything: republishing a signed rung twice is a no-op at the relay by construction
 * (./ladder.ts), and `lastSold` already collapses a repeated count.
 */
export const inFlightGuard = <T>(fn: () => Promise<T>): (() => Promise<T | undefined>) => {
  let running = false
  return async () => {
    if (running) return undefined
    running = true
    try {
      return await fn()
    } finally {
      running = false
    }
  }
}

// --- reconciling a `pending` row against the node -------------------------------------------
//
// A `pending` row means we sent a debit and never heard back, so whether money moved is unknown.
// The watcher refuses to guess and that is correct (retrying might double-pay, dropping it might
// strand a buyer) — but "go and look at the node's outgoing payments" is an investigation, and on
// a demo day it is a line in a terminal nobody is reading. This turns it into a glance.
//
// IT IS A HEURISTIC, NOT A KEY, and it is labelled one everywhere it prints. The node stores no
// link between a debit and the settled invoice that caused it, so all we can match on is amount
// and time. Two refunds of the same amount inside the window are indistinguishable here. A match
// is evidence for a human, never an input to a decision this program makes.
export type Outgoing = { paidAtUnix: number; amount: number; operationId: string; internal?: boolean }

// How far either side of the attempt to look. Wide, because the row is written BEFORE the payment
// and the interesting failure is precisely the one where the node took a long time to answer.
const MATCH_WINDOW_S = 15 * 60

export const matchingPayments = (ops: unknown, sats: number, at: number): Outgoing[] => {
  if (!Array.isArray(ops)) return []
  return ops
    .filter((o: Outgoing) => {
      if (!o || typeof o !== 'object') return false
      // Amount is exact: a refund is for what the buyer paid, never a rounded figure. Fees are
      // carried in separate fields (structs.proto:641-642) and do not move this number.
      if (Number(o.amount) !== sats) return false
      const t = Number(o.paidAtUnix)
      return Number.isFinite(t) && Math.abs(t - at) <= MATCH_WINDOW_S
    })
    .sort((a: Outgoing, b: Outgoing) => a.paidAtUnix - b.paidAtUnix)
}

// --- item 9 (2026-08-24): the startup reconcile ----------------------------------------------
//
// `.refunds.json` is the ONLY durable record that a refund happened. The node has no
// "already refunded" field, and CLINK's `k1` is in memory with a five-minute TTL (findings
// §13.28), so it cannot carry idempotency. Lose the file, restore an old one, or start the watcher
// on a second machine, and every oversell it already paid is recomputed from the node and paid
// again. This is the same failure class as the tick race, not a durability nicety.
//
// THE ONE DECISION THIS FUNCTION ENCODES: **a match is evidence for a human, never an input to
// whether money moves.** The roadmap originally said a `pending` row with a matching payment
// becomes `paid` without human intervention; the 2026-08-23 review reversed that (findings §1) and
// the reversal is load-bearing. The node stores no link between a debit and the settled invoice
// that caused it, so two refunds of the same amount inside the window are indistinguishable.
// Marking a row `paid` on that heuristic records a refund that may never have been sent, and the
// buyer is then stranded with no row reprinting to say so — a NEW way for milestone A to lose
// money rather than a guard against one.
//
// So this returns findings, not transitions. Only the two REFUSALS act without a human, because
// refusing costs a delay and deciding costs a payment.
export type PendingMatch = { row: RefundRecord; hits: Outgoing[] }
export type Reconciliation = {
  /** The journal file was absent and the node has sent money. That is the "restored an old file"
   *  case, and it is the one shape where starting up is itself the dangerous act. */
  refuseToStart: boolean
  /** Every `pending` row, with whatever the node has that looks like it. Possibly nothing. */
  pending: PendingMatch[]
}

export const reconcile = (journal: Journal, journalExisted: boolean, ops: Outgoing[]): Reconciliation => ({
  refuseToStart: !journalExisted && ops.length > 0,
  pending: Object.values(journal)
    .filter(row => row.state === 'pending')
    .map(row => ({ row, hits: matchingPayments(ops, row.sats, row.at) })),
})

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

// --- item 4 (2026-08-24): this is a trust boundary and it was open ---------------------------
//
// THE BUYER CHOOSES THE HOST. `refund_pointer` is a string a stranger typed into our own Buy form
// and the node stored on the settled invoice; the seller's watcher then fetches it, twice, and
// asks it for an invoice it is about to pay. Everything from here to `resolvePointer` is written
// against that fact rather than against a cooperative wallet host.
//
// TWO PANEL CLAIMS, BOTH REPRODUCED FIRST (2026-08-24, self-signed listener on 127.0.0.1):
//   * `:257` — the 64 KB bound bounded nothing. `await res.text()` buffered a 10 MB body in 34 ms
//     and the length check ran on the line after. The seller's machine ate every byte.
//   * `:221` — no private-address check on either hop. Hop 2's URL is the `callback` field, which
//     is chosen by the host the buyer named, so a raw `https://127.0.0.1:…` is fully in reach.
//     The listener recorded the connection and the watcher parsed its answer.
// And `redirect: 'follow'` was measured following a self-redirect **21 times** — undici's default
// of 20, which is a cap in the sense that a wall is a cap.
//
// WHAT THE ROADMAP ASKED FOR AND WHY IT COULD NOT BE BUILT ON `fetch`. The bullet says "resolve
// the host, reject private and loopback ranges, and re-check after each redirect". Neither half
// works through `fetch`:
//
//   * `dns.resolve()` followed by `fetch(url)` RE-RESOLVES the name, so the address that was vetted
//     is not the address that is connected to. A hostile pointer's DNS can answer differently the
//     second time. That is security theatre, and shipping it would be worse than shipping nothing,
//     because the ledger would then carry a guarantee that is not one.
//   * `redirect: 'follow'` hands back the FINAL response. There is no per-hop anything.
//
// SO THE TRANSPORT CHANGED. `node:https` instead of `fetch`, which is stdlib and adds no
// dependency, and which lets all three fixes fall out of one shape:
//
//   1. NO TOCTOU. We resolve the name ourselves, refuse if ANY returned address is private, and
//      then connect to that exact IP with `servername` and the `Host` header set to the real
//      hostname — so TLS is still validated against the name and the socket still goes where we
//      looked. This is the second of the two shapes the brief named; the first (a custom undici
//      `lookup` dispatcher) needs the `undici` package, and `node:https` is already here.
//   2. THE REDIRECT CHAIN IS OURS. `https.request` follows nothing, so each hop is a separate,
//      separately-vetted request, capped at MAX_REDIRECTS and re-checked for https every time.
//   3. THE BODY IS COUNTED OFF THE STREAM and the request is destroyed the moment it crosses the
//      bound, in bytes rather than in the UTF-16 code units `text.length` was measuring.
//
// ONE DEADLINE covers the whole chain, so a host cannot hold the watcher for MAX_REDIRECTS × the
// timeout by redirecting slowly.
//
// NEVER PUT THE PATH IN AN ERROR. Every message built below names `u.host` and never `u.pathname`
// — the path carries the name half of the buyer's Lightning address, which is the half that
// identifies a person. See the header of this file.
const FETCH_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 64 * 1024
// Eight, not three. Three was measured against a lab host and is under what a real wallet provider
// costs: an apex-to-www redirect, a `/.well-known` rewrite and a CDN region hop is already three
// before anything unusual happens, and exceeding the cap is a PERMANENT failure here — a `queued`
// row that is never retried. A cap exists to stop a loop, and eight stops a loop just as well.
const MAX_REDIRECTS = 8

// A 4xx is the host saying "this address does not exist here", which no amount of retrying fixes;
// a 5xx or a socket error is the host having a bad minute. They need opposite handling — one is a
// human's problem and one is the next tick's — so the distinction is carried out of here rather
// than flattened into "the fetch failed". A pointer aimed at a private address is permanent too:
// it will resolve there again in six minutes, and a person needs to see it.
class PermanentHttpError extends Error {}

/**
 * Is this address one the seller's watcher must not be pointed at?
 *
 * Fails CLOSED: anything that is not a parseable public address — including a string that is not
 * an address at all — reads as private. This is the whole security decision of item 4 and it is a
 * pure function precisely so it can be tested exhaustively without a network.
 *
 * ponytail: the ranges below are the ones an SSRF actually uses — loopback, RFC1918, link-local
 * (169.254.169.254 is the cloud metadata endpoint), CGNAT, the documentation and benchmark blocks,
 * multicast and reserved — plus IPv6's loopback, unique-local, link-local, multicast, the
 * IPv4-mapped forms, and the well-known NAT64 prefix. Exotic v4-in-v6 tunnelling (6to4 2002::/16,
 * Teredo 2001::/32) is not enumerated; if this ever needs to be airtight, the upgrade is a
 * published CIDR table rather than more branches here.
 */
export const isPrivateAddress = (ip: string): boolean => {
  const version = isIP(ip)
  if (version === 0) return true

  if (version === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number]
    if (a === 0 || a === 10 || a === 127) return true // this-network, RFC1918, loopback
    if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
    if (a === 192 && b === 168) return true // RFC1918
    if (a === 169 && b === 254) return true // link-local, and the cloud metadata endpoint with it
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT, RFC6598
    if (a === 192 && b === 0) return true // IETF protocol assignments and TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
    if (a === 198 && b === 51) return true // TEST-NET-2
    if (a === 203 && b === 0) return true // TEST-NET-3
    return a >= 224 // multicast, reserved, broadcast
  }

  // NORMALISE BEFORE TESTING ANYTHING, because this function used to fail OPEN on the one class it
  // exists to catch. `0::1` and `0:0:0:0:0:0:0:1` are loopback, neither starts with `::`, and
  // `parseInt('0', 16)` is 0, which matches none of the masks below — so both were ALLOWED
  // (measured 2026-08-24, along with `0:0:0:0:0:ffff:10.0.0.1`). The docstring above promised the
  // opposite, which is the worse half: a guard that reads as a guarantee and is not one.
  //
  // WHATWG URL is the platform's own IPv6 canonicaliser and it is already a dependency of nothing —
  // `new URL` is a global. It answers `::1` for every spelling of loopback, and it rewrites the
  // dotted IPv4-mapped forms to hex (`::ffff:127.0.0.1` -> `::ffff:7f00:1`), so the `::` prefix
  // rule below now catches every mapped address including the public ones. That is stricter than
  // before and deliberately so: an IPv4-mapped address in a DNS answer for a wallet host is not a
  // thing that happens legitimately, and this is the direction to be wrong in.
  let s: string
  try {
    s = new URL(`http://[${ip.toLowerCase()}]`).hostname.slice(1, -1)
  } catch {
    return true // it parsed as IPv6 above and will not normalise here: refuse rather than guess
  }
  if (s.startsWith('::')) return true // ::, ::1, every IPv4-mapped form, and the reserved ::/96
  if (s.startsWith('64:ff9b:')) return true // NAT64, which carries an embedded IPv4 address
  const head = Number.parseInt(s.split(':')[0] || 'zz', 16)
  if (!Number.isFinite(head)) return true
  if ((head & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((head & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  return (head & 0xff00) === 0xff00 // ff00::/8 multicast
}

/**
 * Read a response body, giving up MID-STREAM the moment it crosses `max` BYTES.
 *
 * This is the bug in one function. `await res.text()` buffered the whole thing and the bound was
 * consulted on the next line, so a 64 KB limit let a 10 MB answer through — measured, 34 ms, on a
 * host a stranger's payment pointer named. Counting off the stream and destroying the socket makes
 * the limit cost what it says it costs, and it counts bytes rather than the UTF-16 code units
 * `String.length` reports.
 *
 * Exported because it is the only half of `fetchHop` that a test can reach: every address a local
 * listener can bind is one `isPrivateAddress` refuses, which is the vetting working correctly and
 * also the reason there is no way to drive a real oversized body through the whole path.
 */
export const readBounded = (stream: Readable, max: number): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        stream.destroy() // closes the socket, so the host stops sending rather than being ignored
        reject(new Error(`response larger than ${max} bytes`))
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', reject)
  })

type Hop = { location?: string; body: string }

/**
 * One GET, to an address vetted a moment before the socket opens, following nothing.
 *
 * The order is the point: resolve, refuse, then connect to the address that was refused-or-not.
 * `servername` keeps TLS validating against the hostname rather than the literal, and the `Host`
 * header keeps virtual hosting working, so nothing about this is visible to a well-behaved host.
 */
const fetchHop = async (url: string, deadline: number): Promise<Hop> => {
  const u = new URL(url)
  if (u.protocol !== 'https:') throw new PermanentHttpError('not an https URL')
  const hostname = u.hostname.replace(/^\[|\]$/g, '') // a URL keeps an IPv6 literal's brackets

  const literal = isIP(hostname) !== 0
  const addresses = literal ? [hostname] : (await lookup(hostname, { all: true })).map(a => a.address)
  if (addresses.length === 0) throw new PermanentHttpError(`${u.host} does not resolve to anything`)
  // ANY private answer refuses the whole name. A host that resolves to both a public and a private
  // address is a DNS-rebinding attempt, not a host with an unusual DNS setup.
  const bad = addresses.find(isPrivateAddress)
  if (bad) throw new PermanentHttpError(`${u.host} resolves to ${bad}, a private or reserved address`)

  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('out of time before the request was sent')

  return new Promise<Hop>((resolve, reject) => {
    // A WALL-CLOCK DEADLINE. `req.setTimeout` was here and it is an IDLE timeout — `socket.setTimeout`
    // fires after N ms of INACTIVITY, not N ms of elapsed time. Measured 2026-08-24: a host sending
    // one byte every 600 ms held a request whose "deadline" was 1,000 ms open for 24.6 seconds, and
    // the timeout never fired. At one byte per 9.9 s a host stays under both this and MAX_BODY_BYTES
    // for a week.
    //
    // The cost of that is not the refund, it is the watcher. `refundOversells` is awaited inside
    // `tick`, `tick` is wrapped in `inFlightGuard`, and that guard DROPS the polls queued behind it —
    // so one slow host chosen by one buyer stops stock republishing, ladder rungs and sold-out
    // marking for as long as it cares to trickle. That is the oversell this slice exists to refund.
    //
    // `fetch` had this for free: `AbortSignal.timeout` aborts the body read too. Losing it was the
    // real cost of the transport change and it was not visible in the diff.
    let killer: ReturnType<typeof setTimeout> | undefined
    const done = (hop: Hop) => {
      clearTimeout(killer)
      resolve(hop)
    }
    const fail = (err: Error) => {
      clearTimeout(killer)
      reject(err)
    }
    const req = httpsRequest(
      {
        host: addresses[0],
        // SNI cannot carry an IP, and a literal has to be matched by the certificate itself.
        servername: literal ? undefined : hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        // `identity` because we do not decompress. RFC 7231 §5.3.4: a request with NO
        // accept-encoding lets the server use ANY content-coding — absence is not a refusal. `fetch`
        // sent `gzip, deflate` and decompressed transparently; `node:https` does neither, so a host
        // that gzipped would hand JSON.parse a gzip stream. That throws a SyntaxError, which is not
        // a PermanentHttpError, so the row journals `failed` and retries every six minutes forever
        // — a permanent failure wearing a transient label, and no `queued` line to tell the seller.
        headers: { host: u.host, accept: 'application/json', 'accept-encoding': 'identity' },
      },
      res => {
        const status = res.statusCode ?? 0
        const location = typeof res.headers.location === 'string' ? res.headers.location : undefined
        if (status >= 300 && status < 400 && location) {
          res.resume()
          return done({ location, body: '' })
        }
        if (status < 200 || status >= 300) {
          res.resume()
          return fail(status >= 400 && status < 500 ? new PermanentHttpError(`HTTP ${status}`) : new Error(`HTTP ${status}`))
        }
        readBounded(res, MAX_BODY_BYTES).then(body => done({ body }), fail)
      },
    )
    // Subsumes the idle timeout it replaced: this fires at `remaining` ms of elapsed time, which is
    // always at or before the moment an idle timer of the same length could.
    killer = setTimeout(() => req.destroy(new Error('deadline exceeded')), remaining)
    req.on('error', fail)
    req.end()
  })
}

/**
 * GET some JSON, vetting every hop of the redirect chain.
 *
 * ponytail: `hop` is injectable ONLY so the redirect cap can be tested. Every address a local test
 * server can bind is one `isPrivateAddress` correctly refuses, so a loop bound that could run away
 * is otherwise unprovable — and an unbounded loop here hangs the watcher.
 */
export const getJson = async (url: string, hop = fetchHop): Promise<unknown> => {
  const deadline = Date.now() + FETCH_TIMEOUT_MS
  let target = url
  for (let n = 0; ; n++) {
    const res = await hop(target, deadline)
    if (res.location === undefined) return JSON.parse(res.body)
    if (n >= MAX_REDIRECTS) throw new PermanentHttpError(`more than ${MAX_REDIRECTS} redirects`)
    const next = new URL(res.location, target)
    // Re-checked per hop, which is the thing `redirect: 'follow'` made impossible. A 302 to
    // http:// would otherwise downgrade the whole exchange after the first hop looked fine.
    if (next.protocol !== 'https:') throw new PermanentHttpError(`redirected to ${next.protocol}, which is not https`)
    target = next.toString()
  }
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
