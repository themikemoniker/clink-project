import './style.css'
import { orderBySale, parseListings, parseSales, type Item } from './listing.ts'
import { fetchSaleEvents } from './nostr.ts'
import { renderDetail, renderFlyerFoot, renderIndex, renderMasthead } from './render.ts'

// Slice 1 hardcodes the seller, as the build plan says to. Slice 5 (deploy from the app) is
// what writes these into the generated site, at which point this block becomes generated code.
// The pubkey is the throwaway seeding identity from /spike/seed-listings.ts, not a real seller.
const SELLER_PUBKEY = 'fb18e881362a772e1bff2fc260a5ff47cb01d3fa7a254349948603774cdb47a0'
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
]

const app = document.querySelector<HTMLDivElement>('#app')!
// The npub is a pure function of a build-time constant, so it is encoded at build time
// (vite.config.ts) rather than shipping bech32 to every visitor to render one line of chrome.
const npub = __SELLER_NPUB__

const events = await fetchSaleEvents(SELLER_PUBKEY, RELAYS)
const sale = parseSales(events, SELLER_PUBKEY)[0]
const items = orderBySale(parseListings(events, SELLER_PUBKEY), sale)
const byD = new Map<string, Item>(items.map(i => [i.d, i]))

// Hash routing, because it is the only kind of routing a static site on an arbitrary gateway
// gets for free. NIP-5A (5A.md:196) guarantees /404.html as a fallback for unknown paths, so
// path routing is possible — but it costs a round trip through a 404 on every deep link, and
// slice 1 does not need one.
const route = () => {
  const match = /^#\/item\/(.+)$/.exec(location.hash)
  const item = match?.[1] ? byD.get(decodeURIComponent(match[1])) : undefined
  app.replaceChildren(
    renderMasthead(sale, npub),
    item ? renderDetail(item) : renderIndex(items),
    renderFlyerFoot(sale, __SITE_URL__),
  )
  document.title = item ? `${item.title} — ${sale?.title ?? 'Yard Sale'}` : (sale?.title ?? 'Yard Sale')
  if (item) window.scrollTo(0, 0)
}

addEventListener('hashchange', route)
route()
