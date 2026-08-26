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
  // style.css:165, `body > main { display: none }`. This is the block roadmap item 8 names, and
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

// --- item 13's last bullet (2026-08-26) -------------------------------------------------------
//
// The shrink confirmation is new markup and new CSS, and item 8 exists because this project has
// shipped five slices of markup that never rendered. So it renders here, in a real chromium,
// before anybody trusts it.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT, said plainly. It proves the element is in the built page,
// that it is hidden cold, that unhiding it paints a legible, styled, non-clipped box, that the
// list items lay out, and that the checkbox is a real control a person can tick. It does NOT
// drive `doPublishSale` — that needs a signer and a four-relay read, neither of which exists in
// this harness — so the decision to SHOW it is covered by the unit tests on `droppedMembers` in
// src/admin.test.ts, and the painting is covered here. The seam between them is `showShrink`,
// four lines of textContent and replaceChildren.

test('the shrink confirmation is in the page and hidden until a publish would drop something', async () => {
  const { page } = await open()
  const box = page.locator('#sale-shrink')
  assert.equal(await box.count(), 1)
  assert.equal(await box.getAttribute('hidden'), '')
  assert.equal(await box.isVisible(), false)
  // Unticked cold, and main.ts `showShrink` clears it every time the box is hidden — a tick that
  // survived from a previous publish is not a confirmation of this one.
  assert.equal(await page.locator('#sale-shrink-ok').isChecked(), false)
  // It has to sit INSIDE the sale form and above the submit button, or a seller reads the warning
  // after pressing the thing it is warning about.
  assert.equal(await page.locator('#sale #sale-shrink').count(), 1)
  const buttonComesAfter = await page.evaluate(
    () =>
      !!(
        document.querySelector('#sale-shrink')!.compareDocumentPosition(document.querySelector('#publish-sale')!) &
        Node.DOCUMENT_POSITION_FOLLOWING
      ),
  )
  assert.equal(buttonComesAfter, true, 'the button should come after the warning')
  await page.close()
})

test('and when it is shown it paints: styled, legible, and the checkbox is a real control', async () => {
  const { page, errors } = await open()

  // Exactly what main.ts `showShrink` writes — textContent and replaceChildren, never innerHTML,
  // because these strings are `d` tags read off a relay.
  await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('#sale-shrink')!
    box.hidden = false
    document.querySelector('#sale-shrink-what')!.textContent = 'This would un-list 2 items that your sale lists right now:'
    document.querySelector('#sale-shrink-list')!.replaceChildren(
      ...['yardsale-2026-08-mugs', 'yardsale-2026-08-lamp'].map(d => {
        const li = document.createElement('li')
        li.textContent = d
        return li
      }),
    )
  })

  const box = page.locator('#sale-shrink')
  assert.equal(await box.isVisible(), true)
  const rect = (await box.boundingBox())!
  assert.ok(rect.height > 40 && rect.width > 100, `the box has no size: ${JSON.stringify(rect)}`)

  // The warning reads as a warning. `.warn` is `color: var(--bad)`; if the rule is missing or the
  // class is misspelled this is the muted grey every other hint uses, which is the failure that
  // looks fine in a screenshot.
  const what = page.locator('#sale-shrink-what')
  const [warnColour, hintColour] = await page.evaluate(() => [
    getComputedStyle(document.querySelector('#sale-shrink-what')!).color,
    getComputedStyle(document.querySelector('#sale-shrink .hint')!).color,
  ])
  assert.notEqual(warnColour, hintColour, 'the warning is the same colour as an ordinary hint')
  assert.match(await what.textContent() ?? '', /un-list 2 items/)

  // Both `d`s painted, and as separate rows rather than one run-together string.
  assert.equal(await page.locator('#sale-shrink-list li').count(), 2)
  assert.equal(await page.locator('#sale-shrink-list li').first().textContent(), 'yardsale-2026-08-mugs')

  // The sentence that stops M3 being built on a false premise: un-listing does not delete, and
  // the storefront still draws a non-member. If this copy goes, the feature starts lying.
  assert.match(await box.textContent() ?? '', /Un-listing is not deleting/)
  assert.match(await box.textContent() ?? '', /replacement/)

  // A real control, not a decoration. Ticking it is what the guard reads.
  const ok = page.locator('#sale-shrink-ok')
  assert.equal(await ok.isChecked(), false)
  await ok.check()
  assert.equal(await ok.isChecked(), true)

  assert.deepEqual(errors, [])
  await page.close()
})

// --- M3's fiat half (2026-08-26) --------------------------------------------------------------
//
// New markup again, and one claim in main.ts `showFiat` that is a browser behaviour rather than a
// design opinion: `#price` is DISABLED and not merely hidden, because a `required` control inside
// a hidden wrapper is still validated and Chrome refuses to submit with "an invalid form control
// is not focusable" — a submit button that silently does nothing. That is asserted here, both
// ways, rather than believed.

test('the fiat price field is in the page and out of the way until an item needs it', async () => {
  const { page } = await open()
  assert.equal(await page.locator('#price-fiat').getAttribute('hidden'), '')
  assert.equal(await page.locator('#price-fiat-note').getAttribute('hidden'), '')
  assert.equal(await page.locator('#price-fiat-amount').isDisabled(), true)
  // The sats field is the default and the only one a seller can reach by typing. There is no
  // control anywhere that enters a currency — it can only ever be read off an existing listing.
  assert.equal(await page.locator('#price').isVisible(), true)
  assert.equal(await page.locator('#price').isDisabled(), false)
  assert.equal(await page.locator('#price-fiat-currency').textContent(), '—')
  await page.close()
})

test('switched into a currency, the row paints it and the form still submits', async () => {
  const { page, errors } = await open()

  // Exactly the attribute changes main.ts `showFiat(fiat)` makes.
  await page.evaluate(() => {
    const $ = (s: string) => document.querySelector<HTMLElement>(s)!
    $('#price-sats').hidden = true
    ;($('#price') as HTMLInputElement).toggleAttribute('disabled', true)
    $('#price-fiat').hidden = false
    $('#price-fiat-note').hidden = false
    ;($('#price-fiat-amount') as HTMLInputElement).toggleAttribute('disabled', false)
    $('#price-fiat-currency').textContent = 'MXN'
    ;($('#price-fiat-amount') as HTMLInputElement).value = '80'
  })

  assert.equal(await page.locator('#price').isVisible(), false)
  assert.equal(await page.locator('#price-fiat').isVisible(), true)
  assert.equal(await page.locator('#price-fiat-amount').inputValue(), '80')
  // The label reads "Price, in MXN" — one sentence built from a listing's own currency tag.
  assert.match((await page.locator('label[for="price-fiat-amount"]').textContent()) ?? '', /Price, in MXN/)
  // And the warning that this item can never be bought through the page, which is the whole
  // reason carrying the price through is safe at all.
  assert.match((await page.locator('#price-fiat-note').textContent()) ?? '', /no Buy button/)
  assert.match((await page.locator('#price-fiat-note').textContent()) ?? '', /nothing in this app\s+converts/)

  // THE CLAIM. `#title` is the form's other required field and is empty on a cold page, so it is
  // filled first — otherwise this measures the title and not the price.
  await page.locator('#title').fill('Records, jazz and salsa')
  const disabled = await page.evaluate(() => ({
    // `willValidate` is the direct statement: a disabled control is barred from constraint
    // validation entirely (HTML §4.10.18.3), which is what takes it out of the submit path.
    priceWillValidate: document.querySelector<HTMLInputElement>('#price')!.willValidate,
    formValid: document.querySelector<HTMLFormElement>('#item')!.checkValidity(),
  }))
  const validWhenDisabled = disabled.formValid
  assert.equal(disabled.priceWillValidate, false, 'a disabled control should be barred from validation')

  // Re-enable the hidden required field, which is what "just hide it" would have left behind.
  await page.evaluate(() => {
    const price = document.querySelector<HTMLInputElement>('#price')!
    price.toggleAttribute('disabled', false)
    price.value = ''
  })
  const enabled = await page.evaluate(() => ({
    priceWillValidate: document.querySelector<HTMLInputElement>('#price')!.willValidate,
    formValid: document.querySelector<HTMLFormElement>('#item')!.checkValidity(),
  }))
  const validWhenHiddenAndRequired = enabled.formValid
  assert.equal(enabled.priceWillValidate, true, 'hiding a wrapper does not take its control out of validation')

  assert.equal(validWhenDisabled, true, 'disabling the sats field should take it out of validation')
  assert.equal(validWhenHiddenAndRequired, false, 'a hidden required field still blocks submit — this is why disabled')

  assert.deepEqual(errors, [])
  await page.close()
})

// --- and the two things the fiat row got wrong the first time (2026-08-27) ---------------------
//
// Both are attributes on `#price-fiat-amount`, both were missing, and neither is reachable from a
// unit test: what enforces them is the browser's own constraint validation, which is exactly the
// class of claim item 8 exists to stop us asserting from a comment. So they are driven here.

// The shared setup, which is the attribute changes main.ts `showFiat(fiat)` makes.
const intoFiat = async (page: import('playwright').Page, currency: string, amount: string) => {
  await page.evaluate(
    ([code, value]) => {
      const $ = (s: string) => document.querySelector<HTMLElement>(s)!
      $('#price-sats').hidden = true
      ;($('#price') as HTMLInputElement).toggleAttribute('disabled', true)
      $('#price-fiat').hidden = false
      $('#price-fiat-note').hidden = false
      ;($('#price-fiat-amount') as HTMLInputElement).toggleAttribute('disabled', false)
      $('#price-fiat-currency').textContent = code!
      ;($('#price-fiat-amount') as HTMLInputElement).value = value!
    },
    [currency, amount],
  )
  // `#title` is the form's other required field and is empty on a cold page, so it is filled
  // first, or every assertion below measures the title and not the price.
  await page.locator('#title').fill('Records, jazz and salsa')
}

const formValid = (page: import('playwright').Page) =>
  page.evaluate(() => document.querySelector<HTMLFormElement>('#item')!.checkValidity())

test('a blank fiat price cannot be published, because a blank number field reads as zero', async () => {
  // THE DEFECT. `#price` has always been `required` and `#price-fiat-amount` was not, so clearing
  // it left `readDraft` computing `Number('')`, which is 0, which passes every check after it.
  // An 80 MXN item opened to change its stock and saved with the amount blank republishes as
  // `["price","0","MXN"]`, and the storefront draws that as "Free, just ask when you get here".
  //
  // `required` is the whole fix and it has to be asserted in a browser: it is inert while the
  // control is disabled (HTML §4.10.18.3, the same rule the test above leans on), so "the
  // attribute is in the markup" and "the attribute stops a submit" are different claims.
  const { page } = await open()
  assert.equal(await page.locator('#price-fiat-amount').getAttribute('required'), '')

  await intoFiat(page, 'MXN', '')
  assert.equal(await formValid(page), false, 'a blank fiat price should block submit, as a blank sats price does')

  // And it is the blank that is refused, not the fiat row itself.
  await page.locator('#price-fiat-amount').fill('80')
  assert.equal(await formValid(page), true)

  // Zero typed on purpose is a real price: `boxes` is `["price","0","MXN"]` on the live sale and
  // the page draws it as "Free". The form must not confuse "free" with "I cleared the box", and
  // the only thing that tells them apart is whether a seller typed the character.
  await page.locator('#price-fiat-amount').fill('0')
  assert.equal(await formValid(page), true)
  await page.close()
})

test('a fiat price may have a fractional part, because a peso is not a sat', async () => {
  // The field shipped as `step="1"`, inherited from the sats field beside it. A sat is whole by
  // definition and 12.50 USD is an ordinary price, so under step="1" a fractional listing was
  // editable, rendered into the form, and then refused by the browser on submit with a bubble the
  // seller cannot clear without changing what the item costs. `admin.ts` `fiatPriceReason` is the
  // other half; this is the half only a browser can answer.
  const { page } = await open()
  assert.equal(await page.locator('#price-fiat-amount').getAttribute('step'), 'any')

  await intoFiat(page, 'USD', '12.5')
  assert.equal(await formValid(page), true, 'step="1" would report a stepMismatch here')

  await page.locator('#price-fiat-amount').fill('80.5')
  assert.equal(await formValid(page), true)

  // The bound that survives from the sats field: negative is not a price. `min="0"` is what says
  // so, and `fiatPriceReason` says it again for anything that reaches the handler another way.
  await page.locator('#price-fiat-amount').fill('-1')
  assert.equal(await formValid(page), false)
  await page.close()
})
