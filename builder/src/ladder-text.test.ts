// G1.1 (#181): panel 6's #result-text and #ladder-note follow the language. Socket-free.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ladderNote, resultLine, type NoteVars } from './ladder-text.ts'
import { STRINGS } from './i18n.ts'

// en is copied literally from main.ts as it was before this slice (988613a), so the English must not change.
const EDIT = ' You just edited an item, so this is not optional: the rungs your watcher is holding were cut from the OLD listing and are now older than what is on the relays, which means it would publish them and the relay would ignore it. It would keep reporting success while the item stayed on sale after it sold. Restarting the watcher on this file is what closes that.'
const OLD = {
  buy: 'Mug grande is live on 3/4 relays as 30402:abc:mug, with a Buy button.',
  cash: 'Mug grande is live on 3/4 relays as 30402:abc:mug, cash at the table.',
  file: '2 item(s) in this ladder. Save it as .ladder.json next to watch-sales.ts, then restart the watcher.',
  sent: '2 item(s) in this ladder. Sent encrypted to your watcher on 3/4 relays, so there is no file to copy and nothing to restart. The download stays here as a backup.',
  none: '2 item(s) in this ladder. The ladder could NOT be sent to your watcher: no relay accepted it. The item is published and really for sale, but your watcher has not been told about it. Save it as .ladder.json next to watch-sales.ts and restart the watcher, or publish again once the relays answer.',
}
const R = { title: 'Mug grande', ok: 3, total: 4, d: '30402:abc:mug' }
const VARIANTS: Record<'file' | 'sent' | 'none', Omit<NoteVars, 'wasEdit'>> = {
  file: { items: 2, total: 4, ladderRelaysOk: undefined },
  sent: { items: 2, total: 4, ladderRelaysOk: 3 },
  none: { items: 2, total: 4, ladderRelaysOk: 0 },
}
const NOTES = (['file', 'sent', 'none'] as const).flatMap(v => [false, true].map(wasEdit => ({ v, wasEdit, vars: { ...VARIANTS[v], wasEdit } })))

test('en is word for word the old English: both result lines, 3 notes, with and without the edit warning', () => {
  assert.equal(resultLine('en', { ...R, noffer: true }), OLD.buy)
  assert.equal(resultLine('en', { ...R, noffer: false }), OLD.cash)
  for (const { v, wasEdit, vars } of NOTES) {
    // The relay path never carries the edit warning: the watcher's ladder was just replaced.
    const want = OLD[v] + (wasEdit && v !== 'sent' ? EDIT : '')
    assert.equal(ladderNote('en', vars), want, `${v} wasEdit=${wasEdit}`)
  }
})

const BANNED = ['relay', 'watcher', 'ladder', 'nostr', '.ladder.json', 'watch-sales', 'kind', 'npub', 'hex']
const plain = (label: string, es: string, en: string) => {
  assert.ok(es.trim(), `${label}: empty es`)
  assert.notEqual(es, en, `${label}: es is the English text`)
  for (const w of BANNED) assert.ok(!es.toLowerCase().includes(w), `${label}: es says "${w}": ${es}`)
  assert.doesNotMatch(es, /\{\w+\}/, `${label}: an unfilled slot`)
}

test('es: not the English, no jargon, has the title and the counts, and gives the next step', () => {
  for (const noffer of [true, false]) {
    const es = resultLine('es', { ...R, noffer })
    plain(`result noffer=${noffer}`, es, resultLine('en', { ...R, noffer }))
    assert.ok(es.includes('Mug grande'), `no title: ${es}`)
    assert.ok(es.includes('3 de 4'), `no count: ${es}`)
  }
  for (const { v, wasEdit, vars } of NOTES) {
    const es = ladderNote('es', vars)
    plain(`${v} wasEdit=${wasEdit}`, es, ladderNote('en', vars))
    assert.match(es, /^2 artículos /, `${v}: no item count`)
    // The next step: send nothing / download and give it to the helper / try again.
    if (v === 'sent') assert.match(es, /No tienes que enviar/), assert.ok(es.includes('3 de 4'))
    if (v === 'file') assert.match(es, /Descarga el archivo y dáselo a tu ayudante de ventas/)
    if (v === 'none') assert.match(es, /vuelve a publicar/), assert.match(es, /Descarga el archivo/)
    // The edit warning: the helper's list is old and the file must be given again.
    const warned = /ya es vieja\. Dale este archivo otra vez\./.test(es)
    assert.equal(warned, wasEdit && v !== 'sent', `${v} wasEdit=${wasEdit}: edit warning ${warned}`)
  }
})

test('es plural: 1 artículo vs 2 artículos', () => {
  const one = ladderNote('es', { ...VARIANTS.file, items: 1, wasEdit: false })
  const two = ladderNote('es', { ...VARIANTS.file, items: 2, wasEdit: false })
  assert.match(one, /^1 artículo en /)
  assert.match(two, /^2 artículos en /)
  assert.notEqual(one.replace(/^1/, ''), two.replace(/^2/, ''))
})

// L4: the exact functions the switch re-calls are resultLine and ladderNote, through showResult.
test('switch: the same view rendered en then es gives different text for both lines', () => {
  const view = { result: { ...R, noffer: true }, note: { ...VARIANTS.none, wasEdit: true } }
  const en = [resultLine('en', view.result), ladderNote('en', view.note)]
  const es = [resultLine('es', view.result), ladderNote('es', view.note)]
  assert.notEqual(es[0], en[0])
  assert.notEqual(es[1], en[1])
  assert.equal(en[0], OLD.buy)
  assert.equal(en[1], OLD.none + EDIT)
})

test('main.ts: no old English left, publish fills resultView, the switch calls showResult', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  for (const old of ['in this ladder', "', cash at the table.'", "', with a Buy button.'", 'restart the watcher', 'You just edited an item'])
    assert.ok(!src.includes(old), `main.ts still writes "${old}"`)
  assert.match(src, /resultView = \{\s*result: \{[^}]*\},\s*note: \{[^}]*\},\s*\}\s*showResult\(\)/)
  assert.match(src, /\$\('#result-text'\)\.textContent = resultLine\(lang, resultView\.result\)/)
  assert.match(src, /\$\('#ladder-note'\)\.textContent = ladderNote\(lang, resultView\.note\)/)
  const sw = src.slice(src.indexOf("$('#lang-switch').addEventListener"))
  assert.match(sw.slice(0, sw.indexOf('\n})')), /\n  showResult\(\)/, 'the language switch does not call showResult')
  // loadPanel runs after a publish and must not clear the view.
  assert.match(src, /let resultView: ResultView = null\n/)
  assert.ok(!/\bresultView = null/.test(src), 'resultView is cleared somewhere besides its start')
})

// L1: a missing es entry makes the output English, which the checks above catch.
test('L1: with one es entry missing, the es output is the English and the check goes red', () => {
  const keep = STRINGS['ladder.notSent']!
  try {
    STRINGS['ladder.notSent'] = { en: keep.en, es: '' }
    const vars = { ...VARIANTS.none, wasEdit: false }
    assert.throws(() => plain('none', ladderNote('es', vars), ladderNote('en', vars)))
  } finally {
    STRINGS['ladder.notSent'] = keep
  }
})
