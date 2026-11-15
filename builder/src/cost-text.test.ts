// G1.1 (#151): the item form's approval count and the deploy-cost line follow the language. Socket-free.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { deployCost, itemCost, type CostView } from './cost-text.ts'

const v = (o: Partial<CostView>): CostView =>
  ({ n: 1, uploads: 0, mint: false, noffer: false, fiatCurrency: null, units: 0, watcher: false, ...o })

const TAIL_EN = ' Your signer should ask once per kind and remember the rest — if it asks every time, it ignored the permissions we requested.'
const TAIL_ES = ' Tu teléfono debería preguntar una vez por cada tipo y recordar el resto; si pregunta cada vez, ignoró los permisos que pedimos.'

// en is copied from main.ts `refreshCost` as it was before this slice (3f96c9e): the English must not change.
const ITEM: [string, CostView, string, string][] = [
  ['new item, 2 uploads, mint, watcher', v({ n: 9, uploads: 2, mint: true, units: 3, watcher: true }),
    '9 signatures: 2 photo uploads + 1 offer + 1 listing + 3 availability steps + 1 encrypted ladder for your watcher.' + TAIL_EN,
    '9 aprobaciones: 2 subidas de fotos + 1 oferta + 1 artículo + 3 pasos de disponibilidad + 1 aviso cifrado para tu ayudante.' + TAIL_ES],
  ['edit reusing its offer', v({ n: 3, noffer: true, units: 2 }),
    '3 signatures: 0 offers — this item already has one, at this price + 1 listing + 2 availability steps.' + TAIL_EN,
    '3 aprobaciones: 0 ofertas (este artículo ya tiene una con este precio) + 1 artículo + 2 pasos de disponibilidad.' + TAIL_ES],
  ['fiat in USD', v({ n: 2, fiatCurrency: 'USD', units: 1 }),
    '2 signatures: 0 offers — priced in USD, so it stays cash at the table + 1 listing + 1 availability step.' + TAIL_EN,
    '2 aprobaciones: 0 ofertas (el precio está en USD, así que se paga en efectivo en la mesa) + 1 artículo + 1 paso de disponibilidad.' + TAIL_ES],
  ['1 unit, 1 upload, 1 signature', v({ n: 1, uploads: 1, units: 1 }),
    '1 signature: 1 photo upload + 1 listing + 1 availability step.' + TAIL_EN,
    '1 aprobación: 1 subida de foto + 1 artículo + 1 paso de disponibilidad.' + TAIL_ES],
  ['3 units', v({ n: 4, units: 3 }),
    '4 signatures: 1 listing + 3 availability steps.' + TAIL_EN,
    '4 aprobaciones: 1 artículo + 3 pasos de disponibilidad.' + TAIL_ES],
]

const DEPLOY: [number, string, string][] = [
  [3, '5 signatures: 3 file uploads + 1 site manifest + 1 Blossom server list. The uploads are all one kind, so your signer should ask about them once.',
    '5 aprobaciones: 3 archivos + 1 índice de la tienda + 1 lista de servidores de archivos. Los archivos son del mismo tipo, así que tu teléfono debería preguntar una sola vez.'],
  [1, '3 signatures: 1 file uploads + 1 site manifest + 1 Blossom server list. The uploads are all one kind, so your signer should ask about them once.',
    '3 aprobaciones: 1 archivo + 1 índice de la tienda + 1 lista de servidores de archivos. Los archivos son del mismo tipo, así que tu teléfono debería preguntar una sola vez.'],
  [0, 'The storefront files are missing. Run `npm run build` in /builder.',
    'Faltan los archivos de la tienda. Esta página está incompleta; avisa a quien te la dio.'],
]

test('itemCost: exact en (unchanged) and es for each case', () => {
  for (const [name, view, en, es] of ITEM) {
    assert.equal(itemCost('en', view), en, `en ${name}`)
    assert.equal(itemCost('es', view), es, `es ${name}`)
  }
})

test('deployCost: exact en (unchanged) and es for 3, 1 and 0 files', () => {
  for (const [n, en, es] of DEPLOY) {
    assert.equal(deployCost('en', n), en, `en ${n}`)
    assert.equal(deployCost('es', n), es, `es ${n}`)
  }
})

// Words the seller must never read, and English words that would mean a part was left untranslated.
const JARGON = /relay|signer|nsec|hex|blossom|kind/i
const LEFTOVER = /\b(signatures?|offers?|listing|uploads?|availability|steps?|watcher|ladder|files?|manifest|missing|your)\b/i

// Every es sentence the module can make for these cases; `es` must be a real Spanish function.
const allEs = (item: typeof itemCost, deploy: typeof deployCost) => [
  ...ITEM.map(([, view]) => ['item', item('es', view), itemCost('en', view)] as const),
  ...DEPLOY.map(([n]) => ['deploy', deploy('es', n), deployCost('en', n)] as const),
]
const esProblems = (item: typeof itemCost, deploy: typeof deployCost) => {
  const out: string[] = []
  for (const [what, es, en] of allEs(item, deploy)) {
    if (!es.trim()) out.push(`${what}: empty es`)
    if (es === en) out.push(`${what}: es is the English text`)
    if (JARGON.test(es)) out.push(`${what}: jargon in ${es}`)
    if (LEFTOVER.test(es)) out.push(`${what}: English left in ${es}`)
  }
  return out
}

test('es: never the English, no jargon, no English leftovers; plurals are right', () => {
  assert.deepEqual(esProblems(itemCost, deployCost), [])
  // Negative control (L1): an es that is the English text must go red on every case.
  const enItem: typeof itemCost = (_l, view) => itemCost('en', view)
  const enDeploy: typeof deployCost = (_l, n) => deployCost('en', n)
  const bad = esProblems(enItem, enDeploy)
  assert.equal(bad.filter(p => p.endsWith('es is the English text')).length, ITEM.length + DEPLOY.length)
  assert.ok(bad.some(p => p.includes('jargon')), 'the English deploy line says signer/Blossom, which the check must catch')
  // Singular vs plural.
  const one = itemCost('es', v({ n: 1, uploads: 1, units: 1 }))
  assert.ok(!/aprobaciones|fotos|pasos/.test(one), `es singular uses a plural: ${one}`)
  assert.match(itemCost('es', v({ n: 4, uploads: 3, units: 3 })), /^4 aprobaciones: 3 subidas de fotos \+ 1 artículo \+ 3 pasos /)
  assert.match(deployCost('es', 1), /: 1 archivo \+/)
})

// Returns the reasons a main.ts source text is not wired to cost-text.ts; empty means wired.
const block = (src: string, head: string, end: string) => {
  const at = src.indexOf(head)
  const stop = at < 0 ? -1 : src.indexOf(end, at)
  return stop < 0 ? '' : src.slice(at, stop + end.length)
}
const wiringProblems = (src: string) => {
  const out: string[] = []
  if (!src.includes('itemCost(lang, costView)')) out.push('no itemCost(lang, costView) call')
  if (!src.includes('deployCost(lang, deployFiles)')) out.push('no deployCost(lang, deployFiles) call')
  if (/availability step\$\{|'1 encrypted ladder for your watcher'|1 site manifest \+/.test(src)) out.push('main.ts still writes the English itself')
  const sw = block(src, "$('#lang-switch').addEventListener('click', () => {", '\n})')
  if (!sw.includes('showCost()')) out.push('the switch does not call showCost()')
  if (!sw.includes('showDeployCost()')) out.push('the switch does not call showDeployCost()')
  if (!block(src, 'const refreshDeployCost = async', '\n}\n').includes('.catch(() => [])')) out.push('refreshDeployCost lost its catch')
  return out
}

test('wiring: main.ts says both lines through cost-text.ts and the switch re-writes them', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.deepEqual(wiringProblems(src), [])
  const noSwitch = src.replace('  showCost() // #151: the item', '  // the item')
    .replace('  showDeployCost() // #151: the deploy-cost line', '  // the deploy-cost line')
  assert.notEqual(noSwitch, src)
  assert.deepEqual(wiringProblems(noSwitch), ['the switch does not call showCost()', 'the switch does not call showDeployCost()'])
  // The old English write put back must go red too.
  const oldText = src.replace('showDeployCost() // #151: cost-text.ts',
    "$('#deploy-cost').textContent = `${n + 2} signatures: ${n} file uploads + 1 site manifest + 1 Blossom server list. `")
  assert.notEqual(oldText, src)
  assert.deepEqual(wiringProblems(oldText), ['main.ts still writes the English itself'])
})
