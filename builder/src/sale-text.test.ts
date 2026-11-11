// G1.1: the sale-published sentence follows the language. Socket-free.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { saleCost, saleLive } from './sale-text.ts'

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

// --- #132: the ready-to-publish cost sentence, and the switch that re-draws it ---------------------

// en is copied from main.ts as it was before this slice, so the English must not change.
const COST = {
  en: {
    1: '1 signature. It replaces your whole collection with these 1 item, in the order shown below — nostr has no edit, only replacement. Read from 3/4 relays.',
    3: '1 signature. It replaces your whole collection with these 3 items, in the order shown below — nostr has no edit, only replacement. Read from 3/4 relays.',
  },
  es: {
    1: 'Lo apruebas una sola vez. Reemplaza toda tu lista con 1 artículo, en el orden de abajo. Se leyó de 3 de 4 servidores.',
    3: 'Lo apruebas una sola vez. Reemplaza toda tu lista con 3 artículos, en el orden de abajo. Se leyó de 3 de 4 servidores.',
  },
} as const

test('saleCost: exact en (unchanged) and es for 1 and 3 items', () => {
  for (const n of [1, 3] as const) {
    for (const lang of ['en', 'es'] as const) {
      assert.equal(saleCost(lang, { n, answered: 3, relays: 4 }), COST[lang][n], `${lang} ${n}`)
    }
  }
})

test('saleCost: es singular/plural, not the English, no jargon', () => {
  const one = saleCost('es', { n: 1, answered: 3, relays: 4 })
  const three = saleCost('es', { n: 3, answered: 3, relays: 4 })
  assert.ok(!one.includes('artículos'), `es singular says artículos: ${one}`)
  assert.match(one, /\b1 artículo\b/)
  assert.match(three, /\b3 artículos\b/)
  for (const n of [1, 3]) {
    const es = saleCost('es', { n, answered: 3, relays: 4 })
    assert.notEqual(es, saleCost('en', { n, answered: 3, relays: 4 }), `${n}: es is the English text`)
    assert.doesNotMatch(es, /relay|signer|nostr|signature|kind 30405|bunker|nsec/i, `${n}: jargon in ${es}`)
  }
})

// The source from `head` up to and including the first `end` after it, or null.
const block = (src: string, head: string, end: string) => {
  const at = src.indexOf(head)
  if (at < 0) return null
  const stop = src.indexOf(end, at)
  return stop < 0 ? null : src.slice(at, stop + end.length)
}

type FakeEl = { off?: boolean; textContent: string; toggleAttribute: (a: string, on: boolean) => void }

// Runs main.ts's own `refreshSaleCost` (its source, cut out of the file) against a fake page and
// reports #publish-sale's disabled state and #sale-cost's text. Signed in, panel loaded, 3 items,
// 3 of 4 relays answered: only `pending` (or signing out) can block the button.
const runRefresh = (src: string, pending: boolean, signedIn = true) => {
  const fn = block(src, 'const refreshSaleCost = () => {', '\n}\n')
  if (!fn) return { off: undefined as boolean | undefined, cost: '' }
  const els: Record<string, FakeEl> = {}
  const $ = (id: string) => (els[id] ??= { textContent: '', toggleAttribute(_a, on) { this.off = on } })
  const noPublishSaleReason = (s: { signedIn: boolean }) => (s.signedIn ? undefined : 'Connect a signer first.')
  const run = new Function('$', 'noPublishSaleReason', 'saleCost', 'owned', 'signer', 'panelLoaded', 'answered',
    'RELAYS', 'salePending', 'lang', `${fn}; refreshSaleCost()`)
  run($, noPublishSaleReason, saleCost, [1, 2, 3], signedIn ? {} : null, true, ['a', 'b', 'c'], ['a', 'b', 'c', 'd'], pending, 'es')
  return { off: els['#publish-sale']?.off, cost: els['#sale-cost']?.textContent ?? '' }
}

// Returns the reasons a main.ts source text is not wired; empty means wired.
const costProblems = (src: string) => {
  const out: string[] = []
  if (!src.includes('saleCost(')) out.push('no saleCost( call')
  if (src.includes('nostr has no edit, only replacement. Read from')) out.push('main.ts still writes the cost sentence itself')
  const sw = block(src, "$('#lang-switch').addEventListener('click', () => {", '\n})')
  if (!sw || !sw.includes('refreshSaleCost()')) out.push('the language switch does not call refreshSaleCost()')
  // #132: the switch calls refreshSaleCost, so it must not turn the button back on mid-publish.
  if (runRefresh(src, true).off !== true) out.push('refreshSaleCost enables #publish-sale while a publish is pending')
  const pub = block(src, 'const doPublishSale = async', '\n}\n') ?? ''
  const set = pub.indexOf('salePending = true')
  if (set < 0 || set > pub.indexOf('await publishSale(')) out.push('doPublishSale does not mark pending before publishing')
  if (!/finally \{\s*salePending = false; refreshSaleCost\(\)/.test(pub)) out.push('doPublishSale does not clear pending in finally')
  return out
}

test('wiring: refreshSaleCost uses saleCost, the switch re-draws it, and pending keeps the button off', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.deepEqual(costProblems(src), [])
  // Ready and not pending: the button is on and the sentence is the Spanish one.
  assert.deepEqual(runRefresh(src, false), { off: false, cost: COST.es[3] })
  // Signed out (the switch can be tapped before connecting): the existing reason text, button off.
  assert.deepEqual(runRefresh(src, false, false), { off: true, cost: 'Cannot publish yet: Connect a signer first.' })

  // Negative controls: each old shape must report its own problem.
  const call = /saleCost\(lang,[^\n]*\n[^\n]*\}\)/
  assert.match(src, call, 'the saleCost call was not found to replace')
  const oldText = src.replace(call,
    "`1 signature. It replaces your whole collection with these ${n} item${n === 1 ? '' : 's'}, in the order ` +\n" +
    '      `shown below — nostr has no edit, only replacement. Read from ${answered.length}/${RELAYS.length} relays.`')
  assert.deepEqual(costProblems(oldText), ['no saleCost( call', 'main.ts still writes the cost sentence itself'])

  const noSwitch = src.replace(/(\n  showNode\(\)\n)  refreshSaleCost\(\)[^\n]*\n/, '$1')
  assert.notEqual(noSwitch, src)
  assert.deepEqual(costProblems(noSwitch), ['the language switch does not call refreshSaleCost()'])

  const noGate = src.replace("toggleAttribute('disabled', !!reason || salePending)", "toggleAttribute('disabled', !!reason)")
  assert.notEqual(noGate, src)
  assert.deepEqual(costProblems(noGate), ['refreshSaleCost enables #publish-sale while a publish is pending'])

  const noSet = src.replace("salePending = true; $('#publish-sale')", "$('#publish-sale')")
  assert.notEqual(noSet, src)
  assert.deepEqual(costProblems(noSet), ['doPublishSale does not mark pending before publishing'])

  const noClear = src.replace('salePending = false; refreshSaleCost()', 'refreshSaleCost()')
  assert.notEqual(noClear, src)
  assert.deepEqual(costProblems(noClear), ['doPublishSale does not clear pending in finally'])
})
