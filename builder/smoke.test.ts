// The builder's half of roadmap item 8. Same shape and same reasoning as
// storefront/smoke.test.ts. Read that file's header first; this one only records what differs.
//
// What differs is that this page needs no relay stub. Everything asserted here is static markup
// in index.html plus style.css, so the page is loaded cold, with no signer, no node and no
// network, which is also the state a seller first sees it in, and therefore worth asserting on
// its own. `public/site/` and `public/site.json` are gitignored build products of
// bundle-storefront.mjs; nothing below touches them, so this test runs on a fresh clone before
// anything has been bundled.
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

before(async () => {
  await build({ root: here, logLevel: 'error' })
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

const open = async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${origin}/`)
  await page.waitForSelector('main', { timeout: 15_000 })
  return { page, errors }
}

test('the authoring page boots cold (no signer, no node, no relay) without throwing', async () => {
  const { page, errors } = await open()
  assert.equal(await page.locator('h1').first().textContent(), 'Lamppost')
  // Rule 2's front door. If neither button paints, a seller has no way in at all.
  assert.ok(await page.locator('#nip07').isVisible())
  assert.ok(await page.locator('#bunker-scan').isVisible())
  assert.deepEqual(errors, [])
  await page.close()
})

test('the print stylesheet hides <main>, so the sticker sheet is the only thing on the paper', async () => {
  // style.css:154, `body > main { display: none }`. This is the block roadmap item 8 names, and
  // design.md §4 is the reason: everything inside <main> is a tool (a form, a signer, a deploy
  // button) and none of it means anything printed. It had never run in a browser before item 8.
  const { page } = await open()

  const displays = async () =>
    page.evaluate(() => ({
      main: getComputedStyle(document.querySelector('body > main')!).display,
      sheet: getComputedStyle(document.querySelector('#sticker-sheet')!).display,
    }))

  assert.notEqual((await displays()).main, 'none', '<main> should be visible on screen')

  await page.emulateMedia({ media: 'print' })
  assert.equal((await displays()).main, 'none')

  await page.close()
})

test('the sticker sheet exists and stays hidden until the seller builds one', async () => {
  // It is `hidden` in index.html and main.ts:431 clears that only once buildSheet returns a
  // non-zero count. The element has to BE there for that to work. An empty print with no sheet
  // is exactly the class of defect this file exists to catch.
  const { page } = await open()
  const sheet = page.locator('#sticker-sheet')
  assert.equal(await sheet.count(), 1)
  assert.equal(await sheet.getAttribute('hidden'), '')
  assert.equal(await sheet.getAttribute('aria-label'), 'Item stickers')
  await page.close()
})
