// Item 8: the builder, in a real browser. Companion to storefront.smoke.test.ts — read that
// file's header for why this lives in /shots, why it is `node --test` rather than
// `@playwright/test`, and why it is the slow suite.
//
// WHAT THIS CAN AND CANNOT COVER, STATED UP FRONT SO NOBODY READS MORE INTO A GREEN RUN.
// `builder/src/signer.ts` has exactly two paths and Playwright is neither of them: a NIP-07
// extension is a real Chrome extension, and a NIP-46 bunker is a remote signer on somebody
// else's device. So this file asserts the surface a seller meets BEFORE either one answers —
// the connect screen, and the fact that nothing behind it is reachable without a signer.
//
// It deliberately does NOT inject a `window.nostr` shim. That was the tempting option and
// /docs/prompts/browser-verify-and-deploy.md §2 is right about the cost: a shim holds a private
// key in a page, and /CLAUDE.md rule 2 applies to it directly. It would also buy less than it
// looks — publishing an item mints a REAL offer on the node (CLINK Manage `create` is explicitly
// not idempotent, clink-manage.md:226) and puts a REAL kind 30402 on public relays. A smoke test
// that leaves litter on four public relays every time anyone runs `npm test` is not a smoke test.
//
// ⇒ The publish sequence, the ladder download, the deploy button and the signature-prompt count
// remain UNRUN BY MACHINE and belong to the human half of item 7 with nos2x. Say that out loud
// rather than letting a green suite here imply otherwise.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, type Browser, type Page } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, '..', 'builder', 'dist')
const PORT = 4184 // capture.ts uses 4174; storefront.smoke.test.ts uses 4183
const PAGE = `http://localhost:${PORT}/`

// Same allowlist rule as the storefront suite: exact text, so a NEW error still fails.
const KNOWN_CONSOLE_ERRORS: string[] = []

let server: ChildProcess
let browser: Browser
let page: Page
const consoleErrors: string[] = []

before(async () => {
  assert.ok(
    existsSync(join(DIST, 'index.html')),
    `no ${DIST}/index.html — run \`npm run build\` in /builder first (its prebuild also bundles ` +
      `/storefront into public/site, so a fresh clone has nothing to deploy until that runs).`,
  )
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: join(HERE, '..', 'builder'),
    stdio: 'ignore',
  })
  for (let i = 0; ; i++) {
    try {
      await fetch(PAGE)
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
  await page.goto(PAGE)
})

after(async () => {
  await browser?.close()
  server?.kill()
})

test('the connect screen offers both signer routes', async () => {
  await page.waitForSelector('#connect', { timeout: 15_000 })
  assert.equal(await page.locator('#nip07').isVisible(), true, 'no NIP-07 button — the only route that works on this operator’s hardware')
  assert.equal(await page.locator('#bunker-scan').isVisible(), true, 'no bunker route')
})

test('nothing is signed in until a signer answers', async () => {
  // `#signed-in` ships `hidden`. If it ever paints without a signer, the builder is claiming an
  // identity it does not hold — and the failure mode that matters is the one item 7 nearly hit
  // for real: signing as the WRONG npub and reporting success at every step.
  assert.equal(await page.locator('#signed-in').isVisible(), false, '#signed-in painted with no signer attached')
})

test('the authoring forms render their required fields', async () => {
  // The forms exist in the markup whether or not a signer is attached; what has never been
  // checked is that they render at all and that `required` survived the build.
  assert.equal(await page.locator('#sale').count(), 1, 'no sale form')
  assert.equal(await page.locator('#item').count(), 1, 'no item form')
  assert.equal(await page.locator('#sale-title').getAttribute('required'), '', 'the sale title is not required')
  // An item is `1 + units` signatures and the builder shows the real count, because a seller
  // told "one approval" who then sees thirty abandons the publish and leaves a listing on the
  // relays with no ladder behind it (/docs/status.md, slice 4).
  assert.equal(await page.locator('#sale-cost').count(), 1, 'no signature-cost line')
})

test('publishing is refused until a node and a signer exist', async () => {
  assert.equal(await page.locator('#publish-sale').isDisabled(), true, '"Publish my sale" is enabled with no signer')
})

test('no console errors beyond the ones already written down', async () => {
  const unexpected = consoleErrors.filter(e => !KNOWN_CONSOLE_ERRORS.includes(e))
  assert.deepEqual(unexpected, [], `new console error(s):\n  ${unexpected.join('\n  ')}`)
})
