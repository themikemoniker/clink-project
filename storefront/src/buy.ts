// The Buy button: a CLINK Offers (kind 21001) invoice request sent from a static page, and the
// invoice that comes back. There is no backend in this file and there is no backend behind it —
// the request goes to the seller's own node over the relay named inside the offer.
//
// Wire format is quoted, never remembered: /docs/clink-notes.md §2.3-§2.6, which cites
// CLINK/specs/clink-offers.md. Where the running Lightning.Pub diverges from the spec it is
// noted inline and in /docs/spike-findings.md.
//
// Posture: STRICT ON SEND, LENIENT ON RECEIVE. We always tag `["clink_version","1"]`
// (clink-offers.md:257 makes it mandatory); we never require it on a response, because
// Lightning.Pub omits it there and rejecting would mean working against no server that exists
// (/docs/spike-findings.md §2).
import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import { decodeNoffer, invoiceSats, PRICE_FIXED, type Offer } from './offer.ts'

export const CLINK_OFFER_KIND = 21001 // clink-offers.md; registry at CLINK/README.md:52-58

// The invoice lifetime is the reservation (/docs/spec.md §8). We ask for it on the request and
// stop listening for the receipt when it lapses.
const INVOICE_TTL_SECONDS = 900

const RESPONSE_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 16_384
const MAX_BOLT11 = 2_000

export type Range = { min: number; max: number }
export type Outcome =
  | { ok: true; bolt11: string; sats: number }
  // A typed decline the page can act on — this is the thing an LNURL QR cannot give you.
  | { ok: false; code: number; error: string; range?: Range; payerData?: string[]; latest?: string }
  | { ok: false; code: 0; error: string } // ours: no answer, or an answer we refuse to trust

type Payload = Record<string, unknown>

// The receipt handler gets the decrypted payload and the event it came in. The page ignores
// both — "it is paid" is all a buyer needs — but /spike/check-buy.ts prints them, because
// whether Lightning.Pub sends a `preimage` and whether it tags `clink_version` on a *receipt*
// are open questions in /docs/spike-findings.md §5 that only a real settlement can answer.
export type OnPaid = (receipt: Payload, event: Event) => void

const parseResponse = (raw: string): Payload | null => {
  if (raw.length > MAX_RESPONSE_BYTES) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : null
  } catch {
    return null
  }
}

const asRange = (value: unknown): Range | undefined => {
  const r = value as Range | undefined
  return r && Number.isFinite(r.min) && Number.isFinite(r.max) ? { min: r.min, max: r.max } : undefined
}

// Lightning.Pub adds a `payer_data` array of the keys it wanted to its `code: 1` error. That
// field is NOT in the Offers spec's error payload (clink-offers.md:176) — it is a Lightning.Pub
// extension (/docs/spike-findings.md §6) and it is the difference between "declined" and
// "declined, and here is the form field you missed".
const asKeys = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every(k => typeof k === 'string') && value.length <= 20
    ? (value as string[]).map(k => k.slice(0, 64))
    : undefined

const asText = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : fallback

let live: { close: () => void } | undefined

/** Drop any open payment subscription. Called when the page navigates away from the item. */
export const closeBuy = () => {
  live?.close()
  live = undefined
}

/**
 * Ask the seller's node for an invoice, then keep listening for the settlement receipt.
 *
 * The receipt (clink-offers.md:307-343) is NIP-44 encrypted to the payer and to nobody else —
 * not the seller, not us. The page holds the ephemeral key it just minted, so the page is the
 * one party that can read it. That is why "did it get paid?" needs no backend and no polling.
 *
 * On error code 3 the response MAY carry `latest`, a replacement pointer, and the client
 * "SHOULD store the new offer and retry automatically" (clink-offers.md:217-219). We retry
 * once — and re-check the replacement's own price against the page, because a forwarding
 * pointer that quietly costs more is exactly the trick the check exists to catch.
 */
export const requestInvoice = async (
  offer: Offer,
  payerData: Record<string, string>,
  expectSats: number,
  description: string,
  onPaid: OnPaid,
): Promise<Outcome> => {
  const first = await attempt(offer, payerData, expectSats, description, onPaid)
  if (first.ok || first.code !== 3) return first

  const latest = typeof first.latest === 'string' ? decodeNoffer(first.latest) : null
  if (!latest || (latest.priceSats !== undefined && latest.priceSats !== expectSats)) return first
  return attempt(latest, payerData, expectSats, description, onPaid)
}

const attempt = async (
  offer: Offer,
  payerData: Record<string, string>,
  expectSats: number,
  description: string,
  onPaid: OnPaid,
): Promise<Outcome> => {
  closeBuy()

  // KEY HANDLING NOTICE — the only key in shipped browser code, and the only /CLAUDE.md rule-2
  // exception outside /spike. Rule 2 says nothing but a Signer touches a private key; this
  // generates one. It is an exception rather than a violation, for three reasons:
  //
  //   * It is not the seller's key and not the buyer's key. It is minted here, used for one
  //     request, and dropped when the page navigates away. It signs nothing else, ever.
  //   * CLINK requires it. The Offers flow is between the payer's key and the service
  //     (clink-offers.md), and the settlement receipt is NIP-44 encrypted to whoever signed the
  //     request (/docs/spike-findings.md §5). A Signer cannot stand in: the buyer has no signer,
  //     and asking them to install one to buy a 1,000-sat mug is the sale not happening.
  //   * A fresh one per purchase is the privacy posture, not an accident. Reusing a key would
  //     let the node — and the relay — link one buyer's purchases to each other.
  //
  // It never leaves this function, is never persisted, and is never logged. Grep `KEY HANDLING`
  // to audit rule 2 and this file is meant to come back with the spike scripts.
  // THIS FUNCTION RESOLVES; IT DOES NOT REJECT. Every network and protocol path below already
  // honours that — one `finish()` per branch plus a deadline — and until 2026-08-24 the six lines
  // that follow did not, which is the whole of the panel's `render.ts:521` claim.
  //
  // `decodeNoffer` checks TLV 0 is 32 bytes and nothing more, so a `clink_offer` carrying 32 bytes
  // that are not a point on secp256k1 parses fine and then throws SYNCHRONOUSLY inside
  // `getConversationKey`. That is a malformed offer in the SELLER's own listing, not a dead relay,
  // which is why no amount of network testing found it.
  //
  // GREPPED BEFORE FIXING, and the Buy form is not the only caller. `spike/refund.ts`
  // `resolvePointer` awaits `requestInvoice` for the noffer branch OUTSIDE its try/catch, so the
  // same throw came out of `refundOversells` and killed the watcher's tick — every tick, for as
  // long as that oversell existed, refunding nothing and journalling nothing. The refund pointer
  // is a string a stranger typed, so producing one is free. Fixing it at the call sites would have
  // meant fixing it at two and missing that one.
  let sk: Uint8Array
  let pk: string
  let convo: Uint8Array
  let request: Event
  try {
    sk = generateSecretKey()
    pk = getPublicKey(sk)
    convo = getConversationKey(sk, offer.pubkey)

    const payload: Payload = {
      offer: offer.offer, // noffer TLV 2
      payer_data: payerData, // clink-offers.md:136 — an object on the request
      expires_in_seconds: INVOICE_TTL_SECONDS,
      description: description.slice(0, 100), // clink-offers.md:141 — max 100 chars, node enforces
    }
    // "Required for spontaneous/variable, optional otherwise" (clink-offers.md:134). A fixed-price
    // offer is priced by the node; sending our own number there would only invite disagreement.
    if (offer.priceType !== PRICE_FIXED) payload.amount_sats = expectSats

    request = finalizeEvent(
      {
        kind: CLINK_OFFER_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', offer.pubkey],
          ['clink_version', '1'],
        ],
        content: encrypt(JSON.stringify(payload), convo),
      },
      sk,
    )
  } catch {
    // Named as the seller's problem, because it is: nothing the buyer typed can cause it and
    // nothing they can do will fix it. The error carries no detail from the exception — it would
    // be a curve-arithmetic message, and it is not addressed to this reader.
    return {
      ok: false,
      code: 0,
      error: 'This item’s payment pointer is unusable, so no request could be built. Nothing was sent. Tell the seller.',
    }
  }

  const relays = [offer.relay]
  const pool = new SimplePool() // verifies every event's signature before onevent — pool.js:1132
  let settled = false

  return new Promise<Outcome>(resolve => {
    const finish = (outcome: Outcome) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      // On failure nothing more can arrive; on success the receipt still might, so the
      // subscription outlives this promise and closeBuy() is what ends it.
      if (!outcome.ok) close()
      resolve(outcome)
    }

    const close = () => {
      clearTimeout(receiptWindow)
      sub.close()
      pool.close(relays)
      if (live === handle) live = undefined
    }
    const handle = { close }
    live = handle

    const onevent = (event: Event) => {
      const body = (() => {
        try {
          return event.content.length > MAX_RESPONSE_BYTES ? null : parseResponse(decrypt(event.content, convo))
        } catch {
          return null // not for us, or not from a key that shares our conversation
        }
      })()
      if (!body) return

      // The receipt: `{"res":"ok"}`, or `{"res":"ok","preimage":…}` per clink-offers.md:327-333.
      // Lightning.Pub never sends the preimage (/docs/spike-findings.md §5), so its absence
      // proves nothing and we do not require it.
      if (body.res === 'ok') {
        close()
        onPaid(body, event)
        return
      }

      if (typeof body.bolt11 === 'string' && body.bolt11.length <= MAX_BOLT11) {
        const bolt11 = body.bolt11.trim()
        const sats = invoiceSats(bolt11)
        // The one check that makes the price on the page mean something. An invoice for an
        // amount we did not advertise — or one with no amount at all, which any wallet would
        // happily let the buyer overpay — is refused rather than displayed.
        if (sats !== expectSats) {
          finish({
            ok: false,
            code: 0,
            error: `The node offered an invoice for ${sats === null ? 'an unspecified amount' : `${sats.toLocaleString()} sats`}, not the ${expectSats.toLocaleString()} sats listed. Nothing was paid.`,
          })
          return
        }
        finish({ ok: true, bolt11, sats })
        return
      }

      if (typeof body.code === 'number') {
        // The Offers error envelope is `{code, error}` with NO `res` field. Debits and Manage
        // use `{"res":"GFY",…}` — one parser for all three would be a bug (clink-notes §2.4).
        finish({
          ok: false,
          code: body.code,
          error: asText(body.error, 'The seller’s node declined the request.'),
          range: asRange(body.range),
          payerData: asKeys(body.payer_data),
          // clink-offers.md:212-235 — a forwarding pointer, present on code 3 only.
          latest: typeof body.latest === 'string' ? body.latest.slice(0, 1_000) : undefined,
        })
      }
    }

    // One filter OBJECT, not an array — nostr-tools 2.24.3 (/docs/spike-findings.md §13.9).
    // `#e` pins this to the request we just signed, which is also what makes the relay's habit
    // of replaying minutes-old kind 21001 events (§13.1) harmless here: a replayed response to
    // somebody else's request cannot carry our event id.
    const sub = pool.subscribeMany(
      relays,
      { kinds: [CLINK_OFFER_KIND], authors: [offer.pubkey], '#p': [pk], '#e': [request.id] },
      { onevent },
    )

    const receiptWindow = setTimeout(close, INVOICE_TTL_SECONDS * 1_000)
    const deadline = setTimeout(
      () =>
        finish({
          ok: false,
          code: 0,
          error: 'The seller’s node did not answer. It may be offline — this is a payment to a person’s own computer, not to a company.',
        }),
      RESPONSE_TIMEOUT_MS,
    )

    Promise.any(pool.publish(relays, request)).catch(() =>
      finish({ ok: false, code: 0, error: `Could not reach the seller’s relay (${offer.relay}).` }),
    )
  })
}
