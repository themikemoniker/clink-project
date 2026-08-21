// The sale itself — kind 30405, the masthead, the thing every item points at.
//
// SLICE 9, AND IT IS THE SLICE. /docs/spec.md §10 calls this "masthead editing", which undersells
// it by a lot. Until now `builder/src/listing.ts` imported `SALE` from `/spike/fixture.ts` and
// stamped it on every item anybody authored:
//
//   d          prefixed `yardsale-2026-08-`
//   location   `Colonia Americana, Guadalajara`
//   g          `9ewmr4z`  (and see fixture.ts — that value was 5.9 km wrong for eight slices)
//   a          `30405:<their own pubkey>:yardsale-2026-08`
//
// Two consequences, and the second is worse. A seller in Oaxaca published items tagged with a
// Guadalajara geohash and neighbourhood, signed by their own key, permanently, on four public
// relays. And the `a` tag pointed at a kind 30405 **that nothing in the builder ever published** —
// grep `30405` and the only writer was `/spike/seed-listings.ts`. So the builder signed items
// into a collection that did not exist for any seller but us, and `spike/check-deploy.ts` printed
// `(no kind 30405 — the page falls back to its own name)` for exactly that case, which reads like
// a graceful fallback rather than the missing feature it was.
//
// So: the builder AUTHORS the sale. It does not borrow one. `/spike/*` keeps its fixture — those
// scripts are the fixture — and nothing under `/builder` imports it any more.
//
// Cited, nothing recalled:
//   Gamma   kind 30405 Product Collection, required d/title, `a` members    GammaMarkets spec.md:213-262
//   NIP-99  `g` is "a geohash for more precise location"                    nips/99.md:53
//   NIP-01  addressable events replace on (kind, pubkey, d)                 nips/01.md
import type { EventTemplate } from 'nostr-tools/pure'
import type { Sale } from '../../storefront/src/listing.ts'

export const SALE_KIND = 30405 // Gamma spec.md:213 "Product Collection (Kind: 30405)"

export type SaleDraft = {
  /** The collection's `d`. NOT a form field — see `saleD` below for why. */
  d: string
  title: string
  /** Where the date and the opening hours live. No NIP has a field for them — findings §13.12. */
  summary: string
  location: string
  /** Geohash, or '' for a sale that does not publish one. */
  g: string
}

/**
 * A first-time seller's sale.
 *
 * `d` is a constant rather than a date, and that is deliberate. It addresses the collection
 * forever (NIP-01 replaces on (kind, pubkey, d)), it is already unique per seller because the
 * pubkey is in the coordinate, and a date in it goes stale the moment the seller runs a second
 * sale — at which point changing it would orphan every item's `a` tag AND every item's `d`
 * prefix at once.
 */
export const DEFAULT_SALE: SaleDraft = {
  d: 'sale',
  title: 'Yard sale',
  summary: 'Saturday, 8am–2pm. Cash, or Lightning.',
  location: '',
  g: '',
}

/**
 * Which `d` this browser should author under: the one already on the relays, or the default.
 *
 * THE SALE `d` IS NOT AN INPUT, and refusing to make it one is the whole safety story here.
 * `/docs/known-defects.md` already records that an item whose `d` falls outside the sale's prefix
 * cannot be edited in the admin panel (`admin.ts` `draftFrom`). The sale's `d` is that prefix. A
 * text field for it is therefore a field that, mistyped once, silently orphans every item the
 * seller has ever published: the `a` tags point at a collection that no longer exists, and every
 * existing item drops out of the edit form.
 *
 * Reading it back off the relays instead costs nothing — the panel already fetches kind 30405 in
 * the same query as the listings — and it means the live fixture sale (`yardsale-2026-08`) keeps
 * its prefix without anybody typing it.
 */
export const saleD = (published: Sale | undefined): string => published?.d ?? DEFAULT_SALE.d

/** An item's `d`: the sale's own, then the slug. `yardsale-2026-08-mugs`, `sale-brass-lamp`. */
export const listingD = (saleD: string, slug: string) => `${saleD}-${slug}`

/**
 * A published sale, back as the form that would republish it.
 *
 * Same contract as `admin.ts` `draftFrom` and for the same reason: an edit is a replacement (there
 * is no update verb in NIP-01), so anything not read back here is silently dropped on Save.
 */
export const draftFromSale = (published: Sale | undefined): SaleDraft =>
  published
    ? {
        d: published.d,
        title: published.title,
        summary: published.summary ?? '',
        location: published.location ?? '',
        g: published.geo ?? '',
      }
    : { ...DEFAULT_SALE }

// Geohash base32 (Niemeyer). No a, i, l or o — which is why those four are the characters a typo
// produces, and why this rejects rather than repairs. Same alphabet as storefront/src/render.ts
// `geoUri`, which is the only thing that reads what we write.
const GEO32 = '0123456789bcdefghjkmnpqrstuvwxyz'

/**
 * A geohash the seller typed, or '' if it is not one.
 *
 * Uppercase is accepted and folded, because a geohash copied out of a map tool often arrives that
 * way and the encoding is case-insensitive. Everything else is refused: a `g` tag containing a
 * non-geohash is worse than no `g` tag, because `geoUri` would either drop it (best case) or a
 * less careful client would put a pin in the sea.
 */
export const normaliseGeohash = (raw: string): string => {
  const s = raw.trim().toLowerCase()
  return /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/.test(s) ? s : ''
}

/**
 * Latitude/longitude to a geohash, so the seller can press a button instead of knowing what a
 * geohash is.
 *
 * The coordinates come from `navigator.geolocation`, which is a native browser API and therefore
 * the only "find me on a map" that does not involve somebody's server — /CLAUDE.md rule 1. There
 * is no geocoder here and there will not be one: turning "Colonia Americana" into coordinates is
 * an HTTP call to a third party, which is exactly the dependency spec §10's map line died on
 * (findings §31).
 *
 * 7 characters is ±76 m, which is a driveway. More would publish which house.
 */
export const geohashOf = (lat: number, lon: number, precision = 7): string => {
  const la: [number, number] = [-90, 90]
  const lo: [number, number] = [-180, 180]
  let evenBit = true
  let bits = 0
  let ch = 0
  let out = ''
  while (out.length < precision) {
    const box = evenBit ? lo : la
    const mid = (box[0] + box[1]) / 2
    const high = (evenBit ? lon : lat) > mid
    ch = (ch << 1) | (high ? 1 : 0)
    box[high ? 0 : 1] = mid
    evenBit = !evenBit
    if (++bits === 5) {
      out += GEO32[ch]
      bits = 0
      ch = 0
    }
  }
  return out
}

/**
 * The collection's tags.
 *
 * `itemDs` is every item this seller has in this sale, in the order the panel already has them.
 * Gamma spec.md:221 makes each member an `["a","30402:<pubkey>:<d-tag>"]`, and spec.md:213-236
 * makes the order meaningful — `storefront/src/listing.ts` `orderBySale` renders members in order
 * and strays after, which is what lets a newly authored item appear at the foot of the sale
 * without re-signing this event on every publish.
 *
 * `location`, `g` and `summary` are all optional on the collection, so an empty one writes no tag
 * rather than an empty one. An empty `g` in particular would be a coordinate at the equator for
 * anything that decoded it without checking.
 */
export const saleTags = (sale: SaleDraft, pubkey: string, itemDs: string[]): string[][] => [
  ['d', sale.d],
  ['title', sale.title],
  ...(sale.summary ? [['summary', sale.summary]] : []),
  ...(sale.location ? [['location', sale.location]] : []),
  ...(sale.g ? [['g', sale.g]] : []),
  ...itemDs.map(d => ['a', `30402:${pubkey}:${d}`]),
]

export const saleTemplate = (
  sale: SaleDraft,
  pubkey: string,
  itemDs: string[],
  now: number,
): EventTemplate => ({
  kind: SALE_KIND,
  created_at: now,
  tags: saleTags(sale, pubkey, itemDs),
  // The storefront reads the masthead's second line from the `summary` TAG; the content is here
  // so a generic NIP-51-shaped client that only renders content still shows something.
  content: sale.summary,
})
