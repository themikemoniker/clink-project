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
  loadStorefront,
  MANIFEST_KIND,
  manifestTemplate,
  serverListTemplate,
  siteUrl,
  storefrontPaths,
  withQR,
  type SiteFile,
} from './deploy.ts'
import type { Signer } from './signer.ts'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { errLine, fmt, STRINGS } from './i18n.ts'
import { resize } from './photos.ts'
import { PublishError } from './publish.ts'
import type { DeployStep } from './deploy.ts'

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

// #103: a step the builder can show in the seller's language. Each problem is one line, so a
// step with no key, an unknown key, or a {slot} left unfilled is named in the failure.
const stepProblems = (steps: DeployStep[]): string[] =>
  steps.flatMap(s => {
    if (!s.key) return [`${s.kind}: no key`]
    if (!(s.key in STRINGS)) return [`${s.kind}: ${s.key} is not in STRINGS`]
    const slots = [...STRINGS[s.key]!.en.matchAll(/\{(\w+)\}/g)].map(m => m[1]!)
    const unfilled = slots.filter(n => typeof s.vars?.[n] !== 'string')
    if (unfilled.length) return [`${s.kind}: ${s.key} has no ${unfilled.join(', ')}`]
    // The table's English is the text deploy.ts writes, so the spike script's log is unchanged.
    return fmt('en', s.key, s.vars) === s.text ? [] : [`${s.kind}: ${s.key} reads "${fmt('en', s.key, s.vars)}", not "${s.text}"`]
  })

// A relay that says OK to every EVENT, and nothing else. Fake URLs only; no socket is opened.
class FakeRelaySocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
  readyState = 0
  onopen?: () => void; onmessage?: (ev: { data: string }) => void; onclose?: () => void; onerror?: () => void
  url: string
  constructor(url: string) { this.url = url; setTimeout(() => { this.readyState = 1; this.onopen?.() }, 0) }
  send(msg: string) {
    const [type, ev] = JSON.parse(msg) as [string, { id: string }]
    if (type === 'EVENT') setTimeout(() => this.onmessage?.({ data: JSON.stringify(['OK', ev.id, true, '']) }), 0)
  }
  close() { this.readyState = 3 }
}

test('every deploy step names a table line with all its slots filled, and the last one is the site', async () => {
  const realFetch = globalThis.fetch
  const puts: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    puts.push(String(input))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  useWebSocketImplementation(FakeRelaySocket)
  const steps: DeployStep[] = []
  try {
    const servers = ['https://a.example.test', 'https://b.example.test']
    const relays = ['wss://r1.example.test', 'wss://r2.example.test', 'wss://r3.example.test']
    const result = await deploy(signer, relays, site(), { gateway: 'example.test', servers }, s => steps.push(s))
    strictEqual(puts.length, 4) // two files on two servers: the fakes really were reached
    deepStrictEqual(steps.map(s => s.kind), ['hash', 'upload', 'upload', 'upload', 'upload', 'upload', 'publish', 'done'])
    deepStrictEqual(stepProblems(steps), [])
    deepStrictEqual(steps[0]!.vars, { n: '2' })
    deepStrictEqual(steps.at(-2)!.vars, { n: '3' })
    deepStrictEqual(steps[5]!.vars, { done: '4', total: '4' })
    const done = steps.at(-1)!
    strictEqual(done.key, 'deploy.live')
    strictEqual(done.vars.url, result.url)
    strictEqual(result.relaysOk, 3)
  } finally {
    globalThis.fetch = realFetch
    useWebSocketImplementation(globalThis.WebSocket)
  }
})

test('the step check (L1) goes red on a missing key, an unknown key and an unfilled slot', () => {
  const good: DeployStep = { kind: 'done', text: 'Live at https://example.test/site', key: 'deploy.live', vars: { url: 'https://example.test/site' } }
  deepStrictEqual(stepProblems([good]), [])
  deepStrictEqual(stepProblems([{ ...good, key: '' }]), ['done: no key'])
  deepStrictEqual(stepProblems([{ ...good, key: 'deploy.nope' }]), ['done: deploy.nope is not in STRINGS'])
  deepStrictEqual(stepProblems([{ ...good, vars: {} }]), ['done: deploy.live has no url'])
  deepStrictEqual(stepProblems([{ ...good, vars: { url: 'https://other.test' } }]).length, 1)
})

test('content types come from the extension, and an unknown one is not guessed', () => {
  strictEqual(contentType('/index.html'), 'text/html')
  strictEqual(contentType('/assets/index-BQaELXyb.js'), 'text/javascript')
  strictEqual(contentType('/assets/index-BwpsJq0V.css'), 'text/css')
  strictEqual(contentType('/photo.JPG'), 'image/jpeg')
  strictEqual(contentType('/weird.bin'), 'application/octet-stream')
})

// #167: the specific deploy and photo failures are PublishErrors with a table key, so the builder
// shows its own Spanish line instead of "Algo salió mal". All offline. The signer is a fixed fake
// (a made-up pubkey and a zero signature): no key exists here (CLAUDE.md rule 2).
const FAKE_PK = 'f'.repeat(64)
const fakeSigner: Signer = {
  label: 'fake',
  getPublicKey: async () => FAKE_PK,
  signEvent: async (e: EventTemplate) => ({ ...e, pubkey: FAKE_PK, id: '0'.repeat(64), sig: '0'.repeat(128) }) as VerifiedEvent,
  nip44Encrypt: async () => '',
  nip44Decrypt: async () => '',
  close: async () => {},
}
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not throw') }, (e: unknown) => e)
const keyed = (err: unknown, key: string, message: string) => {
  ok(err instanceof PublishError, `not a PublishError: ${String(err)}`)
  strictEqual(err.name, 'PublishError')
  strictEqual(err.key, key)
  strictEqual(err.message, message) // English is the old text, word for word
  strictEqual(errLine(err).key, key) // a key missing from the table would fall back to err.generic here
  strictEqual(fmt('en', key, err.vars), message)
  ok(!fmt('es', key, err.vars).includes('{'), `${key}: es shows a slot`)
  return err
}

test('deploy (#167): a file list without /index.html or /404.html rejects keyed deploy.badBuild', async () => {
  keyed(await caught(deploy(fakeSigner, [], [file('/404.html', 'x')], { dryRun: true })), 'deploy.badBuild', 'No /index.html — that is not a site.')
  keyed(await caught(deploy(fakeSigner, [], [file('/index.html', 'x')], { dryRun: true })), 'deploy.badBuild', 'No /404.html — NIP-5A 5A.md:196 requires it.')
})

test('storefrontPaths and loadStorefront (#167): an unreadable file list or a missing file rejects keyed deploy.badBuild', async () => {
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch
    const listMsg = 'Could not read the storefront file list (404). Run `npm run build` in /builder.'
    keyed(await caught(storefrontPaths()), 'deploy.badBuild', listMsg)
    keyed(await caught(loadStorefront()), 'deploy.badBuild', listMsg)
    // The list reads fine but one file is gone.
    globalThis.fetch = (async (input: string | URL | Request) =>
      String(input).endsWith('/site.json')
        ? { ok: true, status: 200, json: async () => ['/index.html'] }
        : { ok: false, status: 404 }) as unknown as typeof fetch
    keyed(await caught(loadStorefront()), 'deploy.badBuild', 'Missing storefront file /index.html (404).')
  } finally {
    globalThis.fetch = realFetch
  }
})

// A relay that refuses every EVENT. Fake URLs only; no socket is opened.
class RefusingRelaySocket extends FakeRelaySocket {
  override send(msg: string) {
    const [type, ev] = JSON.parse(msg) as [string, { id: string }]
    if (type === 'EVENT') setTimeout(() => this.onmessage?.({ data: JSON.stringify(['OK', ev.id, false, 'blocked: test']) }), 0)
  }
}

test('deploy (#167): no relay taking the manifest rejects keyed deploy.noRelay with the kind', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  useWebSocketImplementation(RefusingRelaySocket)
  try {
    const err = keyed(
      await caught(deploy(fakeSigner, ['wss://r1.example.test'], site(), { gateway: 'example.test', servers: ['https://a.example.test'] })),
      'deploy.noRelay',
      `No relay accepted the kind ${MANIFEST_KIND}. The site cannot resolve — try again.`,
    )
    deepStrictEqual(err.vars, { kind: String(MANIFEST_KIND) })
    ok(!fmt('es', 'deploy.noRelay', err.vars).includes(String(MANIFEST_KIND)), 'es shows the kind number')
  } finally {
    globalThis.fetch = realFetch
    useWebSocketImplementation(globalThis.WebSocket)
  }
})

test('resize (#167): a 1 GB photo rejects keyed photo.tooBig before it is decoded', async () => {
  const err = keyed(await caught(resize({ size: 1e9, name: 'a.jpg' } as File)), 'photo.tooBig', 'a.jpg is 1000.0 MB — too large.')
  strictEqual(err.vars?.mb, '1000.0')
  strictEqual(err.vars?.name, 'a.jpg')
  const es = fmt('es', 'photo.tooBig', err.vars)
  ok(!es.includes('a.jpg') && !es.includes('1000'), `es shows the name or size: ${es}`)
})

test('resize (#167): a browser with no 2d canvas rejects keyed photo.noCanvas', async () => {
  const g = globalThis as Record<string, unknown>
  const saved = { createImageBitmap: g.createImageBitmap, OffscreenCanvas: g.OffscreenCanvas }
  g.createImageBitmap = async () => ({ width: 800, height: 600, close: () => {} })
  g.OffscreenCanvas = class { getContext() { return null } }
  try {
    keyed(await caught(resize({ size: 1000, name: 'a.jpg' } as File)), 'photo.noCanvas', 'This browser will not give us a 2d canvas, so photos cannot be resized.')
  } finally {
    Object.assign(g, saved)
  }
})
