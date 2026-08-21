// The printable item-sticker sheet — design.md §4, spec §10 slice 9.
//
// WHY IT LIVES IN THE BUILDER AND NOT IN THE STOREFRONT, stated as a decision because both were
// real candidates.
//
// The storefront already has the items, already prints (design.md §3), and its `@media print`
// flyer is the best physical artifact in the project — a third print block there would have been
// the natural home. It loses on one measurement: **the storefront deliberately ships no QR
// encoder in its cold load** (spec §9). Its own flyer QR is a build-time `<symbol>` injected at
// deploy, and the invoice QR is a 3.91 KB chunk fetched only behind the Buy button, so a visitor
// who merely browses downloads neither. N item stickers is N distinct QRs, which needs a real
// encoder, in a bundle with 0.4 KB of headroom against a ceiling that was restated one slice ago.
//
// The builder has `uqr` already (exact-pinned 0.1.3, dynamically imported for the bunker QR and
// the deploy QR), already knows every item the seller authored, and its budget is "whatever it
// takes" (design.md §5). And the person printing stickers is the SELLER, at a desk, once —
// which is the same argument that keeps the encoder out of the buyer's cold load in the first
// place. Same dynamic import, so a seller who never prints stickers never fetches it either.
//
// WHAT THE STICKER ENCODES was settled in slice 8 and measured: the storefront deep link
// `#/item/<d>`, not the item's `noffer`. A raw noffer sticker is unpayable by anything that
// cannot supply `refund_pointer`, and there is no optional tier on an offer's `payer_data`
// (findings §6, spec §7.3) — so no sticker is both generically payable and refundable. The deep
// link serves every wallet because it lands on the page that asks for the pointer and does the
// CLINK request itself. It is also the smaller code: 110 characters and 43x43 modules against the
// noffer's 237 and 59x59, i.e. 0.47 mm per module at 2 cm rather than 0.34. design.md §4.
import type { Item } from '../../storefront/src/listing.ts'

/** ≥2cm square or phones will not read it reliably — design.md §4. */
export const MIN_STICKER_MM = 20

/**
 * What one sticker's QR encodes.
 *
 * `siteUrl` is the deployed site (`deploy.ts` `siteUrl`), so the hash route resolves the same way
 * a buyer reaching the page from the flyer does. The `d` is percent-encoded because it is a `d`
 * tag, which is whatever the seller typed — `normaliseSlug` keeps our own to `[a-z0-9-]`, but an
 * item imported from a sale authored elsewhere has no such guarantee, and an unescaped `#` or `?`
 * in a fragment truncates the link.
 */
export const stickerUrl = (siteUrl: string, d: string): string =>
  `${siteUrl.replace(/\/+$/, '')}/#/item/${encodeURIComponent(d)}`

/**
 * Which items get a sticker.
 *
 * Sold ones do not: a sticker goes on a physical object before the sale, and the object behind a
 * sold listing has already left. Printing one is a QR that lands on `missingItemNote` — which
 * slice 9 also built, precisely because a sticker outlives its item and this filter cannot catch
 * the ones already stuck on things.
 */
export const stickerItems = (items: Item[]): Item[] => items.filter(i => !i.sold)

/**
 * The QR, as SVG built element by element.
 *
 * Same shape as `storefront/src/render.ts` `qrCode`: `uqr`'s `encode` gives the module matrix and
 * we emit ONE `<path>` of 1x1 squares rather than N `<rect>`s. Built with `createElementNS` and
 * `setAttribute` rather than from `renderSVG`'s string, so the sticker sheet never sets innerHTML
 * — which matters more here than at the bunker QR, because this page is also rendering titles
 * that came off a public relay.
 *
 * `border: 1` is the quiet zone. The QR spec wants 4 modules; at these sizes 4 modules of white
 * around a 43-module symbol wastes a third of the sticker, and the sticker is on white paper with
 * white margin around it either way.
 */
export const qrSvg = async (text: string): Promise<SVGSVGElement> => {
  const { encode } = await import('uqr')
  const { size, data } = encode(text, { border: 1 })
  let d = ''
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (data[y]![x]) d += `M${x} ${y}h1v1h-1z`
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `QR code linking to ${text}`)
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  svg.append(path)
  return svg
}

/**
 * Build the sheet into `host`.
 *
 * Name and price above the code, per design.md §4 — the seller needs to be able to tell two
 * stickers apart while holding a sheet of them, and the buyer needs to know what they scanned
 * before they scan it. Everything from a relay goes in through `textContent`.
 */
export const buildSheet = async (host: HTMLElement, items: Item[], siteUrl: string): Promise<number> => {
  const sheet = document.createDocumentFragment()
  const chosen = stickerItems(items)
  for (const item of chosen) {
    const fig = document.createElement('figure')
    fig.className = 'sticker'

    const name = document.createElement('strong')
    name.textContent = item.title

    const price = document.createElement('span')
    price.className = 'sticker-price'
    // Sats only on a sticker is wrong: `records` is 80 MXN and still wants a label on the crate.
    // Whatever the seller authored, as they authored it.
    price.textContent = item.price
      ? `${item.price.amount.toLocaleString('en-US')} ${item.price.currency}`
      : ''

    const box = document.createElement('div')
    box.className = 'sticker-qr'
    fig.append(name, price, box)
    sheet.append(fig)
    // Awaited per item rather than in parallel: `import('uqr')` resolves once and the rest is
    // synchronous, so a Promise.all here would buy nothing and lose the DOM order.
    box.append(await qrSvg(stickerUrl(siteUrl, item.d)))
  }
  host.replaceChildren(sheet)
  return chosen.length
}
