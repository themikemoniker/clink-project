// Item 8: the storefront, in a real browser, asserted rather than photographed.
//
// WHY THIS FILE EXISTS. There are 61 + 67 + 42 `node --test` assertions in this project and not
// one of them touches a DOM, which is exactly how five slices of markup reached a demo having
// never rendered. `render.test.ts` says so itself at its head. This is the cheapest thing that
// makes "it renders" a claim a machine can refuse.
//
// WHY IT LIVES IN /shots AND NOT IN /storefront. `shots/capture.ts`'s header already decided
// this: shots "keeps its own package.json so Playwright never lands in the dependency list of
// the two apps that have a gzip budget to defend" (/docs/spec.md §9). Playwright is a
// devDependency and would never reach a bundle, but the decision is explicit and written down,
// and reversing it silently in a different slice is how documented decisions rot. So the browser
// lives where the browser already lives, and this file reuses the `vite preview` + `chromium`
// machinery capture.ts proved.
//
// IT IS `node --test`, NOT `@playwright/test`. /docs/status.md's rule is three suites, one
// runner, "do not start a fourth pattern". `playwright` the LIBRARY is importable on its own —
// `chromium.launch()` and `page.locator()` need no runner — so this is the same `node --test`
// and the same `node:assert` as every other suite here. No config file, no reporter, no fixture
// library, no page objects.
//
// IT IS THE SLOW SUITE AND THAT IS DELIBERATE. It launches Chromium, serves `storefront/dist`
// and reads listings off four PUBLIC RELAYS, so it is seconds where the other three are
// milliseconds. It needs `npm run build` in /storefront first. A failure here that names relays
// is the network, not the markup — the message says so, because a gate people learn to
// disbelieve is worse than no gate.
//
// IT SPENDS NOTHING. It never requests an invoice and never presses Buy. `mugs` is the oversell
// and it has already been spent (item 6, 2026-08-25); `lamp` is 30,000 sats and is not for
// testing plumbing.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, type Browser, type Page } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, '..', 'storefront', 'dist')
const PORT = 4183 // not capture.ts's 4173, so a capture run and a test run cannot fight
const SELLER = 'npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws'
const PAGE = `http://localhost:${PORT}/?seller=${SELLER}`

// RELAY TRANSPORT NOISE IS THE WEATHER, NOT THE MARKUP, and this list was written from two runs
// that disagreed. The first (2026-08-25) logged three of `WebSocket is already in CLOSING or
// CLOSED state.` — nostr-tools 2.24.3 writing to a pool socket it has already closed. The very
// next run logged none of those and two of `wss://relay.damus.io/ … 503` instead, because that
// relay was having a bad minute.
//
// So an exact-text allowlist would gate this suite on whether four public relays are healthy,
// and a gate that goes red for reasons the committer cannot fix is a gate people learn to
// ignore. These are matched as PATTERNS, deliberately narrow: a failed socket to a `wss://` host
// and a write to an already-closed one. Anything else — a TypeError, a failed asset, a thrown
// render — still fails the assertion, which is the only reason to watch the console at all.
//
// What is filtered is PRINTED rather than swallowed, so a run that is quietly drowning in relay
// errors still shows it to whoever is reading the output.
const RELAY_NOISE = [
  /^WebSocket connection to 'wss:\/\/[^']+' failed/,
  /^WebSocket is already in CLOSING or CLOSED state\.$/,
]

let server: ChildProcess
let browser: Browser
let page: Page
const consoleErrors: string[] = []

before(async () => {
  assert.ok(
    existsSync(join(DIST, 'index.html')),
    `no ${DIST}/index.html — run \`npm run build\` in /storefront first. This suite asserts the ` +
      `bytes that get deployed, not the dev server.`,
  )
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: join(HERE, '..', 'storefront'),
    stdio: 'ignore',
  })
  for (let i = 0; ; i++) {
    try {
      await fetch(`http://localhost:${PORT}/`)
      break
    } catch {
      if (i >= 60) throw new Error(`vite preview never came up on ${PORT}`)
      await new Promise(r => setTimeout(r, 500))
    }
  }
  browser = await chromium.launch()
  page = await browser.newPage()
  page.on('console', m => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${String(e)}`))
})

after(async () => {
  await browser?.close()
  server?.kill()
})

// ITEM 8 RECONCILED 2026-10-31: main's storefront/smoke.test.ts (aa85e0b) is item 8 wherever the two
// suites overlap, so this file's index-renders, Buy-form-required and Buy-panel-does-not-print tests
// were dropped in its favour. What stays here is what main's suite does not cover.
// Not in `npm test`: it reads the live relays. Run it by hand: node --test *.smoke.test.ts

test('printing reveals the flyer footer and keeps the items', async () => {
  await page.goto(PAGE)
  await page.waitForSelector('.item', { timeout: 30_000 })
  const flyer = page.locator('.flyer-foot').first()
  assert.equal(await flyer.isVisible(), false, 'the flyer footer must not show on screen')

  await page.emulateMedia({ media: 'print' })
  try {
    assert.equal(await flyer.isVisible(), true, 'the @media print block did not reveal the flyer footer')
    assert.ok((await page.locator('.flyer-foot .tab').count()) > 0, 'the flyer printed no tear-off tabs')
    // `<main>` STAYS. Both /docs/prompts/milestone-b.md and README item 8 specify "assert the
    // print stylesheet hides <main>"; nothing does, and nothing should — `<main>` is the item
    // grid, which style.css:235 regrids to three columns precisely so it prints. Asserting the
    // brief's sentence would have encoded the opposite of design.md §3. Measured 2026-08-25.
    assert.equal(await page.locator('main').first().isVisible(), true, '<main> must still print — it is the flyer')
  } finally {
    await page.emulateMedia({ media: 'screen' })
  }
})

test('the flyer QR marker survives, because deploy silently no-ops without it', async () => {
  // NOT an assertion that the QR renders. It cannot here, by design: slice 5 moved the encode to
  // DEPLOY time, so `storefront/dist` carries the raw `<!--QR-->` comment and the deployed bytes
  // carry a `<symbol id="qr">`. Measured 2026-08-25: 8 tear-off tabs, 8 `<use href="#qr">`, and
  // zero symbols to resolve against in `vite preview`.
  //
  // What is worth asserting is the seam. `builder/src/deploy.ts` `withQR` opens
  // `if (!html.includes('<!--QR-->')) return html` — so renaming or tidying that comment out of
  // index.html does not fail a build, does not fail a deploy, and does not log anything. It
  // ships a flyer whose every QR box is empty, forever, silently. That is the failure this
  // assertion exists for, and it is the one a diff would never show.
  await page.goto(PAGE)
  await page.waitForSelector('.item', { timeout: 30_000 })
  const html = await page.content()
  const markers = html.split('<!--QR-->').length - 1
  const hasSymbol = (await page.locator('symbol#qr').count()) > 0
  assert.ok(
    markers > 0 || hasSymbol,
    'neither the QR marker nor a <symbol id="qr"> is present — builder/src/deploy.ts withQR ' +
      'will no-op and every tear-off tab will print an empty box',
  )
  // EXACTLY ONE, and this assertion exists because the first version of it did not catch a real
  // bug committed minutes later. `withQR` is `html.replace(marker, …)` — String.replace with a
  // string argument substitutes the FIRST occurrence only. A second copy of the marker anywhere
  // earlier in the file (the obvious way to get one: writing a COMMENT that quotes it, which is
  // exactly what happened on 2026-08-25) silently steals the substitution, and the real marker
  // is left untouched. "Marker present" was true, the suite was green, and the flyer would still
  // have printed blank. An invariant is only worth the failure it can actually see.
  assert.ok(
    markers <= 1,
    `${markers} copies of the QR marker in the page — withQR replaces only the first, so the ` +
      `<symbol> would be injected at the wrong one and every tear-off tab would still print blank`,
  )
  const uses = await page.locator('use[href="#qr"]').count()
  assert.ok(uses > 0, 'the tear-off tabs reference no QR at all')
})

test('no console errors beyond relay transport noise', async () => {
  const noise = consoleErrors.filter(e => RELAY_NOISE.some(p => p.test(e)))
  const unexpected = consoleErrors.filter(e => !RELAY_NOISE.some(p => p.test(e)))
  if (noise.length) console.log(`# ${noise.length} relay transport error(s), filtered:\n#   ${[...new Set(noise)].join('\n#   ')}`)
  assert.deepEqual(
    unexpected,
    [],
    `new console error(s). A page that renders correctly while throwing is one browser version ` +
      `away from blank:\n  ${unexpected.join('\n  ')}`,
  )
})
