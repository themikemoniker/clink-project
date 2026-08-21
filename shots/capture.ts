// Screenshots of the live app, and a captioned PDF of them.
//
// This is demo/submission tooling, not product code — same throwaway status as /spike, and it
// keeps its own package.json so Playwright never lands in the dependency list of the two apps
// that have a gzip budget to defend (/docs/spec.md §9).
//
// WHY IT SHOOTS `vite preview` AND NOT THE LIVE GATEWAY. The nsite gateway sends
// `cache-control: max-age=3600` and serves the PREVIOUS build until it lapses
// (/docs/spike-findings.md §7), so a screenshot taken right after a deploy would show the old
// site and look like a broken one. `vite preview` serves the exact `dist/` bytes that
// `deploy-nsite.ts` just hashed and published, and the page still reads its listings from the
// four public relays — so everything in these shots except the file origin is live.
//
// The Buy shot sends a REAL CLINK Offers request (kind 21001) over relays to the seller's own
// node and shows the invoice that comes back. Requesting an invoice costs nothing; nothing here
// pays one. The refund pointer is `check-buy@example.com`, the deliberately unresolvable default
// from spike/check-buy.ts.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')

/** The live sale. The storefront reads its seller from the hostname; `?seller=` is the dev fallback. */
const SELLER = 'npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws'
const STOREFRONT = `http://localhost:4173/?seller=${SELLER}`
const BUILDER = 'http://localhost:4174/'
const LIVE_STOREFRONT = `https://${SELLER}.nsite.lol/`
const LIVE_BUILDER = 'https://npub1qqm97k4eg432zydvkclnhhnkyd7dgjxmndmaapk48jzms9uyl5qqlerxa2.nsite.lol/'

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 900 }

type Shot = { file: string; title: string; caption: string }
const shots: Shot[] = []

const serve = (cwd: string, port: number): ChildProcess =>
  spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: join(HERE, '..', cwd),
    stdio: 'ignore',
  })

const waitForPort = async (url: string, tries = 60): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url)
      return
    } catch {
      await new Promise(r => setTimeout(r, 500))
    }
  }
  throw new Error(`${url} never came up. Run \`npm run build\` in storefront/ and builder/ first.`)
}

/**
 * Item photos are `loading: 'lazy'` (render.ts), and a `fullPage` screenshot does NOT scroll — so
 * everything below the fold stays unloaded and renders as an empty grey box. That looks exactly
 * like an item with no photo, which would put a lie in the PDF. Walk the page first, then wait
 * for the images to actually decode.
 */
const loadLazyImages = async (page: Page) => {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight / 2) {
      window.scrollTo(0, y)
      await new Promise(r => setTimeout(r, 120))
    }
    window.scrollTo(0, 0)
  })
  await page.waitForFunction(
    () => [...document.images].every(i => i.complete),
    undefined,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(300)
}

/** Screenshot + record the caption in one call, so a shot can never land in out/ uncaptioned. */
const shoot = async (page: Page, file: string, title: string, caption: string, fullPage = true) => {
  if (fullPage) await loadLazyImages(page)
  await page.screenshot({ path: join(OUT, file), fullPage })
  shots.push({ file, title, caption })
  console.log(`  ok  ${file}`)
}

/** The storefront renders from relays, so "loaded" means the items arrived, not that onload fired. */
const goto = async (page: Page, url: string, waitFor: string) => {
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForSelector(waitFor, { timeout: 30_000 })
  // The masthead animates in; settle before shooting so nothing is caught mid-transition.
  await page.waitForTimeout(600)
}

const main = async () => {
  mkdirSync(OUT, { recursive: true })

  console.log('# serving the built storefront and builder')
  const servers = [serve('storefront', 4173), serve('builder', 4174)]
  let browser: Browser | undefined
  try {
    await Promise.all([waitForPort('http://localhost:4173/'), waitForPort(BUILDER)])

    browser = await chromium.launch()
    const ctx = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2 })
    const page = await ctx.newPage()

    console.log('# storefront')
    await goto(page, STOREFRONT, '.items')
    await shoot(
      page,
      '01-sale-index.png',
      'The sale, as a buyer sees it',
      'A static page with no backend behind it. It is served from Blossom blobs addressed by ' +
        'a Nostr pubkey, and every item on it was read live from four public relays at page ' +
        'load. Sold items keep their stamp rather than disappearing, so a buyer arriving from a ' +
        `printed flyer can see what went. Live at ${LIVE_STOREFRONT}`,
    )

    // The buyer's real context is a phone in a driveway, so the item and payment shots are taken
    // at phone width rather than desktop.
    const phone = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
    const p = await phone.newPage()

    await goto(p, `${STOREFRONT}#/item/yardsale-2026-08-lamp`, '.buy')
    await shoot(
      p,
      '02-item-detail.png',
      'An item, and a Buy button that is not a link to a checkout',
      'The detail view asks for one thing before it will request an invoice: a refund pointer. ' +
        'That is not ceremony. Stock is a number on a relay, relays reorder and replay, and if ' +
        'two people buy the last lamp the second one has to be given their money back — so the ' +
        'page refuses to take money it could not return. The location is a `geo:` link, handed ' +
        'to the OS, so no tile server is contacted and nobody is told a buyer looked.',
    )

    // A real kind 21001 request over relays to the seller's node. Free — nothing pays this.
    await p.fill('.buy-form input', 'check-buy@example.com')
    await p.click('.buy-form button.pay')
    await p.waitForSelector('svg.qr', { timeout: 60_000 })
    await p.waitForTimeout(400)
    await shoot(
      p,
      '03-clink-invoice.png',
      'The whole thesis, in one screenshot',
      'This QR is a real BOLT11 invoice. A static page with no server asked the seller’s own ' +
        'Lightning node for it by sending a CLINK Offers request (kind 21001) over public Nostr ' +
        'relays, and the node answered the same way. No backend of ours took part, no liquidity ' +
        'was pooled, and no key was custodied. The page then checks the invoice amount against ' +
        'the listed price and refuses it if they disagree — a guard an LNURL QR cannot offer. ' +
        'The QR encoder is a 3.9 KB chunk fetched only on tapping Buy, never on cold load.',
    )

    await goto(p, `${STOREFRONT}#/item/yardsale-2026-08-plants`, '.detail, .items')
    await shoot(
      p,
      '04-sold.png',
      'Sold, and marked sold by a watcher that holds no key',
      'These plants were bought for 6,000 real sats. A watcher on the seller’s machine observed ' +
        'the settlement on the node and republished the listing as sold — and it does that ' +
        'holding no signing key of the seller’s. If the same item oversells, the same watcher ' +
        'refunds the loser automatically over a CLINK Debit (kind 21002), from a key with no ' +
        'funds and no identity, capped by the node itself rather than by our code.',
    )

    await goto(p, `${STOREFRONT}#/item/yardsale-2026-08-records`, '.detail')
    await shoot(
      p,
      '05-cash-only.png',
      'The buyers this page does not serve, told so plainly',
      'Priced in pesos, cash at the table, and deliberately no Buy button. The interesting part ' +
        'is that it says so. An item with no payment path used to render a price and no way to ' +
        'act on it, which reads as a bug; every non-buyable state now names its own reason — ' +
        'fiat, free, below the node’s 10-sat invoice floor, or priced above inbound liquidity.',
    )

    await goto(p, `${STOREFRONT}#/item/yardsale-2026-08-gone`, '.items')
    await shoot(
      p,
      '06-sticker-outlived-item.png',
      'A sticker that outlived the thing it was stuck to',
      'Scanning a printed sticker for an item that has since been taken down used to fall ' +
        'through to the index in silence, which looks broken to the one visitor who arrived ' +
        'from the physical world. It now says what happened. This is the failure mode that ' +
        'only exists because the stickers are real.',
    )

    console.log('# print stylesheet')
    await page.emulateMedia({ media: 'print' })
    await goto(page, STOREFRONT, '.items')
    await shoot(
      page,
      '07-print-flyer.png',
      'The same page, printed as a flyer',
      'No second template and no export step — one `@media print` block turns the sale into ' +
        'the flyer that gets taped to a lamppost, QR included. The storefront QR is a ' +
        'build-time SVG symbol, so printing costs no encoder in the bundle.',
    )
    await page.emulateMedia({ media: 'screen' })

    console.log('# builder')
    await goto(page, BUILDER, '#sale')
    await shoot(
      page,
      '08-builder.png',
      'The seller’s authoring app, which is also a static page',
      'The seller writes their sale here and it holds no key: signing goes through a browser ' +
        'extension (NIP-07) or a remote bunker (NIP-46), and the seller’s node is reached with ' +
        'a narrow CLINK Manage grant (kind 21003) rather than node credentials. Each item is ' +
        'published as a listing and gets its offer minted on the seller’s own node. The builder ' +
        `itself deploys as an nsite — if our own app needed a server, the pitch would be false. ` +
        `Live at ${LIVE_BUILDER}`,
    )

    await page.locator('#sale').scrollIntoViewIfNeeded()
    await shoot(
      page,
      '09-sale-masthead.png',
      'The sale is authored, not inherited',
      'Until this slice the builder imported the demo fixture’s sale and stamped it on every ' +
        'item anyone authored — our `d` prefix, our neighbourhood, our geohash — into a ' +
        'collection nothing in the builder ever published. A seller in Oaxaca published ' +
        'Guadalajara items, signed by their own key, permanently, to four public relays. The ' +
        'builder now writes its own kind 30405. Decoding a geohash for the map link also found ' +
        'the fixture’s own had been 5.94 km wrong for eight slices, because nothing had ever ' +
        'decoded one.',
      false,
    )

    const admin = page.locator('#admin')
    await admin.scrollIntoViewIfNeeded()
    await shoot(
      page,
      '10-admin.png',
      'Editing, restocking, and the one thing this architecture genuinely cannot do',
      'Edit, restock, mark sold, and private notes encrypted to the seller’s own key. The ' +
        'honest gap is on this panel: "view settled sales" has no CLINK path at all — Manage’s ' +
        'only resource is the offer, and the node’s own invoice RPC is keyed on a raw secret ' +
        'NIP-46 does not expose. So the seller’s browser cannot see the seller’s sales. That is ' +
        'not a bug we failed to fix; it is what holding no key actually costs. Units sold are ' +
        'derived from the relays instead, and the money is read on the machine where the key is.',
      false,
    )

    await ctx.close()
    await phone.close()

    console.log('# building the PDF')
    await buildPdf(browser)
  } finally {
    if (browser) await browser.close()
    for (const s of servers) s.kill()
  }
}

/**
 * The PDF is rendered by the browser that is already open, from an HTML sheet with the PNGs
 * inlined as data URIs. Playwright's own `page.pdf()` does the printing, so this adds no PDF
 * library — and inlining means the file does not depend on out/*.png still sitting next to it.
 */
const buildPdf = async (browser: Browser) => {
  const page = await browser.newPage()

  // The PNGs are shot at 2–3x for crisp out/ files, which lands the embedded PDF around 21 MB —
  // over the 10 MB cap a lot of submission forms enforce. Re-encode a print-sized copy through a
  // canvas in the browser already open, rather than adding an image library for it. out/ keeps
  // the full-resolution originals.
  const encoded = await page.evaluate(
    async (files: { file: string; src: string }[]) => {
      const out: Record<string, string> = {}
      for (const { file, src } of files) {
        const img = new Image()
        img.src = src
        await img.decode()
        const scale = Math.min(1, 1400 / img.width)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        const ctx = canvas.getContext('2d')!
        // JPEG has no alpha; without this, transparent pixels composite to black.
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        out[file] = canvas.toDataURL('image/jpeg', 0.86)
      }
      return out
    },
    shots.map(s => ({
      file: s.file,
      src: `data:image/png;base64,${readFileSync(join(OUT, s.file)).toString('base64')}`,
    })),
  )
  const dataUri = (file: string) => encoded[file]!

  const pages = shots
    .map(
      (s, i) => `
      <section>
        <header>
          <span class="num">${String(i + 1).padStart(2, '0')}</span>
          <h2>${s.title}</h2>
        </header>
        <div class="shot"><img src="${dataUri(s.file)}" alt="${s.title}" /></div>
        <p>${s.caption}</p>
      </section>`,
    )
    .join('')

  const html = `<!doctype html><meta charset="utf-8"><title>CLINK yard sale</title>
  <style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 10.5pt/1.5 -apple-system, "Helvetica Neue", sans-serif; color: #1a1a1a; }
    .cover { height: 265mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
    .cover .brand { font-size: 11pt; letter-spacing: 2.5pt; text-transform: uppercase; color: #b8860b; margin: 0 0 4mm; }
    .cover h1 { font-size: 30pt; line-height: 1.15; margin: 0 0 6mm; letter-spacing: -0.5pt; }
    .cover .sub { font-size: 13pt; color: #444; margin: 0 0 12mm; max-width: 150mm; }
    .cover dl { display: grid; grid-template-columns: 42mm 1fr; gap: 2.5mm 5mm; margin: 0; font-size: 9.5pt; }
    .cover dt { color: #666; }
    .cover dd { margin: 0; }
    .cover code { font: 8.5pt ui-monospace, Menlo, monospace; word-break: break-all; }
    section { page-break-after: always; page-break-inside: avoid; }
    section:last-child { page-break-after: auto; }
    header { display: flex; align-items: baseline; gap: 4mm; border-bottom: 0.4pt solid #ccc; padding-bottom: 2.5mm; margin-bottom: 5mm; }
    .num { font: 9pt ui-monospace, Menlo, monospace; color: #b8860b; }
    h2 { font-size: 14pt; margin: 0; font-weight: 600; letter-spacing: -0.2pt; }
    .shot { text-align: center; margin-bottom: 5mm; }
    .shot img { max-width: 100%; max-height: 185mm; object-fit: contain; border: 0.4pt solid #ddd; }
    p { margin: 0; color: #333; max-width: 165mm; }
  </style>
  <div class="cover">
    <p class="brand">Lamppost</p>
    <h1>A yard sale that takes Lightning<br>and has no server</h1>
    <p class="sub">A static page, hosted on Nostr, that takes real Lightning payments by sending
    CLINK requests over public relays to the seller's own node. No backend, no database, no
    accounts, no pooled liquidity, and no custody of anyone's keys.</p>
    <dl>
      <dt>Storefront</dt><dd><code>${LIVE_STOREFRONT}</code></dd>
      <dt>Builder</dt><dd><code>${LIVE_BUILDER}</code></dd>
      <dt>Proven with real money</dt><dd>6,000 sats settled, and the page read the settlement receipt nobody else can decrypt</dd>
      <dt>Payments</dt><dd>CLINK Offers (kind 21001) — buyer to the seller's node, over relays</dd>
      <dt>Refunds</dt><dd>CLINK Debit (kind 21002) — capped and kill-switched by the node itself</dd>
      <dt>Authoring</dt><dd>CLINK Manage (kind 21003) — no node credentials in the browser</dd>
      <dt>Hosting</dt><dd>NIP-5A nsite, four complete Blossom mirrors</dd>
      <dt>Cold load</dt><dd>32.01 KB gzip JS, + 3.9 KB only if you tap Buy</dd>
    </dl>
  </div>
  ${pages}`

  await page.setContent(html, { waitUntil: 'load' })
  await page.pdf({ path: join(HERE, 'clink-yard-sale.pdf'), format: 'A4', printBackground: true })
  await page.close()
}

await main()
console.log(`\n# ${shots.length} shots in shots/out/`)
console.log('# PDF at shots/clink-yard-sale.pdf')
