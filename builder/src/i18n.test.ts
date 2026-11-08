// G1.1 and G1.2, socket-free (L9). The browser half is in ../smoke.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { keep, load, missing, pickLang, STRINGS } from './i18n.ts'

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

test('inventory (L1): missing() goes red on a table with one es removed', () => {
  const broken = { ...STRINGS, 's1.nip07': { en: STRINGS['s1.nip07']!.en, es: '' } }
  assert.deepEqual(missing(Object.keys(broken), broken), ['s1.nip07'])
  const { es: _, ...noEs } = STRINGS['s1.connect']!
  assert.deepEqual(missing(['s1.connect', 'brand'], { ...STRINGS, 's1.connect': noEs }), ['s1.connect'])
  assert.deepEqual(missing(['no.such.key']), ['no.such.key'])
})

test('the Spanish has no jargon', () => {
  for (const [k, v] of Object.entries(STRINGS))
    for (const w of ['signer', 'bunker', 'nip-07', 'relay', 'nsec'])
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
