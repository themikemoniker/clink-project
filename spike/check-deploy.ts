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
const fetchBody = async (url: string, allow404 = false) => {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) }).catch(() => null)
  if (!res || (!res.ok && !(allow404 && res.status === 404))) return { res, hash: null }
  return { res, hash: await sha256(new Uint8Array(await res.arrayBuffer())) }
}
const fetchHash = async (url: string, allow404 = false) => (await fetchBody(url, allow404)).hash

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
// ITEM 18. "Did my deploy land" used to get three answers here and the third one only said
// STALE. STALE alone does not separate "wait twenty more minutes" from "waiting has already
// failed", which is the only distinction an operator can act on. So this section now prints the
// freshness headers the gateway ACTUALLY sends — read off the response, never assumed — and
// turns them into one verdict.
const fmtAge = (s: number) => {
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${Math.max(0, Math.floor(s))}s`
}

if (!process.argv.includes('--skip-gateway')) {
  console.log(`\n# 4. GATEWAY — a cache in front of the two above, NOT the source of truth\n`)
  let stale = 0
  let firstStale: string | null = null
  let staleServesBytes = false
  let headers: Headers | null = null
  let etagIsBodyHash: boolean | null = null
  for (const p of paths) {
    const { res, hash: got } = await fetchBody(`${base}${p.path}`)
    const ok = got === p.sha256
    // Prefer a stale path the gateway actually ANSWERS for the escape-hatch probe below. A
    // stale asset path 404s (the cached index.html names different filenames), and "(nothing)"
    // busted still reads "(nothing)", which proves nothing either way.
    if (!ok) { stale++; if (firstStale === null || (got !== null && staleServesBytes === false)) { firstStale = p.path; staleServesBytes = got !== null } }
    headers ??= res?.headers ?? null
    // The gateway's ETag looks like the sha256 of the bytes it served. If that holds, `curl -sI`
    // answers the staleness question with no body at all. Asserted every run rather than
    // believed, because a cheap check that is quietly wrong is worse than no cheap check.
    // `W/` matters: the gateway weak-tags the SAME sha256 when it negotiates gzip, so a naive
    // quote-strip reports a false mismatch on any client that sends `accept-encoding`. Measured
    // 2026-08-26: identity gives `"<sha>"`, gzip gives `W/"<sha>"`, same digest, and the digest
    // is of the DECOMPRESSED bytes.
    if (res && got) etagIsBodyHash = (etagIsBodyHash ?? true) && res.headers.get('etag')?.replace(/^W\//, '').replace(/"/g, '') === got
    console.log(`  ${ok ? 'ok  ' : 'STALE'} ${p.path.padEnd(34)} ${ok ? 'byte-identical' : `serving ${got?.slice(0, 12) ?? '(nothing)'}, manifest says ${p.sha256.slice(0, 12)}`}`)
  }
  const missing = await fetchHash(`${base}/definitely-missing`, true)
  const want = paths.find(p => p.path === '/404.html')?.sha256
  console.log(`  ${missing === want ? 'ok  ' : 'FAIL'} /definitely-missing${' '.repeat(15)} ${missing === want ? 'served our /404.html (5A.md:196)' : 'did NOT serve our /404.html'}`)
  if (missing !== want) failures++

  // --- what the gateway says about its own freshness, as it said it -----------------------------
  const hdr = (n: string) => headers?.get(n) ?? null
  const cc = hdr('cache-control')
  const maxAge = Number(cc?.match(/max-age=(\d+)/)?.[1] ?? NaN)
  const ageHdr = hdr('age')
  const publishedAgo = Date.now() / 1000 - manifest.created_at
  console.log(`\n#      cache-control: ${cc ?? '(not sent)'}`)
  console.log(`#      age:           ${ageHdr ?? '(NOT SENT — the gateway does not expose how much of its window is left)'}`)
  console.log(`#      date:          ${hdr('date') ?? '(not sent)'}`)
  console.log(`#      last-modified: ${hdr('last-modified') ?? '(not sent)'}  <- the BLOB's mtime, not the cache entry's`)
  console.log(`#      etag:          ${etagIsBodyHash === null ? '(nothing served to compare against)' : etagIsBodyHash ? 'IS the sha256 of the bytes served — `curl -sI <url>` answers this whole section without a body' : 'is NOT the sha256 of the bytes served — do not use it as a cheap check'}`)
  console.log(`#      manifest published ${fmtAge(publishedAgo)} ago`)

  if (stale === 0) {
    console.log(`\n#      The gateway is serving exactly what the manifest names. Nothing to wait for.`)
  } else {
    // `last-modified` is deliberately NOT used to date the cache entry. Measured 2026-08-26:
    // the Blossom origin (cdn.hzrd149.com) returns the identical `last-modified` for the same
    // blob, so it is the blob's timestamp travelling through, not when this gateway filled.
    let verdict: string
    if (Number.isFinite(maxAge) && ageHdr !== null && Number.isFinite(Number(ageHdr))) {
      const left = maxAge - Number(ageHdr)
      verdict = left > 0
        ? `the gateway's own \`age\` says ${fmtAge(left)} of a ${fmtAge(maxAge)} window is left. WAIT IT OUT.`
        : `the gateway's own \`age\` says its ${fmtAge(maxAge)} window lapsed ${fmtAge(-left)} ago and it is STILL stale. WAITING IS NOT THE FIX.`
    } else if (Number.isFinite(maxAge) && publishedAgo < maxAge) {
      verdict = `no \`age\` header, so this is inferred from the manifest: published ${fmtAge(publishedAgo)} ago, inside the ${fmtAge(maxAge)} the gateway advertises, so at most ${fmtAge(maxAge - publishedAgo)} to go. WAIT IT OUT.`
    } else if (Number.isFinite(maxAge)) {
      verdict = `no \`age\` header. This manifest was published ${fmtAge(publishedAgo)} ago, which is ${(publishedAgo / maxAge).toFixed(1)}x the ${fmtAge(maxAge)} the gateway advertises. The advertised window lapsed long ago and the gateway is still stale, so WAITING IS NOT THE FIX. Findings §7 recorded this at 70 minutes; it is now ${fmtAge(publishedAgo)}.`
    } else {
      verdict = `the gateway sent no parseable \`max-age\`, so there is no window to reason about. UNVERIFIED.`
    }
    console.log(`\n#      ${stale} path(s) stale — the gateway is serving bytes this manifest does not name.
#      Sections 1 and 2 passed, so the relays and Blossom already hold the new version
#      and the deploy itself landed.
#
#      HOW LONG IS LEFT: ${verdict}`)

    // Item 18's second bullet: is a cache-busting query string an escape hatch? Findings §7 says
    // no, measured at 70 minutes. Probe it live rather than citing the note, and probe the
    // request-side `no-cache` too, because "I tried a query string" is not the same as "I tried".
    if (firstStale) {
      const wantStale = paths.find(p => p.path === firstStale)!.sha256
      const bust = `${firstStale}?nocache=${x?.slice(0, 12)}`
      const byQuery = await fetchHash(`${base}${bust}`)
      const byHeader = await fetch(`${base}${firstStale}`, { headers: { 'cache-control': 'no-cache', pragma: 'no-cache' }, signal: AbortSignal.timeout(30_000) })
        .then(async r => (r.ok ? await sha256(new Uint8Array(await r.arrayBuffer())) : null))
        .catch(() => null)
      const say = (got: string | null) => (got === wantStale ? 'DEFEATED THE CACHE' : `no — still ${got?.slice(0, 12) ?? '(nothing)'}`)
      console.log(`\n#      ESCAPE HATCH, probed against ${firstStale}:
#        query string  ${bust.slice(firstStale.length).padEnd(22)} ${say(byQuery)}
#        request header cache-control: no-cache  ${say(byHeader)}
#      A stale copy on the gateway's side is not addressable from the client. What IS
#      addressable: every blob is content-addressed on Blossom, so section 2 above is the
#      deploy's proof and the gateway is only the last mile.`)
    }
  }
}

console.log(`\n# ${base}/`)
console.log(`# ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
