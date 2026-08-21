// The fixture sale, shared by seed-listings.ts (publishes it) and mint-offers.ts (mints one
// CLINK offer per buyable item). Extracted in slice 2 so the two scripts cannot drift: an
// offer minted for an item the listing prices differently is the exact failure the slice-2
// brief calls out ("the offer and the displayed price must agree").
//
// IT DOES NOT DIE WITH /spike, and it used to say it would. Slice 4 landed the real Signer and
// /builder imports this file rather than duplicating it: SALE (listing.ts, main.ts), SALE_RELAYS
// (publish.ts) and REFUND_POINTER (manage.ts). Two spellings of REFUND_POINTER is a sale where
// half the items cannot be refunded, so one definition is the point. Nor does /spike/.dev-key
// die at slice 4 — that decision was reversed on 2026-08-21; the reasoning is in the header of
// ./seed-listings.ts and it is the current one.

// Where this fixture sale lives. Shared so the seeder that publishes a listing and the watcher
// that republishes it cannot end up pointing at different relays — a mismatch there is a
// watcher that works perfectly and a storefront that never sees the update.
// The storefront's own copy is in storefront/src/main.ts, which slice 5 will generate.
// The one payer_data key this project defines, decided in slice 2 because offers are minted
// against it and getting it wrong means re-minting every offer (/docs/spec.md §7.3). CLINK
// enumerates no payer_data keys at all (/docs/clink-notes.md §8), so the name is ours. Declared
// REQUIRED on every offer: Lightning.Pub then refuses to issue an invoice to a payer who did
// not supply a refund pointer, which turns "we hope we can refund an oversell" into a form field.
//
// It lived in mint-offers.ts until slice 4. It moved here because the builder mints offers too
// (over CLINK Manage) and that file cannot be imported — it is a script with top-level effects.
// Two spellings of this string is a sale where half the items cannot be refunded.
export const REFUND_POINTER = 'refund_pointer'

export const SALE_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
]

export const SALE = {
  d: 'yardsale-2026-08',
  title: 'Moving Sale — Colonia Americana',
  summary: 'Saturday 23 August, 8am–2pm. Cash, or Lightning. Everything must go.',
  location: 'Colonia Americana, Guadalajara',
  g: '9ewmr4z', // geohash, NIP-99 99.md:53
}

export type FixtureItem = {
  d: string
  title: string
  price: [amount: string, currency: string]
  stock?: string
  status?: string
  summary?: string
  photo?: boolean
}

// Deliberately uneven: some fields missing, three ways of being unavailable, two currencies.
// The storefront parser has to survive all of it. Hostile inputs are NOT published here —
// they live in storefront/src/listing.test.ts, because this writes to public relays.
//
// PRICES ARE AUTHORED IN SATS wherever an item is meant to be buyable. That is slice 2's
// answer to the fiat→sats question: there is no conversion, because a conversion needs a
// price oracle and an oracle is somebody else's server (/CLAUDE.md rule 1). The seller writes
// the sats number, the listing displays that number, and the offer is minted at that same
// number. Items priced in fiat are cash-only and get no offer — which is honest for a yard
// sale, and keeps a fiat listing in the fixture so the no-offer render path stays exercised.
export const ITEMS: FixtureItem[] = [
  { d: 'couch',   title: 'Green velvet couch, 3-seat',  price: ['210000', 'sats'], stock: '1',
    summary: 'Some sun-fade on the left arm, no tears, no smell. You bring friends and a truck.', photo: true },
  { d: 'bike',    title: 'Bianchi road bike, 54cm',     price: ['180000', 'sats'], stock: '1',
    summary: 'Recently serviced. New chain and bar tape.', photo: true },
  { d: 'lamp',    title: 'Brass floor lamp',            price: ['30000', 'sats'],  stock: '3',
    summary: 'Three of these. Rewired, all work.', photo: true },
  // The cheap multi-unit item, added 2026-08-21 to prove slice 3's decrement with real money
  // without spending 30,000 sats a go. Same shape as `lamp` — priced in sats, stock 3, so it
  // exercises the identical ladder — at 1/30th the cost per settlement. Two payments prove the
  // decrement and that the node reports two DISTINCT settled invoices against one offer, which
  // is the only part of watch-sales.ts money had not yet touched. The third unit is deliberately
  // left unsold: it is a 1,000-sat item to sell live on stage instead of a 30,000-sat one.
  { d: 'mugs',    title: 'Coffee mugs, mismatched',     price: ['1000', 'sats'],   stock: '3',
    summary: 'Three left, none of them a matching pair. All survived the move.', photo: true },
  // priced in pesos: cash only, no offer, no Buy button
  { d: 'records', title: 'Records, jazz and salsa',     price: ['80', 'MXN'],      stock: '24',
    summary: 'Priced each, cash at the table. Mostly VG+, a few beat up — dig through the crate.', photo: true },
  { d: 'table',   title: 'Oak dining table + 4 chairs', price: ['175000', 'sats'], stock: '0',
    summary: 'SOLD — leaving it up so you can see what a sold item looks like.', photo: true },
  { d: 'mirror',  title: 'Full-length mirror',          price: ['22000', 'sats'],  status: 'sold',
    summary: 'Gone. Sold the old way, with a status tag instead of a stock count.', photo: true },
  // no summary, no stock tag at all — parser must not assume either exists
  { d: 'plants',  title: 'Houseplants, various',        price: ['6000', 'sats'], photo: true },
  // no photo — the storefront must lay out fine without one
  { d: 'boxes',   title: 'Moving boxes, free',          price: ['0', 'MXN'],       stock: '12',
    summary: 'Free. Take them, please. They are in the garage.' },
]

export const listingD = (item: FixtureItem) => `${SALE.d}-${item.d}`

const sold = (item: FixtureItem) => item.status === 'sold' || item.stock === '0'

// An item gets an offer only if it is priced in whole sats, above Lightning.Pub's hardcoded
// 10-sat floor (offerManager.ts:224,251), and is still for sale. Sold items deliberately get
// no offer: /docs/spec.md §7.4(a) makes "the offer stops existing" the decline mechanism.
export const offerPriceSats = (item: FixtureItem): number | undefined => {
  if (sold(item) || !/^sats?$/i.test(item.price[1])) return undefined
  const sats = Number(item.price[0])
  return Number.isSafeInteger(sats) && sats >= 10 ? sats : undefined
}
