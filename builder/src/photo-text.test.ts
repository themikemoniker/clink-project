// G1.1 (#154): the #photo-state line follows the language. Socket-free.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { STRINGS } from './i18n.ts'
import { photoState, type PhotoView } from './photo-text.ts'

const W = [1200, 480, 160]
const VIEWS: PhotoView[] = [null, { kind: 'none' }, { kind: 'have', widths: W }, { kind: 'stored', widths: W }]
const BANNED = /blossom|relay|servidor|\d+\s*px|\bpx\b|signer|nsec|\bhex\b/i

test('every view: es is not the English and has no jargon or unfilled {slot}', () => {
  for (const v of VIEWS) {
    const es = photoState('es', v)
    assert.ok(es.trim(), `${v?.kind ?? 'hint'}: empty es`)
    assert.notEqual(es, photoState('en', v), `${v?.kind ?? 'hint'}: es is the English`)
    assert.doesNotMatch(es, BANNED, `${v?.kind ?? 'hint'}: jargon in "${es}"`)
    assert.ok(!es.includes('{'), `${v?.kind ?? 'hint'}: unfilled slot in "${es}"`)
  }
  // L1: the jargon check goes red on each English text that carries it.
  for (const v of VIEWS.slice(2)) assert.match(photoState('en', v), BANNED)
  assert.match(photoState('en', null), BANNED)
})

test('en is word for word what main.ts wrote before #154', () => {
  assert.equal(photoState('en', null), 'Resized in your browser to 1200, 480 and 160px. The original is never uploaded.')
  assert.equal(photoState('en', { kind: 'none' }), 'No photo on this item yet.')
  assert.equal(photoState('en', { kind: 'have', widths: W }),
    '1200px, 480px, 160px already on Blossom. Leave the file field empty to keep them.')
  assert.equal(photoState('en', { kind: 'stored', widths: W }), '1200px, 480px, 160px on Blossom.')
  assert.ok(photoState('en', { kind: 'stored', widths: [480] }).startsWith('480px on'))
})

test('every photo.* key is in STRINGS with en and es', () => {
  for (const k of ['photo.hint', 'photo.none', 'photo.have', 'photo.stored']) {
    assert.ok(STRINGS[k]?.en.trim(), `${k}: no en`)
    assert.ok(STRINGS[k]?.es.trim(), `${k}: no es`)
  }
})

// The #photo-state writes in a main.ts source that do not go through photoState(.
const literalWrites = (src: string) =>
  [...src.matchAll(/\$\('#photo-state'\)\.textContent\s*=(?!\s*photoState\()(.*)/g)].map(m => m[1]!)

test('wiring: every #photo-state write goes through photoState, and the switch and startup re-write it', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.deepEqual(literalWrites(src), [])
  assert.equal([...src.matchAll(/\$\('#photo-state'\)\.textContent\s*=\s*photoState\(lang, photoView\)/g)].length, 1)
  // The three sites (resetItem, startEdit, onPhoto) set the view; a site writing text itself is caught above.
  assert.equal([...src.matchAll(/^\s*photoView = /gm)].length, 3, 'not three photoView write sites')
  assert.match(src, /photoView = null[^\n]*\n\s*showPhoto\(\)/, 'resetItem does not reset to the hint')
  assert.match(src, /applyLang\(document, lang\)\nshowNode\(\)\nshowPhoto\(\)\n/, 'startup does not show it after applyLang')
  const sw = src.slice(src.indexOf("$('#lang-switch').addEventListener"))
  assert.ok(sw.slice(0, sw.indexOf('\n})')).includes('showPhoto()'), 'the switch does not re-write it')
})

test('wiring (L1): the check flags each old English write put back', () => {
  for (const old of [
    "  $('#photo-state').textContent =\n    'Resized in your browser to 1200, 480 and 160px. The original is never uploaded.'",
    "  $('#photo-state').textContent = draft.blobs.length\n    ? `${x} already on Blossom.`\n    : 'No photo on this item yet.'",
    "    $('#photo-state').textContent = `${blobs.map(b => `${b.w}px`).join(', ')} on Blossom.`",
  ]) assert.equal(literalWrites(old).length, 1, old)
  assert.deepEqual(literalWrites("$('#photo-state').textContent = photoState(lang, photoView)"), [])
})
