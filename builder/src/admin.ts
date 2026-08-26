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
  isSats,
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
 *   * A currency this form cannot carry: anything `fiatCurrency` refuses, which is a `price` tag
 *     whose currency is not 1–12 plain letters. No tool of ours writes one and a relay can still
 *     hand us one, and republishing it would change what the listing says.
 *
 * A FIAT PRICE IS NO LONGER ONE OF THEM (M3), and read the body, because this docblock said the
 * opposite for one slice after the code stopped agreeing. It used to refuse every non-sats
 * currency outright, on the reasoning that a sats-only form would republish `80 MXN` as `80 sats`
 * and hand somebody a 99.99% discount. That reasoning was right about the danger and wrong that
 * refusing forever was the only way out: the price and the currency are carried through, no
 * offer is minted, and the item stays exactly as unpayable as it was.
 *
 * `saleD` was the spike fixture's `SALE.d` until slice 9. It is now the seller's own — see
 * ./sale.ts `saleD`, and note that this function is precisely why the sale's `d` is not a form
 * field: change it and every item the seller has stops being editable, in silence.
 */
// Re-exported so main.ts asks ONE module about currency. admin.ts is already the seam between
// the builder and the storefront's parser; a second import path to the same predicate is how two
// of them drift apart, which is the defect M3 found in the first place.
export { isSats } from '../../storefront/src/listing.ts'

/**
 * A currency this form may carry through, or null.
 *
 * THE ONE THING THAT MUST NOT HAPPEN is a "fiat" price that is really sats. `listingTags` writes
 * `draft.fiat` straight into the `price` tag, and `publish.ts` mints nothing for a fiat draft — so
 * a currency that the storefront reads as sats would produce a listing priced N sats with no
 * offer, which is merely broken, and one round-trip later a seller could put an offer behind a
 * number that was never sats. Refusing every spelling of sats here is what keeps the two paths
 * from ever meeting. `isSats` is the storefront's own predicate, imported rather than restated.
 *
 * Otherwise: ISO 4217 is three letters, but 99.md:41 says "ISO 4217-like" and the wild is wider
 * than that, so this bounds rather than enumerates. Letters only, 1–12 of them — enough for
 * anything real, and short enough that a relay cannot hand the form a paragraph.
 */
export const fiatCurrency = (raw: string | undefined): string | null => {
  const code = (raw ?? '').trim()
  if (!/^[A-Za-z]{1,12}$/.test(code)) return null
  return isSats(code) ? null : code
}

/**
 * Why this fiat amount cannot be published, in the seller's terms, or `undefined` if it can.
 *
 * HERE RATHER THAN INLINE IN `main.ts` FOR THE REASON `noPublishSaleReason` IS: a check written
 * into the submit handler is a check with no test on it, and this one was wrong for a slice
 * without anything noticing. The first pass at M3 validated a fiat amount with
 * `Number.isSafeInteger`, which is the SATS rule wearing the fiat field's label. A sat is whole
 * by definition. 12.50 USD and 80.50 MXN are ordinary prices, `parsePrice` in
 * storefront/src/listing.ts has always read them, and `records` at 80 MXN only slipped through
 * because it happens to be round. Every fractional listing in the wild was editable and then
 * unpublishable, and the one way out the form offered was to change what the item costs.
 *
 * THE BOUND IS `parsePrice`'S BOUND, deliberately: a price this form accepts has to be a price
 * the page can read back, and the storefront refuses anything non-finite, negative, or over 1e15.
 * `String(amount)` is what reaches the tag and `Number()` is what reads it, and those round-trip
 * to the same value for everything in range, exponent notation included.
 *
 * Zero is legal and is not an oversight: `boxes` is `["price","0","MXN"]` on the live sale, and
 * the storefront draws it as "Free". What must not reach here is a BLANK field, which reads as
 * `Number('')` and is also 0: that is caught in the markup by `required` on `#price-fiat-amount`,
 * because the difference between "this is free" and "I cleared the box" is not visible from the
 * number and is not this function's to guess.
 */
export const fiatPriceReason = (amount: number, currency: string): string | undefined =>
  Number.isFinite(amount) && amount >= 0 && amount <= 1e15
    ? undefined
    : `Give a price in ${currency}, as a number, at or above zero.`

export const draftFrom = (item: Item, event: Event, saleD: string): Draft | null => {
  const prefix = `${saleD}-`
  if (!item.d.startsWith(prefix)) return null
  const slug = item.d.slice(prefix.length)
  if (!slug) return null
  // M3. This used to be `if (item.price && item.price.currency !== 'sats') return null`, so
  // `records` at 80 MXN could never be edited at all. Two things were wrong with it and they are
  // separable:
  //
  //   * IT COMPARED ON THE EXACT LOWERCASE STRING while storefront/src/listing.ts accepted
  //     `/^sats?$/i`. An item priced `sat` or `SATS` was therefore BUYABLE and NOT EDITABLE.
  //     Measured against both live sales on 2026-08-26: all 17 listings write exactly `sats` or
  //     `MXN`, so this was latent, not live — and it is closed by construction now, because both
  //     files call the same exported `isSats`.
  //   * IT REFUSED FOREVER, which was right about the danger and wrong that refusing was the only
  //     way out. A sats-only form would have republished 80 MXN as 80 sats, a silent 99.99%
  //     discount on something somebody might then buy. Carrying the currency and the amount
  //     through as a display price that never mints an offer is the other way to be right.
  const fiat = item.price && !isSats(item.price.currency) ? fiatCurrency(item.price.currency) : null
  if (item.price && !isSats(item.price.currency) && !fiat) return null

  const blobs = [...item.images, ...item.thumbs].flatMap(p => blobFrom(p) ?? [])
  const hero = blobs[0]
  const servers = hero
    ? [...new Set([serverOf(hero.url), ...imetaValues(event, 'fallback').map(serverOf)])].filter(Boolean)
    : []

  return {
    slug,
    title: item.title,
    summary: item.summary ?? '',
    priceSats: fiat ? 0 : (item.price?.amount ?? 0),
    ...(fiat ? { fiat: { amount: item.price!.amount, currency: fiat } } : {}),
    // `stock: undefined` means the seller never said, and `status` carries the answer instead
    // (storefront/src/listing.ts) — which for a yard sale means one unit, then gone.
    stock: item.stock ?? (item.sold ? 0 : 1),
    alt: imetaValues(event, 'alt')[0] ?? '',
    blobs,
    servers,
    // A fiat item's `clink_offer`, if some other tool wrote one, is not reusable: `reusableOffer`
    // measures a pointer's own TLV 4 against a SATS price, and this item has none. Dropping it
    // here is what keeps "unpayable" true through an edit.
    noffer: fiat ? undefined : event.tags.find(t => t[0] === 'clink_offer')?.[1],
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
 *
 * SHRINKING IS NOT DECIDED HERE, and this paragraph used to say it was not decided anywhere.
 * Item 13's last bullet landed as `droppedMembers` below, one function down, and the reason it is
 * not another branch of this function is the reason this docblock gave for deferring it: a shrink
 * is also exactly what a legitimate delete looks like, so nothing can tell a mistake from an
 * intention. A guard that cannot tell them apart must ask rather than refuse, so it is an explicit
 * confirmation in `main.ts` `doPublishSale` and it sits AFTER this gate. Below quorum the member
 * list is short because a relay was slow, which has a different answer.
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

/**
 * The `d` of every item the sale on the relays currently lists.
 *
 * `itemRefs` are `30402:<pubkey>:<d>` (Gamma spec.md:221, and `orderBySale` builds them in that
 * exact shape). A ref that is not this seller's own 30402 is SKIPPED rather than counted: the
 * builder only ever publishes this seller's items, so a foreign ref could never be preserved and
 * warning about one would be a warning nobody can clear. That is a known limit rather than an
 * oversight — nothing this app writes can produce one.
 */
export const saleMemberDs = (itemRefs: string[] | undefined, pubkey: string): string[] => {
  if (!itemRefs?.length || !/^[0-9a-f]{64}$/.test(pubkey)) return []
  const prefix = `${LISTING_KIND}:${pubkey}:`
  const out: string[] = []
  for (const ref of itemRefs) {
    if (typeof ref !== 'string' || !ref.startsWith(prefix)) continue
    // Everything after the second colon, so a `d` that itself contains one survives the split.
    const d = ref.slice(prefix.length)
    if (d && !out.includes(d)) out.push(d)
  }
  return out
}

/**
 * Which members this publish would un-list — item 13's last bullet, and it is a SET difference
 * rather than a length comparison.
 *
 * The roadmap words it as "the list I am about to publish is shorter than the one on the relays",
 * and a count is a proxy for the thing that actually costs a seller something. Swapping one item
 * for another leaves the count identical and still un-lists a real listing, so the count would
 * wave it through. What matters is whether a member that IS in the sale right now is missing from
 * the list about to replace it, and that is what this returns.
 *
 * IT RETURNS THE `d`s, NOT A BOOLEAN, because the confirmation has to name them. "This will
 * un-list 3 items" is a warning a seller cannot check; naming them is a warning they can.
 *
 * WHY THIS IS NOT A REFUSAL. Shrinking is also exactly what a legitimate delete looks like — M3's
 * retirement works BY removing a member — so nothing here can tell a mistake from an intention.
 * A guard that cannot tell them apart must ask rather than decide, which is why this is an
 * explicit confirmation and not another `noPublishSaleReason` branch. Building it here is what
 * lets M3's delete land later without tripping a rule on every legitimate use.
 */
export const droppedMembers = (members: string[], next: string[]): string[] => {
  const keep = new Set(next)
  return members.filter(d => !keep.has(d))
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
  //
  // CLEAR IT FIRST, and this line is the whole of the 2026-08-24 fix. `seenOn` is a Map on the POOL
  // (abstract-pool.js:698) that is only ever added to — never cleared, never expired — and main.ts
  // holds ONE pool for the session. `loadItems` runs on connect, after every item publish, and on
  // every "Reload my items"; an unchanged item keeps its event id across all of them. So a relay
  // that answered once was still counted as answering forever, and the gate turned into a ratchet
  // in the direction that protects nobody:
  //
  //   t0  damus + nos.lol answer, two relays time out  -> answered 2, blocked. Correct.
  //   t1  seller presses "Reload my items", as the message tells them to. band answers, damus is
  //       now down, so `items` is short by whatever only damus held — but damus is still in seenOn
  //       from t0, so answered is 3, the quorum PASSES, and publishing un-lists a real item.
  //
  // That is the kind 30405 replacement dropping members, which is the loss item 13's quorum bullet
  // was moved into milestone A to close. `items` comes from THIS query; `answered` has to as well.
  // `loadItems` is the only reader of `seenOn` in this codebase, so clearing it costs nothing.
  pool.trackRelays = true
  pool.seenOn.clear()
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
