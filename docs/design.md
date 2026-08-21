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

**Built in slice 9, and "editable" turned out to be the smaller half.** There was no sale config
to edit: the builder imported `/spike/fixture.ts`'s and stamped our neighbourhood and geohash on
every item anybody authored, into a kind 30405 nothing in the builder ever published. It is a
real form now (`builder/index.html` §3, `builder/src/sale.ts`) — name, the date-and-hours line
that has nowhere else to live because no NIP carries one, neighbourhood, and an optional geohash
with a "use my location" button that reads the browser's own geolocation and rounds to ±76 m.
No geocoder: turning a neighbourhood name into coordinates is an HTTP call to a third party, and
that is the exact dependency the geohash map died on (spec §10, findings §31).

The neighbourhood renders as a `geo:` link when the geohash decodes, which is the whole surviving
remnant of §10's "map of nearby sales" — the buyer's own map app, no tile server, nothing of ours
told that they looked.

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

**Corrected in slice 9, because §3 below is the print spec slice 9 implements and two of the six
items here describe things that do not exist.** The render half shipped in slice 1
(`storefront/src/listing.ts` `srcset`, `render.ts` `photo`); the generator half shipped in slice 4
(`builder/src/photos.ts`). What is marked NOT BUILT is not a deferral with a slice on it — it is a
decision, with the reasoning and a citation.

1. **Resize client-side on upload** via canvas. Generate 2–3 widths per photo. Each width is its
   own Blossom blob. **Shipped slice 4** — `photos.ts` `WIDTHS = [1200, 480, 160]`, jpeg q0.82,
   never upscaled, original never uploaded.
2. ~~**Dithered thumbnails on the index.** 1-bit halftone: authentically newsprint, dramatically
   smaller than JPEG, prints perfectly on any printer.~~ **NOT BUILT, and not planned.** There is
   no dithering anywhere in this project and nothing is scheduled to add it. What exists is a
   print-only CSS approximation — `grayscale(1) contrast(1.45) brightness(1.06)`,
   `style.css` in the first `@media print` block — which was written in slice 1 saying "until
   slice 4 exists", and slice 4 came and went without it. The honest reason it never got built:
   a 1-bit halftone is a **fourth rendition** to generate, upload, sign a kind 24242 for and carry
   an extra `thumb` tag for, in exchange for a thumbnail that looks better on a laser printer and
   worse on a screen — and the screen is where every buyer sees it. The CSS filter costs zero
   bytes, zero blobs and zero signatures. **Whether it is good enough on paper is a question only
   a print preview answers, and nobody has run one** — that is owed to
   `/docs/prompts/browser-verify-and-deploy.md`, not to a future slice of this pipeline.
3. **Full-colour photo on the item detail view** — a buyer needs to judge whether the couch is
   stained. **Shipped slice 1**: the same srcset, larger `sizes`.
4. **Aspect-ratio boxes** so nothing shifts as blobs arrive. **Shipped slice 1** — the box comes
   from the event's own `WxH`, with `4 / 3` as a fallback rather than a claim.
5. ~~**Blurhash or thumbhash placeholder** rendered inline in the listing event while the blob
   fetches.~~ **NOT BUILT, deliberately, and the decision is recorded rather than pending.**
   `blurhash` is a real NIP-94 field reachable through NIP-92 `imeta` (findings §13.21 pins the
   citation), and `builder/src/listing.ts` `imetaTag` writes `x`, `dim`, `alt` and `fallback` and
   pointedly not this one: it would need an encoder in the builder **and a decoder inside the
   storefront's 32 KB gzip budget** (spec §9) to replace a flat tone that already works. The
   placeholder that ships is `.shot-empty`, a 45° hatch. The field name is pinned, so shipping one
   later is an hour rather than a research task.
6. **Lazy load** below the fold. **Shipped slice 1** — `loading="lazy"`, `decoding="async"`.

---

## 3. Print

The seller prints the page, tapes it to a lamppost, and the QR on it goes to the live version where sold items have already vanished. Paper that stays current. This is the best physical artifact in the project — build the stylesheet early, not in polish.

Requirements, and **as of slice 9 every one of them says what the stylesheet actually does**.
`storefront/src/style.css` has two `@media print` blocks (the flyer, and one line hiding the buy
panel); slice 9 adds no third. The one requirement that was a description of an unbuilt pipeline
is corrected in place rather than deleted, because the reasoning is the useful part:

- **`@page` margins** — `@page { margin: 14mm }`.
- **Hide buy buttons, nav, and all interactive chrome** — `.buy`, `.back` and `.byline` are
  `display: none` in print. Paper cannot be tapped and an npub is not a thing anyone reads off a
  lamppost.
- **Black only** — every ink token is redefined to `#000` inside the print block, so the sold
  stamp, the hairlines and the soft-grey metadata all resolve to one ink. A colour laser and a
  40-peso mono laser print the same flyer.
- ~~dithered thumbs print correctly by construction~~ **There are no dithered thumbs.** §2.2 says
  why, and the sentence above was a print *requirement* resting on a pipeline stage that was never
  built. What prints is `grayscale(1) contrast(1.45) brightness(1.06)` plus a hairline box, which
  is an approximation of a halftone rather than one. **Do not build the dithering to make this
  document true.** The open question is not "when do we add it" — it is "is the approximation good
  enough on paper", and only somebody looking at a print preview can answer that.
- **`break-inside: avoid` on each item** — both the modern property and `page-break-inside`, since
  print engines are the last place either alias is safely dropped. Slice 9 adds the same pair per
  **sticker** on the builder's sheet (§4), for the same reason.
- **Show sats price as of print time, with a line noting live pricing at the URL** — prices render
  as authored, and the flyer's foot says *"Prices as printed. Scan for what is still unsold — this
  list changes during the sale."*
- **Tear-off tab strip at the foot of the flyer** (what real yard sale signs do), each tab carrying
  the storefront QR — eight tabs, dashed rules, each one a `<use>` of the build-time `<symbol>`, so
  the page ships no QR encoder to repeat it eight times.

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

**And the deep link is the *easier* code to scan, which was measured rather than assumed.** The
first draft of this paragraph guessed the opposite. Measured with the `uqr` the builder already
ships, on the live `mugs` item:

| encodes | chars | QR |
|---|---|---|
| the item's `noffer` | 237 | 59×59 modules (51×51 uppercased into alphanumeric mode) |
| the storefront deep link | 110 | **43×43 modules** |

A `noffer` carries a 32-byte pubkey, a relay URL and an opaque offer id; the deep link carries an
npub and a slug. So the sticker that works everywhere is also the one with the fattest modules at
a given sticker size — at 2cm that is 0.47mm per module against 0.34mm. The trade-off in the
paragraph above has no downside left to weigh.

**Built in slice 9, in the builder** — `builder/src/stickers.ts`, `builder/src/style.css`'s
`@media print` block, and a button in the panel that already lists the seller's items.

**Where it lives was slice 9's decision and both candidates were real.** The storefront already
has the items, already prints (§3), and its flyer is the best physical artifact in the project, so
a third `@media print` block there was the natural home. It loses on one measurement: the
storefront **deliberately ships no QR encoder in its cold load** (spec §9) — its own flyer QR is a
build-time `<symbol>` injected at deploy and the invoice QR is a 3.91 KB chunk behind the Buy
button, so a visitor who only browses downloads neither. N stickers is N distinct codes, which
needs a real encoder, in a bundle that had 0.4 KB of headroom.

⇒ **The builder**, and the reasoning is the same one that keeps `uqr` out of the buyer's cold
load: the person printing stickers is the seller, at a desk, once. It is behind the same dynamic
`import('uqr')` the deploy button uses, so a seller who never prints stickers never fetches it
either. Cost: +2.1 KB gzip on a bundle whose budget is "whatever it takes" (§5).

What shipped, against this section's own requirements: name and price above the code; 25 mm
square, comfortably over the 2 cm floor and 0.58 mm per module at 43×43; `break-inside: avoid`
per sticker, both spellings, per §3; a dashed cut line; and **sold items get no sticker**, because
the object behind a sold listing has already left. The ones already stuck on things are exactly
why the storefront also grew `missingItemNote` in the same slice — a sticker outlives its item and
no filter here can reach one.

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
