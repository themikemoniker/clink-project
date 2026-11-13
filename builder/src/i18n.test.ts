// G1.1 and G1.2, socket-free (L9). The browser half is in ../smoke.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { countKey, fmt, keep, load, missing, pickLang, STRINGS } from './i18n.ts'

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
      // A {slot} name is never shown (fmt fills it), so `{relays}` is not the word relay.
      assert.ok(!v.es.replace(/\{\w+\}/g, '').toLowerCase().includes(w), `${k}: es says "${w}"`)
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

// #63: the meta line under each item row. Each row: language, stock count, the exact text.
const LEFT: ['en' | 'es', number, string][] = [
  ['en', 1, '1 left'], ['en', 3, '3 left'], ['en', 0, '0 left'],
  ['es', 1, 'queda 1'], ['es', 3, 'quedan 3'], ['es', 0, 'quedan 0'],
]
const META63 = ['meta.left.one', 'meta.left.other', 'meta.sold', 'meta.gone', 'meta.buy', 'meta.cash', 'meta.noPrice']

test('fmt (#63): the item meta line is word for word in English and follows the count in Spanish', () => {
  for (const [lang, n, want] of LEFT)
    assert.equal(fmt(lang, countKey('meta.left', n), { n: String(n) }), want, `${lang} stock ${n}`)
  // The singular is its own text: without the `.one` branch, Spanish 1 would read "quedan 1".
  assert.notEqual(fmt('es', 'meta.left.other', { n: '1' }), 'queda 1')
  assert.equal(countKey('meta.left', 1), 'meta.left.one')
  for (const n of [0, 2, 3, 10]) assert.equal(countKey('meta.left', n), 'meta.left.other', String(n))
  const both: [string, Record<string, string>, string, string][] = [
    ['meta.sold', {}, 'sold', 'vendido'],
    ['meta.gone', { s: '2', u: '5' }, '2/5 gone', '2/5 vendidos'],
    ['meta.buy', {}, 'Buy button', 'botón de Comprar'],
    ['meta.cash', {}, 'cash only', 'solo efectivo'],
    ['meta.noPrice', {}, 'no price', 'sin precio'],
  ]
  for (const [k, vars, en, es] of both) {
    assert.equal(fmt('en', k, vars), en, `${k}: English changed`)
    assert.equal(fmt('es', k, vars), es, `${k}: Spanish`)
  }
  for (const k of META63) {
    assert.ok(k in STRINGS, `${k} is not in STRINGS`)
    assert.ok(!/relay|signer|nsec|oracle|nostr|hex/i.test(STRINGS[k]!.es), `${k}: jargon in "${STRINGS[k]!.es}"`)
  }
  assert.deepEqual(missing(META63), [])
})

test('fmt (#63, L1): each blanked es is caught by missing', () => {
  for (const k of META63) {
    const broken = { ...STRINGS, [k]: { en: STRINGS[k]!.en, es: '' } }
    assert.deepEqual(missing(Object.keys(broken), broken), [k])
  }
})

test('main.ts (#63): metaLine goes through the table and the switch re-renders the item rows', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const meta = src.slice(src.indexOf('const metaLine ='), src.indexOf('const renderItems ='))
  assert.ok(meta.length > 0, 'metaLine not found')
  for (const gone of ["' left'", ' left`', "'cash only'", "'Buy button'", "'no price'", "'sold'", ' gone`'])
    assert.ok(!meta.includes(gone), `metaLine still writes "${gone}" itself`)
  for (const k of ['meta.noPrice', 'meta.sold', 'meta.gone', 'meta.buy', 'meta.cash'])
    assert.ok(meta.includes(`'${k}'`), `metaLine never uses ${k}`)
  assert.ok(meta.includes("countKey('meta.left', item.stock ?? 1), { n: String(item.stock ?? 1) }"), 'stock count without countKey or its default of 1')
  assert.ok(meta.includes("toLocaleString('en-US')"), 'price formatting changed')
  assert.ok(src.includes('meta.textContent = metaLine(lang, own)'), 'renderItems does not pass the language')
  const sw = src.slice(src.indexOf("$('#lang-switch').addEventListener"), src.indexOf("$('#nip07')"))
  assert.ok(sw.includes('if (owned.length) renderItems()'), 'the switch does not re-render the item rows')
})

// #126: the item checks, the notes lines, Disconnect and Cancel. Each row: key, vars, the exact
// English main.ts wrote before (fake numbers only), and the values the Spanish must show.
const NEW126: [string, Record<string, string>, string, string[]][] = [
  ['item.noSlug', {}, 'Give the item a title, or a slug.', []],
  ['item.noTitle', {}, 'Give the item a title.', []],
  ['item.badPrice', {}, 'Price must be a whole number of sats.', []],
  ['item.floor', {}, 'A buyable item must be at least 10 sats — the node will not invoice less. Set stock to 0, or clear the node field, to list it as cash-only.', ['10']],
  ['item.badStock', {}, 'Stock must be 0–999.', ['999']],
  ['err.generic', { msg: 'boom' }, 'boom', []],
  ['notes.encrypting', {}, 'Encrypting to your own key…', []],
  ['notes.saved', { ok: '3', all: '4' }, 'Notes saved on 3/4 relays. Only your key can read them.', ['3/4']],
  ['notes.none', {}, 'No relay took your notes. Nothing was lost — press it again.', []],
  ['status.disconnected', {}, 'Disconnected.', []],
  ['edit.cancelled', {}, 'Back to a new item. Nothing was changed.', []],
]
// The old English as main.ts wrote it (the notes line was a template, the no-server line a throw).
const OLD126 = ['Give the item a title, or a slug.', 'Give the item a title.', 'Price must be a whole number of sats.',
  'A buyable item must be at least 10 sats', 'Stock must be 0–999.', 'Encrypting to your own key…', 'Notes saved on ',
  'No relay took your notes', 'Disconnected.', 'Back to a new item. Nothing was changed.']
const sayLeft = (src: string) =>
  OLD126.filter(lit => [...src.matchAll(/\b(?:say|Error)\(([^\n]*)/g)].some(m => m[1]!.includes(lit)))

test('fmt (#126): item checks, notes, Disconnect and Cancel are word for word in English and plain in Spanish', () => {
  for (const [k, vars, en, shown] of NEW126) {
    assert.ok(k in STRINGS, `${k} is not in STRINGS`)
    assert.equal(fmt('en', k, vars), en, `${k}: English changed`)
    const es = fmt('es', k, vars)
    assert.ok(es.trim(), `${k}: no es`)
    assert.notEqual(es, en, `${k}: es is the English text`)
    assert.ok(!STRINGS[k]!.es.includes('{msg}') && !es.includes('boom'), `${k}: es shows the raw error`)
    assert.ok(!es.includes('{'), `${k}: unfilled slot in "${es}"`)
    assert.ok(!/relay|signer|nsec|hex/i.test(es), `${k}: jargon in "${es}"`)
    for (const v of shown) assert.ok(es.includes(v), `${k}: es drops ${v}: "${es}"`)
  }
  assert.deepEqual(missing(NEW126.map(r => r[0])), [])
})

test('fmt (#126, L1): each blanked es is caught by missing', () => {
  for (const [k] of NEW126) {
    const broken = { ...STRINGS, [k]: { en: STRINGS[k]!.en, es: '' } }
    assert.deepEqual(missing(Object.keys(broken), broken), [k])
  }
})

test('main.ts (#126): none of the old English is inside a say( call, and each key is written through sayT', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.deepEqual(sayLeft(src), [])
  for (const [k] of NEW126) assert.ok(src.includes(`sayT('${k}'`), `main.ts never calls sayT('${k}'`)
  assert.equal([...src.matchAll(/sayT\('err\.generic', 'bad', \{ msg: err instanceof Error \? err\.message : String\(err\) \}\)/g)].length, 3)
  const notes = src.slice(src.indexOf('const doSaveNotes ='), src.indexOf('// --- photos'))
  assert.ok(notes.includes("if (ok === 0) { sayT('notes.none', 'bad'); return }"), 'the no-server notes case still throws')
  assert.ok(!/say\(err instanceof Error/.test(notes), 'doSaveNotes still prints err.message itself')
})

test('main.ts (#126, L1): the say( finder sees each old literal put back', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  for (const lit of OLD126) assert.deepEqual(sayLeft(`${src}\n  say('${lit}', 'bad')`), [lit], lit)
  assert.deepEqual(sayLeft("say(`Notes saved on ${ok}/${RELAYS.length} relays. Only your key can read them.`, 'ok')"), ['Notes saved on '])
  assert.deepEqual(sayLeft("if (ok === 0) throw new Error('No relay took your notes. Nothing was lost — press it again.')"), ['No relay took your notes'])
})

// #103: the Deploy progress lines. Fake numbers and the fake URL only. Each row: key, vars, the
// exact English main.ts and deploy.ts wrote before, and the values the Spanish must show.
const SITE = 'https://example.test/site'
const NEW103: [string, Record<string, string>, string, string[]][] = [
  ['deploy.reading', {}, 'Reading the storefront…', []],
  ['deploy.hash', { n: '12' }, 'Hashing 12 files…', ['12']],
  ['deploy.uploading', {}, 'Uploading…', []],
  ['deploy.upload', { done: '7', total: '24' }, 'Uploading 7/24…', ['7', '24']],
  ['deploy.publish', { n: '4' }, 'Publishing the manifest to 4 relays…', ['4']],
  ['deploy.live', { url: SITE }, `Live at ${SITE}`, [SITE]],
]

test('fmt (#103): the Deploy lines are word for word in English and filled, plain Spanish', () => {
  for (const [k, vars, en, shown] of NEW103) {
    assert.ok(k in STRINGS, `${k} is not in STRINGS`)
    assert.equal(fmt('en', k, vars), en, `${k}: English changed`)
    const es = fmt('es', k, vars)
    assert.notEqual(es, en, `${k}: es is the English text`)
    assert.ok(!es.includes('{'), `${k}: unfilled slot in "${es}"`)
    assert.ok(!/relay|blob|manifest|blossom|hash|nostr|nsec|signer/i.test(es), `${k}: jargon in "${es}"`)
    for (const v of shown) assert.ok(es.includes(v), `${k}: es drops ${v}: "${es}"`)
  }
  assert.deepEqual(missing(NEW103.map(r => r[0])), [])
})

test('fmt (#103, L1): each blanked es is caught by missing', () => {
  for (const [k] of NEW103) {
    const broken = { ...STRINGS, [k]: { en: STRINGS[k]!.en, es: '' } }
    assert.deepEqual(missing(Object.keys(broken), broken), [k])
  }
})

// A Deploy line main.ts still writes itself: the old English inside a say( call.
const OLD103 = ['Reading the storefront…']
const deploySayLeft = (src: string) =>
  OLD103.filter(lit => [...src.matchAll(/\bsay\(([^\n]*)/g)].some(m => m[1]!.includes(lit)))

test('main.ts (#103): the Deploy lines go through sayT, so a language switch re-writes them', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.ok(!src.includes("'Reading the storefront…'"), 'main.ts still writes "Reading the storefront…" itself')
  assert.deepEqual(deploySayLeft(src), [])
  assert.ok(src.includes("sayT('deploy.reading'"), "main.ts never calls sayT('deploy.reading'")
  assert.ok(src.includes("const onDeployStep = (step: DeployStep) => sayT(step.key, step.kind === 'done' ? 'ok' : 'busy', step.vars)"),
    'onDeployStep does not write the step through the table')
  // The catch keeps the raw message (out of scope), and nothing plain is said before it.
  const flow = src.slice(src.indexOf('const doDeploy ='), src.indexOf('const refreshDeployCost ='))
  const tryPart = flow.slice(0, flow.indexOf('} catch (err) {'))
  assert.ok(tryPart.length > 0 && !/\bsay\(/.test(tryPart), 'a plain say( in the deploy flow clears the line the switch re-writes')
  assert.ok(flow.includes("say(err instanceof Error ? err.message : String(err), 'bad')"), 'the doDeploy catch changed')
})

test('main.ts (#103, L1): the finder sees the old Deploy line put back', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const back = src.replace("sayT('deploy.reading')", "say('Reading the storefront…')")
  assert.notEqual(back, src, "sayT('deploy.reading') is not in main.ts")
  assert.deepEqual(deploySayLeft(back), OLD103)
})

// #109: the failures publish.ts writes itself. Each row: key, vars, the exact English publish.ts
// threw before (fake values only), and a phrase the Spanish must say.
const MINT_MSG = 'Request Denied. Has this key been authorised on the node? Run `node spike/authorize-manage.ts` once, at the desk.'
const NEW109: [string, Record<string, string>, string, string][] = [
  ['publish.noRelay', {}, 'No relay accepted the listing. It is signed but nobody can see it — try again.', 'Presiona Publicar otra vez'],
  ['publish.noRelaySale', {}, 'No relay accepted the sale. It is signed but nobody can see it — try again.', 'Presiona Publicar otra vez'],
  ['publish.mintFail', { msg: MINT_MSG }, `Could not mint the offer: ${MINT_MSG}`, 'sección 2'],
  ['publish.notSent', { msg: 'The title was altered in encoding. Nothing was published.' }, 'The title was altered in encoding. Nothing was published.',
    'No se publicó nada. Revisa los datos del artículo e inténtalo otra vez.'],
]

test('fmt (#109): publish failures are word for word in English and plain, error-free Spanish', () => {
  for (const [k, vars, en, phrase] of NEW109) {
    assert.ok(k in STRINGS, `${k} is not in STRINGS`)
    assert.equal(fmt('en', k, vars), en, `${k}: English changed`)
    const es = fmt('es', k, vars)
    assert.ok(STRINGS[k]!.es.trim(), `${k}: no es`)
    assert.notEqual(es, en, `${k}: es is the English text`)
    assert.ok(!/relay|signer|nsec|hex|node spike|\{/i.test(es), `${k}: jargon or a slot in "${es}"`)
    for (const v of Object.values(vars)) assert.ok(!es.includes(v), `${k}: es shows the raw English`)
    assert.ok(es.includes(phrase), `${k}: es does not say "${phrase}": "${es}"`)
  }
  assert.ok(STRINGS['publish.mintFail']!.es.includes('efectivo'), 'mintFail does not offer the cash-only way out')
  // The node field is section 2 in index.html; the Spanish names that number.
  assert.match(HTML, /<h2>2 · Your node\b/)
  assert.deepEqual(missing(NEW109.map(r => r[0])), [])
})

test('fmt (#109, L1): each blanked es is caught by missing', () => {
  for (const [k] of NEW109) {
    const broken = { ...STRINGS, [k]: { en: STRINGS[k]!.en, es: '' } }
    assert.deepEqual(missing(Object.keys(broken), broken), [k])
  }
})

// Both publish catches in main.ts: the item one and the sale one.
const catchOf = (src: string, from: string, to: string) => {
  const flow = src.slice(src.indexOf(from), src.indexOf(to))
  return flow.slice(flow.lastIndexOf('} catch (err) {'), flow.lastIndexOf('} finally {'))
}
const publishCatches = (src: string) => [
  catchOf(src, 'const doPublish =', '// --- the sale (slice 9)'),
  catchOf(src, 'const doPublishSale =', 'const locate ='),
]
const KEYED = "err instanceof PublishError ? sayT(err.key, 'bad', err.vars) : "

test('main.ts (#109): both publish catches show a PublishError through the table, and keep their old fallback', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const [item, sale] = publishCatches(src)
  assert.ok(item!.includes(`${KEYED}sayT('err.generic', 'bad', { msg: err instanceof Error ? err.message : String(err) })`), 'item catch')
  assert.ok(sale!.includes(`${KEYED}say(err instanceof Error ? err.message : String(err), 'bad')`), 'sale catch')
  assert.match(src, /import \{[^}]*\bPublishError\b[^}]*\} from '\.\/publish\.ts'/)
})

test('main.ts (#109, L1): removing either PublishError branch is caught', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  for (const i of [0, 1]) {
    const one = publishCatches(src)[i]!
    assert.ok(one.includes(KEYED), `catch ${i} has no PublishError branch`)
    const broken = src.replace(one, one.replace(KEYED, ''))
    assert.notEqual(broken, src)
    assert.ok(!publishCatches(broken)[i]!.includes('PublishError'), `catch ${i}: the removed branch is not seen`)
  }
})

// A fake signer: a fixed fake pubkey and a zero signature, so the storefront's parser rejects
// every event and the self-parse check throws before any network call. No key exists here.
const FAKE_PK = 'f'.repeat(64)
const fakeSigner = {
  label: 'fake', getPublicKey: async () => FAKE_PK, close: async () => {},
  nip44Encrypt: async () => '', nip44Decrypt: async () => '',
  signEvent: async (t: object) => ({ ...t, pubkey: FAKE_PK, id: '0'.repeat(64), sig: '0'.repeat(128) }),
} as never
const FAKE_SALE = { d: 'yardsale-fake', title: 'Venta falsa', summary: '', location: '', g: '' }

test('publish.ts (#109): its own failures are PublishErrors with a key and the unchanged English', async () => {
  const { publish, publishSale, PublishError } = await import('./publish.ts')
  const item = { slug: 'silla', title: 'Silla', summary: '', priceSats: 100, stock: 1, alt: '', blobs: [], servers: [] }
  const sent: { kind: string }[] = []
  const caught = async (p: Promise<unknown>) => { try { await p } catch (e) { return e } return assert.fail('it did not throw') }
  const e1 = await caught(publish(fakeSigner, null, item, FAKE_SALE, s => sent.push(s)))
  assert.ok(e1 instanceof PublishError, String(e1))
  assert.equal(e1.key, 'publish.notSent')
  assert.equal(e1.message, 'The listing we just signed does not survive our own parser. Nothing was published.')
  assert.equal(fmt('en', e1.key, e1.vars), e1.message)
  const e2 = await caught(publishSale(fakeSigner, FAKE_SALE, ['yardsale-fake-silla'], s => sent.push(s)))
  assert.ok(e2 instanceof PublishError, String(e2))
  assert.equal(e2.key, 'publish.notSent')
  assert.equal(e2.message, 'The sale we just signed does not survive our own parser. Nothing was published.')
  assert.ok(!sent.some(s => s.kind === 'publish'), 'it reached the network step')
  // The network failures cannot be built offline, so: the class itself, as publish.ts throws it.
  const e3 = new PublishError('No relay accepted the sale. It is signed but nobody can see it — try again.', 'publish.noRelaySale')
  assert.ok(e3 instanceof Error)
  assert.equal(fmt('en', e3.key, e3.vars), e3.message)
  const src = readFileSync(new URL('./publish.ts', import.meta.url), 'utf8')
  assert.ok(!/from '\.\/i18n\.ts'/.test(src), 'publish.ts imports i18n')
  for (const [k] of NEW109) assert.ok(src.includes(`'${k}'`), `publish.ts never throws ${k}`)
  assert.equal([...src.matchAll(/throw notSent\(/g)].length, 8, 'a "Nothing was published" throw is not keyed')
  assert.ok(!/throw new Error\(/.test(src), 'publish.ts still throws a plain Error')
})

// #123: the #node-state line. en is the old English byte for byte; es names no command and no relay.
const NEW123: [string, Record<string, string>, string][] = [
  ['node.none', {}, 'No node — items will publish as cash-only, with no Buy button.'],
  ['node.bad', {}, 'That is not an nmanage1… pointer. Run `node spike/authorize-manage.ts` and paste what it writes.'],
  ['node.ok', { key: 'abababab', relay: 'wss://relay.example' }, 'Node abababab… on wss://relay.example. Offers will be minted over CLINK Manage.'],
]

test('fmt (#123): the node line is word for word in English and plain Spanish with no command or relay', () => {
  for (const [k, vars, en] of NEW123) {
    assert.ok(k in STRINGS, `${k} is not in STRINGS`)
    assert.ok(STRINGS[k]!.es.trim(), `${k}: no es`)
    assert.equal(fmt('en', k, vars), en, `${k}: English changed`)
    const es = fmt('es', k, vars)
    assert.notEqual(es, en, `${k}: es is the English text`)
    assert.ok(!es.includes('{'), `${k}: unfilled slot in "${es}"`)
    assert.ok(!/nostr|relay|signer|pointer|nmanage|clink|nsec|hex/i.test(es), `${k}: jargon in "${es}"`)
  }
  const bad = fmt('es', 'node.bad')
  assert.ok(!bad.includes('spike/') && !bad.includes('node '), `node.bad es names the terminal step: "${bad}"`)
  const ok = fmt('es', 'node.ok', NEW123[2]![1])
  assert.ok(ok.includes('abababab'), `node.ok es drops the key: "${ok}"`)
  assert.ok(!/wss|relay/i.test(ok), `node.ok es shows the relay: "${ok}"`)
  assert.deepEqual(missing(NEW123.map(r => r[0])), [])
})

test('fmt (#123, L1): each blanked es is caught by missing', () => {
  for (const [k] of NEW123) {
    const broken = { ...STRINGS, [k]: { en: STRINGS[k]!.en, es: '' } }
    assert.deepEqual(missing(Object.keys(broken), broken), [k])
  }
})

// #130: why Publish sale is off. The es quorum line names the real es Reload button.
const NEW130 = ['sale.no.signer', 'sale.no.loading', 'sale.no.empty', 'sale.no.quorum', 'sale.cannot']

test('table (#130): the five cannot-publish keys have es, and keep their slots in both languages', () => {
  assert.deepEqual(missing(NEW130), [])
  for (const lang of ['en', 'es'] as const) {
    assert.ok(STRINGS['sale.cannot']![lang].includes('{reason}'), `sale.cannot ${lang} lost {reason}`)
    for (const slot of ['{answered}', '{relays}'])
      assert.ok(STRINGS['sale.no.quorum']![lang].includes(slot), `sale.no.quorum ${lang} lost ${slot}`)
  }
  assert.ok(STRINGS['sale.no.quorum']!.es.includes(`“${STRINGS['items.reload']!.es}”`), 'quorum es does not name the es Reload button')
  assert.equal(fmt('en', 'sale.cannot', { reason: 'Connect a signer first.' }), 'Cannot publish yet: Connect a signer first.')
  for (const k of NEW130) assert.ok(!/relay|signer|nsec/i.test(fmt('es', k, { answered: '1', relays: '4', reason: 'x' })), `${k}: jargon in es`)  // Negative controls (L1): a key with no entry, and each blanked es, are reported.
  assert.deepEqual(missing(['sale.no.bogus']), ['sale.no.bogus'])
  for (const k of NEW130) {
    const broken = { ...STRINGS, [k]: { en: STRINGS[k]!.en, es: '' } }
    assert.deepEqual(missing(Object.keys(broken), broken), [k])
  }
})

test('main.ts (#123): setNode writes through the table; #node-state keeps its English fallback and no data-i18n', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  for (const gone of ['No node — items', 'That is not an nmanage1', 'Offers will be minted over'])
    assert.ok(!src.includes(gone), `main.ts still writes "${gone}" itself`)
  assert.match(HTML, /<p class="hint" id="node-state">No node/, 'the pre-script English fallback is gone')
  assert.ok(!/<[^>]*id="node-state"[^>]*data-i18n|<[^>]*data-i18n[^>]*id="node-state"/.test(HTML), '#node-state has a data-i18n: a switch would wipe a pasted node')
})
