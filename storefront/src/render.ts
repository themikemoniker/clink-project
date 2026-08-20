// Markup for the sale page. design.md §1: newspaper classifieds, hairline rules, light only.
//
// Every string that came off a relay reaches the DOM through append() or textContent, never
// through innerHTML, so a title containing markup is displayed as the characters the seller
// typed rather than parsed. That is a property of h() below, not of a sanitiser we have to
// remember to call — which is why there is no sanitiser here.
import { srcset, type Item, type Money, type Sale } from './listing.ts'

type Kid = Node | string | false | null | undefined

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  ...kids: Kid[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, v)
  for (const kid of kids) if (kid !== false && kid != null) el.append(kid)
  return el
}

// Currency here is whatever the seller wrote. 99.md:41 calls it "ISO 4217-like", which in the
// wild means "sats" and "btc" turn up beside real codes, and Intl throws on those.
//
// ponytail: no fiat -> sats conversion. It needs a price oracle, i.e. an HTTP call to somebody
// else's server, which is the one thing /CLAUDE.md rule 1 forbids. Slice 2 has to solve it
// anyway to mint an offer with a sats price, and whatever it decides belongs here too.
export const formatPrice = (price: Money | undefined): string | undefined => {
  if (!price) return undefined
  if (price.amount === 0) return 'Free'
  if (/^sats?$/i.test(price.currency)) return `${price.amount.toLocaleString('en-US')} sats`
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: price.currency.toUpperCase(),
      maximumFractionDigits: Number.isInteger(price.amount) ? 0 : 2,
    }).format(price.amount)
  } catch {
    return `${price.amount.toLocaleString()} ${price.currency.toUpperCase()}`
  }
}

// Only when there is genuinely more than one. A yard sale item is one thing unless it says so,
// and "1 left" on every row is noise.
const stockNote = (item: Item): string | undefined =>
  item.stock !== undefined && item.stock > 1 ? `${item.stock} available` : undefined

const photo = (item: Item, sizes: string): HTMLElement => {
  const s = srcset(item)
  // The box is reserved whether or not a photo exists, so nothing on the page moves as blobs
  // land — design.md §2.4.
  const frame = h('div', { class: 'shot', style: `aspect-ratio:${s?.aspect ?? '4 / 3'}` })
  if (!s) {
    frame.classList.add('shot-empty')
    return frame
  }
  frame.append(
    h('img', {
      src: s.src,
      srcset: s.srcset,
      sizes,
      alt: item.title,
      loading: 'lazy',
      decoding: 'async',
    }),
  )
  return frame
}

const soldStamp = () => h('span', { class: 'stamp', 'aria-label': 'Sold' }, 'sold')

export const renderMasthead = (sale: Sale | undefined, npub: string): HTMLElement =>
  h(
    'header',
    { class: 'masthead' },
    h('h1', {}, sale?.title ?? 'Yard Sale'),
    // No standard tag carries a sale's date and opening hours — not in NIP-99, not in
    // GammaMarkets. The collection's `summary` is where the seller writes them for now; slice 6
    // needs to decide whether that stays a freeform line or earns a tag.
    sale?.summary && h('p', { class: 'dateline' }, sale.summary),
    sale?.location && h('p', { class: 'dateline' }, sale.location),
    h('p', { class: 'byline' }, 'Published by ', h('code', {}, npub)),
  )

export const renderIndex = (items: Item[]): HTMLElement => {
  if (items.length === 0) {
    return h(
      'main',
      { class: 'items empty' },
      h('p', {}, 'Nothing is listed here yet, or the relays did not answer in time.'),
    )
  }
  const main = h('main', { class: 'items' })
  for (const item of items) {
    const price = formatPrice(item.price)
    const note = stockNote(item)
    main.append(
      h(
        'article',
        { class: item.sold ? 'item sold' : 'item', id: `item-${item.d}` },
        // The whole row is the target — a thumbnail-sized tap target fails in a driveway.
        h(
          'a',
          { class: 'item-link', href: `#/item/${encodeURIComponent(item.d)}` },
          photo(item, '(min-width: 60rem) 22rem, (min-width: 40rem) 45vw, 92vw'),
          h('h2', {}, item.title, item.sold && soldStamp()),
        ),
        item.summary && h('p', { class: 'summary' }, item.summary),
        h(
          'p',
          { class: 'meta' },
          price && h('span', { class: 'price' }, price),
          note && h('span', { class: 'stock' }, note),
        ),
      ),
    )
  }
  return main
}

// design.md §3 — the flyer's foot. Screen-hidden, print-only: the seller prints the page, tapes
// it to a lamppost, and each tab carries the storefront QR. The paper stays current because the
// URL on it shows a page where sold items have already gone.
//
// The QR is a <use> of a <symbol> that vite.config.ts encoded at build time, so this ships no
// QR library and repeating it across eight tabs costs eight <use> elements.
const TABS = 8

export const renderFlyerFoot = (sale: Sale | undefined, siteUrl: string): HTMLElement => {
  const label = siteUrl.replace(/^https?:\/\//, '')
  const tabs = h('div', { class: 'tabs' })
  for (let i = 0; i < TABS; i++) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
    use.setAttribute('href', '#qr')
    svg.append(use)
    tabs.append(h('div', { class: 'tab' }, svg, h('span', {}, label)))
  }
  return h(
    'footer',
    { class: 'flyer-foot' },
    h('h2', {}, sale?.title ?? 'Yard Sale'),
    h(
      'p',
      {},
      'Prices as printed. Scan for what is still unsold — this list changes during the sale.',
    ),
    tabs,
  )
}

// design.md §2.3: the index is for scanning, the detail view is where a buyer decides whether
// the couch is stained. Same markup contract, bigger source from the same srcset.
export const renderDetail = (item: Item): HTMLElement => {
  const price = formatPrice(item.price)
  const note = stockNote(item)
  return h(
    'main',
    { class: 'detail' },
    h('a', { class: 'back', href: '#/' }, '← All items'),
    h(
      'article',
      { class: item.sold ? 'item sold' : 'item' },
      photo(item, '(min-width: 50rem) 44rem, 96vw'),
      h('h2', {}, item.title, item.sold && soldStamp()),
      h(
        'p',
        { class: 'meta' },
        price && h('span', { class: 'price' }, price),
        note && h('span', { class: 'stock' }, note),
      ),
      // NIP-99 99.md:21 says .content is markdown. We render it as text: a markdown parser is
      // both bytes we do not have and an injection surface pointed straight at hostile input.
      // ponytail: revisit if sellers actually write markdown — a renderer that emits DOM nodes
      // rather than an HTML string is the only acceptable shape.
      item.content && h('div', { class: 'body' }, item.content),
      item.location && h('p', { class: 'where' }, item.location),
      // Slice 2 puts the Buy button here. It is deliberately absent rather than stubbed —
      // design.md is explicit that this control must read as obviously live, and a dead one
      // that does nothing is worse than none.
    ),
  )
}
