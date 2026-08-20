// Deploy a built directory as an nsite: blobs to Blossom, manifest to relays.
//
// This exists instead of `nsyte` because nsyte is not on npm (see /docs/spike-findings.md §7),
// its alternatives cost either a Deno runtime with `deno install -A` or a 93 MB unsigned binary,
// and slice 5 has to do this from a browser anyway — where shelling out to a binary is not an
// option. Everything here is the same shape the builder will run in-page, minus the Signer.
//
// KEY HANDLING NOTICE: same throwaway /spike/.dev-key as seed-listings.ts, same /CLAUDE.md
// rule-2 exception, same expiry — delete both when slice 4 lands a real Signer.
//
// Specs, read rather than recalled:
//   NIP-5A  nips/5A.md      root manifest kind 15128, path tags, aggregate hash, resolution
//   BUD-03  buds/03.md      kind 10063 user server list
//   BUD-11  buds/11.md      kind 24242 upload auth (one per blob — see spike-findings §9)
//
// Usage: node deploy-nsite.ts [dir] [--relays wss://a,wss://b] [--blossom https://x,https://y]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SimplePool, finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = join(HERE, '.dev-key')

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]!
}
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))
const DIR = positional[0] ?? join(HERE, '..', 'storefront', 'dist')
const RELAYS = arg('relays', 'wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band,wss://relay.primal.net').split(',')
// cdn.hzrd149.com first, and as of 2026-08-20 it is the only public Blossom server found that
// will store an nsite's HTML/JS/CSS for an unknown pubkey. blossom.band is nostr.build: it takes
// the sale's photos happily and answers `415 File type not allowed` for text. Twelve others
// refuse anonymous uploads outright. See /docs/spike-findings.md §7.
const BLOSSOM = arg('blossom', 'https://cdn.hzrd149.com').split(',')

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE} — run seed-listings.ts first`)
if (!existsSync(join(DIR, 'index.html'))) throw new Error(`${DIR} has no index.html — run \`npm run build\` in /storefront`)
// 5A.md:196 — a host server that cannot match a path MUST fall back to /404.html. Without it
// every wrong URL on the deployed site is the gateway's error page, not ours.
if (!existsSync(join(DIR, '404.html'))) throw new Error(`${DIR} has no 404.html — NIP-5A 5A.md:196 requires it`)

const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const pk = getPublicKey(sk)
console.log(`# deploying ${DIR}\n# as ${nip19.npubEncode(pk)}`)

// --- 1. walk the build ------------------------------------------------------------------
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
}

const files = walk(DIR).map(full => {
  const bytes = readFileSync(full)
  return {
    // 5A.md:47 — "an absolute path ending with a filename and extension". POSIX separators
    // regardless of the host OS, because this is a URL path, not a filesystem path.
    path: '/' + relative(DIR, full).split(/[\\/]/).join(posix.sep),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    type: TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream',
  }
})
console.log(`# ${files.length} files, ${(files.reduce((n, f) => n + f.bytes.length, 0) / 1024).toFixed(1)} KB total`)

// --- 2. upload each blob ----------------------------------------------------------------
// One kind 24242 auth per blob. A batched multi-`x` token is accepted and silently
// misattributed by blossom.band — /docs/spike-findings.md §9. Never batch this.
const authFor = (sha256: string) => {
  const ev = finalizeEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'upload'],                                                    // 11.md:11-19
      ['expiration', String(Math.floor(Date.now() / 1000) + 300)],        // short — 11.md:85-91
      ['x', sha256],
    ],
    content: 'Deploy nsite',
  }, sk)
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64url')}`
}

const live: string[] = []
for (const server of BLOSSOM) {
  let ok = 0
  for (const f of files) {
    try {
      const res = await fetch(`${server}/upload`, {
        method: 'PUT',
        headers: { authorization: authFor(f.sha256), 'content-type': f.type },
        body: f.bytes,
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        console.log(`#   ${server} ${f.path}: ${res.status} ${(await res.text()).slice(0, 120)}`)
        continue
      }
      const body = await res.json().catch(() => ({} as { sha256?: string }))
      // A 200 is not evidence the server stored what we sent. Compare content-addresses.
      if (body.sha256 && body.sha256 !== f.sha256) {
        console.log(`#   ${server} MISATTRIBUTED ${f.path}: asked ${f.sha256.slice(0, 12)}, got ${String(body.sha256).slice(0, 12)}`)
        continue
      }
      ok++
    } catch (err) {
      console.log(`#   ${server} ${f.path}: ${String(err).slice(0, 100)}`)
    }
  }
  console.log(`# ${server}: ${ok}/${files.length} blobs stored`)
  if (ok === files.length) live.push(server)
}
if (live.length === 0) throw new Error('no Blossom server holds a complete copy — refusing to publish a manifest that cannot resolve')

// --- 3. the aggregate hash --------------------------------------------------------------
// 5A.md:75-84, exactly: one `<sha256hash> <absolute-path>\n` line per path tag, sorted
// ascending lexicographically, concatenated as UTF-8, sha256, lowercase hex. Hash first,
// then path — the reverse order silently produces a wrong-but-plausible digest.
const aggregate = createHash('sha256')
  .update(files.map(f => `${f.sha256} ${f.path}\n`).sort().join(''))
  .digest('hex')

// --- 4. publish ---------------------------------------------------------------------------
const now = Math.floor(Date.now() / 1000)

// 5A.md:17 — root site, kind 15128, and it MUST NOT include a `d` tag.
const manifest = finalizeEvent({
  kind: 15128,
  created_at: now,
  tags: [
    ...files.map(f => ['path', f.path, f.sha256]),      // 5A.md:45-49
    ['x', aggregate, 'aggregate'],                       // 5A.md:56
    ['title', 'Moving Sale — Colonia Americana'],
    ['description', 'A yard sale that takes Lightning, with no server anywhere in it.'],
    ...live.map(s => ['server', s]),                     // 5A.md:58, a hint; the 10063 is the rule
  ],
  content: '',
}, sk)

// BUD-03 03.md:7-11 — kind 10063, at least one `server` tag with the full URL including scheme,
// most trusted first, content unused. NIP-5A 5A.md:188-190: a gateway MUST try these, and with
// neither a 10063 nor `server` tags it MUST return 404. This is the tag that makes the site load.
const serverList = finalizeEvent({
  kind: 10063,
  created_at: now,
  tags: live.map(s => ['server', s]),
  content: '',
}, sk)

const pool = new SimplePool()
for (const ev of [manifest, serverList]) {
  const results = await Promise.allSettled(
    pool.publish(RELAYS, ev).map(p =>
      Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000))]),
    ),
  )
  const ok = results.filter(r => r.status === 'fulfilled').length
  const why = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
  console.log(`# kind ${ev.kind} -> ${ok}/${RELAYS.length} relays` + (ok < RELAYS.length && why ? `  (${String(why.reason).slice(0, 80)})` : ''))
  if (ok === 0) console.log(`#   WARNING: kind ${ev.kind} reached no relay; the site will not resolve`)
}
pool.close(RELAYS)

const npub = nip19.npubEncode(pk)
console.log(`
# aggregate  ${aggregate}
# manifest   ${manifest.id}
#
# Try it on any nsite gateway:
#   https://${npub}.nsite.lol/
#   https://${npub}.nsite.lol/definitely-missing        <- should serve /404.html
#
# Verify what actually landed:
#   nak req -k 15128 -a ${pk} wss://relay.damus.io | jq '.tags'
#   nak req -k 10063 -a ${pk} wss://relay.damus.io | jq '.tags'`)
process.exit(0)
