// #153: the item form's approval count and the deploy line follow the language. Socket-free.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { deployCost, itemCost, type ItemCost } from './cost-text.ts'

const TAIL = ' Your signer should ask once per kind and remember the rest — if it asks every time, it ignored the permissions we requested.'
const base: ItemCost = { n: 2, uploads: 0, mint: false, noffer: false, units: 1, watcher: false }

// en is copied by hand from refreshCost as it was before this slice (3f96c9e), so the English
// cannot change. The numbers are inputs: only the words are under test.
const EN: [Partial<ItemCost>, string][] = [
  [{ n: 1, units: 0 }, '1 signature: 1 listing + 0 availability steps.' + TAIL],
  [{}, '2 signatures: 1 listing + 1 availability step.' + TAIL],
  [{ n: 6, uploads: 1, units: 4 }, '6 signatures: 1 photo upload + 1 listing + 4 availability steps.' + TAIL],
  [{ n: 7, uploads: 3, mint: true, units: 1, watcher: true },
    '7 signatures: 3 photo uploads + 1 offer + 1 listing + 1 availability step + 1 encrypted ladder for your watcher.' + TAIL],
  [{ n: 5, noffer: true, units: 4 },
    '5 signatures: 0 offers — this item already has one, at this price + 1 listing + 4 availability steps.' + TAIL],
  [{ n: 7, uploads: 1, fiatCurrency: 'USD', units: 4, watcher: true },
    '7 signatures: 1 photo upload + 0 offers — priced in USD, so it stays cash at the table + 1 listing + 4 availability steps + 1 encrypted ladder for your watcher.' + TAIL],
]

const ES_TAIL = ' Tu app de firma debería preguntarte una vez y recordar el resto. Si te pregunta cada vez, no guardó los permisos.'
const ES: string[] = [
  '1 aprobación: 1 anuncio + 0 avisos de cuántos quedan.' + ES_TAIL,
  '2 aprobaciones: 1 anuncio + 1 aviso de cuántos quedan.' + ES_TAIL,
  '6 aprobaciones: 1 foto + 1 anuncio + 4 avisos de cuántos quedan.' + ES_TAIL,
  '7 aprobaciones: 3 fotos + 1 forma de cobro + 1 anuncio + 1 aviso de cuántos quedan + 1 lista privada para tu ayudante de ventas.' + ES_TAIL,
  '5 aprobaciones: 0 formas de cobro, porque este artículo ya tiene una con este precio + 1 anuncio + 4 avisos de cuántos quedan.' + ES_TAIL,
  '7 aprobaciones: 1 foto + 0 formas de cobro, porque el precio está en USD y se paga en efectivo + 1 anuncio + 4 avisos de cuántos quedan + 1 lista privada para tu ayudante de ventas.' + ES_TAIL,
]

const DEPLOY_EN_5 = '7 signatures: 5 file uploads + 1 site manifest + 1 Blossom server list. The uploads are all one kind, so your signer should ask about them once.'
const DEPLOY_EN_0 = 'The storefront files are missing. Run `npm run build` in /builder.'

const JARGON = /signature|signer|Blossom|relay|nsec|hex|kind|encrypted/i

test('itemCost: exact en (unchanged) and es for 0, 1 and 3 uploads, mint/noffer/fiat/watcher, units 0, 1 and 4', () => {
  EN.forEach(([v, en], i) => {
    assert.equal(itemCost('en', { ...base, ...v }), en, `en case ${i}`)
    assert.equal(itemCost('es', { ...base, ...v }), ES[i], `es case ${i}`)
  })
})

test('deployCost: exact en (unchanged) and es for 0, 1 and 5 files', () => {
  assert.equal(deployCost('en', 5), DEPLOY_EN_5)
  assert.equal(deployCost('en', 0), DEPLOY_EN_0)
  assert.equal(deployCost('es', 5),
    '7 aprobaciones: 5 archivos de tu tienda + 1 índice de tu tienda + 1 lista de servidores. Los archivos son todos iguales para tu app de firma, así que debería preguntarte por ellos una sola vez.')
  assert.match(deployCost('es', 1), /^3 aprobaciones: 1 archivo de tu tienda \+/)
  assert.equal(deployCost('es', 0), 'Faltan los archivos de tu tienda. Todavía no se puede publicar.')
})

test('es differs from en in every case, has no jargon, and never sends the seller to a terminal', () => {
  const all: [string, string, string][] = [
    ...EN.map(([v], i): [string, string, string] => [`item ${i}`, itemCost('es', { ...base, ...v }), itemCost('en', { ...base, ...v })]),
    ...[0, 1, 5].map((n): [string, string, string] => [`deploy ${n}`, deployCost('es', n), deployCost('en', n)]),
  ]
  for (const [name, es, en] of all) {
    assert.ok(es.trim(), `${name}: empty es`)
    assert.notEqual(es, en, `${name}: es is the English text`)
    assert.doesNotMatch(es, JARGON, `${name}: jargon in ${es}`)
    assert.ok(!es.includes('npm run build'), `${name}: es says npm run build`)
  }
})

test('es pluralises: singular and plural forms differ', () => {
  const one = itemCost('es', { ...base, n: 1, uploads: 1, units: 1 })
  const many = itemCost('es', { ...base, n: 9, uploads: 3, units: 4 })
  assert.match(one, /^1 aprobación: 1 foto \+ 1 anuncio \+ 1 aviso de/)
  assert.ok(!/aprobaciones|fotos|avisos/.test(one), `es singular says a plural: ${one}`)
  assert.match(many, /^9 aprobaciones: 3 fotos \+ 1 anuncio \+ 4 avisos de/)
  assert.match(deployCost('es', 1), /1 archivo de/)
  assert.match(deployCost('es', 2), /2 archivos de/)
})

// Returns the reasons a main.ts source text is not wired to cost-text.ts; empty means wired.
const wiringProblems = (src: string) => {
  const out: string[] = []
  if (!/import \{[^}]*\bitemCost\b[^}]*\} from '\.\/cost-text\.ts'/.test(src)) out.push('cost-text.ts is not imported')
  if (src.includes('encrypted ladder for your watcher')) out.push('main.ts still writes the #cost English itself')
  if (src.includes('The storefront files are missing')) out.push('main.ts still writes the #deploy-cost English itself')
  const at = src.indexOf("$('#lang-switch').addEventListener('click', () => {")
  const sw = at < 0 ? '' : src.slice(at, src.indexOf('\n})', at))
  if (!sw.includes('refreshCost()')) out.push('the language switch does not re-draw #cost')
  if (!sw.includes('showDeployCost()')) out.push('the language switch does not re-draw #deploy-cost')
  return out
}

test('wiring: main.ts uses cost-text.ts and the switch re-draws both lines', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.deepEqual(wiringProblems(src), [])
  // Negative controls (L1): the old shapes must each report their own problem.
  const old = src.replace("import { deployCost, itemCost } from './cost-text.ts'\n", '')
    .replace('$(\'#cost\').textContent = itemCost(', "const x = ['1 encrypted ladder for your watcher']; itemCost(")
    .replace("deployFiles = (await", "'The storefront files are missing. Run `npm run build` in /builder.'; deployFiles = (await")
  assert.deepEqual(wiringProblems(old), [
    'cost-text.ts is not imported',
    'main.ts still writes the #cost English itself',
    'main.ts still writes the #deploy-cost English itself',
  ])
  const noSwitch = src.replace(/\n  refreshCost\(\) \/\/ #153[^\n]*\n  showDeployCost\(\)[^\n]*/, '')
  assert.notEqual(noSwitch, src)
  assert.deepEqual(wiringProblems(noSwitch), [
    'the language switch does not re-draw #cost',
    'the language switch does not re-draw #deploy-cost',
  ])
})
