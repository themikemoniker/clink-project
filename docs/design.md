# Design Direction

Two surfaces, opposite constraints. Do not share a design system between them.

| | Builder + admin | Generated storefront |
|---|---|---|
| Audience | Seller, motivated, loaded once | Buyer, in a driveway, on mobile data |
| Priority | Speed of building UI | Weight, legibility, print |
| Stack | ~~React + Tailwind + shadcn/ui~~ Vite + TypeScript, hand-written CSS (see §5) | Hand-written CSS, no component library |
| Budget | Whatever it takes | ~~~30KB~~ **32 KB JS gzip**, ~10KB CSS (settled slice 2, raised once in slice 8 with the reasoning written down — spec §9) |

---

## 1. Storefront: newspaper classifieds

The metaphor is not decoration. NIP-99 is literally titled *Classified Listings* — this is classifieds that look like classifieds, printed on a paper made of relays. It also happens to be the cheapest aesthetic on the web: no gradients, no shadows, no rounded corners, no dark mode. Hairline rules, high-contrast serif, whitespace.

### Masthead (a feature, not styling)

Sale name, date, hours, neighborhood. This is what makes the printed version a real flyer. Sourced from the seller's sale config, editable in the admin panel.

### Layout

- Grid that evokes columns; do NOT use CSS `columns` (breaks with lazy images and interactive elements)
- Hairline rules between items, not cards with borders on all sides
- 1 column mobile, 2–3 desktop
- Light mode only. This is read outdoors in sunlight.

### Typography

- One high-contrast display serif for the masthead ONLY, subsetted to the characters that sale actually uses. Target ≤ 20KB woff2.
- Body: system serif stack (Georgia / Iowan Old Style / Charter / serif). Zero bytes.
- Sans for UI chrome only: buttons, prices in sats, metadata.
- No justified text with hyphenation off — produces rivers.

### Things that would tip it into costume (don't)

Dropcaps, faux-yellowed paper textures, fake ink bleed, ALL-CAPS everything, decorative rules.

### The Buy button is exempt from the metaphor

It must read as a modern, obviously tappable control. This is the moment money moves; clarity beats the bit.

**Built in slice 2** (`render.ts` `renderBuy`, `style.css` `.buy`): sans throughout, solid ink fill, full width, ≥44px tall, on the item detail page only — not on the index, where a row is a link and a payment control would be a mis-tap waiting to happen. One `<section>` that swaps through four states (form → waiting → invoice → paid) with an `aria-live` region, because a purchase is the only stateful thing on this page.

The form field above it is not a dark pattern and not optional: the offer declares `refund_pointer` required, so the node refuses a payment it could not refund. The copy says that in one sentence, once.

### Sold state

Strikethrough on the title plus a rotated stamp. **Do not hide sold items** — a page where things visibly disappear over the morning is more compelling than one that was always short. Fade, strike, stamp; keep them in the flow.

---

## 2. Image pipeline (biggest lever on perceived quality)

A 4MB phone photo from a driveway will destroy load time. This is not a polish item — build it in Slice 1.

1. **Resize client-side on upload** via canvas. Generate 2–3 widths per photo. Each width is its own Blossom blob.
2. **Dithered thumbnails on the index.** 1-bit halftone: authentically newsprint, dramatically smaller than JPEG, prints perfectly on any printer.
3. **Full-colour photo on the item detail view** — a buyer needs to judge whether the couch is stained.
4. **Aspect-ratio boxes** so nothing shifts as blobs arrive.
5. **Blurhash or thumbhash placeholder** rendered inline in the listing event while the blob fetches.
6. **Lazy load** below the fold.

---

## 3. Print

The seller prints the page, tapes it to a lamppost, and the QR on it goes to the live version where sold items have already vanished. Paper that stays current. This is the best physical artifact in the project — build the stylesheet early, not in polish.

Requirements:

- `@page` margins
- Hide buy buttons, nav, and all interactive chrome
- Black only; dithered thumbs print correctly by construction
- `break-inside: avoid` on each item
- Show sats price as of print time, with a line noting live pricing at the URL
- Tear-off tab strip at the foot of the flyer (what real yard sale signs do), each tab carrying the storefront QR

---

## 4. QR codes — two distinct types, do not conflate

| Type | Encodes | Where it appears |
|---|---|---|
| **Storefront QR** | The site URL (gateway or `nsite://`) | Flyer footer, tear-off tabs, admin panel for sharing |
| **Item QR** | ~~The item's `noffer`~~ the item's storefront deep link, `#/item/<d-tag>` — corrected in slice 8, see below | Price stickers on physical objects |

Item QRs need a printable sticker sheet: one per item, ≥2cm square or phones won't read it reliably, item name and price above the code. Scan the thing, pay for the thing.

**The storefront QR moved from build time to deploy time in slice 5.** It used to be a
build-time constant, which is exactly what made the storefront compile per seller — the URL
contains the seller's npub. It is now injected into `index.html` on its way to Blossom by
`builder/src/deploy.ts`. The design requirement is unchanged and still met: the page ships no QR
encoder. The cold HTML went from 0.4 KB to 2.4 KB gzip for it.

~~`SPIKE`: item QRs depend on per-item offers being mintable.~~ **Resolved, and the answer changed the design.** Per-item offers are mintable and are live (spec §6.1), so an item QR *could* encode the item's `noffer` — but slice 2 made every offer require a `refund_pointer` in `payer_data`, and a wallet scanning a raw QR has no way to supply one. The node declines it. So an item sticker that encodes the noffer today is a QR that cannot be paid.

Item QRs therefore encode the **storefront deep link** (`#/item/<d-tag>`) ~~until slice 8 decides what happens to buyers without a refund pointer~~. Scan the thing, land on the thing's page, pay there. That is one extra tap and it keeps the refund guarantee, which is the demo.

**CONFIRMED IN SLICE 8. The sticker encodes the deep link, permanently, and this table's "Item QR
→ the item's `noffer`" row is wrong.** The provisional answer above was written assuming the worst
case about wallets; slice 8 checked, and the worst case is not the reason. Two measurements:

- **A raw `noffer` sticker is unpayable by anything that cannot supply `refund_pointer`**, which
  is the node declining rather than a wallet failing (`code: 1`, confirmed on the wire in slice 2).
- **Relaxing the offer to accept anyone is not available.** `payer_data` on an offer is a
  required-key list with no optional tier, and a key the offer does not declare is **discarded**
  rather than stored (`offerManager.ts:139-142`, `:276`). So there is no sticker that is both
  payable by a generic wallet and refundable. Findings §6, spec §7.3.

⇒ The deep link is not a compromise pending better wallet support. **It serves every wallet**,
because it lands on a page that asks for the pointer and then does the CLINK request itself,
whereas a raw `noffer` serves only wallets that speak CLINK *and* can be prompted for an arbitrary
key. One extra tap buys universality and the refund guarantee together.

**What the sticker still needs, and it is slice 9's** (the printable sheet, per §10): the name and
price above the code, ≥2cm square, and the deep link is longer than an `noffer` so the module
count is higher — check it scans at 2cm from a real print before the sheet is called done.

---

## 5. Builder + admin: no component library

~~shadcn/ui. Forms, dialogs, tables, toasts, upload progress. Radix gives accessible focus
management and keyboard behaviour for free — do not hand-roll these under time pressure.~~

**Reversed in slice 4 and closed in slice 6, measured both times.** Native `<form>`, `<label>`,
`<input>`, `<output>` and `<dialog>` already give the focus order, labelling and keyboard
behaviour Radix was wanted for; hand-rolling was never the alternative on offer.

Slice 6 is where this line said to revisit, because the admin panel was supposed to want tables,
dialogs and toasts. It wanted one list, two buttons per row and a textarea — and it reuses the
item form as its edit form, because in nostr an edit *is* a re-publish under the same `d` and
there is no second form to build. The whole panel cost **+4.3 KB gzip**; React and ReactDOM are
~45 KB gzip before a single component. In an app that is itself fetched blob by blob from a cold
gateway (rule 5), that is ten times the feature it would have helped build. Spec §9 agrees and
is no longer deferring the question.

Keep it plain. The admin is a tool; it should not cosplay as a newspaper. The one place the two surfaces meet is the live preview of the storefront, which renders the real template.

### Avoid looking AI-generated

Default Tailwind palette, Inter, purple-to-blue gradients, dark mode with glass cards — judges will have seen this forty times that weekend. Warm paper-ish neutrals, one accent, high contrast.

Shipped as such: `builder/src/style.css`, ~100 lines, one rust accent (`--accent: #8c3a10`, the
same one the storefront uses for prices), no dark mode.

---

## 6. Theming: out of scope for v1

One well-designed template, optionally one accent colour picker. Seller theming is a Slice 10 that will never happen, and one great-looking template demos better than three mediocre ones.
