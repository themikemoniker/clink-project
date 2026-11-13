// G1.1 and G1.2: the photo status line (#photo-state) speaks Spanish and follows the switch. Socket-free.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { STRINGS } from './i18n.ts'
import { photoState, type PhotoView } from './photo-text.ts'

const VIEWS: PhotoView[] = [null, { kind: 'none' }, { kind: 'have', widths: [1200, 480, 160] }, { kind: 'stored', widths: [1200, 480, 160] }]
const BANNED = /blossom|relay|servidor de blossom|\bpx\b|\d+px|signer|nsec|\bhex\b/i
const KEYS = ['photo.hint', 'photo.none', 'photo.have', 'photo.stored']

test('every view: es is not the English and has no jargon and no raw {slot}', () => {
  for (const v of VIEWS) {
    const es = photoState('es', v)
    assert.ok(es.trim(), `${JSON.stringify(v)}: empty es`)
    assert.notEqual(es, photoState('en', v), `${JSON.stringify(v)}: es is the English text`)
    assert.doesNotMatch(es, BANNED, `${JSON.stringify(v)}: jargon in "${es}"`)
    assert.ok(!es.includes('{'), `${JSON.stringify(v)}: raw slot in "${es}"`)
  }
  // L1: the jargon check goes red on the English of every view but the plain `none`.
  for (const v of VIEWS.filter(v => v?.kind !== 'none')) assert.match(photoState('en', v), BANNED)
})

test('en is word for word the old main.ts English', () => {
  assert.equal(photoState('en', null), 'Resized in your browser to 1200, 480 and 160px. The original is never uploaded.')
  assert.equal(photoState('en', { kind: 'none' }), 'No photo on this item yet.')
  const have = photoState('en', { kind: 'have', widths: [1200, 480, 160] })
  assert.ok(have.includes('1200px, 480px, 160px'), have)
  assert.equal(have, '1200px, 480px, 160px already on Blossom. Leave the file field empty to keep them.')
  assert.equal(photoState('en', { kind: 'stored', widths: [1200, 480] }), '1200px, 480px on Blossom.')
})

test('every photo.* key is in STRINGS with both languages', () => {
  for (const k of KEYS) {
    assert.ok(STRINGS[k], `${k} is not in STRINGS`)
    assert.ok(STRINGS[k]!.en.trim(), `${k}: no en`)
    assert.ok(STRINGS[k]!.es.trim(), `${k}: no es`)
  }
})

// The #photo-state writes in a main.ts source text that do not go through photoState(.
const literalWrites = (src: string) =>
  src.split('\n').filter(l => l.includes('#photo-state') && l.includes('textContent') && !l.includes('photoState('))

test('main.ts: every #photo-state write goes through photoState, and the switch re-writes it', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.deepEqual(literalWrites(src), [])
  assert.ok(src.split('\n').some(l => l.includes('#photo-state') && l.includes('photoState(')), 'no photoState write at all')
  for (const old of ['The original is never uploaded', 'No photo on this item yet', 'on Blossom.'])
    assert.ok(!src.includes(old), `main.ts still writes "${old}" itself`)
  const handler = src.slice(src.indexOf("$('#lang-switch').addEventListener"))
  assert.match(handler.slice(0, handler.indexOf('\n})')), /\bshowPhoto\(\)/, 'the switch does not re-write #photo-state')
  // L14: the first paint runs right after the first applyLang, before any listener.
  assert.match(src, /\napplyLang\(document, lang\)\nshowNode\(\)\nshowPhoto\(\)\n/)
  // resetItem puts the default hint back.
  const reset = src.slice(src.indexOf('const resetItem'), src.indexOf('\n}\n', src.indexOf('const resetItem')))
  assert.match(reset, /photoView = null\b[^\n]*\n\s*showPhoto\(\)/)
})

test('main.ts check (L1): the old literal writes are flagged', () => {
  const fixtures = [
    "    $('#photo-state').textContent = `${blobs.map(b => `${b.w}px`).join(', ')} on Blossom.`",
    "  $('#photo-state').textContent = 'No photo on this item yet.'",
    "  $('#photo-state').textContent =",
  ]
  for (const f of fixtures) assert.deepEqual(literalWrites(f), [f])
  assert.deepEqual(literalWrites("const showPhoto = () => { $('#photo-state').textContent = photoState(lang, photoView) }"), [])
})
