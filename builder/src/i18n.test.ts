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
const WIRED: Record<string, string> = { 'shrink.hint': 'publishing this list', 'shrink.ok': 'un-list them', 'price.hint': 'Sats only', 'price.fiatNote': 'priced in another currency',
  // #60: panel 5's static text
  'panel5.h': 'Your sale so far', 'panel5.hint': 'straight off the public relays', 'items.load': 'Load my items',
  'notes.save': 'Save my private notes', 'notes.hint': 'encrypted to your own key',
  // #74: panel 7's fixed words, in a span outside the link
  'deployed.live': 'Your sale is live at' }
const element = (keyPattern: string, flags = '') =>
  new RegExp(`<(\\w+)\\b[^>]*\\bdata-i18n="${keyPattern}"[^>]*>([\\s\\S]*?)</\\1>`, flags)
const textOf = (html: string, key: string) => element(key.replaceAll('.', '\\.')).exec(html)?.[2]
const unwired = (html: string) => html.replace(element('[^"]+', 'g'), '')

test('inventory (#55, #60): the un-list hint, its tick-box, both price notes and panel 5 are wired', () => {
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

test('inventory (#60, L1): removing any one of panel 5\'s data-i18n attributes is caught', () => {
  for (const k of ['panel5.h', 'panel5.hint', 'items.load', 'notes.save', 'notes.hint']) {
    const broken = HTML.replace(` data-i18n="${k}"`, '')
    assert.notEqual(broken, HTML, `${k} is not in index.html`)
    assert.equal(textOf(broken, k), undefined)
    assert.ok(unwired(broken).includes(WIRED[k]!), `${k}: its English is not seen once unwired`)
  }
})

test('main.ts (#60): "Reload my items" comes from the table, so a language switch keeps it', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.ok(STRINGS['items.reload']?.en === 'Reload my items', 'items.reload is not in STRINGS')
  assert.ok(!src.includes("'Reload my items'"), 'main.ts still writes "Reload my items" itself')
  assert.match(src, /\$\('#refresh-items'\)\.dataset\.i18n = 'items\.reload'; applyLang\(document, lang\)/)
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
  assert.ok(src.includes("sayT('status.connected', 'ok', { label: s.label })"), 'the connected line is not in the table')
  assert.ok(/fmt\(lang, 'whoami', \(who = /.test(src), 'the signed-in name is not kept for the switch')
})

// #69: the waiting, scan and failure lines. The failure's es must not carry the raw English error.
const NEW69 = ['status.waiting', 'status.scan', 'status.connectFail']
test('fmt (#69): waiting, scan and failure lines have Spanish, and the Spanish failure hides the error', () => {
  for (const k of NEW69) {
    assert.ok(k in STRINGS, `${k} is not in STRINGS`)
    assert.notEqual(STRINGS[k]!.es, STRINGS[k]!.en, `${k} is untranslated`)
    assert.ok(!/signer|bunker|nip-?\d|relay|nsec|hex/i.test(STRINGS[k]!.es), `${k}: jargon in "${STRINGS[k]!.es}"`)
  }
  assert.deepEqual(missing(NEW69), [])
  const es = fmt('es', 'status.connectFail', { msg: 'boom' })
  assert.ok(!es.includes('{') && !es.includes('boom'), es)
  assert.equal(fmt('en', 'status.connectFail', { msg: 'boom' }), 'boom')
  assert.equal(fmt('en', 'status.waiting'), 'Waiting for your signer…')
  assert.equal(fmt('en', 'status.scan'), 'Scan the code with your signer. Approve every permission it lists.')
})

test('fmt (#69, L1): each blanked es is caught by missing', () => {
  for (const k of NEW69) {
    const broken = { ...STRINGS, [k]: { en: STRINGS[k]!.en, es: ' ' } }
    assert.deepEqual(missing(Object.keys(broken), broken), [k])
  }
})

test('main.ts (#69): the waiting and scan lines go through the table, and so do both failures', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.ok(!src.includes('Waiting for your signer'), 'main.ts still writes the waiting line itself')
  assert.ok(!src.includes('Scan the code with your signer'), 'main.ts still writes the scan line itself')
  assert.equal([...src.matchAll(/sayT\('status\.connectFail', 'bad', \{ msg: /g)].length, 2)
  assert.ok(!/say\(err instanceof Error/.test(src.slice(src.indexOf('const connect ='), src.indexOf('// --- node'))), 'a step-1 catch still prints err.message itself')
})

// #74: panel 5's sentences main.ts writes itself, and panel 7. Fake numbers and names only. Each
// row is: key, vars, the exact English main.ts wrote before, and the values the Spanish must show.
const SALE = 'Venta de prueba'
const NEW74: [string, Record<string, string>, string, string[]][] = [
  ['items.reading', {}, 'reading the relays…', []],
  ['items.sale', { title: SALE }, `sale “${SALE}”`, [SALE]],
  ['items.noSale', {}, 'no sale published yet — section 3', ['3']],
  ['items.loaded', { n: '7', ok: '3', all: '4', sale: 'S' }, '7 item(s), read from 3/4 relays · S', ['7', '3/4', 'S']],
  ['items.otherCurrency', {}, 'Priced in something this form cannot carry, so republishing it here would change what it says.', []],
  ['items.otherSale', { d: 'otra-venta' }, 'Published outside “otra-venta”, so this form cannot address it without orphaning the original.', ['otra-venta']],
  ['note.label', {}, 'Private note', []],
  ['note.placeholder', {}, 'What you paid for it. Who is coming to collect it. What to say if they haggle.', []],
  ['stickers.cost', { n: '5' }, '0 signatures. 5 unsold item(s) get a sticker; sold ones do not, because the thing is gone.', ['5']],
  ['notes.cost', {}, '1 signature, however many notes you changed — they are one encrypted event, not one each.', []],
  ['deploy.detail', { n: '12', s: '2', ok: '3', all: '4', v: 'abcdef012345' },
    '12 files on 2 Blossom server(s), manifest on 3/4 relays. Site version abcdef012345…. The first request may time out while the gateway fetches the blobs — reload once.',
    ['12', '2', '3/4', 'abcdef012345']],
]

test('fmt (#74): panel 5 and panel 7 sentences are word for word in English and filled in Spanish', () => {
  for (const [k, vars, en, shown] of NEW74) {
    assert.ok(k in STRINGS, `${k} is not in STRINGS`)
    assert.equal(fmt('en', k, vars), en, `${k}: English changed`)
    const es = fmt('es', k, vars)
    assert.notEqual(es, en, `${k}: es is the English text`)
    assert.ok(!es.includes('{'), `${k}: unfilled slot in "${es}"`)
    assert.ok(!/relay|blossom|manifest|nsec|signature|firma|hex/i.test(es), `${k}: jargon in "${es}"`)
    for (const v of shown) assert.ok(es.includes(v), `${k}: es drops ${v}: "${es}"`)
  }
  // The loaded line, built the way main.ts builds it.
  const line = fmt('en', 'items.loaded', { n: '2', ok: '4', all: '4', sale: fmt('en', 'items.noSale') })
  assert.equal(line, '2 item(s), read from 4/4 relays · no sale published yet — section 3')
  assert.deepEqual(missing([...NEW74.map(r => r[0]), 'deployed.live']), [])
})

test('fmt (#74, L1): each blanked es is caught, and the panel 7 span without its key is seen', () => {
  for (const k of [...NEW74.map(r => r[0]), 'deployed.live']) {
    const broken = { ...STRINGS, [k]: { en: STRINGS[k]!.en, es: '' } }
    assert.deepEqual(missing(Object.keys(broken), broken), [k])
  }
  const broken = HTML.replace(' data-i18n="deployed.live"', '')
  assert.notEqual(broken, HTML, 'deployed.live is not in index.html')
  assert.equal(textOf(broken, 'deployed.live'), undefined)
  assert.ok(unwired(broken).includes('Your sale is live at'))
  // applyLang writes textContent, so the key must sit on the span, never on the <p> around the link.
  assert.match(HTML, /<span data-i18n="deployed\.live">Your sale is live at<\/span> <a id="site-url"/)
})

test('main.ts (#74): panel 5 and panel 7 sentences go through the table', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  for (const gone of ["'reading the relays…'", "'Private note'", 'What you paid for it', 'unsold item(s) get a sticker',
    '1 signature, however many', 'this form cannot', 'Site version', 'no sale published yet', 'item(s), read from'])
    assert.ok(!src.includes(gone), `main.ts still writes "${gone}" itself`)
  for (const [k] of NEW74) assert.ok(src.includes(`fmt(lang, '${k}'`), `main.ts never calls fmt(lang, '${k}')`)
})

// #106: the edit-an-item flow. Fake title and slug only. Each row: key, vars, the exact English
// main.ts wrote before, and the values the Spanish must show.
const NEW106: [string, Record<string, string>, string, string[]][] = [
  ['item.publish', {}, 'Publish this item', []],
  ['item.edit', {}, 'Edit', []],
  ['item.markSold', {}, 'Mark sold', []],
  ['edit.publishChanges', { title: 'Silla roja' }, 'Publish changes to “Silla roja”', ['Silla roja']],
  ['edit.markSold', { title: 'Silla roja' }, 'Mark “Silla roja” sold', ['Silla roja']],
  ['edit.note', { d: 'yardsale-x-silla' }, 'Editing yardsale-x-silla. It replaces the listing at the same address — nostr has no edit, only replacement — and re-cuts the availability ladder, so your watcher needs the new file afterwards.', ['yardsale-x-silla']],
  ['edit.soldNote', {}, 'Its Buy button disappears as soon as this publishes, because a sold listing carries no offer pointer. The offer itself stays on your node — deleting it would take the buyer’s stored refund pointer with it, and a payment that lands late still has to be refundable.', ['Comprar']],
  ['edit.check', {}, 'Check it over, then publish.', []],
  ['edit.loaded', {}, 'Loaded. Change what you need, then publish.', []],
]

test('fmt (#106): the edit flow is word for word in English and filled, plain Spanish', () => {
  for (const [k, vars, en, shown] of NEW106) {
    assert.ok(k in STRINGS, `${k} is not in STRINGS`)
    assert.equal(fmt('en', k, vars), en, `${k}: English changed`)
    const es = fmt('es', k, vars)
    assert.notEqual(es, en, `${k}: es is the English text`)
    assert.ok(!es.includes('{'), `${k}: unfilled slot in "${es}"`)
    assert.ok(!/nostr|relay|signer|blossom|kind|pointer|replacement|ladder|nsec|hex/i.test(es), `${k}: jargon in "${es}"`)
    for (const v of shown) assert.ok(es.includes(v), `${k}: es drops ${v}: "${es}"`)
  }
  assert.deepEqual(missing(NEW106.map(r => r[0])), [])
})

test('fmt (#106, L1): each blanked es is caught by missing', () => {
  for (const [k] of NEW106) {
    const broken = { ...STRINGS, [k]: { en: STRINGS[k]!.en, es: '' } }
    assert.deepEqual(missing(Object.keys(broken), broken), [k])
  }
})

test('inventory (#106): the Publish button is wired; only fixed texts carry a data-i18n', () => {
  const text = textOf(HTML, 'item.publish')
  assert.equal(text?.trim(), STRINGS['item.publish']!.en, 'index.html #publish has no data-i18n="item.publish"')
  assert.ok(!unwired(HTML).includes('Publish this item'), '"Publish this item" is outside a data-i18n element')
  // applyLang writes the raw table text, so a {title} or {d} key on a node would print the slot.
  for (const k of [...HTML.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]!))
    assert.ok(!STRINGS[k]!.en.includes('{'), `index.html puts ${k}, which has a {slot}, on a data-i18n node`)
})

test('inventory (#106, L1): the Publish button with its data-i18n removed is caught', () => {
  const broken = HTML.replace(' data-i18n="item.publish"', '')
  assert.notEqual(broken, HTML, 'item.publish is not in index.html')
  assert.equal(textOf(broken, 'item.publish'), undefined)
  assert.ok(unwired(broken).includes('Publish this item'))
})

test('main.ts (#106): the edit flow goes through the table and survives a language switch', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  for (const gone of ["'Edit'", "'Mark sold'", "'Publish this item'", 'Publish changes to', '” sold`', 'Check it over, then publish.',
    'Loaded. Change what you need', 'Its Buy button disappears', 're-cuts the availability ladder'])
    assert.ok(!src.includes(gone), `main.ts still writes "${gone}" itself`)
  // The row buttons keep a key so applyLang re-writes them; the vars texts never get one.
  assert.ok(src.includes("edit.dataset.i18n = 'item.edit'; edit.textContent = fmt(lang, 'item.edit')"), 'Edit row button')
  assert.ok(src.includes("sold.dataset.i18n = 'item.markSold'; sold.textContent = fmt(lang, 'item.markSold')"), 'Mark sold row button')
  assert.ok(!/dataset\.i18n = 'edit\./.test(src), 'a {title}/{d} key is put on a data-i18n node')
  // resetItem gives #publish its fixed key back and forgets the edit; editItem takes the key away.
  const reset = src.slice(src.indexOf('const resetItem ='), src.indexOf('// --- publish ---'))
  assert.ok(reset.includes("editView = null; $('#publish').dataset.i18n = 'item.publish'; $('#publish').textContent = fmt(lang, 'item.publish')"), 'resetItem')
  const edit = src.slice(src.indexOf('const editItem ='), src.indexOf('const doSaveNotes ='))
  assert.ok(edit.includes("delete $('#publish').dataset.i18n"), 'editItem leaves item.publish on #publish, so a switch prints "Publish this item"')
  for (const k of ['edit.markSold', 'edit.soldNote', 'edit.publishChanges', 'edit.note']) assert.ok(edit.includes(`'${k}'`), `editItem never uses ${k}`)
  assert.ok(edit.includes("sayT(markingSold ? 'edit.check' : 'edit.loaded', 'ok')"), 'the loaded status is not re-translated on a switch')
  const sw = src.slice(src.indexOf("$('#lang-switch').addEventListener"), src.indexOf("$('#nip07')"))
  assert.ok(/applyLang\(document, lang\)[\s\S]*showEdit\(\)/.test(sw), 'the switch does not re-write the edit texts after applyLang')
  assert.match(src, /const showEdit = \(\) => \{\n  if \(!editView\) return\n  \$\('#publish'\)\.textContent = fmt\(lang, editView\.btn, editView\.vars\)\n  \$\('#editing-note'\)\.textContent = fmt\(lang, editView\.note, editView\.vars\)/)
})
