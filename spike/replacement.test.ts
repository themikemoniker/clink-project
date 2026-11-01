// Step 5 of check-ladder-relay.ts, offline. Run: npm test  (in /spike)
//
// Same style and same runner as ladder.test.ts: node --test, node:assert, no framework. No network
// and no key: the pool is a fake that records the call order and delivers scripted events, and the
// events only need the fields the rule reads, so nothing here is signed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LADDER_KIND, ladderD } from './ladder.ts'
import { replacementArrives } from './replacement.ts'

type Ev = { id: string; kind: number; tags: string[][] }

const D = 'item-1'
const tags = [['d', ladderD(D)]]
// The original and its replacement: same kind, same `d`, different id. Only the id tells them apart.
const original: Ev = { id: 'a'.repeat(64), kind: LADDER_KIND, tags }
const next: Ev = { id: 'b'.repeat(64), kind: LADDER_KIND, tags }
const otherItem: Ev = { id: 'c'.repeat(64), kind: LADDER_KIND, tags: [['d', ladderD('item-2')]] }
const filter = { kinds: [LADDER_KIND], authors: ['f'.repeat(64)], since: 1 }

// `inside` is delivered synchronously inside subscribe(), before it has even returned.
const fakePool = (inside: Ev[] = []) => {
  const calls: string[] = []
  let onevent: ((ev: Ev) => void) | undefined
  const pool = {
    subscribe: (_relays: string[], _filter: unknown, params: { onevent?: (ev: Ev) => void }) => {
      calls.push('subscribe')
      onevent = params.onevent
      for (const ev of inside) onevent?.(ev)
      return { close: () => void calls.push('close') }
    },
  }
  return {
    pool: pool as unknown as Parameters<typeof replacementArrives>[0],
    calls,
    deliver: (ev: Ev) => onevent?.(ev),
    closes: () => calls.filter(c => c === 'close').length,
  }
}

// Every pending setTimeout shows up here, so a timer left behind is counted rather than assumed.
const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

test("the critic's reproduction: only the original arrives and 0 relays accept, so nothing is proven", async () => {
  const f = fakePool()
  const result = await replacementArrives(f.pool, ['wss://a'], filter, next, async () => {
    f.calls.push('publish')
    f.deliver(original)
    f.deliver(otherItem)
    return 0
  }, 50)
  assert.deepEqual(result, { accepted: 0, arrived: false })
})

test('the replacement arrives after the original: arrived, and the accepted count is kept', async () => {
  const f = fakePool()
  const before = timers()
  const result = await replacementArrives(f.pool, ['wss://a'], filter, next, async () => {
    f.calls.push('publish')
    f.deliver(original)
    f.deliver(next)
    return 3
  }, 10_000)
  assert.deepEqual(result, { accepted: 3, arrived: true })
  assert.equal(f.closes(), 1)
  assert.deepEqual(f.calls, ['subscribe', 'publish', 'close'])
  assert.equal(timers(), before, 'the timeout is cleared on arrival')
})

test('it arrives before the OK: synchronously inside subscribe, and publish resolves later', async () => {
  const f = fakePool([original, next])
  const result = await replacementArrives(f.pool, ['wss://a'], filter, next, async () => {
    f.calls.push('publish')
    await tick(20)
    return 1
  }, 10_000)
  assert.deepEqual(result, { accepted: 1, arrived: true })
  assert.equal(f.closes(), 1)
  assert.equal(f.calls.indexOf('subscribe'), 0)
  assert.ok(f.calls.indexOf('publish') > 0, 'publish is called after subscribe')
})

test('it arrives before the OK: delivered while publish is still pending', async () => {
  const f = fakePool()
  const result = await replacementArrives(f.pool, ['wss://a'], filter, next, async () => {
    f.calls.push('publish')
    await tick(5)
    f.deliver(next)
    await tick(20)
    return 1
  }, 10_000)
  assert.deepEqual(result, { accepted: 1, arrived: true })
  assert.deepEqual(f.calls, ['subscribe', 'publish', 'close'])
})

test('accepted but never delivered: the timeout ends it, closed once', async () => {
  const f = fakePool()
  const before = timers()
  const result = await replacementArrives(f.pool, ['wss://a'], filter, next, async () => {
    f.calls.push('publish')
    return 2
  }, 50)
  assert.deepEqual(result, { accepted: 2, arrived: false })
  assert.equal(f.closes(), 1)
  assert.deepEqual(f.calls, ['subscribe', 'publish', 'close'])
  assert.equal(timers(), before)
  // Late delivery after the window has closed changes nothing and closes nothing twice.
  f.deliver(next)
  assert.equal(f.closes(), 1)
})

test('a rejected publish cleans up AT ONCE, long before the timeout', async () => {
  const f = fakePool()
  const before = timers()
  const started = Date.now()
  const result = await replacementArrives(f.pool, ['wss://a'], filter, next, async () => {
    f.calls.push('publish')
    throw new Error('relay refused')
  }, 10_000)
  const elapsed = Date.now() - started
  assert.deepEqual(result, { accepted: 0, arrived: false })
  assert.ok(elapsed < 1_000, `resolved in ${elapsed} ms, not at the 10 s timeout`)
  assert.equal(f.closes(), 1)
  assert.deepEqual(f.calls, ['subscribe', 'publish', 'close'])
  assert.equal(timers(), before, 'the timeout is cleared on rejection')
})

test('a rejected publish: the replacement delivered afterwards cannot change the result', async () => {
  const f = fakePool()
  const before = timers()
  let rejected = false
  // The replacement turns up 20 ms after the rejection, well inside the 10 s timeout. If rejection
  // left the window open, this would flip `arrived` to true and the call would resolve with it.
  const late = tick(20).then(() => {
    assert.ok(rejected)
    f.deliver(next)
  })
  const result = await replacementArrives(f.pool, ['wss://a'], filter, next, async () => {
    f.calls.push('publish')
    rejected = true
    throw new Error('relay refused')
  }, 10_000)
  await late
  assert.deepEqual(result, { accepted: 0, arrived: false })
  assert.equal(f.closes(), 1)
  assert.equal(timers(), before)
})

test('a publish that throws synchronously is a rejection too', async () => {
  const f = fakePool()
  const before = timers()
  const started = Date.now()
  const result = await replacementArrives(f.pool, ['wss://a'], filter, next, (() => {
    f.calls.push('publish')
    throw new Error('no relays')
  }) as () => Promise<number>, 10_000)
  const elapsed = Date.now() - started
  assert.deepEqual(result, { accepted: 0, arrived: false })
  assert.ok(elapsed < 1_000, `resolved in ${elapsed} ms, not at the 10 s timeout`)
  assert.equal(f.closes(), 1)
  assert.equal(timers(), before)
})
