// The trust boundary. Everything below arrives from a relay, signed by anyone, shaped however
// the author liked. /CLAUDE.md: verify the signature, bound the sizes, validate before parsing.
// Nothing here is recalled from memory — every tag is cited to a spec line.
//
//   NIP-99  kind 30402 classified listing        nips/99.md
//   NIP-58  image / thumb tag shape              nips/58.md
//   Gamma   kind 30402 extensions, kind 30405    GammaMarkets/market-spec spec.md
import { verifiedSymbol, verifyEvent, type Event } from 'nostr-tools/pure'

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
}

export type Sale = {
  d: string
  pubkey: string
  title: string
  summary?: string
  location?: string
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

const parseItem = (ev: Event): Item | null => {
  const d = text(tagValue(ev, 'd'), 200) // 99.md:64, Gamma spec.md:108 — required
  const title = text(tagValue(ev, 'title'), LIMITS.title) // 99.md:34, Gamma spec.md:109
  if (!d || !title) return null // no identity or no name = not renderable

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
    price: parsePrice(firstTag(ev, 'price')),
    stock,
    sold,
    images: parsePhotos(ev, 'image'),
    thumbs: parsePhotos(ev, 'thumb'),
    location: text(tagValue(ev, 'location'), LIMITS.location), // 99.md:37
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
