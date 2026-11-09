// G1.1: the sale-published sentence follows the language. Socket-free.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { saleLive } from './sale-text.ts'

const base = { title: 'Venta de prueba', ok: 3, total: 4, d: 'sale-test' }
const MAP = ' Its neighbourhood is now a tappable map link on your storefront.'
const MAP_ES = ' Ahora el barrio de tu venta se puede tocar en tu tienda para abrir un mapa.'

// en is copied from main.ts as it was before this slice (948177e), so the English must not change.
// Keys: items, then mapLink.
const EXPECTED = {
  en: {
    '1,false': '“Venta de prueba” is live on 3/4 relays as sale-test, listing 1 item(s).',
    '1,true': '“Venta de prueba” is live on 3/4 relays as sale-test, listing 1 item(s).' + MAP,
    '3,false': '“Venta de prueba” is live on 3/4 relays as sale-test, listing 3 item(s).',
    '3,true': '“Venta de prueba” is live on 3/4 relays as sale-test, listing 3 item(s).' + MAP,
  },
  es: {
    '1,false': '“Venta de prueba” ya está publicada en 3 de 4 servidores como sale-test, con 1 artículo.',
    '1,true': '“Venta de prueba” ya está publicada en 3 de 4 servidores como sale-test, con 1 artículo.' + MAP_ES,
    '3,false': '“Venta de prueba” ya está publicada en 3 de 4 servidores como sale-test, con 3 artículos.',
    '3,true': '“Venta de prueba” ya está publicada en 3 de 4 servidores como sale-test, con 3 artículos.' + MAP_ES,
  },
} as const
const CASES = [1, 3].flatMap((items) => [false, true].map((mapLink) => ({ items, mapLink })))
const key = (c: { items: number; mapLink: boolean }) => `${c.items},${c.mapLink}` as keyof typeof EXPECTED.en

test('exact en (unchanged) and es for 1 and 3 items, with and without the map link', () => {
  for (const c of CASES) {
    for (const lang of ['en', 'es'] as const) {
      assert.equal(saleLive(lang, { ...base, ...c }), EXPECTED[lang][key(c)], `${lang} ${key(c)}`)
    }
  }
})

test('es singular says artículo, plural says artículos', () => {
  for (const mapLink of [false, true]) {
    const one = saleLive('es', { ...base, items: 1, mapLink })
    assert.match(one, /\b1 artículo\b/)
    assert.ok(!one.includes('artículos'), `es singular says artículos: ${one}`)
    assert.match(saleLive('es', { ...base, items: 3, mapLink }), /\b3 artículos\b/)
  }
})

test('es is not the English text and has no jargon', () => {
  for (const c of CASES) {
    const es = saleLive('es', { ...base, ...c })
    assert.ok(es.trim(), `${key(c)}: empty es`)
    assert.notEqual(es, saleLive('en', { ...base, ...c }), `${key(c)}: es is the English text`)
    for (const bad of [/relay/i, /signer/i, /nostr/i, /kind 30405/i, /bunker/i, /nsec/i]) {
      assert.doesNotMatch(es, bad, `${key(c)}: es says ${bad}`)
    }
  }
})

// Returns the reasons a main.ts source text is not wired to saleLive; empty means wired.
const wiringProblems = (src: string) => {
  const out: string[] = []
  if (!src.includes('saleLive(')) out.push('no saleLive( call')
  // Not a bare 'is live on': the item-publish line (out of scope) still says that in English.
  if (src.includes('” is live on') || src.includes('item(s).`')) out.push('main.ts still writes the sale sentence itself')
  return out
}

test('wiring: main.ts calls saleLive and no longer writes the English itself', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.deepEqual(wiringProblems(src), [])
  // The same check over a copy with the call put back to the old English template must go red.
  const call = /saleLive\(lang, \{[^}]*\}\)/
  assert.match(src, call, 'the saleLive call was not found to replace')
  const old = src.replace(
    call,
    '`“${draft.title}” is live on ${relaysOk}/${RELAYS.length} relays as ${draft.d}, listing ${owned.length} item(s).` +\n' +
      "      (draft.g ? ' Its neighbourhood is now a tappable map link on your storefront.' : '')",
  )
  assert.notEqual(old, src)
  assert.deepEqual(wiringProblems(old), ['no saleLive( call', 'main.ts still writes the sale sentence itself'])
})
