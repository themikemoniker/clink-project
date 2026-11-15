// spike/test-relay.ts against the real round-trip script and the wire. Run: npm test (in /spike).
// Every key is generated in memory for this run. Binds port 0 on 127.0.0.1.
//
// Proved able to fail (L8) by these mutations of test-relay.ts, each run once and then restored:
//   1. `matches` ignores `authors`        -> "round trip" fails on its `authors` query (3 events).
//   2. `matches` ignores `#<letter>` tags -> "round trip" fails on its `#d` query.
//   3. the push loop in `accept` disabled -> "round trip" fails: the check's step 5 prints FAIL.
//   4. `keyOf` drops the `d` tag          -> "replacement" and "round trip" fail.
//   5. the `newestFirst(e, prev) > 0` refusal removed -> "replacement" fails.
//   6. `valid = true` instead of verifyEvent -> "bad signature" fails.
//   7. `f.until !== undefined` back to nostr-tools' `f.until &&` -> "until: 0" fails.
//   8. onReq's `conn.subs.delete(subId)` before validation removed -> "malformed REQ" fails.
//   9. the CLOSE branch in onText made a no-op -> "CLOSE" fails.
//  10. `drop` no longer clears conn.subs / conns -> "socket close" fails.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { startTestRelay } from './test-relay.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const decoySk = generateSecretKey()
const DECOY = getPublicKey(decoySk)
const planted: Event[] = []
let seller: { pubkey: string; d: string; latest: string; stored: number } | undefined

// Plants, synchronously and before the check gets its OK, two kind 30078 events by another author:
// one with the check's own `d` (and newer), one with a different `d`. The check itself cannot see a
// relay drop `authors`: nostr-tools re-runs `matchFilters` on every pushed EVENT
// (lib/esm/abstract-relay.js `_onmessage`). So the raw queries after it do: one that drops
// `authors` returns the decoys under the seller's filter, one that drops `#d` returns the second.
let relay: Awaited<ReturnType<typeof startTestRelay>>
before(async () => {
  relay = await startTestRelay({
    port: 0,
    afterStore: (e, inject) => {
      if (e.kind !== 30078 || e.pubkey === DECOY || !e.content.length) return
      const d = e.tags.find(t => t[0] === 'd')![1]!
      seller = { pubkey: e.pubkey, d, latest: e.id, stored: (seller?.stored ?? 0) + 1 }
      if (planted.length) return
      for (const tag of [d, `${d}-other`]) {
        planted.push(finalizeEvent({ kind: 30078, created_at: e.created_at + 1, tags: [['d', tag]], content: 'decoy' }, decoySk))
        inject(planted.at(-1)!)
      }
    },
  })
})
after(() => relay.close())

// A raw client: every message in arrival order, and a wait for the first one matching `pred`.
const connect = async () => {
  const ws = new WebSocket(relay.url)
  const seen: any[] = []
  const waiters: Array<() => void> = []
  ws.onmessage = m => { seen.push(JSON.parse(m.data as string)); waiters.splice(0).forEach(w => w()) }
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail })
  const until = (pred: (m: any) => boolean) => new Promise<any[]>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`timed out; saw ${JSON.stringify(seen).slice(0, 400)}`)), 5000)
    const check = () => { const i = seen.findIndex(pred); if (i === -1) return waiters.push(check); clearTimeout(t); ok(seen.splice(0, i + 1)) }
    check()
  })
  const send = (...msg: unknown[]) => ws.send(JSON.stringify(msg))
  const publish = (e: Event) => (send('EVENT', e), until(m => m[0] === 'OK' && m[1] === e.id))
  const req = async (id: string, ...filters: unknown[]) => {
    send('REQ', id, ...filters)
    return (await until(m => (m[0] === 'EOSE' || m[0] === 'CLOSED') && m[1] === id)).filter(m => m[0] === 'EVENT').map(m => m[2] as Event)
  }
  const done = () => new Promise(ok => { if (ws.readyState === ws.CLOSED) return ok(0); ws.onclose = ok; ws.close() })
  clients.add(done)
  return { ws, send, until, publish, req, done }
}
// A failed assertion skips a test's own done(); close what it left so later counts stay its own.
const clients = new Set<() => Promise<unknown>>()
afterEach(async () => { await Promise.all([...clients].map(d => d())); clients.clear() })
const sk = generateSecretKey()
const ev = (created_at: number, tags: string[][] = [], kind = 30078, content = '') => finalizeEvent({ kind, created_at, tags, content }, sk)
const pushedTo = (msgs: any[], sub: string) => msgs.filter(m => m[0] === 'EVENT' && m[1] === sub).length

test('round trip: node check-ladder-relay.ts passes against the test relay, which honours authors and #d', async () => {
  const child = spawn(process.execPath, ['check-ladder-relay.ts', '--relays', relay.url], { cwd: HERE, env: { PATH: process.env.PATH } })
  let out = ''
  child.stdout.on('data', c => (out += c))
  child.stderr.on('data', c => (out += c))
  const code = await new Promise(ok => child.on('close', ok))
  // The child's socket may close after it exits; let it, so later tests count only their own.
  for (let i = 0; i < 100 && relay.liveSubscriptions() > 0; i++) await new Promise(ok => setTimeout(ok, 20))
  assert.equal(code, 0, out)
  assert.match(out, /# ALL CHECKS PASSED/)
  assert.ok(seller && planted.length === 2, 'the check published no kind 30078 the relay saw')
  assert.equal(seller.stored, 2, 'the check publishes the ladder, then its replacement')
  const c = await connect()
  const byD = await c.req('d', { kinds: [30078], '#d': [seller.d] })
  assert.deepEqual(byD.map(e => e.id).sort(), [seller.latest, planted[0]!.id].sort())
  const bySeller = await c.req('a', { kinds: [30078], authors: [seller.pubkey] })
  assert.deepEqual(bySeller.map(e => e.id), [seller.latest], 'only the replacement is stored for the seller')
})

test('replacement: only the newest kind 30078 per d is kept, whatever order they arrive in', async () => {
  const c = await connect()
  const [older, newer, other] = [ev(1, [['d', 'same']]), ev(2, [['d', 'same']]), ev(1, [['d', 'other']])]
  const ids = [older.id, newer.id, other.id]
  for (const e of [older, other, newer]) assert.equal((await c.publish(e)).at(-1)[2], true)
  assert.deepEqual((await c.req('r1', { ids })).map(e => e.id).sort(), [newer.id, other.id].sort())
  await c.publish(older)
  assert.deepEqual((await c.req('r2', { ids })).map(e => e.id).sort(), [newer.id, other.id].sort())
})

test('bad signature is answered OK false and is not stored', async () => {
  const c = await connect()
  const bad = { ...ev(3, [], 1, 'tampered'), sig: 'a'.repeat(128) }
  const ok = (await c.publish(bad)).at(-1)
  assert.equal(ok[2], false)
  assert.match(ok[3], /^invalid: /)
  assert.deepEqual(await c.req('b', { ids: [bad.id] }), [])
})

test('localhost only: the listening address is 127.0.0.1', () => assert.equal(relay.address, '127.0.0.1'))

test('until: 0 and limit: 0 are bounds, not "no bound"', async () => {
  const c = await connect()
  const [a, b] = [ev(5, [], 1, 'five'), ev(10, [], 1, 'ten')]
  for (const e of [a, b]) await c.publish(e)
  assert.deepEqual(await c.req('u0', { ids: [a.id, b.id], until: 0 }), [])
  assert.deepEqual((await c.req('u5', { ids: [a.id, b.id], until: 5 })).map(e => e.id), [a.id])
  assert.deepEqual((await c.req('s0', { ids: [a.id, b.id], since: 0 })).map(e => e.id), [b.id, a.id])
  assert.deepEqual(await c.req('l0', { ids: [a.id, b.id], limit: 0 }), [])
})

// L10: each of these publishes on the SAME socket after the rejection or CLOSE. The relay pushes
// before it answers OK, so the OK is the end of the window: no timeout is waited on.
test('malformed REQ reusing a live id is CLOSED and the old subscription gets nothing more', async () => {
  const c = await connect()
  await c.req('dup', { kinds: [1] })
  await c.req('control', { kinds: [1] })
  c.send('REQ', 'dup', { kinds: [1], since: -1 })
  assert.match((await c.until(m => m[0] === 'CLOSED')).at(-1)[1], /^dup$/)
  assert.equal(relay.liveSubscriptions(), 1, 'only the control is still open')
  const msgs = await c.publish(ev(20, [], 1, 'after the rejection'))
  assert.equal(pushedTo(msgs, 'control'), 1, 'positive control: the live subscription was pushed it')
  assert.equal(pushedTo(msgs, 'dup'), 0)
})

test('CLOSE stops delivery', async () => {
  const c = await connect()
  await c.req('gone', { kinds: [1] })
  await c.req('control', { kinds: [1] })
  c.send('CLOSE', 'gone')
  const msgs = await c.publish(ev(21, [], 1, 'after CLOSE'))
  assert.equal(pushedTo(msgs, 'control'), 1, 'positive control')
  assert.equal(pushedTo(msgs, 'gone'), 0)
})

test('socket close ends its subscriptions', async () => {
  const c = await connect()
  await c.req('s', { kinds: [1] })
  assert.equal(relay.liveSubscriptions(), 1)
  await c.done() // the relay drops the subscriptions before it echoes the close frame
  assert.equal(relay.liveSubscriptions(), 0)
})

test('a 70 kB event crosses the 64-bit length path both ways; junk gets a NOTICE, not a crash', async () => {
  const c = await connect()
  c.send('nonsense')
  c.ws.send('{not json')
  for (const _ of [1, 2]) await c.until(m => m[0] === 'NOTICE')
  const fat = ev(30, [], 1, 'x'.repeat(70_000))
  assert.equal((await c.publish(fat)).at(-1)[2], true)
  assert.equal((await c.req('f', { ids: [fat.id] }))[0]?.content.length, 70_000)
})

test('node test-relay.ts --port 0 prints one line and nothing else on startup', async () => {
  const child = spawn(process.execPath, ['test-relay.ts', '--port', '0'], { cwd: HERE, env: { PATH: process.env.PATH } })
  let out = ''
  await new Promise<void>(ok => child.stdout.on('data', c => { out += c; if (out.includes('\n')) ok() }))
  await new Promise(ok => setTimeout(ok, 200))
  child.kill()
  assert.match(out, /^# test relay listening on ws:\/\/127\.0\.0\.1:\d+\n$/)
})
