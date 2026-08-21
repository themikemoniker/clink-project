// node --test, no framework — same style as ./listing.test.ts, storefront/src/listing.test.ts
// and spike/ladder.test.ts. This covers the pure half of a deploy: the aggregate hash, the two
// event shapes, and the two refusals that stop a site being published broken.
//
// The network half is proven against real Blossom servers and real relays by
// /spike/deploy-nsite.ts, which drives this module through a key-backed Signer shim the way
// check-manage.ts drives manage.ts.
import { createHash } from 'node:crypto'
import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert'
import test from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import {
  aggregateHash,
  contentType,
  deploy,
  MANIFEST_KIND,
  manifestTemplate,
  serverListTemplate,
  siteUrl,
  withQR,
  type SiteFile,
} from './deploy.ts'
import type { Signer } from './signer.ts'

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const NOW = 1_756_000_000

// The same narrow shim /spike/check-manage.ts uses: four methods over a key held only in
// memory, for the duration of one test process. Nothing persisted, nothing published.
const signer: Signer = {
  label: 'test',
  getPublicKey: async () => pk,
  signEvent: async (e: EventTemplate) => finalizeEvent(e, sk) as VerifiedEvent,
  nip44Encrypt: async (to, text) => encrypt(text, getConversationKey(sk, to)),
  nip44Decrypt: async (to, ct) => decrypt(ct, getConversationKey(sk, to)),
  close: async () => {},
}

const file = (path: string, body: string): SiteFile => ({
  path,
  bytes: new TextEncoder().encode(body),
  type: contentType(path),
})

const site = () => [file('/index.html', '<!doctype html><p>hi'), file('/404.html', '<!doctype html><p>no')]

test('the aggregate hash is hash-then-path, sorted, newline-terminated', async () => {
  // 5A.md:78-84. Computed here the long way, with node:crypto, so this test fails if the
  // implementation is ever "simplified" into agreeing with itself.
  const files = [
    { path: '/index.html', sha256: '186ea5fd14e88fd1ac49351759e7ab906fa94892002b60bf7f5a428f28ca1c99' },
    { path: '/favicon.ico', sha256: 'fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321' },
  ]
  const expected = createHash('sha256')
    .update(files.map(f => `${f.sha256} ${f.path}\n`).sort().join(''))
    .digest('hex')
  strictEqual(await aggregateHash(files), expected)

  // It MUST NOT depend on the order of the tags in the manifest (5A.md:73).
  strictEqual(await aggregateHash([...files].reverse()), expected)
})

test('reversing hash and path produces a different, wrong-but-plausible digest', async () => {
  // The trap findings §7 names by name: `<path> <hash>` still hashes to 64 valid hex characters
  // and nothing downstream would ever notice. This test is the thing that would notice.
  const files = [{ path: '/index.html', sha256: 'a'.repeat(64) }]
  const reversed = createHash('sha256').update(`${files[0]!.path} ${files[0]!.sha256}\n`).digest('hex')
  ok((await aggregateHash(files)) !== reversed)
})

test('a root manifest carries no `d` tag, and does carry the aggregate', async () => {
  const files = [{ path: '/index.html', sha256: 'a'.repeat(64) }]
  const aggregate = await aggregateHash(files)
  const ev = manifestTemplate(files, aggregate, ['https://cdn.hzrd149.com'], { title: 'Sale' }, NOW)

  strictEqual(ev.kind, MANIFEST_KIND)
  // 5A.md:16 — "kind 15128 and MUST NOT include a `d` tag". A `d` tag here makes it an
  // addressable event that no gateway resolves as a root site.
  strictEqual(ev.tags.find(t => t[0] === 'd'), undefined)
  deepStrictEqual(ev.tags.find(t => t[0] === 'path'), ['path', '/index.html', 'a'.repeat(64)])
  deepStrictEqual(ev.tags.find(t => t[0] === 'x'), ['x', aggregate, 'aggregate']) // 5A.md:56
  deepStrictEqual(ev.tags.find(t => t[0] === 'server'), ['server', 'https://cdn.hzrd149.com'])
  strictEqual(ev.content, '')
})

test('the server list is a kind 10063 of bare server tags', () => {
  // Without this event and without `server` tags, a gateway MUST return 404 (5A.md:188-190).
  const ev = serverListTemplate(['https://a.example', 'https://b.example'], NOW)
  strictEqual(ev.kind, 10063)
  deepStrictEqual(ev.tags, [['server', 'https://a.example'], ['server', 'https://b.example']])
})

test('a root site URL is one DNS label', async () => {
  // 5A.md:136, 148 — `<npub>.<gateway>`, single label, so wildcard certs work.
  const url = siteUrl(pk, 'nsite.lol')
  match(url, /^https:\/\/npub1[023456789acdefghjklmnpqrstuvwxyz]{58}\.nsite\.lol$/)
  // A gateway pasted with a scheme or a trailing slash must not produce `https://npub.https://…`
  strictEqual(siteUrl(pk, 'https://nsite.lol/'), url)
})

test('a site with no /404.html is refused before anything is uploaded', async () => {
  // 5A.md:196 makes /404.html the fallback for every unmatched path, and the storefront's hash
  // routing depends on it. Refusing here costs nothing; discovering it from a gateway costs an
  // hour of cache (findings §7).
  await rejects(() => deploy(signer, [], [file('/index.html', 'x')], { dryRun: true }), /404\.html/)
  await rejects(() => deploy(signer, [], [file('/404.html', 'x')], { dryRun: true }), /index\.html/)
})

test('a dry run hashes and signs the real events without touching the network', async () => {
  const result = await deploy(signer, [], site(), { dryRun: true, gateway: 'nsite.lol' })
  strictEqual(result.manifest.kind, MANIFEST_KIND)
  strictEqual(result.serverList.kind, 10063)
  strictEqual(result.manifest.pubkey, pk)
  strictEqual(result.relaysOk, 0)
  strictEqual(result.files.length, 2)
  // Every path tag has a real content address behind it.
  for (const f of result.files) {
    strictEqual(f.sha256, createHash('sha256').update(f.bytes).digest('hex'))
    ok(result.manifest.tags.some(t => t[0] === 'path' && t[1] === f.path && t[2] === f.sha256))
  }
  strictEqual(result.manifest.tags.find(t => t[0] === 'x')?.[1], await aggregateHash(result.files))
})

test('the flyer QR is encoded at deploy time, into the marker the page ships', async () => {
  // storefront/index.html carries `<!--QR-->` and no encoder; slice 5 moved the encoding here
  // because the URL contains the seller's npub and is not known until deploy.
  const html = await withQR('<body><!--QR--></body>', 'https://npub1x.nsite.lol')
  match(html, /<symbol id="qr" viewBox="[\d\s.]+">/)
  ok(!html.includes('<!--QR-->'))
  // A page without the marker is passed through untouched rather than guessed at.
  strictEqual(await withQR('<body></body>', 'https://x'), '<body></body>')
})

test('injecting the QR changes index.html’s hash, so it must happen before hashing', async () => {
  // The ordering bug this guards: hash first, inject second, and every visitor gets a 404 for
  // an index.html whose hash is not the one in the manifest.
  const plain = await deploy(signer, [], site(), { dryRun: true })
  const withMarker = await deploy(signer, [], [file('/index.html', '<body><!--QR--></body>'), file('/404.html', 'x')], {
    dryRun: true,
  })
  const hashOf = (r: typeof plain, path: string) => r.files.find(f => f.path === path)!.sha256
  ok(hashOf(plain, '/index.html') !== hashOf(withMarker, '/index.html'))
  // And the hash in the manifest is the hash of the bytes that were uploaded, not of the input.
  strictEqual(
    hashOf(withMarker, '/index.html'),
    createHash('sha256').update(withMarker.files.find(f => f.path === '/index.html')!.bytes).digest('hex'),
  )
})

test('content types come from the extension, and an unknown one is not guessed', () => {
  strictEqual(contentType('/index.html'), 'text/html')
  strictEqual(contentType('/assets/index-BQaELXyb.js'), 'text/javascript')
  strictEqual(contentType('/assets/index-BwpsJq0V.css'), 'text/css')
  strictEqual(contentType('/photo.JPG'), 'image/jpeg')
  strictEqual(contentType('/weird.bin'), 'application/octet-stream')
})
