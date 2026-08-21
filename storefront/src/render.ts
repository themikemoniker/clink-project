// Markup for the sale page. design.md §1: newspaper classifieds, hairline rules, light only.
//
// Every string that came off a relay reaches the DOM through append() or textContent, never
// through innerHTML, so a title containing markup is displayed as the characters the seller
// typed rather than parsed. That is a property of h() below, not of a sanitiser we have to
// remember to call — which is why there is no sanitiser here.
import { requestInvoice, type Outcome } from './buy.ts'
import { srcset, type Item, type Money, type Sale } from './listing.ts'
import { isPointer, MIN_PAYABLE_SATS } from './offer.ts'

// The working name, settled in slice 2. It appears twice and quietly: as the masthead when a
// sale has no title of its own, and as a colophon — which is where a printer's mark belongs on
// a flyer, and this flyer is the one that gets taped to a lamppost.
export const SITE_NAME = 'Lamppost'

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
// No fiat -> sats conversion, ever: it needs a price oracle, i.e. an HTTP call to somebody
// else's server, and /CLAUDE.md rule 1 forbids one. Slice 2 settled the question the other way
// round — an item that is meant to be buyable is *authored* in sats, so the number here and the
// number the offer was minted at are the same number. See listing.ts buyableOffer().
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
export const stockNote = (item: Item): string | undefined =>
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
    h('h1', {}, sale?.title ?? SITE_NAME),
    // No standard tag carries a sale's date and opening hours — not in NIP-99, not in
    // GammaMarkets. The collection's `summary` is where the seller writes them for now; slice 6
    // needs to decide whether that stays a freeform line or earns a tag.
    sale?.summary && h('p', { class: 'dateline' }, sale.summary),
    sale?.location && h('p', { class: 'dateline' }, sale.location),
    // No npub when the page cannot tell whose sale it is (main.ts) — a byline reading
    // "Published by" with nothing after it is worse than no byline.
    npub && h('p', { class: 'byline' }, 'Published by ', h('code', {}, npub), ` · made with ${SITE_NAME}`),
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
    h('h2', {}, sale?.title ?? SITE_NAME),
    h(
      'p',
      {},
      'Prices as printed. Scan for what is still unsold — this list changes during the sale.',
    ),
    tabs,
    h('p', { class: 'colophon' }, `${SITE_NAME} · no server, no account, no processor`),
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
      renderBuy(item),
    ),
  )
}

// ---- the Buy button -------------------------------------------------------------------------
//
// WHY THE FUNCTIONS BELOW ARE EXPORTED, AND WHY THERE IS NO DOM HARNESS — slice 8's decision, and
// /docs/known-defects.md carried it as one since the slice 0-5 review ("needs a DOM harness, which
// is a new dependency and a new test style; that is a decision, not a follow-up fix").
//
// The measurement that settled it: this file touches `document` only inside function bodies, so
// `await import('./render.ts')` succeeds in bare node with no globals installed. Every decision in
// here — which copy a decline gets, whether a stock line is worth printing, how a number reads —
// is therefore already testable, and was untested only because it was private. Exporting four
// names cost nothing and bought ./render.test.ts.
//
// What is still untested is the markup itself: renderIndex, renderDetail and renderBuy build DOM
// and there is no assertion in this repo about what they build. That is the honest boundary. It
// needs jsdom (~2 MB of devDependency) or a browser, the browser is a session that already exists
// (/docs/prompts/browser-verify-and-deploy.md), and the one bug this file has actually shipped —
// LN_ADDRESS rejecting two-character second-level domains — was a decision, not markup, and is
// now covered in offer.test.ts. Revisit if a markup bug ever ships.
// design.md §1: "The Buy button is exempt from the metaphor. It must read as a modern, obviously
// tappable control. This is the moment money moves; clarity beats the bit."
//
// Everything below is one <section> that swaps its own contents through four states — form,
// waiting, invoice, paid — because a purchase is the only stateful thing on this page and a
// framework to hold four states would cost more bytes than the payment code itself.

export const sats = (n: number) => `${n.toLocaleString('en-US')} sats`

const REFUND_POINTER = 'refund_pointer' // the key our offers declare required — /docs/spec.md §7.3

// The five Offers codes (clink-offers.md:188-192), turned into something a person in a driveway
// can act on. Codes are matched exhaustively rather than falling through to the node's own text,
// because the node's text is written for developers.
export const declineText = (out: Extract<Outcome, { ok: false }>): string => {
  switch (out.code) {
    case 1:
      return out.payerData?.length
        ? `The seller’s node needs ${out.payerData.join(', ')} before it will issue an invoice.`
        : 'This item is no longer for sale. Reload the page for what is left.'
    case 2:
      return 'The seller’s node is temporarily unable to take the payment. Try again in a moment.'
    case 3:
      return 'This offer has expired or moved. Reload the page to get the current one.'
    case 4:
      return 'The seller’s node does not support something this page asked for.'
    case 5:
      return out.range
        ? `That price is outside what this node will accept (${sats(out.range.min)} to ${sats(out.range.max)}).`
        : 'That amount was refused.'
    default:
      return out.error
  }
}

// The invoice QR, and the only code-split point on the page.
//
// design.md §4 keeps two QR types apart: the storefront QR (a build-time constant, inlined as an
// SVG <symbol> — see vite.config.ts) and this one, which encodes a BOLT11 that does not exist
// until the node answers. It therefore needs a real encoder in the browser, ~3.9 KB gzip of one.
//
// It is dynamically imported so that cost lands on the buyer who taps Buy, not on every visitor
// loading a sale page on mobile data in a driveway (/docs/spec.md §9's budget is about cold
// load). Uppercasing the invoice first is not cosmetic: bech32 is case-insensitive, and the
// uppercase form fits QR's alphanumeric mode, which drops this invoice from 63 modules to 55.
const qrCode = async (bolt11: string): Promise<SVGSVGElement> => {
  const { encode } = await import('uqr')
  const { size, data } = encode(bolt11.toUpperCase(), { border: 1 })
  // One <path> of 1x1 squares rather than N <rect>s, and built with setAttribute rather than an
  // SVG string, so nothing on this page ever parses markup it did not construct.
  let d = ''
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (data[y]![x]) d += `M${x} ${y}h1v1h-1z`
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`)
  svg.setAttribute('class', 'qr')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Lightning invoice QR code')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  svg.append(path)
  return svg
}

const copyButton = (bolt11: string) => {
  const button = h('button', { type: 'button', class: 'ghost' }, 'Copy invoice')
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(bolt11)
      button.textContent = 'Copied'
    } catch {
      button.textContent = 'Select it below instead'
    }
  })
  return button
}

/**
 * Why this item has no Buy button, in the buyer's terms — or `undefined` when silence is right.
 *
 * SLICE 8, AND IT IS THE HOLE THE SLICE'S ONE-LINE DESCRIPTION DOES NOT NAME. `renderBuy` used to
 * open with `if (!offer || !price) return false`, so an item with no offer rendered no buy panel
 * and no explanation. On the live fixture that is two items a visitor can see, want, and get no
 * answer about: `records` at 80 MXN and `boxes` at free. Neither is a CLINK problem and both are
 * "buyers this page does not serve", which is exactly what this slice is for.
 *
 * Every branch below says what to DO, not what went wrong. "Cash at the table" is an instruction;
 * "no offer available" is a status message about our data model, which is not the buyer's problem.
 */
export const noBuyReason = (item: Item): string | undefined => {
  // Sold already says everything, twice — the stamp and the strikethrough. A third sentence
  // explaining that a sold thing cannot be bought is noise.
  if (item.sold) return undefined
  const price = item.price
  if (!price) return 'No price on this one. Ask the seller.'
  if (price.amount === 0) return 'Free — just ask when you get here.'
  // Fiat. There is no conversion anywhere in this project and there will not be: a price oracle
  // is an HTTP call to somebody else's server and /CLAUDE.md rule 1 forbids one (spec §6.1). So a
  // fiat price is a real price that this page genuinely cannot take, and saying which currency it
  // is stops the sentence reading like a bug.
  if (!/^sats?$/i.test(price.currency)) {
    return `Priced in ${price.currency.toUpperCase()} — cash at the table. This page pays over Lightning, in sats, and it has no way to convert.`
  }
  // Lightning.Pub will not invoice below 10 sats (offer.ts MIN_PAYABLE_SATS), so a Buy button
  // here would only ever answer `code: 5`.
  if (price.amount < MIN_PAYABLE_SATS) return 'Too small for a Lightning invoice — cash at the table.'
  // Priced in sats, above the floor, and still nothing payable: the listing carries no usable
  // `clink_offer`, or it carries one whose TLV 4 price disagrees with the price tag, which
  // `buyableOffer` refuses on purpose. A buyer cannot act on the difference and does not need to;
  // the seller-facing diagnosis is `node spike/check-admin.ts`.
  return 'Not payable on this page. Ask the seller — they may take cash, or have it listed elsewhere.'
}

export const renderBuy = (item: Item): HTMLElement | false => {
  const offer = item.offer
  const price = item.price
  if (!offer || !price) {
    const reason = noBuyReason(item)
    return reason ? h('section', { class: 'buy buy-none' }, h('p', { class: 'hint' }, reason)) : false
  }

  const panel = h('section', { class: 'buy' })
  // aria-live so a screen reader hears the invoice arrive; the whole flow is one region that
  // rewrites itself, and without this it rewrites silently.
  const status = h('div', { class: 'buy-status', role: 'status', 'aria-live': 'polite' })

  const field = h('input', {
    // The `d` tag is authored by whoever signed the event, so it is stripped to what is legal in
    // an id before it goes near one — otherwise a label can simply stop pointing at its input.
    id: `refund-${item.d.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    name: REFUND_POINTER,
    type: 'text',
    inputmode: 'email',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    maxlength: '255',
    required: '',
    placeholder: 'you@yourwallet.com',
  })
  const submit = h('button', { type: 'submit', class: 'pay' }, `Buy — ${sats(price.amount)}`)
  const form = h(
    'form',
    { class: 'buy-form', novalidate: '' },
    h('label', { for: field.id }, 'Where should a refund go?'),
    // Not a dark pattern and not optional: the offer declares this key required, so the node
    // declines a payment that arrives without it (/docs/spec.md §7.3). Say why, once, plainly.
    // Slice 7 made this copy true rather than merely reassuring. It used to say "A Lightning
    // address or noffer" and stop, which was accurate about what the field accepts and silent
    // about what the two cost. They are not equivalent: an noffer is paid over a relay to the
    // buyer's own node, and a Lightning address is a hostname, which means a server that has to
    // be up when the refund is sent. Saying so is the difference between a buyer who knows why
    // they were asked and one who finds out from a queue entry weeks later.
    h(
      'p',
      { class: 'hint' },
      'A Lightning address or noffer. If two people buy the last one, this is where your money ' +
        'comes back — the seller’s node will not take a payment it could not refund. ' +
        'An noffer is refunded over the same relays as this page; a Lightning address has to be ' +
        'looked up on its provider’s server, so use an noffer if you have one.',
    ),
    // SLICE 8, and it is what /docs/spec.md §10 asks for, in the form that is actually true here.
    // §10 says the copy "must state that a raw-QR payer forfeits the automatic refund". Under the
    // decision this slice made — keep the pointer required, make the page the fallback — nobody
    // can forfeit it, because the node declines a payment that arrives without one. So the honest
    // sentence is not a warning about losing the refund; it is why this page is the only way in.
    // A buyer who was just asked for a wallet address is owed that, before they type one.
    h(
      'p',
      { class: 'hint' },
      'This is the only way to pay this item. A wallet that scans the seller’s offer code ' +
        'directly is turned away by their node for the same reason — it has nowhere to send a ' +
        'refund. Nothing here reaches a server of ours; there isn’t one.',
    ),
    field,
    submit,
  )

  const say = (...kids: (Node | string | false)[]) => status.replaceChildren(...kids.filter(k => k !== false) as Node[])

  const showInvoice = (bolt11: string) => {
    const frame = h('div', { class: 'qr-frame' })
    const invoice = h(
      'div',
      { class: 'invoice' },
      h('p', { class: 'invoice-amount' }, sats(price.amount)),
      frame,
      // On the phone the page is already on, this opens the buyer's wallet directly; the QR is
      // for the other case, a page on a laptop and a wallet in a pocket.
      h('a', { class: 'pay', href: `lightning:${bolt11}` }, 'Open in a Lightning wallet'),
      copyButton(bolt11),
      h('code', { class: 'bolt11' }, bolt11),
      h(
        'p',
        { class: 'hint' },
        'Expires in 15 minutes. Keep this page open — it confirms here when the payment lands, ' +
          'because the receipt is encrypted to this page and to nobody else.',
      ),
    )
    say(invoice)
    // The invoice is usable the moment it is on screen; the QR arrives a chunk later, and if the
    // chunk fails to load the buyer still has a link, a copy button and the raw string.
    void qrCode(bolt11).then(svg => frame.append(svg), () => frame.remove())
  }

  const showPaid = () =>
    say(
      h(
        'div',
        { class: 'paid' },
        h('p', { class: 'paid-mark' }, 'Paid'),
        h('p', { class: 'hint' }, 'Show this to the seller when you collect. Nothing was sent to any server of ours.'),
      ),
    )

  form.addEventListener('submit', async event => {
    event.preventDefault()
    const pointer = field.value.trim()
    if (!isPointer(pointer)) {
      field.setAttribute('aria-invalid', 'true')
      say(h('p', { class: 'buy-error' }, 'That does not look like a Lightning address or an noffer.'))
      field.focus()
      return
    }
    field.removeAttribute('aria-invalid')
    submit.disabled = true
    field.disabled = true
    say(h('p', { class: 'waiting' }, 'Asking the seller’s node for an invoice…'))

    const outcome = await requestInvoice(
      offer,
      { [REFUND_POINTER]: pointer },
      price.amount,
      item.title,
      showPaid,
    )
    if (outcome.ok) {
      // Hidden, not removed: the pointer is already baked into this invoice's payer_data, so
      // editing it now would change nothing.
      //
      // ponytail: leaving the item and coming back mints a second invoice rather than showing
      // this one again. Two unpaid invoices cost nothing and expire in 15 minutes, and the
      // oversell that matters is two different buyers — which is slice 3's watcher, not
      // something a page-local cache could fix. Revisit only if a buyer can pay both by accident.
      form.hidden = true
      showInvoice(outcome.bolt11)
      return
    }
    submit.disabled = false
    field.disabled = false
    say(h('p', { class: 'buy-error' }, declineText(outcome)))
  })

  panel.append(form, status)
  return panel
}
