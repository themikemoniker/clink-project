// Spike: would slice 6's admin panel edit the LIVE sale without losing anything?
//
// Same contract as check-buy.ts, check-manage.ts and check-deploy.ts — it imports the shipped
// modules rather than re-implementing them, so if this file and /builder ever disagree, this
// file is wrong. What it adds over builder/src/admin.test.ts is the input: the test builds its
// own events, and this drives the real ones off the public relays — including the five the
// fixture seeded before the builder existed.
//
// An edit in nostr is a REPLACEMENT. NIP-01 keeps one event per (kind, pubkey, `d`) and there is
// no update verb, so anything the round trip drops is data the seller loses by pressing Save,
// permanently, with no old version to go back to. That is what this checks.
//
// It also answers the question the browser cannot: is the ladder sitting next to the watcher
// still the ladder for these listings? See ./ladder.ts `isStale`.
//
// Costs nothing, publishes nothing, signs nothing, and touches no node. No key required.
//
// Usage: node check-admin.ts [<npub|hex>]   (defaults to the fixture seller in ./.dev-key)
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SimplePool } from 'nostr-tools/pool'
import { decode, npubEncode } from 'nostr-tools/nip19'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils.js'
import { draftFrom, imetaValues, loadItems, reusableOffer, soldCount } from '../builder/src/admin.ts'
import { listingTags } from '../builder/src/listing.ts'
import { draftFromSale, saleD } from '../builder/src/sale.ts'
import { isStale } from './ladder.ts'
import { SALE_RELAYS } from './fixture.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LADDER_FILE = join(HERE, '.ladder.json')
const KEY_FILE = join(HERE, '.dev-key')

const raw = process.argv[2]
const pubkey = raw
  ? raw.startsWith('npub1')
    ? (decode(raw as `npub1${string}`).data as string)
    : raw
  : existsSync(KEY_FILE)
    ? getPublicKey(hexToBytes(readFileSync(KEY_FILE, 'utf8').trim()))
    : ''
if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('usage: node check-admin.ts [<npub|hex>]')

let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`)
  if (!ok) failures++
}

const ladder: Record<string, { units: number; steps: { created_at: number }[] }> = existsSync(LADDER_FILE)
  ? JSON.parse(readFileSync(LADDER_FILE, 'utf8'))
  : {}

console.log(`\n# ${npubEncode(pubkey)}`)
console.log(`# ${SALE_RELAYS.join(', ')}\n`)

const pool = new SimplePool()
const { items: owned, sale: published } = await loadItems(pool, SALE_RELAYS, pubkey)
pool.close(SALE_RELAYS)

// SLICE 9. The builder authors the sale now rather than importing /spike/fixture.ts's, so this
// script has to read the same one the panel would — its `d` is every item's `d` prefix and
// therefore decides which items the edit form can even address.
const sale = draftFromSale(published)
sale.d = saleD(published)

console.log('# 1. WHAT THE PANEL WOULD SHOW\n')
// Slice 9's own check. `(no kind 30405)` used to read as a graceful fallback; it was the builder
// never publishing one at all. If this line says "no sale", the masthead on the deployed
// storefront is the site's own name and every item's `a` tag points at nothing.
check(!!published, published
  ? `sale "${published.title}" (${sale.d}) listing ${published.itemRefs.length} member(s)`
  : `NO kind 30405 for this pubkey — the storefront falls back to its own name and every item's "a" tag points at a collection that does not exist. Publish the sale in the builder's section 3.`)
check(!published || !!sale.g, sale.g
  ? `its geohash is ${sale.g}, so the neighbourhood is a tappable geo: link`
  : 'no geohash on the sale — the neighbourhood renders as plain text (optional)')
check(owned.length > 0, `${owned.length} item(s) read off the relays, in the sale's own order`)
for (const { item } of owned) {
  const units = ladder[item.d]?.units
  const sold = soldCount(units, item)
  console.log(
    `#      ${item.d.padEnd(30)} ${(item.price ? `${item.price.amount} ${item.price.currency}` : 'no price').padStart(12)}` +
      `  ${(item.sold ? 'sold' : `${item.stock ?? 1} left`).padEnd(8)}` +
      `${sold === undefined ? '(no ladder here)' : `${sold}/${units} gone`}`.padEnd(18) +
      `${item.offer ? 'buyable' : ''}`,
  )
}

console.log('\n# 2. THE EDIT ROUND TRIP — what a Save would rewrite\n')
let editable = 0
for (const { item, event } of owned) {
  const draft = draftFrom(item, event, sale.d)
  if (!draft) {
    // Both refusals are deliberate and both protect the seller's data: this form speaks only
    // sats, and it can only address `d` tags inside this sale.
    console.log(
      `#      ${item.d.padEnd(30)} not editable here — ` +
        (item.price && item.price.currency !== 'sats'
          ? `priced in ${item.price.currency}`
          : 'addressed outside this sale'),
    )
    continue
  }
  editable++
  // The proof, and the bar is asymmetric on purpose. LOSING a tag is data destruction: NIP-01
  // replaces rather than versions, so the old event is gone and there is nothing to recover it
  // from. GAINING one is not — the fixture's items were seeded before slice 4 and carry no
  // `imeta` at all, and two of them say sold with `status` and no `stock`, so a save through the
  // current authoring path correctly fills both in. Additions are reported, losses fail.
  //
  // `published_at` is the timestamp of the save and is expected to move.
  const strip = (tags: string[][]) =>
    tags.filter(t => t[0] !== 'published_at').map(t => t.join(' ')).sort()
  const before = strip(event.tags)
  const after = strip(listingTags(draft, pubkey, event.created_at, sale))
  const lost = before.filter(t => !after.includes(t))
  const added = after.filter(t => !before.includes(t))
  check(
    lost.length === 0,
    `${item.d}: loses nothing on a save (${draft.blobs.length} photo(s), ${draft.servers.length} mirror(s)` +
      `${added.length ? `, gains ${added.length} tag(s)` : ''})`,
  )
  for (const t of lost) console.log(`         LOST:  ${t.slice(0, 110)}`)
  for (const t of added) console.log(`         gains: ${t.slice(0, 110)}`)
}
check(editable > 0, `${editable} of ${owned.length} item(s) are editable in the builder's form`)

console.log('\n# 3. THE OFFER — reused at the same price, abandoned at a different one\n')
// The money-path half. Reuse is what stops an edit minting a second payable offer (CLINK Manage
// `create` is not idempotent — clink-manage.md:226) and it is the ONLY edit path that works on
// the fixture's five, which were minted over the native RPC and are invisible to Manage
// (findings §13.20).
let withOffer = 0
for (const { item, event } of owned) {
  const noffer = event.tags.find(t => t[0] === 'clink_offer')?.[1]
  if (!noffer || !item.price) continue
  withOffer++
  const price = item.price.amount
  check(reusableOffer(noffer, price) === noffer, `${item.d}: its offer is reused at ${price} sats — no second offer minted`)
  check(
    reusableOffer(noffer, price + 1) === undefined,
    `${item.d}: at ${price + 1} sats it is abandoned, so a price edit mints a fresh one`,
  )
  // And what the storefront's own trust boundary already said about it, restated: the listing
  // and the pointer agree, which is why this item has a Buy button today.
  check(item.offer?.priceSats === price, `${item.d}: the listed price and the pointer's own TLV 4 agree`)
}
check(withOffer > 0, `${withOffer} item(s) carry a payable offer`)

console.log('\n# 4. THE LADDER NEXT TO THE WATCHER\n')
if (!existsSync(LADDER_FILE)) {
  console.log(`#      no ${LADDER_FILE} — nothing to judge. Run seed-listings.ts, or publish from the builder.`)
} else {
  const live = new Map(owned.map(({ item }) => [item.d, item.created_at]))
  for (const [d, rung] of Object.entries(ladder)) {
    const stale = isStale(rung.steps, live.get(d))
    check(!stale, `${d}: its ladder is${stale ? ' NOT' : ''} the ladder for the listing on the relays`)
    if (stale) {
      console.log('         The item was edited after this was cut. Publishing a rung would be a silent')
      console.log('         no-op — the relay answers OK and stores nothing — and the item would stay on')
      console.log('         sale after it sold. Download .ladder.json from the builder again and restart.')
    }
  }
}

console.log('\n# 5. WHAT IS DELIBERATELY NOT HERE\n')
console.log(`#      Settled sales. CLINK Manage's only resource is the offer (clink-manage.md:29, and
#      managementManager.ts:115-134 agrees) and GetUserOfferInvoices rides kind 21000, which is
#      keyed on a raw ECDH secret NIP-46 does not expose (findings §13.18). A browser behind a
#      Signer cannot read them at all. Run 'node sales-report.ts' where the node is.`)
const mirrored = owned.filter(o => imetaValues(o.event, 'fallback').length).length
console.log(`#      imeta is read for 'alt' and 'fallback' only. ${mirrored} item(s) name a Blossom mirror.`)

console.log(`\n# ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
