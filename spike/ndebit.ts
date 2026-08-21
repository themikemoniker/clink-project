// CLINK Debits, kind 21002: the only thing in this project that moves money OUT of the seller's
// node. Everything in slices 0-6 either reads, or signs something a human approved.
//
// Wire format is quoted, never remembered: /docs/clink-notes.md §3, which cites
// CLINK/specs/clink-debits.md. Where the running Lightning.Pub 0.0.37 diverges from the spec it
// is noted inline and in /docs/spike-findings.md.
//
// WHY DEBITS AND NOT `PayInvoice`. The native RPC would work — `PayInvoice` is `auth_type =
// "User"` and /spike/pub-rpc.ts already speaks kind 21000 with the seller's key. That is exactly
// the problem. A "User" credential is not read-only (/docs/spike-findings.md §10): the key that
// reads settlements can drain the account. Refunding through it would mean the watcher holds
// unlimited spend authority and our own code is the only thing bounding it.
//
// A Debit grant is narrower in the one way that matters: the cap is enforced by the NODE, inside
// the payment transaction (`assertDebitFrequency`, debitManager.ts:376-401), against a key that
// is not the seller's. A bug here costs at most one interval's cap, and the seller revokes with
// `BanDebit` without touching anything of ours. /CLAUDE.md's "the refund path needs a hard cap
// and a kill switch" is satisfied by the node rather than by us, which is enormously better.
//
// KEY HANDLING NOTICE. This holds a raw private key: /spike/.refund-key, minted by
// authorize-refunds.ts. Same /CLAUDE.md rule-2 exception as the other spike scripts, and the
// narrowest one in the repo — see that file's header for exactly what this key can and cannot do.
// It is NOT the seller's identity and NOT the account owner. Never logged, never published.
import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import { bech32 } from '@scure/base'
import { sha256 } from '@noble/hashes/sha256.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { parseTLV, tlvText } from '../storefront/src/offer.ts'

export const CLINK_DEBIT_KIND = 21002 // clink-debits.md; registry at CLINK/README.md

const RESPONSE_TIMEOUT_MS = 25_000 // a real Lightning payment, not a lookup
const MAX_RESPONSE_BYTES = 16_384
const MAX_NDEBIT = 1_000

// /docs/clink-notes.md §3.1, clink-debits.md:19-22. TLVs: 0 the node service pubkey, 1 the
// relay, 2 an optional opaque pointer ("a specific budget, account, or application"), 3 an
// optional 32-byte session identifier.
//
// TLV 3 is EXACTLY 32 bytes, and this is worth a line because the slice brief said 3. Two
// independent sources agree on 32: clink-notes §3.1 quoting clink-debits.md, and the reference
// encoder, which throws `raw K1 buffer should be 32 bytes` for anything else
// (@shocknet/clink-sdk nip19Extension.js `ndebitEncode`).
export type DebitPointer = {
  pubkey: string // TLV 0 — the node service
  relay: string // TLV 1 — where it listens
  pointer?: string // TLV 2 — which account/budget. Lightning.Pub requires it; see below
  k1?: string // TLV 3 — a session identifier, lowercase hex, 64 chars
}

/**
 * Decode an `ndebit1…` pointer.
 *
 * Third of three CLINK bech32 TLV pointers, and deliberately the third USE of one parser rather
 * than the third copy of it: `parseTLV`/`tlvText` come from storefront/src/offer.ts, which is
 * where the bounds and the never-throw rule are argued. bech32 checksums the whole string, so a
 * pointer that lost a character in a copy-paste decodes to nothing rather than to a plausible
 * wrong node — which on this path would mean paying a refund to a stranger.
 */
export const decodeNdebit = (raw: string): DebitPointer | null => {
  if (typeof raw !== 'string' || raw.length > MAX_NDEBIT) return null
  const text = raw.trim()
  if (!text.startsWith('ndebit1')) return null
  let data: Uint8Array
  try {
    const { prefix, words } = bech32.decode(text as `ndebit1${string}`, MAX_NDEBIT)
    if (prefix !== 'ndebit') return null
    data = new Uint8Array(bech32.fromWords(words))
  } catch {
    return null
  }

  const tlv = parseTLV(data)
  const pubkey = tlv.get(0)
  const relay = tlvText(tlv.get(1), 512)
  const pointer = tlvText(tlv.get(2), 512)
  const k1 = tlv.get(3)
  if (!pubkey || pubkey.length !== 32) return null
  if (!relay || !/^wss:\/\/[^\s]+$/.test(relay)) return null
  // A k1 that is the wrong length is a corrupt pointer, not a pointer without a session. The
  // difference matters: clink-debits.md:167-171 says a wallet MUST set `k1` when TLV 3 is present
  // and MUST NOT invent one when it is absent, so silently dropping a malformed one would turn a
  // single-use pointer into a reusable one.
  if (k1 && k1.length !== 32) return null

  return {
    pubkey: bytesToHex(pubkey),
    relay,
    pointer,
    k1: k1 ? bytesToHex(k1) : undefined,
  }
}

/**
 * The `k1` for a refund, derived from the settled invoice rather than generated.
 *
 * `k1` is CLINK's only single-use construct (/docs/clink-notes.md §7): the service treats each
 * one as single-use within the scope of the pointer, consumes it when it accepts a request for
 * payout, and answers a duplicate with a GFY. Deriving it from the settled invoice — which is
 * this project's idempotency key everywhere else (spec §8) — means a double refund for the same
 * sale is refused by the node instead of by our bookkeeping.
 *
 * THIS IS A SECOND LAYER AND NOT THE ANSWER, and the slice brief asked for this to be verified
 * rather than assumed. Verified 2026-08-21 by reading debitManager.ts:19-37 and :258-262:
 * Lightning.Pub's `K1Debouncer` is an **in-memory array with a 5-minute TTL**, swept once a
 * minute, and the source comment says so outright — "k1 will persist in memory for up to 5
 * minutes before getting cleared". It is not persisted anywhere and a restart loses the whole
 * set. So this closes the crash-loop window — a supervisor restarting the watcher in a tight
 * loop — and nothing longer. The durable answer is the journal in ./refund.ts.
 *
 * Note also that a duplicate `k1` comes back as GFY code **1**, not the code `6` the spec's own
 * example suggests (`k1AlreadyProcessedReason` at debitTypes.ts:98, returned with `code: 1` at
 * debitManager.ts:261). Match on the message, not the code.
 */
export const k1For = (settledInvoice: string): string => bytesToHex(sha256(settledInvoice))

export type DebitOutcome =
  // clink-debits.md:178-217. `preimage` is present for a standard Lightning payment and ABSENT
  // for an internal settlement — and its absence proves nothing either way, because
  // Lightning.Pub omits it on genuinely external payments too (/docs/spike-findings.md §5).
  | { ok: true; preimage?: string }
  // The Debits GFY envelope: `{"res":"GFY",code,error}`, with `range` on code 5 and
  // `retry_after` on code 4. NOT the Offers envelope `{code,error}` with no `res` — one parser
  // for all three CLINK envelopes is a bug (/docs/clink-notes.md §3.5, §2.5).
  | { ok: false; code: number; error: string; range?: { min: number; max: number }; retryAfter?: number }
  // Ours: no answer, or an answer we refuse to trust. Deliberately code 0, which CLINK does not
  // use, so "the node said no" and "we never heard back" can never be confused. On the money
  // path that distinction is the difference between "not paid" and "unknown".
  | { ok: false; code: 0; error: string }

const asText = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : fallback

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * Pay a BOLT11 out of the seller's node, as the refund key, under the node's own cap.
 *
 * `amountSats` is sent alongside the invoice on purpose. The node decodes the BOLT11 itself and
 * answers GFY `5` if the two disagree (`doNdebit`, debitManager.ts:333-336), so this turns our
 * expectation into something the node checks rather than something we assert. It is the same
 * move storefront/src/buy.ts makes in the other direction when it refuses an invoice for an
 * amount the page did not display.
 *
 * clink-debits.md:132-156 — the direct payment request. `pointer` is optional in the spec and
 * required here: `doNdebit` bails with GFY 1 before doing anything when it is missing
 * (debitManager.ts:252-255), because the pointer is how the node resolves which account to
 * debit. `k1` is 64-char lowercase hex (§3.2).
 */
export const payDebit = (
  sk: Uint8Array,
  node: DebitPointer,
  { bolt11, amountSats, k1 }: { bolt11: string; amountSats: number; k1?: string },
): Promise<DebitOutcome> =>
  debitRequest(sk, node, { pointer: node.pointer, bolt11, amount_sats: amountSats, ...(k1 ? { k1 } : {}) })

/**
 * Ask for a standing budget rather than a payment. **This moves no money.**
 *
 * clink-debits.md:132-156 — the budget request: `amount_sats` plus `frequency`, and crucially no
 * `bolt11`. `doNdebit` branches on `frequency` before it looks at any invoice
 * (debitManager.ts:277-306): with no grant it answers `authRequired` and pushes an authorisation
 * prompt to the account owner; with a grant it answers a bare `{"res":"ok"}` and stops.
 *
 * It exists for exactly one caller — ./authorize-refunds.ts — because a pending authorisation
 * request is the ONLY way to create a debit grant on this node, and this is the way to create one
 * without a payment attached to it. See that file's header for the source read behind that.
 */
export const payDebitBudget = (
  sk: Uint8Array,
  node: DebitPointer,
  { amountSats, frequency }: { amountSats: number; frequency: { number: number; unit: 'day' | 'week' | 'month' } },
): Promise<DebitOutcome> =>
  debitRequest(sk, node, { pointer: node.pointer, amount_sats: amountSats, frequency })

// One transport for both request shapes. The difference between "pay this invoice" and "grant me
// a budget" is two fields in a JSON payload; giving each its own copy of the event construction,
// the subscription and the GFY parsing would be three places to fix a bounds check.
const debitRequest = async (
  sk: Uint8Array,
  node: DebitPointer,
  payload: Record<string, unknown>,
): Promise<DebitOutcome> => {
  const pk = getPublicKey(sk)
  const convo = getConversationKey(sk, node.pubkey)

  const request = finalizeEvent(
    {
      kind: CLINK_DEBIT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      // Strict on send: clink-debits.md makes `clink_version` mandatory. Lenient on receive: the
      // node's own response omits it (debitTypes.ts:151-162 tags only `p` and `e`), so its
      // presence signals nothing — same posture as buy.ts and manage.ts.
      tags: [
        ['p', node.pubkey],
        ['clink_version', '1'],
      ],
      content: encrypt(JSON.stringify(payload), convo),
    },
    sk,
  )

  const relays = [node.relay]
  const pool = new SimplePool() // verifies every event's signature before onevent
  let done = false

  return new Promise<DebitOutcome>(resolve => {
    const finish = (outcome: DebitOutcome) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      sub.close()
      pool.close(relays)
      resolve(outcome)
    }

    const onevent = (reply: Event) => {
      if (reply.content.length > MAX_RESPONSE_BYTES) return
      let body: Record<string, unknown>
      try {
        const raw = decrypt(reply.content, convo)
        if (raw.length > MAX_RESPONSE_BYTES) return
        const value = JSON.parse(raw)
        if (!value || typeof value !== 'object' || Array.isArray(value)) return
        body = value as Record<string, unknown>
      } catch {
        return // not for us, or not from a key that shares our conversation
      }

      if (body.res === 'ok') {
        // Never log a preimage (/CLAUDE.md). It is returned so a caller can record that one
        // exists, and spike/refund.ts stores only whether it did.
        finish({ ok: true, preimage: typeof body.preimage === 'string' ? body.preimage : undefined })
        return
      }
      if (body.res === 'GFY' || typeof body.code === 'number') {
        const range = body.range as { min: number; max: number } | undefined
        finish({
          ok: false,
          code: asNumber(body.code) ?? 0,
          error: asText(body.error, 'The node declined the debit.'),
          // clink-notes §3.5: code 5 carries `range`, code 4 carries `retry_after`. Confirmed in
          // the running node: a frequency-cap denial is `ndebitFailure(5, { max: cap })`, which
          // fills in `range: { min: 1, max: cap }` (debitTypes.ts:104-114). So the cap firing is
          // legible as a number rather than only as a message.
          range:
            range && Number.isFinite(range.min) && Number.isFinite(range.max)
              ? { min: range.min, max: range.max }
              : undefined,
          retryAfter: asNumber(body.retry_after),
        })
      }
    }

    // One filter OBJECT, not an array — nostr-tools 2.24.3 (/docs/spike-findings.md §13.9).
    // `#e` pins this to the request we just signed. The node tags its reply `['p', requester],
    // ['e', requestId]` (debitTypes.ts:151-162), and pinning on the event id is what makes the
    // relay's habit of replaying minutes-old CLINK events (§13.1) harmless here.
    const sub = pool.subscribeMany(
      relays,
      { kinds: [CLINK_DEBIT_KIND], authors: [node.pubkey], '#p': [pk], '#e': [request.id] },
      { onevent },
    )

    const deadline = setTimeout(
      () =>
        finish({
          ok: false,
          code: 0,
          error: `No answer from the node in ${RESPONSE_TIMEOUT_MS / 1000}s. THE REFUND MAY OR MAY NOT HAVE BEEN PAID.`,
        }),
      RESPONSE_TIMEOUT_MS,
    )

    Promise.any(pool.publish(relays, request)).catch(() =>
      finish({ ok: false, code: 0, error: `Could not reach ${node.relay}. Nothing was sent.` }),
    )
  })
}
