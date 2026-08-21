// Spike: is a deployed nsite actually deployed? Same contract as check-buy.ts and
// check-manage.ts — it imports the shipped modules rather than re-implementing them, so if this
// file and the builder ever disagree, this file is wrong.
//
// THE REASON THIS EXISTS is /docs/spike-findings.md §7: the gateway sends
// `cache-control: max-age=3600` and serves the previous build until it lapses, so a deploy
// verified by opening the URL is not verified at all. It looks broken when it is fine, and it
// looks fine when it is broken. The manifest on the relays is the source of truth, the blobs on
// Blossom are the site, and the gateway is a cache in front of both.
//
// Three questions, in order of authority:
//   1. RELAYS   — is there a well-formed kind 15128 and a kind 10063, and does the aggregate
//                 hash still match the paths it claims to cover?
//   2. BLOSSOM  — does every server in the 10063 serve every blob, hashing to its own path tag?
//   3. GATEWAY  — does the host serve the same bytes today? A mismatch here is usually the
//                 cache, not a broken deploy, which is why it is reported last and separately.
//
// It also answers the question the first two cannot: given only the hostname, would the page
// find a sale? That is the whole of slice 5's storefront change — the seller is read from
// `location.hostname` rather than compiled in — and it is checked here through the storefront's
// OWN parser against real relays.
//
// Costs nothing, publishes nothing, signs nothing. No key required.
//
// Usage:
//   node check-deploy.ts <npub|hex> [--gateway nsite.lol] [--skip-gateway]
import { SimplePool } from 'nostr-tools/pool'
import { verifyEvent } from 'nostr-tools/pure'
import { decode, npubEncode } from 'nostr-tools/nip19'
import { aggregateHash, DEFAULT_GATEWAY, MANIFEST_KIND, SERVER_LIST_KIND } from '../builder/src/deploy.ts'
import { orderBySale, parseListings, parseSales, sellerFromLocation } from '../storefront/src/listing.ts'
import { fetchSaleEvents } from '../storefront/src/nostr.ts'
import { SALE_RELAYS } from './fixture.ts'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]!
}

const raw = process.argv[2]
if (!raw || raw.startsWith('--')) throw new Error('usage: node check-deploy.ts <npub|hex> [--gateway nsite.lol]')
const pubkey = raw.startsWith('npub1') ? (decode(raw as `npub1${string}`).data as string) : raw
if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error(`not a pubkey: ${raw}`)

const gateway = arg('gateway', DEFAULT_GATEWAY)
const host = `${npubEncode(pubkey)}.${gateway}`
const base = `https://${host}`

let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`)
  if (!ok) failures++
}

const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

// --- 1. the relays hold the site -------------------------------------------------------------
console.log(`\n# 1. RELAYS — the manifest is the site\n`)
const pool = new SimplePool()
const events = await pool.querySync(SALE_RELAYS, { kinds: [MANIFEST_KIND, SERVER_LIST_KIND], authors: [pubkey] })
pool.close(SALE_RELAYS)

const manifest = events.find(e => e.kind === MANIFEST_KIND)
const serverList = events.find(e => e.kind === SERVER_LIST_KIND)
check(!!manifest, `kind ${MANIFEST_KIND} manifest found`)
// 5A.md:188-190 — with neither a 10063 nor `server` tags a host MUST return 404. This is the
// single most common reason a correct-looking deploy does not resolve.
check(!!serverList, `kind ${SERVER_LIST_KIND} server list found — without it a gateway MUST 404`)
if (!manifest || !serverList) {
  console.log(`\n# ${failures} CHECK(S) FAILED — nothing else can be checked without them`)
  process.exit(1)
}

check(verifyEvent(manifest), 'the manifest signature verifies')
check(verifyEvent(serverList), 'the server list signature verifies')
// 5A.md:16 — a root site is kind 15128 and MUST NOT include a `d` tag. One with a `d` tag is an
// addressable event that no gateway will resolve as a root site.
check(!manifest.tags.some(t => t[0] === 'd'), 'the manifest carries no `d` tag (5A.md:16)')

const paths = manifest.tags.filter(t => t[0] === 'path').map(t => ({ path: t[1]!, sha256: t[2]! }))
check(paths.length > 0, `${paths.length} path tags`)
check(paths.some(p => p.path === '/index.html'), '/index.html is in the manifest')
check(paths.some(p => p.path === '/404.html'), '/404.html is in the manifest (5A.md:196)')
check(
  paths.every(p => p.path.startsWith('/') && /^[0-9a-f]{64}$/.test(p.sha256)),
  'every path tag is an absolute path and a lowercase hex sha256 (5A.md:45-49)',
)

const x = manifest.tags.find(t => t[0] === 'x' && t[2] === 'aggregate')?.[1]
check(x === (await aggregateHash(paths)), `the aggregate \`x\` tag matches the paths it covers (${x?.slice(0, 12)}…)`)

const servers = serverList.tags.filter(t => t[0] === 'server').map(t => t[1]!)
check(servers.length > 0, `the server list names ${servers.length}: ${servers.join(', ')}`)
console.log(`\n#      site version ${x}\n#      published ${new Date(manifest.created_at * 1000).toISOString()}`)

// --- 2. Blossom holds the blobs ---------------------------------------------------------------
console.log(`\n# 2. BLOSSOM — the blobs behind the manifest\n`)
// `allow404` matters: 5A.md:196's fallback is served WITH a 404 status, so treating a 404 as
// "nothing" would report the one behaviour we are checking for as a failure.
const fetchHash = async (url: string, allow404 = false) => {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) }).catch(() => null)
  if (!res || (!res.ok && !(allow404 && res.status === 404))) return null
  return sha256(new Uint8Array(await res.arrayBuffer()))
}

let mirrors = 0
for (const server of servers) {
  let served = 0
  for (const p of paths) if ((await fetchHash(`${server}/${p.sha256}`)) === p.sha256) served++
  // The whole point of comparing content addresses rather than trusting a 200 — findings §13.11.
  check(served === paths.length, `${server} serves ${served}/${paths.length} blobs, each hashing to its path tag`)
  if (served === paths.length) mirrors++
}
console.log(
  `\n#      ${mirrors} complete mirror(s). ` +
    (mirrors > 1 ? 'One server garbage-collecting no longer breaks the site.' : 'ONE copy — a single garbage collection breaks this site.'),
)

// --- 3. what the page would show --------------------------------------------------------------
// Slice 5 deleted the storefront's compiled-in SELLER_PUBKEY: the page reads its seller from
// `location.hostname` (5A.md:156-158). This drives that exact function, with the exact hostname
// the site is served at, through the storefront's own parser against the real relays.
console.log(`\n# 3. WHAT THE PAGE WOULD SHOW — from the hostname alone\n`)
const seller = sellerFromLocation(host, '')
check(seller?.pubkey === pubkey, `${host} resolves to ${seller?.pubkey.slice(0, 12) ?? '(nothing)'}…`)
if (seller) {
  const saleEvents = await fetchSaleEvents(seller.pubkey, SALE_RELAYS)
  const sale = parseSales(saleEvents, seller.pubkey)[0]
  const items = orderBySale(parseListings(saleEvents, seller.pubkey), sale)
  const buyable = items.filter(i => i.offer)
  console.log(`#      masthead: ${sale?.title ?? '(no kind 30405 — the page falls back to its own name)'}`)
  for (const i of items) {
    console.log(`#      ${i.sold ? 'SOLD' : ' '.repeat(4)}  ${i.d.padEnd(30)} ${i.offer ? 'buyable' : '-      '} ${i.title}`)
  }
  console.log(`#      ${items.length} item(s), ${buyable.length} with a Buy button`)
  if (items.length === 0) {
    console.log(`#      An empty sale is not a failure: this pubkey has published no listings. The
#      page renders its masthead and "Nothing is listed here yet", which is visibly
#      different from the "cannot tell whose sale this is" state.`)
  }
}

// --- 4. the gateway, which is only a cache ----------------------------------------------------
if (!process.argv.includes('--skip-gateway')) {
  console.log(`\n# 4. GATEWAY — a cache in front of the two above, NOT the source of truth\n`)
  let stale = 0
  for (const p of paths) {
    const got = await fetchHash(`${base}${p.path}`)
    const ok = got === p.sha256
    if (!ok) stale++
    console.log(`  ${ok ? 'ok  ' : 'STALE'} ${p.path.padEnd(34)} ${ok ? 'byte-identical' : `serving ${got?.slice(0, 12) ?? '(nothing)'}, manifest says ${p.sha256.slice(0, 12)}`}`)
  }
  const missing = await fetchHash(`${base}/definitely-missing`, true)
  const want = paths.find(p => p.path === '/404.html')?.sha256
  console.log(`  ${missing === want ? 'ok  ' : 'FAIL'} /definitely-missing${' '.repeat(15)} ${missing === want ? 'served our /404.html (5A.md:196)' : 'did NOT serve our /404.html'}`)
  if (missing !== want) failures++

  if (stale > 0) {
    console.log(`\n#      ${stale} path(s) stale. This is almost always the hour-long gateway cache
#      (findings §7), not a broken deploy — sections 1 and 2 passed, which means the
#      relays and Blossom already have the new version. Wait it out, and do not
#      redeploy on the day of the sale.`)
  }
}

console.log(`\n# ${base}/`)
console.log(`# ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
