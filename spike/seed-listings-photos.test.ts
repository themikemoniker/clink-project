// spike/seed-listings.ts on a machine that cannot reach its photo host. Run: npm test (in /spike).
// Binds port 0 on 127.0.0.1 for spike/test-relay.ts and for a broken photo host; dials
// 127.0.0.1:1 for the unreachable one, as the brief asks (fetch refuses that port without dialling),
// and a just-closed port for a real ECONNREFUSED. Each test seeds its own throwaway key,
// `.photos-test-<pid>-<n>-key` (gitignored by `spike/.*-key`), from a fixture module written to
// a temp dir whose `d` values are unique to this run, so no photo already in seed-photos/ can
// skip the fetch and pass the test vacuously.
//
// Proved able to fail: run once against seed-listings.ts with only `--photos-from` added and the
// fetch left unwrapped. "unreachable photo host" fails (exit 1, `TypeError: fetch failed`),
// "body cut off" fails (exit 1, `TypeError: terminated`, the failure the #241 review found:
// `res.arrayBuffer()` throwing after the headers arrived) and "non-ok status" fails (exit 1,
// `photo fetch …: 503`). "connection refused" fails as the first does.
// Then, with the fix in, `await res.arrayBuffer()` moved back out of the try (the #241 shape):
// only "body cut off" fails, 3 pass 1 fail.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SimplePool } from 'nostr-tools'

const HERE = dirname(fileURLToPath(import.meta.url))
const PHOTO_DIR = join(HERE, 'seed-photos')
const RUN = `photos-test-${process.pid}`
const TMP = mkdtempSync(join(tmpdir(), `${RUN}-`))

const run = (cmd: string, args: string[]) => {
  const child = spawn(process.execPath, [cmd, ...args], { cwd: HERE, env: { PATH: process.env.PATH } })
  let out = ''
  child.stdout.on('data', c => { out += c })
  child.stderr.on('data', c => { out += c })
  return { child, out: () => out }
}

let relay: ReturnType<typeof run>
let relayUrl = ''
let broken: Server
let brokenHost = ''
before(async () => {
  relay = run('test-relay.ts', ['--port', '0'])
  relayUrl = await new Promise<string>((ok, fail) => {
    relay.child.stdout.on('data', () => { const m = /listening on (\S+)/.exec(relay.out()); if (m) ok(m[1]!) })
    relay.child.once('exit', code => fail(new Error(`test-relay.ts exited ${code}: ${relay.out()}`)))
  })
  // A photo host that answers, then fails: /cut sends headers and half a body and drops the
  // socket; anything else is a 503.
  broken = createServer((req, res) => {
    if (req.url!.startsWith('/cut/')) {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '100000' })
      res.write(Buffer.alloc(1000))
      setTimeout(() => res.socket!.destroy(), 20)
    } else {
      res.writeHead(503).end('down')
    }
  })
  await new Promise<void>(ok => broken.listen(0, '127.0.0.1', ok))
  brokenHost = `127.0.0.1:${(broken.address() as AddressInfo).port}`
})

const keys: string[] = []
const ds: string[] = []
after(() => {
  relay?.child.kill()
  broken?.close()
  for (const key of keys) {
    for (const f of [key, `${key}.offers.json`, `${key}.ladder.json`]) if (existsSync(join(HERE, f))) unlinkSync(join(HERE, f))
  }
  if (existsSync(PHOTO_DIR)) {
    for (const f of readdirSync(PHOTO_DIR)) if (ds.some(d => f.startsWith(`${d}-`))) unlinkSync(join(PHOTO_DIR, f))
  }
})

// Everything seed-listings.ts imports from a fixture (shape copied from spike/fixture.ts): two
// photo items unique to this run, so neither can already be in seed-photos/.
const fixture = (n: number) => {
  const items = ['a', 'b'].map(x => `${RUN}-${n}-${x}`)
  ds.push(...items)
  const file = join(TMP, `fixture-${n}.ts`)
  writeFileSync(file, `
export const SALE_RELAYS = ['ws://127.0.0.1:1']
export const SALE = { d: '${RUN}-${n}-sale', title: 'Photo host test', summary: 'test', location: 'nowhere', g: '9ewmxg9' }
export const ITEMS = ${JSON.stringify(items.map(d => ({ d, title: d, price: ['1000', 'sats'], stock: '1', summary: d, photo: true })))}
export const listingD = (item) => \`\${SALE.d}-\${item.d}\`
export const offerPriceSats = (item) => Number(item.price[0])
`)
  return { items, module: pathToFileURL(file).href }
}

const seed = async (n: number, photosFrom: string) => {
  const key = `.${RUN}-${n}-key`
  keys.push(key)
  const { items, module } = fixture(n)
  const seeder = run('seed-listings.ts', [
    '--key', key, '--fixture', module, '--relays', relayUrl,
    '--blossom', 'http://127.0.0.1:1', '--photos-from', photosFrom,
  ])
  const code = await new Promise<number | null>(ok => seeder.child.once('exit', ok))
  return { code, out: seeder.out(), items }
}

const listingsBy = async (out: string) => {
  const pk = /#\s+hex ([0-9a-f]{64})/.exec(out)?.[1]
  assert.ok(pk, `no pubkey line in the seeder's output:\n${out}`)
  const pool = new SimplePool()
  try {
    return await pool.querySync([relayUrl], { kinds: [30402], authors: [pk] }, { maxWait: 3000 })
  } finally {
    pool.close([relayUrl])
  }
}

const assertPublishedWithoutImages = async (r: Awaited<ReturnType<typeof seed>>, host: string) => {
  assert.equal(r.code, 0, `seed-listings.ts exited ${r.code}:\n${r.out}`)
  assert.doesNotMatch(r.out, /TypeError/)
  const lines = r.out.split('\n').filter(l => l.startsWith('# ') && l.includes(`photo host ${host}`))
  assert.equal(lines.length, 1, `want exactly one "photo host ${host}" line, got ${lines.length}:\n${r.out}`)
  assert.match(lines[0]!, /without images/)
  assert.match(lines[0]!, /seed-photos\//)
  const events = await listingsBy(r.out)
  assert.equal(events.length, r.items.length, `want ${r.items.length} listings on the relay, got ${events.length}`)
  for (const e of events) assert.ok(!e.tags.some(t => t[0] === 'image'), `listing ${e.id} carries an image tag`)
  for (const d of r.items) {
    const left = existsSync(PHOTO_DIR) ? readdirSync(PHOTO_DIR).filter(f => f.startsWith(`${d}-`)) : []
    assert.deepEqual(left, [], `a failed fetch left ${left.join(', ')} in seed-photos/`)
  }
}

test('unreachable photo host: one line naming the host, listings still publish without images, exit 0', async () => {
  const r = await seed(1, 'http://127.0.0.1:1')
  await assertPublishedWithoutImages(r, '127.0.0.1:1')
  // fetch refuses port 1 itself (it is on the Fetch spec's bad-port list), so nothing is dialled.
  assert.match(r.out, /photo host 127\.0\.0\.1:1 unreachable: bad port/)
})

test('connection refused: a port that was just closed gives ECONNREFUSED, and the run still exits 0', async () => {
  const closed = createServer()
  await new Promise<void>(ok => closed.listen(0, '127.0.0.1', ok))
  const host = `127.0.0.1:${(closed.address() as AddressInfo).port}`
  await new Promise(ok => closed.close(ok))
  const r = await seed(4, `http://${host}`)
  await assertPublishedWithoutImages(r, host)
  assert.match(r.out, new RegExp(`photo host ${host} unreachable: connect ECONNREFUSED`))
})

test('body cut off after the headers: the download failure is caught too, nothing half-written is kept', async () => {
  const r = await seed(2, `http://${brokenHost}/cut`)
  await assertPublishedWithoutImages(r, brokenHost)
  assert.match(r.out, new RegExp(`photo host ${brokenHost} unreachable: `))
})

test('non-ok status: one line with the status, listings still publish without images', async () => {
  const r = await seed(3, `http://${brokenHost}`)
  await assertPublishedWithoutImages(r, brokenHost)
  assert.match(r.out, new RegExp(`photo host ${brokenHost} refused: HTTP 503`))
})
