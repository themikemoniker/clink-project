# Design Direction

Two surfaces, opposite constraints. Do not share a design system between them.

| | Builder + admin | Generated storefront |
|---|---|---|
| Audience | Seller, motivated, loaded once | Buyer, in a driveway, on mobile data |
| Priority | Speed of building UI | Weight, legibility, print |
| Stack | React + Tailwind + shadcn/ui | Hand-written CSS, no component library |
| Budget | Whatever it takes | ~30KB JS **gzip**, ~10KB CSS (settled slice 2 — spec §9) |

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
| **Item QR** | The item's `noffer` | Price stickers on physical objects |

Item QRs need a printable sticker sheet: one per item, ≥2cm square or phones won't read it reliably, item name and price above the code. Scan the thing, pay for the thing.

~~`SPIKE`: item QRs depend on per-item offers being mintable.~~ **Resolved, and the answer changed the design.** Per-item offers are mintable and are live (spec §6.1), so an item QR *could* encode the item's `noffer` — but slice 2 made every offer require a `refund_pointer` in `payer_data`, and a wallet scanning a raw QR has no way to supply one. The node declines it. So an item sticker that encodes the noffer today is a QR that cannot be paid.

Item QRs therefore encode the **storefront deep link** (`#/item/<d-tag>`) until slice 8 decides what happens to buyers without a refund pointer. Scan the thing, land on the thing's page, pay there. That is one extra tap and it keeps the refund guarantee, which is the demo.

---

## 5. Builder + admin: shadcn/ui

Forms, dialogs, tables, toasts, upload progress. Radix gives accessible focus management and keyboard behaviour for free — do not hand-roll these under time pressure.

Keep it plain. The admin is a tool; it should not cosplay as a newspaper. The one place the two surfaces meet is the live preview of the storefront, which renders the real template.

### Avoid looking AI-generated

Default Tailwind palette, Inter, purple-to-blue gradients, dark mode with glass cards — judges will have seen this forty times that weekend. Warm paper-ish neutrals, one accent, high contrast.

---

## 6. Theming: out of scope for v1

One well-designed template, optionally one accent colour picker. Seller theming is a Slice 10 that will never happen, and one great-looking template demos better than three mediocre ones.
