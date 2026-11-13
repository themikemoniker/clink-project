// #182: the sticker QR's aria-label is a table string and follows a language switch. No browser:
// a tiny fake `document` on globalThis. Fake urls and titles only; no keys of any kind.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fmt, STRINGS, type Lang } from './i18n.ts'
import { buildSheet, qrSvg, relabelSheet } from './stickers.ts'
import type { Item } from '../../storefront/src/listing.ts'

class FakeEl {
  attrs = new Map<string, string>()
  children: FakeEl[] = []
  className = ''
  textContent = ''
  tag: string
  constructor(tag: string) { this.tag = tag }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)) }
  getAttribute(k: string) { return this.attrs.get(k) ?? null }
  append(...c: FakeEl[]) { this.children.push(...c) }
  replaceChildren(...c: FakeEl[]) { this.children = c.flatMap(x => x.tag === '#fragment' ? x.children : [x]) }
  // Only the one selector stickers.ts uses; anything else is a test bug, so throw.
  querySelectorAll(sel: string): FakeEl[] {
    assert.equal(sel, 'svg[data-qr]')
    const out: FakeEl[] = []
    const walk = (e: FakeEl) => { for (const c of e.children) { if (c.tag === 'svg' && c.attrs.has('data-qr')) out.push(c); walk(c) } }
    walk(this)
    return out
  }
}
;(globalThis as any).document = {
  createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  createElement: (tag: string) => new FakeEl(tag),
  createDocumentFragment: () => new FakeEl('#fragment'),
}

const A = 'https://x.test/#/item/a'
const B = 'https://x.test/#/item/b'
const label = (lang: Lang) => (url: string) => fmt(lang, 'stickers.qr', { url })

test('qrSvg (#182): the aria-label is the one passed in, and data-qr holds the url', async () => {
  const svg = await qrSvg(A, 'LABEL') as unknown as FakeEl
  assert.equal(svg.getAttribute('aria-label'), 'LABEL')
  assert.equal(svg.getAttribute('data-qr'), A)
})

test('relabelSheet (#182): every QR under the host gets the new language, with its own url', async () => {
  const host = new FakeEl('div')
  const box = new FakeEl('div')
  box.append(await qrSvg(A, 'old') as unknown as FakeEl, await qrSvg(B, 'old') as unknown as FakeEl)
  host.append(box)
  relabelSheet(host as unknown as ParentNode, label('es'))
  const [a, b] = host.querySelectorAll('svg[data-qr]')
  assert.equal(a!.getAttribute('aria-label'), STRINGS['stickers.qr']!.es.replace('{url}', A))
  assert.equal(b!.getAttribute('aria-label'), STRINGS['stickers.qr']!.es.replace('{url}', B))
  relabelSheet(host as unknown as ParentNode, label('en'))
  assert.equal(a!.getAttribute('aria-label'), `QR code linking to ${A}`)
  assert.equal(b!.getAttribute('aria-label'), `QR code linking to ${B}`)
})

// The redo's reason: the sheet is built in a fragment, so a switch while the codes are being made
// re-labels a host that does not hold them yet. The finished sheet must still be in the new language.
test('buildSheet (#182): a switch while the codes are being made still leaves every label in the new language', async () => {
  let lang: Lang = 'es'
  let calls = 0
  // Reads `lang` at call time, like main.ts `qrLabel`. The switch lands right after the first code.
  const live = (url: string) => { const s = fmt(lang, 'stickers.qr', { url }); if (++calls === 1) lang = 'en'; return s }
  const item = (d: string) => ({ d, title: `fake ${d}`, sold: false }) as unknown as Item
  const host = new FakeEl('div')
  const n = await buildSheet(host as unknown as HTMLElement, [item('a'), item('b')], 'https://x.test', live)
  assert.equal(n, 2)
  const svgs = host.querySelectorAll('svg[data-qr]')
  assert.deepEqual(svgs.map(s => s.getAttribute('aria-label')), [`QR code linking to ${A}`, `QR code linking to ${B}`])
})

test('stickers.qr (#182, L12): plain Spanish that keeps the url', () => {
  const { en, es } = STRINGS['stickers.qr']!
  assert.equal(en, 'QR code linking to {url}')
  assert.ok(es.trim(), 'no es')
  assert.notEqual(es, en)
  assert.ok(es.includes('{url}'), 'es drops the url')
  assert.ok(!/relay|signer|nsec|hex/i.test(es), `jargon in "${es}"`)
  assert.notEqual(fmt('es', 'stickers.qr', { url: A }), 'stickers.qr', 'fmt fell back to the key')
})

test('main.ts (#182): the switch re-labels the sheet and the build passes the live label', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.ok(src.includes("relabelSheet($('#sticker-sheet'), qrLabel)"), 'the language switch no longer re-labels the sticker QRs')
  assert.ok(src.includes('buildSheet($(\'#sticker-sheet\'), items, url, qrLabel)'), 'doStickers no longer passes qrLabel')
  assert.ok(src.includes("const qrLabel = (url: string) => fmt(lang, 'stickers.qr', { url })"), 'qrLabel no longer reads lang at call time')
  const stickers = readFileSync(new URL('./stickers.ts', import.meta.url), 'utf8')
  assert.ok(!/from '\.\/i18n/.test(stickers), 'stickers.ts imports i18n')
})
