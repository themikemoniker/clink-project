// Deploy a static site as an nsite: hash the files, mirror the blobs to Blossom, publish the
// kind 15128 manifest and the kind 10063 server list.
//
// This is /spike/deploy-nsite.ts lifted into a shared module, the way pub-rpc.ts was lifted out
// of mint-offers.ts in slice 3 (/docs/spike-findings.md §13.13 asked for exactly that pattern).
// The script now drives this file, so the two cannot diverge — and the aggregate hash, which is
// the one thing here that fails silently when it is wrong, has exactly one implementation.
//
// Nothing here touches the filesystem or a private key. Files arrive as bytes and every
// signature goes through the Signer, so the same code runs in a browser and in Node 24.
//
// Specs, read rather than recalled:
//   NIP-5A  nips/5A.md   kind 15128 root manifest, path tags, aggregate hash, resolution
//   BUD-03  buds/03.md   kind 10063 user server list
//   BUD-11  buds/11.md   kind 24242 upload auth — see ./blossom.ts
import { SimplePool } from 'nostr-tools/pool'
import { npubEncode } from 'nostr-tools/nip19'
import type { Event, EventTemplate } from 'nostr-tools/pure'
import { mirror, SERVERS } from './blossom.ts'
import type { Signer } from './signer.ts'

export const MANIFEST_KIND = 15128 // 5A.md:16 — root site, one per pubkey
export const SERVER_LIST_KIND = 10063 // BUD-03, referenced by 5A.md:188-190

/** Where nsites resolve by default. Any NIP-5A host server works; this is not a claim. */
export const DEFAULT_GATEWAY = 'nsite.lol'

export type SiteFile = { path: string; bytes: Uint8Array; type: string }
export type HashedFile = SiteFile & { sha256: string }

const TYPES: Record<string, string> = {
  html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', ico: 'image/x-icon', woff2: 'font/woff2', txt: 'text/plain',
  map: 'application/json', xml: 'application/xml',
}

export const contentType = (path: string): string =>
  TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

export const sha256 = async (bytes: Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))

/**
 * The aggregate hash — 5A.md:78-84, exactly:
 *
 *   1. Collect every `path` tag.
 *   2. For each tag, produce a line in the exact format `<sha256hash> <absolute-path>\n`.
 *   3. Sort all lines in ascending lexicographic order.
 *   4. Concatenate the sorted lines as UTF-8 bytes.
 *   5. Compute the SHA-256 hash of the concatenated bytes.
 *
 * HASH FIRST, THEN PATH. The reverse order produces a wrong-but-plausible digest that nothing
 * downstream would catch — the manifest still publishes, the site still serves, and the `x` tag
 * silently identifies a version that does not exist. Slice 1 cross-checked this implementation
 * against the spec's own `jq … | sort | sha256sum` pipeline (5A.md:96) and both gave
 * `1a15afd6…` for the deployed site (findings §7). Do not re-derive it.
 */
export const aggregateHash = async (files: { path: string; sha256: string }[]): Promise<string> =>
  sha256(new TextEncoder().encode(files.map(f => `${f.sha256} ${f.path}\n`).sort().join('')))

export const hashAll = async (files: SiteFile[]): Promise<HashedFile[]> =>
  Promise.all(files.map(async f => ({ ...f, sha256: await sha256(f.bytes) })))

/** A root site's canonical URL is a SINGLE DNS label: `<npub>.<gateway>` (5A.md:136, 148). */
export const siteUrl = (pubkey: string, gateway: string): string =>
  `https://${npubEncode(pubkey)}.${gateway.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`

/**
 * Put the flyer's QR into the page on its way to Blossom.
 *
 * design.md §4 has two kinds of QR and this is the storefront one: it encodes the site's own
 * URL and appears on every tear-off tab of the printed flyer. Until slice 5 it was encoded by
 * `storefront/vite.config.ts` at BUILD time, which is precisely what made the storefront a
 * per-seller artifact — the URL contains the seller's npub. Deploy time is the first moment
 * both facts exist at once (the seller has connected, the gateway has been chosen), and doing
 * it here keeps design.md §4's real requirement: the page ships no QR encoder at all.
 *
 * `uqr` is dynamically imported so a deploy is the only thing that ever fetches it — the same
 * arrangement the storefront uses behind its Buy button (/docs/spec.md §9).
 */
export const withQR = async (html: string, url: string): Promise<string> => {
  if (!html.includes('<!--QR-->')) return html
  const { renderSVG } = await import('uqr')
  // `pixelSize: 1` is not cosmetic: uqr emits one absolute `M<x>,<y>h…v…h…z` per dark module,
  // so a pixel size of 10 pays two extra digits per module. At 1 the viewBox is the module
  // grid itself and the same code is 3.5 KB smaller in a file every visitor downloads. The
  // <symbol> is scaled by CSS at the tear-off tabs, so nothing renders differently.
  const svg = renderSVG(url, { border: 1, pixelSize: 1 })
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '0 0 33 33'
  const inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
  return html.replace(
    '<!--QR-->',
    `<svg width="0" height="0" style="position:absolute" aria-hidden="true">` +
      `<symbol id="qr" viewBox="${viewBox}">${inner}</symbol></svg>`,
  )
}

export type ManifestMeta = { title?: string; description?: string }

/** 5A.md:16 — kind 15128, and it MUST NOT include a `d` tag. */
export const manifestTemplate = (
  files: { path: string; sha256: string }[],
  aggregate: string,
  servers: string[],
  meta: ManifestMeta,
  now: number,
): EventTemplate => ({
  kind: MANIFEST_KIND,
  created_at: now,
  tags: [
    ...files.map(f => ['path', f.path, f.sha256]), // 5A.md:45-49
    ['x', aggregate, 'aggregate'], // 5A.md:56
    ...(meta.title ? [['title', meta.title]] : []),
    ...(meta.description ? [['description', meta.description]] : []),
    ...servers.map(s => ['server', s]), // 5A.md:58, a hint; the 10063 is the rule
  ],
  content: '',
})

/**
 * BUD-03 — kind 10063, one `server` tag per URL including scheme, most trusted first.
 *
 * This is the tag that makes the site load at all. 5A.md:188-190: a host server MUST try the
 * author's 10063, and with neither a 10063 nor `server` tags on the manifest it MUST return
 * 404. It is once per seller rather than once per deploy — but it is a replaceable event, so
 * republishing costs one signature of a kind the signer already granted and removes an entire
 * class of "the site 404s and nobody knows why".
 */
export const serverListTemplate = (servers: string[], now: number): EventTemplate => ({
  kind: SERVER_LIST_KIND,
  created_at: now,
  tags: servers.map(s => ['server', s]),
  content: '',
})

export type DeployStep =
  | { kind: 'hash'; text: string }
  | { kind: 'upload'; text: string; done: number; total: number }
  | { kind: 'publish'; text: string }
  | { kind: 'done'; text: string }

export type Deployed = {
  url: string
  aggregate: string
  manifest: Event
  serverList: Event
  files: HashedFile[]
  servers: string[]
  relaysOk: number
}

export type DeployOptions = {
  gateway?: string
  servers?: string[]
  meta?: ManifestMeta
  /** Skip every network write. Everything is hashed and both events are built, nothing leaves. */
  dryRun?: boolean
}

/**
 * Deploy one site.
 *
 * The order is load-bearing: the QR is injected BEFORE hashing (it changes index.html's bytes),
 * and the manifest is published only after a server is holding a complete copy. A manifest
 * whose blobs are missing is a site that 404s, and failing loudly here beats discovering it
 * from a buyer standing in a driveway.
 */
export const deploy = async (
  signer: Signer,
  relays: string[],
  files: SiteFile[],
  options: DeployOptions = {},
  onStep: (step: DeployStep) => void = () => {},
): Promise<Deployed> => {
  const { gateway = DEFAULT_GATEWAY, servers = SERVERS, meta = {}, dryRun = false } = options

  // 5A.md:196 — a host server that cannot match a `path` MUST fall back to `/404.html`. Without
  // it, every wrong URL on the deployed site is the gateway's error page rather than ours, and
  // the storefront's hash routing has nothing to land on.
  if (!files.some(f => f.path === '/index.html')) throw new Error('No /index.html — that is not a site.')
  if (!files.some(f => f.path === '/404.html')) throw new Error('No /404.html — NIP-5A 5A.md:196 requires it.')

  const pubkey = await signer.getPublicKey()
  const url = siteUrl(pubkey, gateway)

  onStep({ kind: 'hash', text: `Hashing ${files.length} files…` })
  const withQr = await Promise.all(
    files.map(async f =>
      f.path === '/index.html'
        ? { ...f, bytes: new TextEncoder().encode(await withQR(new TextDecoder().decode(f.bytes), url)) }
        : f,
    ),
  )
  const hashed = await hashAll(withQr)
  const aggregate = await aggregateHash(hashed)

  let live = servers
  if (!dryRun) {
    onStep({ kind: 'upload', text: 'Uploading…', done: 0, total: hashed.length * servers.length })
    const result = await mirror(
      signer,
      hashed.map(f => ({ sha256: f.sha256, bytes: f.bytes, type: f.type })),
      servers,
      (done, total) => onStep({ kind: 'upload', text: `Uploading ${done}/${total}…`, done, total }),
    )
    live = result.complete
    if (live.length === 0) {
      throw new Error('No Blossom server holds a complete copy. Refusing to publish a manifest that cannot resolve.')
    }
  }

  const now = Math.floor(Date.now() / 1000)
  const manifest = await signer.signEvent(manifestTemplate(hashed, aggregate, live, meta, now))
  const serverList = await signer.signEvent(serverListTemplate(live, now))

  let relaysOk = 0
  if (!dryRun) {
    onStep({ kind: 'publish', text: `Publishing the manifest to ${relays.length} relays…` })
    const pool = new SimplePool()
    for (const event of [manifest, serverList]) {
      const results = await Promise.allSettled(
        pool
          .publish(relays, event)
          .map(p => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000))])),
      )
      const ok = results.filter(r => r.status === 'fulfilled').length
      if (event.kind === MANIFEST_KIND) relaysOk = ok
      if (ok === 0) throw new Error(`No relay accepted the kind ${event.kind}. The site cannot resolve — try again.`)
    }
    pool.close(relays)
    onStep({ kind: 'done', text: `Live at ${url}` })
  }

  return { url, aggregate, manifest, serverList, files: hashed, servers: live, relaysOk }
}

/**
 * The storefront's own bytes, fetched from where `bundle-storefront.mjs` put them.
 *
 * A static app cannot run `vite build`, so "generate the site files" means the builder is
 * already carrying them. It carries them as FILES in `public/`, not as base64 inlined into its
 * own JS — that would roughly double the bundle of an app that must itself be fetched blob by
 * blob from a gateway (rule 5). Here they cost one fetch each, and only when somebody deploys.
 *
 * `base` exists so the same call works from `npm run dev` and from the built builder served at
 * a gateway; both are same-origin, which is the only kind of fetch this app makes.
 */
export const storefrontPaths = async (base = ''): Promise<string[]> => {
  const res = await fetch(`${base}/site.json`)
  if (!res.ok) throw new Error(`Could not read the storefront file list (${res.status}). Run \`npm run build\` in /builder.`)
  return (await res.json()) as string[]
}

export const loadStorefront = async (base = ''): Promise<SiteFile[]> => {
  const paths = await storefrontPaths(base)
  return Promise.all(
    paths.map(async path => {
      const file = await fetch(`${base}/site${path}`)
      if (!file.ok) throw new Error(`Missing storefront file ${path} (${file.status}).`)
      return { path, bytes: new Uint8Array(await file.arrayBuffer()), type: contentType(path) }
    }),
  )
}
