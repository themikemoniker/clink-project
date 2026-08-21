import './style.css'
import { closeBuy } from './buy.ts'
import { orderBySale, parseListings, parseSales, sellerFromLocation, type Item } from './listing.ts'
import { fetchSaleEvents } from './nostr.ts'
import { renderDetail, renderFlyerFoot, renderIndex, renderMasthead, SITE_NAME } from './render.ts'

// Slice 5 deleted this page's build-time constants. It used to carry a hardcoded SELLER_PUBKEY
// plus a `define`d npub and site URL, which meant one build per seller — and a builder that
// carries a pre-built storefront cannot ship one seller's key inside it. An nsite is served at
// `<npub>.<gateway>` (NIP-5A 5A.md:136), so the page reads its own seller out of the hostname
// and its own URL out of `location.origin`. One build, any seller. See listing.ts
// `sellerFromLocation` for the fallback that makes `npm run dev` work.
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
]

const app = document.querySelector<HTMLDivElement>('#app')!
const seller = sellerFromLocation(location.hostname, location.search)

if (!seller) {
  // Not on a gateway and no `?seller=`. Nothing to fetch, and fetching for nobody would render
  // an empty sale that looks like a dead relay rather than a wrong URL.
  app.replaceChildren(
    renderMasthead(undefined, ''),
    Object.assign(document.createElement('main'), {
      className: 'items empty',
      textContent:
        'This page reads its sale from the address it is served at. Open it as npub1….nsite.lol, or add ?seller=npub1… while developing.',
    }),
  )
} else {
  const events = await fetchSaleEvents(seller.pubkey, RELAYS)
  const sale = parseSales(events, seller.pubkey)[0]
  const items = orderBySale(parseListings(events, seller.pubkey), sale)
  const byD = new Map<string, Item>(items.map(i => [i.d, i]))

  // Hash routing, because it is the only kind of routing a static site on an arbitrary gateway
  // gets for free. NIP-5A (5A.md:196) guarantees /404.html as a fallback for unknown paths, so
  // path routing is possible — but it costs a round trip through a 404 on every deep link, and
  // slice 1 does not need one.
  const route = () => {
    // Leaving an item drops any open payment subscription with it. Without this, walking the sale
    // leaves a relay socket per item behind, listening for receipts nobody is waiting for.
    closeBuy()
    const match = /^#\/item\/(.+)$/.exec(location.hash)
    const item = match?.[1] ? byD.get(decodeURIComponent(match[1])) : undefined
    app.replaceChildren(
      renderMasthead(sale, seller.npub),
      item ? renderDetail(item) : renderIndex(items),
      renderFlyerFoot(sale, location.origin),
    )
    document.title = item ? `${item.title} — ${sale?.title ?? SITE_NAME}` : (sale?.title ?? SITE_NAME)
    if (item) window.scrollTo(0, 0)
  }

  addEventListener('hashchange', route)
  route()
}
