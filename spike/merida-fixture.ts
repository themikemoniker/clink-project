// The second seller. Same shape as ./fixture.ts, different sale, different key, different
// Lightning.Pub account — and that is the whole point of it existing.
//
// WHY A SECOND FIXTURE AND NOT MORE ITEMS IN THE FIRST. /docs/spike-findings.md §11 says one Pub
// can host a market of sellers, and until now nothing in this repo had ever proved it: every
// listing on the relays, every offer on the node and every nsite was signed by /spike/.dev-key.
// This file is the other half of that proof — `spike/.merida-key` owns its own custodial
// sub-account on the same node (`GetOrCreateNostrAppUser`, created on its first RPC), holds its
// own CLINK Manage grant, and publishes its own kind 30405. The seeder and the offer minter are
// unchanged apart from a `--key`/`--fixture` pair.
//
// READ /docs/spec.md §3.1 BEFORE ONBOARDING ANYBODY REAL THIS WAY. Both keys here are ours, so
// the Pub is still model 1 — our own sats, our own node. It becomes model 2, and us a custodian,
// the moment the balance in one of these accounts belongs to someone else.
//
// Nothing here is recalled: the geohash below was encoded from coordinates and decoded back
// through `storefront/src/render.ts` `geoUri` before it was written down, which is the check
// slice 9 added after the first fixture's `g` spent eight slices 5.9 km off its own `location`.
import type { FixtureItem } from './fixture.ts'

// One definition each, shared with the first sale. A per-seller spelling of REFUND_POINTER is a
// seller whose buyers cannot be refunded; a per-seller relay list is a storefront that reads from
// somewhere its own seeder never wrote.
export { REFUND_POINTER, SALE_RELAYS, offerPriceSats } from './fixture.ts'

export const SALE = {
  // A constant, not a date — same reasoning `builder/src/sale.ts` `DEFAULT_SALE` states at
  // length: the `d` addresses the collection forever and prefixes every item's own `d`, so a
  // date in it orphans the whole sale the first time this seller runs a second one.
  d: 'artesanias',
  title: 'Artesanías yucatecas — taller familiar',
  summary: 'Domingos en el Centro, 9am–3pm. Efectivo, o Lightning.',
  location: 'Centro, Mérida, Yucatán',
  // 20.9667, -89.6230 — ±76 m, about a block off the Plaza Grande. Encoded from 20.9674,
  // -89.6237 and round-tripped through `geoUri`, which prints `geo:20.9667,-89.6230`.
  g: 'd58r28f',
}

// Priced so that ANY SINGLE ITEM settles against the node's real inbound (90,374 sats measured
// 2026-08-21, and shared with the first seller's account — one channel, two tenants). The first
// fixture deliberately carries two items priced above inbound to exercise the failure; this one
// does not repeat that, because what it is here to demonstrate is a second seller taking money.
//
// Titles are in Spanish because the seller is, and because nothing in this project had published
// a listing with a non-ASCII character in it until now.
export const ITEMS: FixtureItem[] = [
  { d: 'hamaca', title: 'Hamaca matrimonial de algodón', price: ['25000', 'sats'], stock: '2',
    summary: 'Tejida a mano en el taller, hilo de algodón, 4 m de largo. Aguanta dos personas.', photo: true },
  { d: 'huipil', title: 'Huipil bordado a mano', price: ['18000', 'sats'], stock: '1',
    summary: 'Bordado en punto de cruz, flores de maculís. Tres semanas de trabajo. Pieza única.', photo: true },
  { d: 'jipi', title: 'Sombrero de jipijapa', price: ['12000', 'sats'], stock: '3',
    summary: 'Tejido en las cuevas de Becal, donde la humedad mantiene la fibra flexible. Se enrolla y no se rompe.', photo: true },
  { d: 'bolsa', title: 'Bolsa de henequén tejida', price: ['6000', 'sats'], stock: '4',
    summary: 'Fibra de henequén de la región, asa de piel curtida.', photo: true },
  // The cheap one, and every sale needs one: 3,000 sats is the item you buy on stage without
  // thinking about it. Same role `mugs` plays in the first fixture.
  { d: 'miel', title: 'Miel de abeja melipona, 250 ml', price: ['3000', 'sats'], stock: '6',
    summary: 'Abeja melipona, sin aguijón, de meliponario propio. Cosecha de marzo.', photo: true },
  { d: 'jabon', title: 'Jabón artesanal de miel y avena', price: ['800', 'sats'], stock: '12',
    summary: 'Hecho en frío con la misma miel. Barra de 100 g.', photo: true },
  // Cash only, priced in pesos: no offer, no Buy button, and the storefront says so out loud
  // since slice 8. Keeps the no-offer render path exercised on this sale too.
  { d: 'alpargatas', title: 'Alpargatas de piel, hechas a mano', price: ['450', 'MXN'], stock: '5',
    summary: 'Suela de llanta, piel de res. Efectivo en el puesto — se miden en el momento.', photo: true },
  // Sold, so it gets no offer and no sticker (`builder/src/stickers.ts` `stickerItems`).
  { d: 'guayabera', title: 'Guayabera de lino, hecha a medida', price: ['22000', 'sats'], status: 'sold',
    summary: 'VENDIDA — se hacen por encargo, pregunta en el puesto.', photo: true },
]

export const listingD = (item: FixtureItem) => `${SALE.d}-${item.d}`
