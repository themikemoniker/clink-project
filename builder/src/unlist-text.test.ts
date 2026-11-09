// G1.1: the counted un-list sentences follow the language. Socket-free.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { unlistSay, unlistWhat } from './unlist-text.ts'

// en is copied from main.ts as it was before this slice (99d011b), so the English must not change.
const EXPECTED = {
  unlistWhat: {
    en: [
      'This would un-list 1 item that your sale lists right now:',
      'This would un-list 3 items that your sale lists right now:',
    ],
    es: [
      'Esto quitaría de la venta 1 artículo que hoy está en tu venta:',
      'Esto quitaría de la venta 3 artículos que hoy están en tu venta:',
    ],
  },
  unlistSay: {
    en: [
      'Publishing this would un-list 1 item. Read the box above, then tick it if you meant to.',
      'Publishing this would un-list 3 items. Read the box above, then tick it if you meant to.',
    ],
    es: [
      'Publicar esto quitaría de la venta 1 artículo. Lee el recuadro de arriba y márcalo si fue a propósito.',
      'Publicar esto quitaría de la venta 3 artículos. Lee el recuadro de arriba y márcalo si fue a propósito.',
    ],
  },
} as const
const FNS = { unlistWhat, unlistSay }

test('both sentences: exact en (unchanged) and es, singular for 1 and plural for 3', () => {
  for (const [name, fn] of Object.entries(FNS)) {
    const want = EXPECTED[name as keyof typeof EXPECTED]
    for (const lang of ['en', 'es'] as const) {
      assert.equal(fn(lang, 1), want[lang][0], `${name} ${lang} n=1`)
      assert.equal(fn(lang, 3), want[lang][1], `${name} ${lang} n=3`)
    }
    assert.ok(!fn('es', 1).includes('artículos'), `${name}: es singular says artículos`)
    assert.ok(fn('es', 3).includes('artículos'), `${name}: es plural lacks artículos`)
  }
})

test('es is not the English text and has no jargon', () => {
  for (const [name, fn] of Object.entries(FNS)) {
    for (const n of [1, 3]) {
      const es = fn('es', n)
      assert.ok(es.trim(), `${name} n=${n}: empty es`)
      assert.notEqual(es, fn('en', n), `${name} n=${n}: es is the English text`)
      for (const bad of [/relay/i, /signer/i, /nostr/i, /kind 30405/i, /un-list/i]) {
        assert.doesNotMatch(es, bad, `${name} n=${n}: es says ${bad}`)
      }
    }
  }
})

// Returns the reasons a main.ts source text is not wired to the functions; empty means wired.
const wiringProblems = (src: string) => {
  const out: string[] = []
  if (!src.includes('unlistWhat(')) out.push('no unlistWhat( call')
  if (!src.includes('unlistSay(')) out.push('no unlistSay( call')
  if (src.includes('would un-list')) out.push('main.ts still writes "would un-list" itself')
  return out
}

test('wiring: main.ts calls both functions and no longer writes the English itself', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.deepEqual(wiringProblems(src), [])
  // The same check over a copy with each call put back to the old English template must go red.
  const oldWhat = src.replace(
    'unlistWhat(lang, dropped.length)',
    "`This would un-list ${dropped.length} item${dropped.length === 1 ? '' : 's'} that your sale lists right now:`",
  )
  assert.notEqual(oldWhat, src, 'the unlistWhat call was not found to replace')
  assert.notDeepEqual(wiringProblems(oldWhat), [])
  const oldSay = src.replace(
    'unlistSay(lang, dropped.length)',
    "`Publishing this would un-list ${dropped.length} item${dropped.length === 1 ? '' : 's'}. ` +\n" +
      '        `Read the box above, then tick it if you meant to.`',
  )
  assert.notEqual(oldSay, src, 'the unlistSay call was not found to replace')
  assert.notDeepEqual(wiringProblems(oldSay), [])
})
