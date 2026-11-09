// G1.1 and G1.2, socket-free (L9). The browser half is in ../smoke.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fmt, keep, load, missing, pickLang, STRINGS } from './i18n.ts'

test('pickLang: a stored choice wins, then any es* phone language, then English', () => {
  for (const nav of ['es', 'es-MX', 'ES-419']) assert.equal(pickLang(nav, null), 'es', nav)
  for (const nav of ['en-US', 'fr', '', undefined, 'est']) assert.equal(pickLang(nav, null), 'en', String(nav))
  assert.equal(pickLang('es-MX', 'en'), 'en')
  assert.equal(pickLang('en-US', 'es'), 'es')
  assert.equal(pickLang('es-MX', 'klingon'), 'es')
  assert.equal(pickLang('en-US', 'ES'), 'en')
})

// The names that are the same in both languages on purpose. Anything else equal is untranslated.
const SAME_IN_BOTH = ['brand']

test('inventory (G1.1): every key has en and es, and every data-i18n in index.html is a key', () => {
  for (const [k, v] of Object.entries(STRINGS)) {
    assert.ok(v.en.trim(), `${k}: no en`)
    assert.ok(v.es.trim(), `${k}: no es`)
    if (!SAME_IN_BOTH.includes(k)) assert.notEqual(v.es, v.en, `${k}: es is the English text`)
  }
  assert.deepEqual(missing(Object.keys(STRINGS)), [])
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const used = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]!)
  assert.ok(used.length >= 12, `only ${used.length} data-i18n keys found in index.html`)
  for (const k of used) assert.ok(k in STRINGS, `index.html uses ${k}, which is not in STRINGS`)
})

// #55: four static texts in the un-list warning and the price row. None of these elements nests a
// tag of its own name, so an element runs from its opening tag to the first closing tag that matches.
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const WIRED: Record<string, string> = { 'shrink.hint': 'publishing this list', 'shrink.ok': 'un-list them', 'price.hint': 'Sats only', 'price.fiatNote': 'priced in another currency' }
const element = (keyPattern: string, flags = '') =>
  new RegExp(`<(\\w+)\\b[^>]*\\bdata-i18n="${keyPattern}"[^>]*>([\\s\\S]*?)</\\1>`, flags)
const textOf = (html: string, key: string) => element(key.replaceAll('.', '\\.')).exec(html)?.[2]
const unwired = (html: string) => html.replace(element('[^"]+', 'g'), '')

test('inventory (#55): the un-list hint, its tick-box and both price notes are wired', () => {
  for (const [k, phrase] of Object.entries(WIRED)) {
    const text = textOf(HTML, k)
    assert.ok(text !== undefined, `index.html has no element with data-i18n="${k}"`)
    assert.equal(text.replace(/\s+/g, ' ').trim(), STRINGS[k]!.en, `${k}: the HTML fallback is not the table's en`)
    assert.ok(!unwired(HTML).includes(phrase), `"${phrase}" is in index.html outside a data-i18n element`)
  }
})

test('inventory (#55, L1): the check sees a tick-box span with its data-i18n removed', () => {
  const broken = HTML.replace(' data-i18n="shrink.ok"', '')
  assert.notEqual(broken, HTML)
  assert.equal(textOf(broken, 'shrink.ok'), undefined)
  assert.ok(unwired(broken).includes('un-list them'))
})

test('inventory (L1): missing() goes red on a table with one es removed', () => {
  const broken = { ...STRINGS, 's1.nip07': { en: STRINGS['s1.nip07']!.en, es: '' } }
  assert.deepEqual(missing(Object.keys(broken), broken), ['s1.nip07'])
  const { es: _, ...noEs } = STRINGS['s1.connect']!
  assert.deepEqual(missing(['s1.connect', 'brand'], { ...STRINGS, 's1.connect': noEs }), ['s1.connect'])
  assert.deepEqual(missing(['no.such.key']), ['no.such.key'])
})

test('the Spanish has no jargon', () => {
  for (const [k, v] of Object.entries(STRINGS))
    for (const w of ['signer', 'bunker', 'nip-07', 'relay', 'nsec', ...(k in WIRED ? ['nostr', 'kind 30405', 'oracle'] : [])])
      assert.ok(!v.es.toLowerCase().includes(w), `${k}: es says "${w}"`)
})

test('load and keep never throw, even when reading the storage itself throws', () => {
  const blocked = (): Storage => { throw new DOMException('blocked', 'SecurityError') }
  assert.equal(load('lamppost.lang', blocked), null)
  assert.doesNotThrow(() => keep('lamppost.lang', 'es', blocked))
  const box = new Map<string, string>()
  const fake = () => ({ getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, v: string) => box.set(k, v) }) as unknown as Storage
  keep('lamppost.lang', 'es', fake)
  assert.equal(load('lamppost.lang', fake), 'es')
})

// #34: the two step-1 texts main.ts writes itself. Fake label and key only.
const KEY = 'aaaaaaaa…bbbbbbbb'
test('fmt (#34): "Connected via" and the signed-in name, in both languages', () => {
  for (const k of ['status.connected', 'whoami']) assert.ok(k in STRINGS, `${k} is not in STRINGS`)
  const es = fmt('es', 'status.connected', { label: 'NIP-07 extension' })
  assert.equal(es, STRINGS['status.connected']!.es)
  assert.ok(!es.includes('{') && !es.includes('NIP-07'), es)
  assert.equal(fmt('en', 'status.connected', { label: 'NIP-07 extension' }), 'Connected via NIP-07 extension.')
  const who = fmt('es', 'whoami', { label: 'Fake bunker', key: KEY })
  assert.equal(who, STRINGS.whoami!.es.replace('{key}', KEY))
  assert.ok(!who.includes('{') && !who.includes('Fake bunker'), who)
  assert.equal(fmt('en', 'whoami', { label: 'Fake bunker', key: KEY }), `Fake bunker — ${KEY}`)
})

test('fmt (#34, L1): a blanked es is caught; unknown keys and {x} neither throw nor print undefined', () => {
  const broken = { ...STRINGS, 'status.connected': { en: STRINGS['status.connected']!.en, es: '' } }
  assert.deepEqual(missing(Object.keys(broken), broken), ['status.connected'])
  assert.doesNotThrow(() => fmt('es', 'no.such.key', { label: 'x' }))
  assert.equal(fmt('es', 'no.such.key'), 'no.such.key')
  assert.equal(fmt('en', 'whoami', { key: KEY }), `{label} — ${KEY}`)
  assert.equal(fmt('en', 'status.connected', { label: '$& {label}' }), 'Connected via $& {label}.')})

test('main.ts (#34): neither step-1 text bypasses the table', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.ok(!src.includes('Connected via'), 'main.ts still writes "Connected via" itself')
  assert.ok(!src.includes('.label} —'), 'main.ts still builds the signed-in name from a template')
  assert.equal([...src.matchAll(/fmt\(lang, '(status\.connected|whoami)'/g)].length, 2)
})
