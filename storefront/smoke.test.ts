// The half render.test.ts does not cover: that this page BUILDS the markup it decides on, in a
// real browser, with the real stylesheet attached.
//
// render.test.ts says so itself in its header: "no assertion here says renderDetail emits a
// <main>", and roadmap item 8 is the bill for that gap. Five slices of markup reached a demo
// unrendered because 61 + 67 unit tests never opened a DOM. This file is deliberately small.
// It is a smoke test, not a page-object framework: build, serve, load, assert a handful of
// structural facts that would have caught "the form never painted".
//
// NO NETWORK, NO KEY, NO NODE. The relay read is stubbed at `window.WebSocket` and answered from
// `smoke-fixture.json`, real kind 30402/30405 events captured off the four public relays on
// 2026-08-25, with their real signatures, because SimplePool verifies every event it accepts
// (nostr-tools/lib/esm/index.js:1177 `this.verifyEvent(event, this.url)`) and unsigned fixtures
// would be dropped before they reached the page. Captured rather than minted: signing fixtures
// here would mean a private key in the test suite, and CLAUDE.md rule 2 puts key handling in a
// Signer and nowhere else. Re-capture with a plain relay read if the sale is ever re-cut; the
// assertions below are structural, so stock counts drifting does not break them.
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { build } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))
const dist = join(here, 'dist')
const SELLER = 'npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

let server: Server
let browser: Browser
let origin: string
let events: unknown[]

before(async () => {
  // Build rather than trust whatever is in dist/: a smoke test that passes against a stale
  // bundle is the failure mode this file exists to prevent. `tsc --noEmit` is npm run build's
  // job, not this one. Here we only need the artifacts.
  await build({ root: here, logLevel: 'error' })
  events = JSON.parse(await readFile(join(here, 'smoke-fixture.json'), 'utf8'))

  // Serve dist/ over real HTTP on an ephemeral port. A module-type <script> needs a real origin
  // and a correct MIME type; file:// gives neither.
  server = createServer((req, res) => {
    const path = normalize(new URL(req.url ?? '/', 'http://x').pathname).replace(/^(\.\.[/\\])+/, '')
    const file = join(dist, path === '/' ? 'index.html' : path)
    readFile(file).then(
      body => {
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(body)
      },
      () => {
        res.writeHead(404).end('not found')
      },
    )
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await new Promise<void>(r => server?.close(() => r()))
})

// One page, loaded once per test, with the relays replaced by the fixture. The stub speaks only
// the three frames this page uses: it answers a REQ with every fixture event and then EOSE, which
// is what `fetchSaleEvents` waits for (nostr.ts `oneose: finish`).
const open = async (hash = '') => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript((evs: unknown[]) => {
    class FakeWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = 0
      onopen: ((e: unknown) => void) | null = null
      onmessage: ((e: { data: string }) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      onclose: ((e: unknown) => void) | null = null
      url: string
      constructor(url: string) {
        this.url = url
        setTimeout(() => {
          this.readyState = 1
          this.onopen?.({})
        }, 0)
      }
      send(raw: string) {
        let msg: unknown[]
        try {
          msg = JSON.parse(raw)
        } catch {
          return
        }
        if (msg[0] !== 'REQ') return
        const sub = msg[1]
        setTimeout(() => {
          if (this.readyState !== 1) return
          for (const ev of evs) this.onmessage?.({ data: JSON.stringify(['EVENT', sub, ev]) })
          this.onmessage?.({ data: JSON.stringify(['EOSE', sub]) })
        }, 0)
      }
      close() {
        if (this.readyState === 3) return
        this.readyState = 3
        this.onclose?.({ code: 1000, reason: '', wasClean: true })
      }
      addEventListener() {}
      removeEventListener() {}
    }
    // @ts-expect-error replacing the browser global on purpose
    window.WebSocket = FakeWebSocket
  }, events)
  await page.goto(`${origin}/?seller=${SELLER}${hash}`)
  await page.waitForSelector('main', { timeout: 15_000 })
  return { page, errors }
}

test('the index paints every item in the sale, from markup this test did not write', async () => {
  const { page, errors } = await open()
  // Nine items in the fixture sale, nine <article>s on the page. render.test.ts asserts what the
  // copy says; this asserts the elements exist at all.
  await page.waitForFunction(() => document.querySelectorAll('article').length > 0, null, { timeout: 15_000 })
  assert.equal(await page.locator('article').count(), 9)
  assert.equal(await page.locator('h1').first().textContent(), 'Moving Sale — Colonia Americana')
  assert.deepEqual(errors, [])
  await page.close()
})

test('a buyable item renders the Buy form, and the refund pointer is a required field', async () => {
  // `lamp` is priced in sats, above the node's floor, and carries a clink_offer: the three
  // conditions render.ts `renderBuy` needs before it builds a form at all.
  const { page, errors } = await open('#/item/yardsale-2026-08-lamp')
  const form = page.locator('form.buy-form')
  await form.waitFor({ timeout: 15_000 })

  // spec §7.3: the offer declares this key required, so the node declines an invoice without it.
  // The name is `refund_pointer` (fixture.ts REFUND_POINTER) and getting it wrong is a sale whose
  // oversells cannot be refunded, which is why it is asserted by name rather than by position.
  const field = form.locator('input[name="refund_pointer"]')
  assert.equal(await field.count(), 1)
  assert.equal(await field.getAttribute('required'), '')
  assert.ok(await field.isVisible(), 'the refund pointer field is present but not visible')

  // A field nobody can name is a field nobody fills in.
  const id = await field.getAttribute('id')
  assert.equal(await form.locator(`label[for="${id}"]`).count(), 1)

  await form.locator('button[type="submit"]').waitFor({ timeout: 5_000 })
  assert.deepEqual(errors, [])
  await page.close()
})

test('the print stylesheet takes the Buy panel off the paper', async () => {
  // style.css:443, `@media print { .buy { display: none } }`. A flyer taped to a lamppost cannot
  // submit a form, and this block had never run in a browser before item 8.
  //
  // NOTE, and it is a doc-vs-code correction: the roadmap's item 8 bullet says the print
  // stylesheet hides `<main>`. In THIS app it does not: `<main>` is the item grid and printing
  // the sale is the entire point of the flyer (design.md §3). `body > main { display: none }` is
  // the BUILDER's rule (builder/src/style.css:154), asserted in builder/smoke.test.ts. Read the
  // code, not the bullet.
  const { page } = await open('#/item/yardsale-2026-08-lamp')
  await page.locator('section.buy').waitFor({ timeout: 15_000 })

  const displays = async () =>
    page.evaluate(() => ({
      buy: getComputedStyle(document.querySelector('section.buy')!).display,
      main: getComputedStyle(document.querySelector('main')!).display,
    }))

  assert.notEqual((await displays()).buy, 'none', 'the Buy panel should be visible on screen')

  await page.emulateMedia({ media: 'print' })
  const printed = await displays()
  assert.equal(printed.buy, 'none')
  // The flyer still has to carry the sale.
  assert.notEqual(printed.main, 'none')

  await page.close()
})
