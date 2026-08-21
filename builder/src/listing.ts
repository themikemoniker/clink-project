// What a published item actually is: a kind 30402's tags, plus every future stock state of it
// pre-signed. Pure functions, no signer, no network — so this is the file with the test.
//
// Every tag is cited to a spec line and nothing is recalled from memory:
//   NIP-99  kind 30402, price/status                 nips/99.md
//   NIP-58  image / thumb                            nips/58.md
//   NIP-92  imeta                                    nips/92.md
//   NIP-94  the field names imeta inherits           nips/94.md
//   Gamma   stock / type / collection membership     GammaMarkets/market-spec spec.md
//   CLINK   clink_offer tag value (an noffer)        clink-offers.md (via /docs/clink-notes.md)
import type { EventTemplate } from 'nostr-tools/pure'
import { atStock, unitsOf } from '../../spike/ladder.ts'
import { SALE } from '../../spike/fixture.ts'

/** One photo, at one width, already on Blossom. */
export type Blob = { url: string; w: number; h: number; sha256: string; type: string }

export type Draft = {
  slug: string // becomes the `d` tag, prefixed with the sale
  title: string
  summary: string
  priceSats: number
  stock: number
  alt: string // NIP-94 `alt`, "description for accessibility"
  noffer?: string // present once the offer is minted
  blobs: Blob[] // widest first is not assumed; sorted here
  servers: string[] // every Blossom server that stored a complete copy
}

export const listingD = (slug: string) => `${SALE.d}-${slug}`

// A slug is a `d` tag, which addresses the event forever: NIP-01 replaces on (kind, pubkey, d).
// Two items that normalise to the same slug are one item, silently, with the second overwriting
// the first — so this is bounded and checked rather than trusted from a form field.
export const normaliseSlug = (raw: string): string =>
  raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks, so "lámpara" and "lampara" collide
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

/**
 * The `imeta` tag — slice 1 deferred "the image placeholder tag" to here, and this is the
 * answer with the citation it asked for.
 *
 * NIP-92 (`nips/92.md`) is the only place a blurhash lives in nostr: `imeta` is variadic
 * space-delimited key/value pairs, MUST carry `url` and at least one other field, and MAY
 * include any field from NIP-94 — whose list (`nips/94.md`) is where `blurhash`, `dim`, `x`,
 * `m`, `alt` and `fallback` are actually defined. Neither NIP-99 nor the GammaMarkets
 * market-spec carries any of them, which is what slice 1 found.
 *
 * WE DO NOT WRITE `blurhash`, deliberately. It would need an encoder here and a decoder in the
 * storefront, whose whole budget is ~30 KB gzip, to replace a flat-tone placeholder that
 * already works (slice 1, design.md §2.5). The field name and its citation are now pinned, so
 * shipping one later is an hour's work rather than a research task. What we DO write earns its
 * place immediately:
 *   `x`        the blob's sha256 — a content address the storefront can check a fetch against,
 *              which is the generalised lesson of findings §13.11 ("a 200 is not evidence")
 *   `dim`      the same aspect-ratio box the srcset already needs, on the tag that defines it
 *   `alt`      accessibility, and no other tag in NIP-99 or Gamma has anywhere to put it
 *   `fallback` "zero or more fallback file sources in case `url` fails" — the standard answer
 *              to blobs living on exactly one server (findings §9), free the moment a second
 *              Blossom server exists
 *
 * One honest caveat: 92.md says each `imeta` SHOULD match a URL in the event's *content*, and
 * ours match `image` tags instead. A generic NIP-92 client will not look here. It is still the
 * right tag — inventing a second one to carry a blurhash is precisely what /docs/spec.md §14
 * warns against — and the fields above are for our own storefront to read.
 */
export const imetaTag = (hero: Blob, servers: string[], alt: string): string[] => [
  'imeta',
  `url ${hero.url}`,
  `m ${hero.type}`, // 94.md: MIME type, lowercase
  `x ${hero.sha256}`, // 94.md: "SHA-256 hexencoded string of the file"
  `dim ${hero.w}x${hero.h}`, // 94.md: "<width>x<height>"
  ...(alt ? [`alt ${alt}`] : []),
  // Same blob, other servers. Blossom is content-addressed, so <server>/<sha256> is the blob
  // wherever it lives — BUD-01. The hero's own server is already in `url`.
  ...servers.filter(s => !hero.url.startsWith(s)).map(s => `fallback ${s}/${hero.sha256}`),
]

/**
 * The listing's tags, in the shape /spike/seed-listings.ts publishes today — deliberately, so
 * the storefront's parser, the flyer and the availability ladder all keep working unchanged.
 * The two differences are `imeta` (above) and that the offer arrives from CLINK Manage.
 */
export const listingTags = (draft: Draft, pubkey: string, now: number): string[][] => {
  // Widest first: the storefront pairs the largest `image` with smaller `thumb`s and builds a
  // srcset from the set (storefront/src/listing.ts `srcset`).
  const photos = [...draft.blobs].sort((a, b) => b.w - a.w)
  const [hero, ...thumbs] = photos

  return [
    ['d', listingD(draft.slug)],
    ['title', draft.title],
    // 99.md:38 ["price","<number>","<currency>","<frequency>"?]. We never write frequency.
    // Always sats: there is no fiat conversion anywhere in this project, because a conversion
    // needs a price oracle and an oracle is somebody else's server (/docs/spec.md §6.1).
    ['price', String(draft.priceSats), 'sats'],
    ['published_at', String(now)],
    // Gamma spec.md:119-121 — the default is *digital*, and a yard sale is emphatically not.
    ['type', 'simple', 'physical'],
    ...(draft.summary ? [['summary', draft.summary]] : []),
    // Gamma spec.md:124 — "Available quantity as integer". The standardised name; not `quantity`.
    ['stock', String(draft.stock)],
    // 99.md:43 — kept beside `stock` because a generic NIP-99 client reads this one and knows
    // nothing about GammaMarkets. Neither subsumes the other.
    ['status', draft.stock === 0 ? 'sold' : 'active'],
    ['location', SALE.location],
    ['g', SALE.g], // geohash, 99.md:53
    ['t', 'yardsale'],
    // Gamma spec.md:148 — products point at their collection for discoverability. The
    // collection is NOT re-signed here: storefront/src/listing.ts `orderBySale` renders
    // collection members in order and strays after, so a newly authored item appears at the
    // foot of the sale without costing a second signature. Slice 6 owns reordering.
    ['a', `30405:${pubkey}:${SALE.d}`],
    // Our own tag (/docs/spec.md §6.1) reusing CLINK's own kind-0/NIP-05 field name
    // (clink-offers.md:58-83) rather than inventing a second one. Purpose-made per item.
    ...(draft.noffer ? [['clink_offer', draft.noffer]] : []),
    ...(hero
      ? [
          // NIP-58 58.md:31 ["image", url, "WxH"]
          ['image', hero.url, `${hero.w}x${hero.h}`],
          // NIP-58 58.md:34 — one or more `thumb`s. The standard multi-width srcset source.
          ...thumbs.map(t => ['thumb', t.url, `${t.w}x${t.h}`]),
          imetaTag(hero, draft.servers, draft.alt),
        ]
      : []),
  ]
}

/**
 * Every event a publish has to sign, in order, INCLUDING the ladder.
 *
 * This is the number /docs/spec.md §5's signature budget did not have: an item is not one
 * signature, it is **1 + units**. The listing, then one pre-signed kind 30402 per reachable
 * stock state, so the watcher can publish availability while holding no key at all
 * (/spike/ladder.ts, /docs/spec.md §7.2). Same kind throughout, so a remembered
 * `sign_event:30402` grant covers all of them (findings §8) — but the UI must never imply
 * one item means one approval.
 *
 * `created_at` strictly increases as stock falls. That is load-bearing, not cosmetic: NIP-01
 * keeps only the newest event per (kind, pubkey, d), so a rung published out of order or
 * replayed is a no-op at the relay. Availability cannot run backwards by construction.
 */
export const eventsToSign = (draft: Draft, pubkey: string, now: number): EventTemplate[] => {
  const tags = listingTags(draft, pubkey, now)
  const content = draft.summary
  const units = unitsOf(String(draft.stock))
  return [
    { kind: 30402, created_at: now, tags, content },
    ...Array.from({ length: units }, (_, i) => ({
      kind: 30402,
      created_at: now + i + 1,
      // atStock also drops `clink_offer` at stock 0, so a sold listing is not still advertising
      // a payable pointer to a page that cached it.
      tags: atStock(tags, units - i - 1),
      content,
    })),
  ]
}

/** How many signer approvals a publish will actually ask for. Shown before the seller starts. */
export const approvalCount = (draft: Draft, mintOffer: boolean): number =>
  draft.blobs.length + // one kind 24242 per blob — NEVER batch them (findings §9)
  (mintOffer ? 1 : 0) + // the kind 21003 CLINK Manage create
  1 + // the listing
  unitsOf(String(draft.stock)) // the ladder
