// CLINK Manage, kind 21003: mint the item's offer on the seller's own node, from a static page,
// over a relay. No backend on either side, and no private key in this file.
//
// Wire format is quoted, never remembered: /docs/clink-notes.md §4, which cites
// CLINK/specs/clink-manage.md. Where the running Lightning.Pub diverges it is noted inline and
// in /docs/spike-findings.md.
//
// WHY MANAGE AND NOT THE NATIVE RPC. /docs/spec.md §14 framed this as portability versus one
// `AuthorizeManage` prompt. Slice 4 measured it and the framing was wrong on both halves:
//
//   * The native kind 21000 RPC is UNREACHABLE from a NIP-46 signer. Lightning.Pub encrypts
//     21000 with its own v1 envelope — xchacha20 keyed on sha256 of the ECDH x-coordinate
//     (nostrPool.ts:110-114, 176-190) — and NIP-46 exposes no raw-ECDH method, only
//     nip04_*/nip44_*. Kind 21003 takes the `else` branch of that same `if` and is NIP-44 v2,
//     which a bunker does expose. So this is not the portable option, it is the only option.
//   * It costs the seller ZERO prompts, not one. `AuthorizeManage` is `auth_type = "User"`
//     (methods.proto:678-683), so the grant is issued once at the desk by
//     /spike/authorize-manage.ts, and every request after it is just a signed event.
//
// The cost, stated plainly: `createOffer` stamps `management_pubkey: requestorPub`
// (managementManager.ts:249) and `validateOfferAccess` refuses get/update/delete unless it
// matches (:280), while `list` filters on it (offerStorage.ts:43-45). Native `AddUserOffer`
// leaves that column `''`. **The offers /spike/mint-offers.ts already minted are invisible and
// unmanageable over Manage.** The two transports partition the offer set; anything authored
// here is Manage's, and anything the seeder made stays the seeder's.
import { SimplePool } from 'nostr-tools/pool'
import type { Event } from 'nostr-tools/pure'
import { bech32 } from '@scure/base'
import { decodeNoffer, type Offer } from '../../storefront/src/offer.ts'
import type { Signer } from './signer.ts'

export const CLINK_MANAGE_KIND = 21003 // clink-manage.md; registry at CLINK/README.md

// The one payer_data key this project defines. Declared REQUIRED on every offer so the node
// refuses to invoice a payer who supplied no refund pointer — /docs/spec.md §7.3. Imported from
// the fixture rather than redeclared, because the seeder mints offers too and two spellings of
// this string is a sale where half the items cannot be refunded.
export { REFUND_POINTER } from '../../spike/fixture.ts'
import { REFUND_POINTER } from '../../spike/fixture.ts'

const RESPONSE_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 16_384
const MAX_NMANAGE = 1_000

// clink-manage.md:13-16 — nmanage TLVs: 0 wallet server pubkey, 1 relay, 2 optional pointer id.
// Same three-field shape as an noffer minus the pricing TLVs, so the parsing rules are the ones
// storefront/src/offer.ts already argues for: bech32 (checksummed, so a pointer that lost a
// character cannot decode to a plausible pubkey), bounded, and it never throws.
export type ManagePointer = { pubkey: string; relay: string; pointer: string }

export const decodeNmanage = (raw: string): ManagePointer | null => {
  if (typeof raw !== 'string' || raw.length > MAX_NMANAGE || !raw.startsWith('nmanage1')) return null
  let data: Uint8Array
  try {
    const { prefix, words } = bech32.decode(raw.trim() as `nmanage1${string}`, MAX_NMANAGE)
    if (prefix !== 'nmanage') return null
    data = new Uint8Array(bech32.fromWords(words))
  } catch {
    return null
  }

  const tlv = new Map<number, Uint8Array>()
  for (let i = 0; i < data.length; ) {
    const type = data[i]!
    const len = data[i + 1]
    if (len === undefined || i + 2 + len > data.length) return null // truncated = corrupt
    if (!tlv.has(type)) tlv.set(type, data.subarray(i + 2, i + 2 + len)) // first wins
    i += 2 + len
  }

  const pubkey = tlv.get(0)
  const decode = (bytes: Uint8Array | undefined) => {
    if (!bytes || bytes.length === 0 || bytes.length > 512) return undefined
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return undefined
    }
  }
  const relay = decode(tlv.get(1))
  // TLV 2 is optional in the spec (multi-account), and required by this node: every Manage
  // action resolves the account from it (managementManager.ts:232, :186) and answers
  // `code: 1, "No pointer provided"` without it.
  const pointer = decode(tlv.get(2))
  if (!pubkey || pubkey.length !== 32 || !pointer) return null
  if (!relay || !/^wss:\/\/[^\s]+$/.test(relay)) return null

  return { pubkey: [...pubkey].map(b => b.toString(16).padStart(2, '0')).join(''), relay, pointer }
}

// clink-manage.md:94 — the offer object the node returns. `noffer` is the field the listing's
// `clink_offer` tag carries.
export type OfferData = {
  id: string
  label: string
  price_sats: number
  payer_data: string[]
  noffer: string
}

export type ManageOutcome =
  | { ok: true; offer: OfferData; decoded: Offer }
  // clink-manage.md:133-186 — the GFY envelope. Note it is `{"res":"GFY",code,error}`, NOT the
  // Offers envelope `{code,error}` with no `res`: one parser for both is a bug (clink-notes §2.4).
  | { ok: false; code: number; error: string; field?: string }

const asText = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : fallback

/**
 * Mint one purpose-made offer for one item.
 *
 * Never the account's default offer: this always `create`s, and a created offer gets a random
 * 34-byte id (offerStorage.ts:17-24), whereas the default offer's id IS the account pointer
 * (/docs/spec.md §6.1). Publishing that one hands every visitor a channel to push authorization
 * prompts at the seller.
 *
 * `create` is explicitly NOT idempotent — "N identical requests create N offers"
 * (clink-manage.md:226). The caller is responsible for not minting twice for one item; the
 * builder does that by minting only on a first publish and reusing the tag on an edit.
 */
export const createOffer = async (
  signer: Signer,
  node: ManagePointer,
  label: string,
  priceSats: number,
): Promise<ManageOutcome> => {
  const payload = {
    resource: 'offer',
    action: 'create',
    pointer: node.pointer,
    // THE `fields` WRAPPER. clink-manage.md:34-47 shows the offer object inline
    // (`{"offer":{"label":…}}`), but both @shocknet/clink-sdk (`NmanageCreateOffer.offer.fields`)
    // and this node (managementManager.ts:240 reads `nmanageReq.offer.fields`) require it
    // nested. Follow the implementation, not the doc — /docs/spike-findings.md §13.3.
    offer: {
      fields: {
        label: label.slice(0, 200),
        price_sats: priceSats,
        callback_url: '', // deliberately empty; see the note in /spike/watch-sales.ts
        payer_data: [REFUND_POINTER],
      },
    },
  }

  const body = await request(signer, node, payload)
  if (!body) {
    return { ok: false, code: 0, error: `The seller’s node did not answer on ${node.relay}. It may be offline.` }
  }
  if (body.res === 'GFY' || typeof body.code === 'number') {
    return {
      ok: false,
      code: typeof body.code === 'number' ? body.code : 0,
      error: asText(body.error, 'The node declined the request.'),
      field: typeof body.field === 'string' ? body.field.slice(0, 64) : undefined,
    }
  }

  const details = body.details as Partial<OfferData> | undefined
  if (!details || typeof details.noffer !== 'string' || typeof details.id !== 'string') {
    return { ok: false, code: 0, error: 'The node answered without an offer.' }
  }

  // Trust the node's echo of nothing. The listing is about to advertise a price, and the
  // storefront re-checks the same number off the noffer's own TLV 4 before it draws a Buy
  // button — so a disagreement discovered here is a loud failure instead of a silent one.
  const decoded = decodeNoffer(details.noffer)
  if (!decoded) return { ok: false, code: 0, error: 'The node returned an offer pointer we cannot decode.' }
  if (decoded.priceSats !== priceSats) {
    return { ok: false, code: 0, error: `The node minted the offer at ${decoded.priceSats ?? 'no'} sats, not ${priceSats}.` }
  }
  if (decoded.offer === node.pointer) {
    return { ok: false, code: 0, error: 'The node returned the account’s default offer. Refusing to publish it.' }
  }
  if (!details.payer_data?.includes(REFUND_POINTER)) {
    return { ok: false, code: 0, error: `The node did not record ${REFUND_POINTER} as required. An oversell could not be refunded.` }
  }

  return {
    ok: true,
    decoded,
    offer: {
      id: details.id,
      label: details.label ?? label,
      price_sats: decoded.priceSats,
      payer_data: details.payer_data,
      noffer: details.noffer,
    },
  }
}

// One request, one response, correlated by `#e` on the reply. Same transport shape as the
// storefront's kind 21001 client (storefront/src/buy.ts) and as the reference SDK's own
// `newNmanageEvent`/`newNmanageFilter` — which we cannot call, because it takes a raw
// `privateKey` (nmanage.d.ts `SendNmanageRequest`) and we only have a Signer.
const request = async (
  signer: Signer,
  node: ManagePointer,
  payload: unknown,
): Promise<Record<string, unknown> | null> => {
  const event = await signer.signEvent({
    kind: CLINK_MANAGE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    // clink-manage.md:232 — the node enforces a max delta between its clock and `created_at`,
    // answering GFY 3 outside ~30s. A browser with a wrong clock fails here, not silently.
    tags: [
      ['p', node.pubkey],
      ['clink_version', '1'], // strict on send, per the posture in buy.ts
    ],
    content: await signer.nip44Encrypt(node.pubkey, JSON.stringify(payload)),
  })

  const relays = [node.relay]
  const pool = new SimplePool() // verifies every event's signature before onevent
  const me = event.pubkey

  return new Promise(resolve => {
    let done = false
    const finish = (value: Record<string, unknown> | null) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      sub.close()
      pool.close(relays)
      resolve(value)
    }

    const onevent = async (reply: Event) => {
      if (reply.content.length > MAX_RESPONSE_BYTES) return
      try {
        const raw = await signer.nip44Decrypt(node.pubkey, reply.content)
        if (raw.length > MAX_RESPONSE_BYTES) return
        const value = JSON.parse(raw)
        if (value && typeof value === 'object' && !Array.isArray(value)) finish(value)
      } catch {
        // Not for us, or not from a key that shares our conversation. Keep listening.
      }
    }

    // One filter OBJECT, not an array — nostr-tools 2.24.3 (/docs/spike-findings.md §13.9).
    // `#e` pins this to the request we just signed, which is what makes relay.lightning.pub's
    // habit of replaying minutes-old CLINK events (§13.1) harmless: a replayed reply to
    // somebody else's request cannot carry our event id.
    const sub = pool.subscribeMany(
      relays,
      { kinds: [CLINK_MANAGE_KIND], authors: [node.pubkey], '#p': [me], '#e': [event.id] },
      { onevent },
    )

    const deadline = setTimeout(() => finish(null), RESPONSE_TIMEOUT_MS)
    Promise.any(pool.publish(relays, event)).catch(() => finish(null))
  })
}
