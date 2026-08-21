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
} from '../../storefront/src/listing.ts'
import { SALE } from '../../spike/fixture.ts'
import type { Blob, Draft } from './listing.ts'

export type Owned = { item: Item; event: Event }

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
 */
export const draftFrom = (item: Item, event: Event): Draft | null => {
  const prefix = `${SALE.d}-`
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

/** Every item this seller has on the relays, in the sale's own order, each with its raw event. */
export const loadItems = async (
  pool: SimplePool,
  relays: string[],
  pubkey: string,
): Promise<Owned[]> => {
  const events = await pool.querySync(relays, { kinds: [LISTING_KIND, SALE_KIND], authors: [pubkey] })
  // parseListings verifies every signature and keeps the newest per address; `item.id` is that
  // winning event's id, so this pairing cannot pick up a superseded version.
  const byId = new Map(events.map(ev => [ev.id, ev]))
  const sale = parseSales(events, pubkey).find(s => s.d === SALE.d)
  return orderBySale(parseListings(events, pubkey), sale)
    .slice(0, MAX_ITEMS)
    .flatMap(item => {
      const event = byId.get(item.id)
      return event ? [{ item, event }] : []
    })
}
