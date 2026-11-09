// One phone-width image per builder step (G1.3). `npm run steps` here, with the builder served by
// `vite preview` on :4174 (the same port capture.ts uses), writes shots/out/steps/step-NN.png.
//
// Unlike capture.ts this file is also imported by builder/smoke.test.ts, which type-checks it with
// builder/tsconfig.json. That is why `page` is a small structural type and not playwright's `Page`,
// and why playwright is only loaded, by a non-literal specifier, when the file is run directly.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Shootable = {
  count(): Promise<number>
  nth(i: number): Shootable
  evaluate<R>(fn: (el: Element) => R): Promise<R>
  screenshot(opts: { path: string; timeout?: number }): Promise<unknown>
}
export type StepPage = { locator(selector: string): Shootable }

/** Every `main > section` whose h2 starts with its step number. Returns the files in step order. */
export const captureSteps = async (page: StepPage, outDir: string): Promise<string[]> => {
  const sections = page.locator('main > section')
  const found: [number, Shootable][] = []
  for (let i = 0, n = await sections.count(); i < n; i++) {
    const section = sections.nth(i)
    // The number is read from the heading, so a re-ordered or skipped step cannot be misnamed.
    const step = await section.evaluate(el => {
      const m = /^\s*(\d+)\s*·/.exec(el.querySelector(':scope > h2')?.textContent ?? '')
      if (!m) return 0
      // Step 6 (#result) is `hidden` until a ladder exists. A shot of it still shows its layout.
      ;(el as HTMLElement).hidden = false
      el.scrollIntoView()
      return Number(m[1])
    })
    if (step) found.push([step, section])
  }
  found.sort((a, b) => a[0] - b[0])
  mkdirSync(outDir, { recursive: true })
  const files: string[] = []
  for (const [step, section] of found) {
    const path = join(outDir, `step-${String(step).padStart(2, '0')}.png`)
    await section.screenshot({ path, timeout: 10_000 })
    files.push(path)
  }
  return files
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2] ?? 'http://localhost:4174/'
  const out = join(dirname(fileURLToPath(import.meta.url)), 'out', 'steps')
  const pw = 'playwright'
  const { chromium } = await import(pw)
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 1, locale: 'es-MX' })
  const page = await context.newPage()
  await page.goto(url)
  await page.waitForSelector('main', { timeout: 15_000 })
  for (const f of await captureSteps(page, out)) console.log(f)
  await browser.close()
}
