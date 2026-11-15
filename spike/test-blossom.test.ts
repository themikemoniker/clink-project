// spike/test-blossom.ts against signed uploads and the real builder client. Run: npm test (in /spike).
// Every key is generated in memory for this run. Binds port 0 on 127.0.0.1.
//
// Proved able to fail (L8) by these mutations of test-blossom.ts, each run once and then restored:
//   1. the x check relaxed to "at least one x matches" (`!xs.includes(sha256)`, no length check)
//      -> "batched auth" fails (200, not 401). "wrong hash" and "refused auths" fail after it
//      only because B is then stored, so their `GET B is 404` no longer holds.
//   2. `valid = true` instead of verifyEvent -> "refused auths" fails on its "tampered" case.
//   3. the `xs[0] !== sha256` check removed -> "wrong hash" and "refused auths" fail.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure'
import { mirror } from '../builder/src/blossom.ts'
import type { Signer } from '../builder/src/signer.ts'
import { startTestBlossom } from './test-blossom.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const sk = generateSecretKey()
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const A = new TextEncoder().encode('blob A, the one the token was signed for')
const B = new TextEncoder().encode('blob B, the one actually sent')

let blossom: Awaited<ReturnType<typeof startTestBlossom>>
before(async () => { blossom = await startTestBlossom({ port: 0, maxBlob: 1024 }) })
after(() => blossom.close())

const now = () => Math.floor(Date.now() / 1000)
type Opts = { xs?: string[]; kind?: number; expiration?: number; t?: string }
const authEvent = (o: Opts) => finalizeEvent({
  kind: o.kind ?? 24242,
  created_at: now(),
  tags: [['t', o.t ?? 'upload'], ['expiration', String(o.expiration ?? now() + 300)], ...(o.xs ?? []).map(x => ['x', x])],
  content: 'test upload',
}, sk)
const header = (e: object) => `Nostr ${Buffer.from(JSON.stringify(e)).toString('base64')}`
const put = (bytes: Uint8Array, authorization?: string, type = 'image/jpeg') =>
  fetch(`${blossom.url}/upload`, { method: 'PUT', headers: { 'content-type': type, ...(authorization ? { authorization } : {}) }, body: bytes })
const get = (hash: string, method = 'GET') => fetch(`${blossom.url}/${hash}`, { method })

test('round trip: a signed upload answers its own sha256, and GET returns the same bytes and type', async () => {
  const bytes = new TextEncoder().encode('<!doctype html><p>round trip</p>')
  const res = await put(bytes, header(authEvent({ xs: [sha(bytes)] })), 'text/html')
  assert.equal(res.status, 200, await res.clone().text())
  const body = await res.json()
  assert.equal(body.sha256, sha(bytes))
  assert.equal(body.size, bytes.length)
  assert.equal(body.url, `${blossom.url}/${sha(bytes)}`)
  const back = await fetch(body.url)
  assert.equal(back.status, 200)
  assert.equal(back.headers.get('content-type'), 'text/html')
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), bytes)
  const head = await get(sha(bytes), 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(bytes.length))
})

test('batched auth is refused: two x tags (A first, then B) uploading B is 401 and B is not stored', async () => {
  const res = await put(B, header(authEvent({ xs: [sha(A), sha(B)] })))
  assert.equal(res.status, 401)
  assert.match(await res.text(), /x tags/)
  assert.equal((await get(sha(B))).status, 404)
  assert.equal((await get(sha(A))).status, 404)
})

test('wrong hash is refused: an auth for A with B as the body is 401', async () => {
  const res = await put(B, header(authEvent({ xs: [sha(A)] })))
  assert.equal(res.status, 401)
  assert.match(await res.text(), /not the body's sha256/)
  assert.equal((await get(sha(B))).status, 404)
})

test('refused auths: expired, tampered, missing, wrong kind, no t=upload, garbage; each a 401 with a reason', async () => {
  const x = [sha(B)]
  const tampered = { ...authEvent({ xs: x }), content: 'changed after signing' }
  const cases: Array<[string, string | undefined, RegExp]> = [
    ['expired', header(authEvent({ xs: x, expiration: now() - 1 })), /expiration/],
    ['tampered', header(tampered), /signature/],
    ['missing', undefined, /missing/],
    ['wrong kind', header(authEvent({ xs: x, kind: 1 })), /kind 1,/],
    ['t=delete', header(authEvent({ xs: x, t: 'delete' })), /t=upload/],
    ['not base64 JSON', 'Nostr !!!not-base64{', /not base64 JSON/],
    ['JSON null', `Nostr ${Buffer.from('null').toString('base64')}`, /not an event/],
    ['tags not arrays', header({ ...authEvent({ xs: x }), tags: 'x' }), /not an event/],
  ]
  for (const [name, auth, reason] of cases) {
    const res = await put(B, auth)
    assert.equal(res.status, 401, name)
    assert.match(await res.text(), reason, name)
  }
  assert.equal((await get(sha(B))).status, 404)
})

test('over the size cap is 413 and not stored; unknown blobs and routes are 404', async () => {
  const big = new Uint8Array(2048).fill(7)
  const res = await put(big, header(authEvent({ xs: [sha(big)] })))
  assert.equal(res.status, 413)
  assert.equal((await get(sha(big))).status, 404)
  assert.equal((await fetch(`${blossom.url}/list`)).status, 404)
})

test('client compatibility: the real builder mirror() stores every blob on the test server', async () => {
  const signer: Signer = {
    label: 'test',
    getPublicKey: async () => getPublicKey(sk),
    signEvent: async (e: EventTemplate) => finalizeEvent(e, sk) as VerifiedEvent,
    nip44Encrypt: async () => { throw new Error('unused') },
    nip44Decrypt: async () => { throw new Error('unused') },
    close: async () => {},
  }
  const files = [
    { bytes: new TextEncoder().encode('<!doctype html><p>index</p>'), type: 'text/html' },
    { bytes: new TextEncoder().encode('body{color:red}'), type: 'text/css' },
  ].map(f => ({ ...f, sha256: sha(f.bytes) }))
  const result = await mirror(signer, files, [blossom.url])
  assert.deepEqual(result.complete, [blossom.url])
  for (const f of files) {
    const res = await fetch(result.urls.get(f.sha256)!)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), f.type)
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), f.bytes)
  }
})

test('localhost only: the listening address is 127.0.0.1', () => assert.equal(blossom.address, '127.0.0.1'))

test('node test-blossom.ts --port 0 prints one line and nothing else on startup', async () => {
  const child = spawn(process.execPath, ['test-blossom.ts', '--port', '0'], { cwd: HERE, env: { PATH: process.env.PATH } })
  let out = ''
  await new Promise<void>(ok => child.stdout.on('data', c => { out += c; if (out.includes('\n')) ok() }))
  await new Promise(ok => setTimeout(ok, 200))
  const url = /listening on (\S+)/.exec(out)?.[1]
  const served = url ? await fetch(`${url}/${'0'.repeat(64)}`).then(r => r.status, String) : 'no url'
  child.kill()
  assert.match(out, /^# test blossom listening on http:\/\/127\.0\.0\.1:\d+\n$/)
  assert.equal(served, 404, 'the printed URL answers HTTP')
})
