// Slice 6 — the admin panel's non-DOM half. Read the sale back off the relays, turn a published
// listing into an editable draft, and decide when an item's existing offer can be reused.
//
// WHY THERE IS NO SETTLED-SALES READER IN THIS FILE, and it is an architectural consequence
// rather than a missing feature. Read this before adding one.
//
// CLINK Manage's only resource is `"offer"` and its only actions are create/update/get/list/
// delete (/docs/clink-notes.md §4, quoting clink-manage.md:29 and :33-92). The running node
// agrees exactly — `managementManager.ts:115-134` switches on those five and answers GFY 1 to
// anything else. There is no invoice resource and no settlement resource anywhere in CLINK.
//
// Settled sales live behind `GetUserOfferInvoices`, and `nostrMiddleware.ts:52-80` routes that
// only from an event that is NOT 21001/21002/21003 — i.e. the native kind 21000 RPC. Kind 21000
// is decrypted with Lightning.Pub's own v1 envelope, keyed on sha256 of the raw ECDH
// x-coordinate (`nostrPool.ts:110-113`), and NIP-46 exposes no raw-ECDH method (findings §13.18).
// So a browser holding only a Signer **cannot read the seller's sales**, and building harder
// does not change it. Handing the page a raw node key instead would break /CLAUDE.md rules 2 and
// 3 at once and give it spend authority, because Lightning.Pub has no observer scope
// (findings §10).
//
// What the browser CAN read is the relays, with no credential at all. The watcher republishes
// each item's stock as money arrives, so `units − stock` is how many units have gone. That is
// strictly less than the node knows — no amounts, no timestamps, no payer data — and it is the
// number a seller actually wants at a yard sale. The full version is /spike/sales-report.ts,
// which runs on the machine where the key already is. Findings §13.25.
import type { SimplePool } from 'nostr-tools/pool'
import type { Event } from 'nostr-tools/pure'
import { decodeNoffer } from '../../storefront/src/offer.ts'
import {
  LISTING_KIND,
  SALE_KIND,
  orderBySale,
  parseListings,
  parseSales,
  type Item,
  type Photo,
  type Sale,
} from '../../storefront/src/listing.ts'
import type { Blob, Draft } from './listing.ts'

export type Owned = { item: Item; event: Event }

/**
 * What `loadItems` found: the seller's items, the sale event they belong to if there is one, and
 * **which relays actually contributed** — item 13's quorum bullet, brought into milestone A
 * because it is the same button as item 3 (roadmap-review-findings §13).
 */
export type Loaded = { items: Owned[]; sale: Sale | undefined; answered: string[] }

const SHA256 = /^[0-9a-f]{64}$/
// A relay is hostile input. A yard sale does not have this many items, and an `imeta` tag does
// not have this many fields.
const MAX_ITEMS = 500
const MAX_IMETA_FIELDS = 40
const MAX_FIELD = 400

/**
 * Read every field of an item's `imeta` tag under one key. Repeats matter: `fallback` is
 * "zero or more fallback file sources in case `url` fails" (NIP-94, via listing.ts `imetaTag`),
 * so there is one per mirroring Blossom server.
 *
 * This is the first and only reader `imeta` has ever had — it has been written since slice 4 and
 * consumed nowhere (/docs/known-defects.md). An edit is where it earns its place: dropping the
 * `fallback` list on a save would quietly take a four-server mirror back down to one.
 */
export const imetaValues = (event: Event, key: string): string[] =>
  (event.tags.find(t => t[0] === 'imeta') ?? [])
    .slice(1, MAX_IMETA_FIELDS + 1)
    .filter(field => typeof field === 'string' && field.startsWith(`${key} `))
    .map(field => field.slice(key.length + 1, key.length + 1 + MAX_FIELD))

/**
 * A photo the listing already carries, as the descriptor a re-publish needs.
 *
 * Blossom is content-addressed: `<server>/<sha256>` IS the blob wherever it lives (BUD-01, which
 * listing.ts `imetaTag` already relies on to write `fallback`). So the sha256 comes back out of
 * the URL and an edit keeps the seller's photos without re-uploading a byte — the difference
 * between an edit costing `1 + units` signatures and `1 + units + 3`.
 *
 * ponytail: `type` is fixed at image/jpeg because photos.ts only ever emits jpeg
 * (`convertToBlob({ type: 'image/jpeg' })`). If a second output format appears, read it off the
 * `imeta m` field, which is already written.
 */
export const blobFrom = (photo: Photo): Blob | null => {
  const sha256 = photo.url.split('/').pop()?.split('?')[0]?.split('.')[0]?.toLowerCase()
  if (!sha256 || !SHA256.test(sha256) || !photo.w || !photo.h) return null
  return { url: photo.url, w: photo.w, h: photo.h, sha256, type: 'image/jpeg' }
}

/** The Blossom origin a blob URL points at — `imetaTag` writes `<server>/<sha256>`, so this undoes it. */
const serverOf = (url: string): string => url.slice(0, url.lastIndexOf('/'))

/**
 * A published listing, back as the draft that would republish it.
 *
 * NIP-01 replaces on (kind, pubkey, `d`), so an edit is a publish under the same `d` and nothing
 * else — there is no update verb and no edit event. The whole job here is not to lose anything
 * on the round trip.
 *
 * Returns null for an item this form cannot faithfully republish, and both cases are real:
 *   * A `d` outside this sale's prefix. Republishing it under `listingD(slug)` would address a
 *     DIFFERENT event, leaving the original orphaned on the relays and unowned by any ladder.
 *   * A fiat price. Sats only, everywhere in this project — there is no conversion and no
 *     oracle (/docs/spec.md §6.1) — so republishing `80 MXN` through a sats-only form would
 *     write `80 sats`, a silent 99.99% discount on an item somebody might then buy.
 *
 * `saleD` was the spike fixture's `SALE.d` until slice 9. It is now the seller's own — see
 * ./sale.ts `saleD`, and note that this function is precisely why the sale's `d` is not a form
 * field: change it and every item the seller has stops being editable, in silence.
 */
export const draftFrom = (item: Item, event: Event, saleD: string): Draft | null => {
  const prefix = `${saleD}-`
  if (!item.d.startsWith(prefix)) return null
  const slug = item.d.slice(prefix.length)
  if (!slug) return null
  if (item.price && item.price.currency !== 'sats') return null

  const blobs = [...item.images, ...item.thumbs].flatMap(p => blobFrom(p) ?? [])
  const hero = blobs[0]
  const servers = hero
    ? [...new Set([serverOf(hero.url), ...imetaValues(event, 'fallback').map(serverOf)])].filter(Boolean)
    : []

  return {
    slug,
    title: item.title,
    summary: item.summary ?? '',
    priceSats: item.price?.amount ?? 0,
    // `stock: undefined` means the seller never said, and `status` carries the answer instead
    // (storefront/src/listing.ts) — which for a yard sale means one unit, then gone.
    stock: item.stock ?? (item.sold ? 0 : 1),
    alt: imetaValues(event, 'alt')[0] ?? '',
    blobs,
    servers,
    noffer: event.tags.find(t => t[0] === 'clink_offer')?.[1],
  }
}

/**
 * The offer an edit should carry, or nothing — in which case publish.ts mints a fresh one.
 *
 * Reusing rather than re-minting is load-bearing twice over:
 *   * CLINK Manage `create` is explicitly NOT idempotent — "N identical requests create N
 *     offers" (clink-manage.md:226). A seller fixing a typo three times would otherwise leave
 *     three payable offers on their node, two of them watched by nothing and holding buyers'
 *     stored refund pointers under them.
 *   * The fixture's five offers were minted over the native kind 21000 RPC and carry an empty
 *     `management_pubkey`, so Manage can neither see nor update them (findings §13.20). Reuse is
 *     the only edit path that works at all on the items the live demo runs on.
 *
 * The price is re-derived from the pointer's own TLV 4 rather than taken from the listing: if the
 * seller changed the price, the old offer still charges the old one. Returning nothing there is
 * what makes a price edit mint a new offer instead of publishing a Buy button that lies.
 */
/**
 * Why publishing the sale would destroy something right now, or `undefined` if it would not.
 *
 * A kind 30405 is a REPLACEMENT: `publishSale` sends every member every time, so the member list
 * it is handed IS the sale from that moment on. Two ways that list is wrong, and they are the same
 * button — which is why the 2026-08-23 review moved half of item 13 into milestone A beside item 3
 * (roadmap-review-findings §13):
 *
 *   * **It is empty.** `#publish-sale` was enabled synchronously from `showSigner()` while
 *     `loadPanel()`'s four-relay read was still in flight, and `owned` is `[]` until that
 *     resolves. A click in that window signed a kind 30405 with zero member tags — and NIP-01
 *     replaces on (kind, pubkey, `d`), so it did not replace the sale, it published a SECOND one
 *     with nothing in it and un-listed every item from the new collection.
 *   * **It is short.** One slow relay and the union is missing whatever only that relay held.
 *
 * The gate lives here rather than at the enable site because a guard on the button protects one
 * path and a guard the submit handler consults protects every caller — including the next entry
 * point somebody adds. `#publish-sale`'s disabled state is derived from this same answer, and the
 * reason is shown rather than left to be guessed at: a disabled control with no explanation is its
 * own defect.
 *
 * QUORUM IS A MAJORITY of the configured relays. Not all of them — one permanently unreachable
 * relay would then block a seller forever — and not one, which is the reading that drops items.
 * Item 13's third bullet, refusing to SHRINK a sale, deliberately stays in milestone D: shrinking
 * is also what a legitimate delete looks like, and telling those apart entangles with M3.
 */
export const noPublishSaleReason = (state: {
  signedIn: boolean
  panelLoaded: boolean
  items: number
  answered: number
  relays: number
}): string | undefined => {
  if (!state.signedIn) return 'Connect a signer first.'
  if (!state.panelLoaded) return 'Still reading your items from the relays — publishing now would send an empty sale.'
  if (state.items === 0) {
    return 'No items came back from the relays. Publishing now would replace your sale with an empty one.'
  }
  if (state.answered * 2 <= state.relays) {
    return `Only ${state.answered} of ${state.relays} relays answered, so this list may be short. Press “Reload my items”.`
  }
  return undefined
}

export const reusableOffer = (noffer: string | undefined, priceSats: number): string | undefined => {
  if (!noffer) return undefined
  const decoded = decodeNoffer(noffer)
  return decoded && decoded.priceSats === priceSats ? noffer : undefined
}

/**
 * How many units of an item have sold, from public information alone.
 *
 * `units` comes from the ladder the browser cut at publish time; `stock` is what the watcher has
 * since republished. Unknown for an item this browser never published — the fixture's, most
 * obviously — because nothing on a relay records what the stock started at.
 */
export const soldCount = (units: number | undefined, item: Item): number | undefined => {
  if (units === undefined || !Number.isFinite(units)) return undefined
  const left = item.sold ? 0 : (item.stock ?? units)
  return Math.max(0, Math.min(units, units - left))
}

/**
 * Every item this seller has on the relays, in the sale's own order, each with its raw event —
 * **and the sale itself**, which slice 9 needed and slice 6 threw away.
 *
 * It used to pick the sale with `s.d === SALE.d`, i.e. it only ever recognised the spike
 * fixture's collection. Any seller who was not us had their own kind 30405 fetched, parsed,
 * verified and then discarded, and the panel ordered their items by nothing. Now the first sale
 * this pubkey has published wins: one root site per pubkey (5A.md:16) means one sale per seller
 * in v1, so "the first one" is "the one".
 */
export const loadItems = async (
  pool: SimplePool,
  relays: string[],
  pubkey: string,
): Promise<Loaded> => {
  // WHICH RELAYS ANSWERED, and it has to be measured rather than assumed. `querySync` returns the
  // union and says nothing about where any of it came from, so one relay silently returning
  // nothing is indistinguishable from a seller who owns nothing — and pressing "Publish my sale"
  // on that reading sends a kind 30405 with a short member list, which is a REPLACEMENT and
  // un-lists whatever did not come back.
  //
  // `trackRelays` + `seenOn` is nostr-tools' own answer (both are public on AbstractSimplePool):
  // it records the relay each event arrived from. So "answered" here means "contributed at least
  // one of this seller's events", which is the honest measurement available. It is NOT "sent
  // EOSE" — a relay that connects and times out its EOSE looks the same as an empty one, and
  // nostr-tools reports EOSE only in aggregate (`oneose` fires once, for all of them).
  pool.trackRelays = true
  const events = await pool.querySync(relays, { kinds: [LISTING_KIND, SALE_KIND], authors: [pubkey] })
  const answered = new Set<string>()
  for (const ev of events) for (const relay of pool.seenOn.get(ev.id) ?? []) answered.add(relay.url)

  // parseListings verifies every signature and keeps the newest per address; `item.id` is that
  // winning event's id, so this pairing cannot pick up a superseded version.
  const byId = new Map(events.map(ev => [ev.id, ev]))
  const sale = parseSales(events, pubkey)[0]
  const items = orderBySale(parseListings(events, pubkey), sale)
    .slice(0, MAX_ITEMS)
    .flatMap(item => {
      const event = byId.get(item.id)
      return event ? [{ item, event }] : []
    })
  return { items, sale, answered: [...answered] }
}
