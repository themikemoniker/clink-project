// The trust boundary. Everything below arrives from a relay, signed by anyone, shaped however
// the author liked. /CLAUDE.md: verify the signature, bound the sizes, validate before parsing.
// Nothing here is recalled from memory — every tag is cited to a spec line.
//
//   NIP-99  kind 30402 classified listing        nips/99.md
//   NIP-58  image / thumb tag shape              nips/58.md
//   Gamma   kind 30402 extensions, kind 30405    GammaMarkets/market-spec spec.md
//   CLINK   clink_offer tag value (an noffer)    clink-offers.md  (via /docs/clink-notes.md)
import { verifiedSymbol, verifyEvent, type Event } from 'nostr-tools/pure'
import { bech32 } from '@scure/base'
import { decodeNoffer, MIN_PAYABLE_SATS, type Offer } from './offer.ts'

export const LISTING_KIND = 30402 // 99.md:9
export const SALE_KIND = 30405 // Gamma spec.md:213 "Product Collection (Kind: 30405)"

// Bounds, not preferences. A yard sale listing that exceeds any of these is not a yard sale
// listing, and rendering it unbounded is how one hostile event ruins the page for everyone.
const LIMITS = {
  tags: 400,
  content: 8_000,
  title: 200,
  summary: 600,
  location: 200,
  currency: 16,
  photos: 8,
  stock: 999_999,
  url: 2_048,
} as const

// C0/C1 controls, zero-width space, and the bidi overrides used for display spoofing.
// ZWNJ/ZWJ (200C/200D) are deliberately kept — stripping them mangles emoji and Indic text.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

const text = (raw: unknown, max: number): string | undefined => {
  if (typeof raw !== 'string') return undefined
  const clean = raw.replace(UNSAFE_CHARS, '').trim().slice(0, max)
  return clean.length ? clean : undefined
}

// Only https. This is what stops `javascript:` and `data:` reaching an attribute, and a
// gateway serves us over https anyway, so http blobs would be blocked as mixed content.
const url = (raw: unknown): string | undefined => {
  const s = text(raw, LIMITS.url)
  if (!s || !s.startsWith('https://')) return undefined
  try {
    return new URL(s).href
  } catch {
    return undefined
  }
}

const firstTag = (ev: Event, name: string) => ev.tags.find(t => t[0] === name)
const tagValue = (ev: Event, name: string) => firstTag(ev, name)?.[1]
const allTags = (ev: Event, name: string) => ev.tags.filter(t => t[0] === name)

export type Money = { amount: number; currency: string }
export type Photo = { url: string; w?: number; h?: number }

export type Item = {
  id: string
  pubkey: string
  d: string
  created_at: number
  title: string
  summary?: string
  content: string
  price?: Money
  stock?: number // undefined = the seller did not say
  sold: boolean
  images: Photo[] // distinct product photos
  thumbs: Photo[] // smaller renditions; see srcset() for the ambiguity
  location?: string
  offer?: Offer // present only when this item can actually be bought — see buyableOffer()
  // ITEM 17. True only when the listing carried a DECODABLE `clink_offer` whose TLV 4 price
  // disagrees with the `price` tag beside it, which `buyableOffer` refuses on purpose. It is one
  // bit rather than a reason code because exactly one distinction changes what a buyer should do:
  // a price disagreement means the number on the page cannot be trusted, and every other way to
  // have no offer (no tag at all, a corrupt pointer, a sold item) leaves the price tag standing.
  // Grouping those is deliberate; see render.ts `noBuyReason`.
  priceDisagrees?: boolean
}

export type Sale = {
  d: string
  pubkey: string
  title: string
  summary?: string
  location?: string
  // 99.md:53 lists `g` under "Other common tags that might be useful"; Gamma spec.md:213-262
  // carries it on the collection too. ONE tag, at whatever precision the author wrote — see
  // render.ts `geoUri` for what the page does with it and /docs/spike-findings.md §31 for the
  // discovery feature it deliberately is not.
  geo?: string
  itemRefs: string[] // "30402:<pubkey>:<d>" — Gamma spec.md:221
}

// 99.md:38  ["price","<number>","<currency>","<frequency>"?]
// Gamma spec.md:110 agrees on the first three. The two specs disagree on <frequency>'s format
// (NIP-99 wants "day"/"month", Gamma wants ISO 8601 "D"/"M") — we never write it and ignore it
// on read, so the disagreement costs us nothing. Currency is "ISO 4217-like" (99.md:41), which
// in practice means "sats" and "btc" appear in the wild alongside real ISO codes.
const parsePrice = (tag: string[] | undefined): Money | undefined => {
  if (!tag) return undefined
  const amount = Number(tag[1])
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e15) return undefined
  const currency = text(tag[2], LIMITS.currency)
  return currency ? { amount, currency } : undefined
}

// Gamma spec.md:124 `stock`: "Available quantity as integer". This is the standardised name.
// /docs/spec.md §6.1 proposed a custom `quantity` tag; it is not needed and is not written.
const parseStock = (raw: string | undefined): number | undefined => {
  if (raw === undefined || !/^\d{1,7}$/.test(raw)) return undefined
  const n = Number(raw)
  return n <= LIMITS.stock ? n : undefined
}

// 58.md:31 ["image", <url>, "<W>x<H>"?] and 58.md:34 ["thumb", <url>, "<W>x<H>"?].
// Gamma spec.md:135 makes the 3rd element an optional sort order, and says an absent dimension
// "should be respected by using an empty string" — so index 2 may legitimately be "".
const parsePhoto = (tag: string[]): Photo | undefined => {
  const href = url(tag[1])
  if (!href) return undefined
  const dims = /^(\d{1,5})x(\d{1,5})$/.exec(tag[2] ?? '')
  return dims ? { url: href, w: Number(dims[1]), h: Number(dims[2]) } : { url: href }
}

// Gamma spec.md:135 sorts images by an optional 4th element, "from lowest to highest,
// independent of starting value". Missing order sorts last, stably.
const sortOrder = (tag: string[]): number => {
  const n = Number(tag[3])
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
}

const parsePhotos = (ev: Event, name: 'image' | 'thumb'): Photo[] => {
  const out: Photo[] = []
  const seen = new Set<string>()
  const tags = allTags(ev, name)
    .slice(0, LIMITS.photos * 2)
    .sort((a, b) => sortOrder(a) - sortOrder(b))
  for (const tag of tags) {
    const photo = parsePhoto(tag)
    if (!photo || seen.has(photo.url)) continue
    seen.add(photo.url)
    out.push(photo)
    if (out.length >= LIMITS.photos) break
  }
  return out
}

// Whether the page may put a Buy button on this item, and the offer it would pay.
//
// Slice 2 owns the fiat -> sats decision (/docs/spec.md §10) and the answer is: there is no
// conversion. A price oracle is somebody else's server and /CLAUDE.md rule 1 forbids one, so a
// buyable item is priced in sats by its seller, the page displays that number, and the offer is
// minted at that number. Everything else is cash at the table, which is what a yard sale mostly
// is anyway.
//
// The agreement is then *enforced*, not assumed: a fixed-price noffer carries its price in
// TLV 4, so a listing whose tag says one thing and whose offer says another is not buyable at
// all. buy.ts re-checks the same number against the BOLT11 the node actually returns, because
// the tag and the TLV are both authored by the seller and only the invoice takes money.
//
// ITEM 17 splits the refusal in two on the way out. The caller gets the offer when there is one,
// and otherwise one bit saying whether the reason was a price disagreement: the only refusal
// here that makes the DISPLAYED price untrustworthy. Everything else leaves the price tag intact,
// so a buyer can still turn up with cash for the number they read.
const buyableOffer = (
  raw: string | undefined,
  price: Money | undefined,
  sold: boolean,
): { offer?: Offer; priceDisagrees?: boolean } => {
  if (raw === undefined || sold) return {} // §7.4(a): a sold item's offer should not exist
  if (!price || !/^sats?$/i.test(price.currency)) return {}
  if (!Number.isSafeInteger(price.amount) || price.amount < MIN_PAYABLE_SATS) return {}
  const offer = decodeNoffer(raw)
  // A pointer we cannot decode is NOT a price disagreement. We do not know what it says, so we
  // cannot claim the price is wrong. The honest reading is "this page has no way to charge you",
  // which is the same thing an absent tag means.
  if (!offer) return {}
  if (offer.priceSats === undefined || offer.priceSats === price.amount) return { offer }
  return { priceDisagrees: true }
}

const parseItem = (ev: Event): Item | null => {
  const d = text(tagValue(ev, 'd'), 200) // 99.md:64, Gamma spec.md:108 — required
  const title = text(tagValue(ev, 'title'), LIMITS.title) // 99.md:34, Gamma spec.md:109
  if (!d || !title) return null // no identity or no name = not renderable

  const price = parsePrice(firstTag(ev, 'price'))
  const stock = parseStock(tagValue(ev, 'stock'))
  // Two independent ways to be unavailable, and we honour both. 99.md:43 `status` is
  // "active"|"sold" and is what a generic NIP-99 client reads; Gamma spec.md:124 `stock` is a
  // count and is what a marketplace client reads. Gamma has no listing-level `status` at all
  // (its `status` is order state carried in NIP-17 DMs, spec.md:563), so neither subsumes the
  // other. Be lenient on receive: either one saying sold means sold.
  const sold = stock === 0 || tagValue(ev, 'status') === 'sold'

  return {
    id: ev.id,
    pubkey: ev.pubkey,
    d,
    created_at: ev.created_at,
    title,
    summary: text(tagValue(ev, 'summary'), LIMITS.summary), // 99.md:35
    content: text(ev.content, LIMITS.content) ?? '',
    price,
    stock,
    sold,
    images: parsePhotos(ev, 'image'),
    thumbs: parsePhotos(ev, 'thumb'),
    location: text(tagValue(ev, 'location'), LIMITS.location), // 99.md:37
    // Our own tag, documented in /docs/spec.md §6.1. clink-offers.md:58-83 standardises the
    // name `clink_offer` for kind 0 metadata and NIP-05; a listing-level tag is not in any
    // spec, so we reuse the standard name rather than invent a second one.
    ...buyableOffer(text(tagValue(ev, 'clink_offer'), 1_000), price, sold),
  }
}

const parseSale = (ev: Event): Sale | null => {
  const d = text(tagValue(ev, 'd'), 200)
  const title = text(tagValue(ev, 'title'), LIMITS.title)
  if (!d || !title) return null
  return {
    d,
    pubkey: ev.pubkey,
    title,
    summary: text(tagValue(ev, 'summary'), LIMITS.summary),
    location: text(tagValue(ev, 'location'), LIMITS.location),
    // A geohash is at most 12 characters in any use anyone makes of one; the charset is checked
    // in render.ts `geoUri`, which is the only thing that reads this.
    geo: text(tagValue(ev, 'g'), 12),
    // Gamma spec.md:221 ["a","30402:<pubkey>:<d-tag>"]. Bounded, and shape-checked so a
    // malformed coordinate can never be used to build a relay filter.
    itemRefs: allTags(ev, 'a')
      .map(t => text(t[1], 300))
      .filter((a): a is string => !!a && /^30402:[0-9a-f]{64}:.+$/.test(a))
      .slice(0, 500),
  }
}

// NIP-01: for addressable events only the newest (kind, pubkey, d) survives; ties break on the
// lowest event id. Relays hand back older versions all the time — dropping this is how a page
// shows an item as available after the seller marked it sold.
const newestPerAddress = (events: Event[]): Event[] => {
  const best = new Map<string, Event>()
  for (const ev of events) {
    const key = `${ev.kind}:${ev.pubkey}:${tagValue(ev, 'd') ?? ''}`
    const prev = best.get(key)
    const newer =
      !prev ||
      ev.created_at > prev.created_at ||
      (ev.created_at === prev.created_at && ev.id < prev.id)
    if (newer) best.set(key, ev)
  }
  return [...best.values()]
}

// nostr-tools memoises its verdict on the event object under a symbol and returns it without
// rechecking (nostr-tools/lib/esm/index.js:211-212); finalizeEvent sets it to true. Object
// spread copies own symbol properties, so `{...verifiedEvent, content: 'anything'}` verifies
// as true. Events off a relay come through JSON.parse and never carry the symbol, so this is
// belt-and-braces today — but the guard must not depend on how the event reached it.
const verified = (ev: Event): boolean => {
  delete (ev as unknown as Record<symbol, unknown>)[verifiedSymbol]
  return verifyEvent(ev)
}

// The single door every relay event comes through. The signature check lives here rather than
// at the call sites so there is no version of this that forgets it.
const trusted = (events: Event[], pubkey: string, kind: number): Event[] =>
  newestPerAddress(
    events.filter(
      ev =>
        ev.kind === kind &&
        ev.pubkey === pubkey && // a relay will happily send events by anyone
        ev.tags.length <= LIMITS.tags &&
        ev.content.length <= LIMITS.content * 4 &&
        verified(ev), // last: it is the expensive one
    ),
  )

export const parseListings = (events: Event[], pubkey: string): Item[] =>
  trusted(events, pubkey, LISTING_KIND)
    .map(parseItem)
    .filter((i): i is Item => i !== null)

export const parseSales = (events: Event[], pubkey: string): Sale[] =>
  trusted(events, pubkey, SALE_KIND)
    .map(parseSale)
    .filter((s): s is Sale => s !== null)

// Order items the way the sale's collection lists them, then anything the collection omits.
export const orderBySale = (items: Item[], sale: Sale | undefined): Item[] => {
  if (!sale) return items
  const rank = new Map(sale.itemRefs.map((ref, i) => [ref, i]))
  const key = (item: Item) =>
    rank.get(`30402:${item.pubkey}:${item.d}`) ?? Number.MAX_SAFE_INTEGER
  return [...items].sort((a, b) => key(a) - key(b) || a.d.localeCompare(b.d))
}

// srcset source for an item's hero image.
//
// The specs leave one thing genuinely ambiguous: NIP-58 pairs one `image` with its `thumb`s,
// while GammaMarkets allows several `image` tags for several distinct product photos and says
// nothing about which image a `thumb` belongs to. With one image — the common case, and every
// case we author — the pairing is unambiguous. With several we attach thumbs to the first and
// let the rest stand alone, which is the only reading that cannot show the wrong photo.
export const srcset = (
  item: Item,
): { src: string; srcset?: string; aspect: string } | undefined => {
  const hero = item.images[0] ?? item.thumbs[0]
  if (!hero) return undefined
  const widths = new Map(
    [...item.thumbs, ...item.images]
      .filter(p => p.w !== undefined)
      .sort((a, b) => a.w! - b.w!)
      .map(p => [p.w!, p.url] as const),
  )
  const ratio = item.images[0] ?? item.thumbs.find(t => t.w && t.h) ?? hero
  return {
    src: hero.url,
    srcset: widths.size > 1 ? [...widths].map(([w, u]) => `${u} ${w}w`).join(', ') : undefined,
    // An explicit box so nothing reflows as blobs land — design.md §2.4. 4/3 is a fallback for
    // events that omit dimensions, not a claim about the photo.
    aspect: ratio.w && ratio.h ? `${ratio.w} / ${ratio.h}` : '4 / 3',
  }
}

// --- who this page belongs to ---------------------------------------------------------------
//
// Slice 5 deleted the build-time SELLER_PUBKEY. An nsite IS its author: NIP-5A 5A.md:136 makes
// a root site's canonical URL `<npub>.<gateway>`, and 5A.md:156-158 requires a host server to
// "parse the left-most DNS label" and, "if the label is a valid npub, decode it and resolve the
// root site manifest". So the gateway already had to decode our npub to serve us these bytes —
// the page can read the same label back out and skip being compiled per seller entirely.
//
// That makes ONE storefront build serve any seller, which is what lets the builder carry a
// pre-built copy and deploy it (spec §10 slice 5). It is a simplification, not a feature.
//
// This is a trust boundary like the rest of this file, for a reason worth stating: whoever
// controls the hostname controls whose signatures this page will accept. That is exactly right
// — an nsite's authority IS its pubkey, and a gateway serving npub A's bytes under npub B's
// hostname has already broken NIP-5A. But it means the bech32 checksum must be honoured rather
// than the string pattern-matched, or a mistyped label resolves to a plausible wrong pubkey.
export type Seller = { pubkey: string; npub: string }

const NPUB_LABEL = /^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/

const decodeNpub = (label: string): Seller | null => {
  if (!NPUB_LABEL.test(label)) return null
  try {
    const { prefix, words } = bech32.decode(label as `npub1${string}`, 90)
    if (prefix !== 'npub') return null
    const bytes = new Uint8Array(bech32.fromWords(words))
    if (bytes.length !== 32) return null
    return { pubkey: [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''), npub: label }
  } catch {
    return null
  }
}

/**
 * The seller this page is serving, read from where it is being served from.
 *
 * 1. The left-most DNS label, if it is an npub (5A.md:156-158). This is the deployed path and
 *    the only one that exists on a gateway.
 * 2. `?seller=npub1…`, for `npm run dev` on localhost and for anything whose URL is not a
 *    gateway subdomain. Titan's `nsite://` scheme is NOT in NIP-5A at all — UNVERIFIED what
 *    `location.hostname` reads there — so this fallback is also what covers it if the label
 *    turns out not to be an npub.
 *
 * Returns null when neither answers, and the page says so rather than fetching for nobody.
 */
export const sellerFromLocation = (hostname: string, search: string): Seller | null =>
  decodeNpub(hostname.split('.')[0] ?? '') ?? decodeNpub(new URLSearchParams(search).get('seller') ?? '')
