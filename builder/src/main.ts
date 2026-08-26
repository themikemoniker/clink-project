// The builder. One form, one publish, no framework.
//
// /docs/spec.md §9 and design.md §5 called for React + Tailwind + shadcn/ui. Slice 4 does not
// add them: this surface is one form, an upload list and a connect screen, and native <form>,
// <label>, <input>, <output> and <dialog> already give the focus order, labelling and keyboard
// behaviour design §5 wanted Radix for. Revisit when slice 6's admin panel wants tables, dialogs
// and toasts; §9 is corrected to say so.
//
// ONE runtime dependency beyond nostr-tools: `uqr`, exact-pinned 0.1.3, the same encoder the
// storefront already measured and justified (spec §9). It renders the `nostrconnect://` QR, and
// without it the bunker path does not work at all — Amber connects by scanning, and a
// 250-character URI shown as text on a laptop is not something a phone can read. Dynamically
// imported, so a seller on a NIP-07 extension never downloads it.
//
// design.md §5 still applies to the look: this is a tool, it should not cosplay as a newspaper,
// and it should not look AI-generated either — warm paper neutrals, one accent, high contrast.
import './style.css'
import { SimplePool } from 'nostr-tools/pool'
import {
  draftFrom,
  droppedMembers,
  fiatCurrency,
  fiatPriceReason,
  isSats,
  loadItems,
  noPublishSaleReason,
  reusableOffer,
  saleMemberDs,
  soldCount,
  type Owned,
} from './admin.ts'
import {
  draftFromSale,
  geohashOf,
  listingD as saleListingD,
  normaliseGeohash,
  saleD as saleDOf,
  type SaleDraft,
} from './sale.ts'
import { buildSheet, stickerItems } from './stickers.ts'
import { loadNotes, saveNotes, MAX_NOTE, type Notes } from './notes.ts'
import { approvalCount, normaliseSlug, type Draft } from './listing.ts'
import { decodeNmanage, type ManagePointer } from './manage.ts'
import { BLOSSOM, resize, upload } from './photos.ts'
import { deploy, DEFAULT_GATEWAY, loadStorefront, siteUrl, storefrontPaths, type DeployStep } from './deploy.ts'
import { downloadLadder, ladderFile, publish, publishSale, RELAYS, type LadderFile, type Step } from './publish.ts'
import {
  awaitBunkerScan,
  bunkerConnectURI,
  connectBunkerURL,
  connectNip07,
  forgetBunker,
  hasNip07,
  PERMS,
  resumeBunker,
  type Signer,
} from './signer.ts'
import type { Blob as PhotoBlob } from './listing.ts'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

let signer: Signer | null = null
let node: ManagePointer | null = null
let photos: PhotoBlob[] = []
// The servers that actually stored EVERY rendition, straight from upload(). Not the BLOSSOM
// constant: `imeta fallback` means "in case `url` fails" (NIP-94, via listing.ts `imetaTag`), so
// a server that took none of the blobs must not appear in it. Harmless while there was one
// server; slice 5 made it four, and a partial mirror would write fallback URLs that 404.
let servers: string[] = []
// Every ladder this seller has published here, not just this page load. The seller saves the
// download OVER the watcher's copy, so a file carrying only the last item blinds the watcher to
// everything else — including the fixture's five. Keyed by the signer's pubkey: two sellers on
// one laptop are two ladders. It holds signed public events and no key material (publish.ts
// `downloadLadder`), which is what makes localStorage an acceptable place for it.
let ladder: LadderFile = {}

// Slice 6. The item currently loaded into the form for editing, if any — its `d` is what makes
// this a replacement rather than a second item, and its `noffer` is what stops an edit minting a
// second payable offer for something already on sale (admin.ts `reusableOffer`).
let editing: { d: string; noffer?: string } | null = null
// M3. The currency of the item being edited, when it is not sats. Set ONLY from a listing that
// already carried one — there is no control anywhere that types a currency — and cleared by
// `resetItem`, or the next item authored in the same page load would silently inherit it.
let fiatCode: string | null = null
// Photos uploaded THIS session, which is not the same as photos on the draft: an edit carries
// blobs that are already on Blossom and re-uploads nothing. Only this number costs signatures.
let uploads = 0
let owned: Owned[] = []
// Has `loadPanel` finished at least once, and which relays contributed when it did. Both gate
// "Publish my sale", which replaces the seller's whole collection with `owned` — so publishing
// from a read that has not happened, or from one only a minority of relays answered, un-lists
// real items. admin.ts `noPublishSaleReason` is the decision; these two are its inputs.
let panelLoaded = false
let answered: string[] = []
// The `d`s the kind 30405 on the relays lists RIGHT NOW, which is the only thing a shrink can be
// measured against. Set from the same read that sets `answered`, and cleared with it: a read that
// failed cannot say anything about what is on the relays, and claiming otherwise would either
// warn about nothing or wave a real shrink through.
let saleMembers: string[] = []
let notes: Notes = {}
// SLICE 9. The sale this browser authors under. It used to be `SALE`, imported from the spike
// fixture, which meant every seller published our neighbourhood, our geohash and an `a` tag
// pointing at a collection only we had ever published (./sale.ts). It is loaded from the
// seller's own kind 30405 when the panel reads the relays, and defaults until then.
let sale: SaleDraft = draftFromSale(undefined)
// One pool for the panel's reads and the note publish. publish() and deploy() open their own.
const pool = new SimplePool()

const NODE_KEY = 'lamppost.nmanage'
const LADDER_KEY = 'lamppost.ladder.'

let ladderKey = ''
const loadLadder = (): LadderFile => {
  if (!ladderKey) return {}
  try {
    return JSON.parse(localStorage.getItem(ladderKey) || '{}') as LadderFile
  } catch {
    return {}
  }
}
const saveLadder = () => {
  if (!ladderKey) return
  try {
    localStorage.setItem(ladderKey, JSON.stringify(ladder))
  } catch {
    // Out of quota. The download still carries this session, so do not fail a publish that has
    // already reached the relays over it.
  }
}

// --- status line ---------------------------------------------------------------------------
const say = (text: string, tone: 'ok' | 'busy' | 'bad' = 'busy') => {
  const el = $('#status')
  el.textContent = text
  el.dataset.tone = tone
}

// --- signer --------------------------------------------------------------------------------
const showSigner = () => {
  $('#signed-in').hidden = !signer
  $('#connect').hidden = !!signer
  $('#publish').toggleAttribute('disabled', !signer)
  refreshSaleCost() // #publish-sale is gated on more than a signer — see admin.ts noPublishSaleReason
  $('#deploy').toggleAttribute('disabled', !signer)
  $('#refresh-items').toggleAttribute('disabled', !signer)
  $('#save-notes').toggleAttribute('disabled', !signer)
  if (signer) void signer.getPublicKey().then(pk => {
    $('#whoami').textContent = `${signer!.label} — ${pk.slice(0, 8)}…${pk.slice(-8)}`
  })
}

const useSigner = (s: Signer) => {
  signer = s
  showSigner()
  say(`Connected via ${s.label}.`, 'ok')
  refreshCost()
  void s.getPublicKey().then(pk => {
    ladderKey = LADDER_KEY + pk
    ladder = { ...loadLadder(), ...ladder }
    void loadPanel()
  })
}

const connect = async (fn: () => Promise<Signer>) => {
  try {
    say('Waiting for your signer…')
    useSigner(await fn())
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), 'bad')
  }
}

// The one-approval path: we generate the nostrconnect:// URI carrying PERMS and the seller's
// signer scans it. See signer.ts on Amber's "Approve basic actions" policy, which discards the
// perms silently — the copy below says so, because the symptom looks like a protocol failure.
let scanAbort: AbortController | null = null
const startScan = async () => {
  scanAbort?.abort()
  scanAbort = new AbortController()
  const relays = ['wss://relay.nsec.app', 'wss://relay.damus.io']
  const secret = crypto.randomUUID()
  const uri = bunkerConnectURI(relays, secret)
  const box = $<HTMLTextAreaElement>('#connect-uri')
  box.value = uri
  // Amber connects by SCANNING this, not by reading it: "If your app offers you a Nostr Connect
  // QR Code you can scan it from here" (Amber `nostr_connect_qr_description`). The builder runs
  // on a laptop and the signer is a phone, so a 250-character URI as text is not a connection
  // path — it is a transcription exercise. Dynamically imported so a seller using a NIP-07
  // extension never downloads an encoder they will not look at.
  const { renderSVG } = await import('uqr')
  $('#connect-qr').innerHTML = renderSVG(uri, { border: 2 })
  $('#scan').hidden = false
  say('Scan the code with your signer. Approve every permission it lists.')
  try {
    useSigner(await awaitBunkerScan(uri, scanAbort.signal))
    $('#scan').hidden = true
  } catch (err) {
    if (!scanAbort.signal.aborted) say(err instanceof Error ? err.message : String(err), 'bad')
  }
}

// --- node ------------------------------------------------------------------------------------
const setNode = (raw: string, remember: boolean) => {
  const trimmed = raw.trim()
  if (!trimmed) {
    node = null
    $('#node-state').textContent = 'No node — items will publish as cash-only, with no Buy button.'
    return
  }
  const decoded = decodeNmanage(trimmed)
  if (!decoded) {
    node = null
    $('#node-state').textContent = 'That is not an nmanage1… pointer. Run `node spike/authorize-manage.ts` and paste what it writes.'
    return
  }
  node = decoded
  // The pointer carries the account pointer in TLV 2 (/docs/spec.md §6.1). It stays in this
  // browser: never rendered in full, never logged, never published.
  $('#node-state').textContent = `Node ${decoded.pubkey.slice(0, 8)}… on ${decoded.relay}. Offers will be minted over CLINK Manage.`
  if (remember) localStorage.setItem(NODE_KEY, trimmed)
  refreshCost()
}

// --- the draft --------------------------------------------------------------------------------
const readDraft = (): Draft => {
  const draft: Draft = {
    slug: normaliseSlug($<HTMLInputElement>('#slug').value || $<HTMLInputElement>('#title').value),
    title: $<HTMLInputElement>('#title').value.trim(),
    summary: $<HTMLTextAreaElement>('#summary').value.trim(),
    priceSats: fiatCode ? 0 : Number($<HTMLInputElement>('#price').value),
    ...(fiatCode
      ? { fiat: { amount: Number($<HTMLInputElement>('#price-fiat-amount').value), currency: fiatCode } }
      : {}),
    stock: Number($<HTMLInputElement>('#stock').value),
    alt: $<HTMLInputElement>('#alt').value.trim(),
    blobs: photos,
    servers,
  }
  // An edit keeps the offer the item already advertises — but only while the price still agrees
  // with the pointer's own TLV 4. Change the price and this returns nothing, publish.ts mints a
  // fresh offer, and the old one is left alone on the node rather than deleted (findings §13.17).
  // A fiat item has no sats price for a pointer's TLV 4 to agree with, so there is nothing to
  // reuse and nothing to mint. `draftFrom` already dropped any `clink_offer` it found.
  draft.noffer = fiatCode ? undefined : reusableOffer(editing?.noffer, draft.priceSats)
  return draft
}

// The signature count, shown BEFORE the seller starts. /docs/spec.md §5 is a UX-critical budget
// and slice 4 adds a term to it: an item is 1 + units, not 1. A UI that implies one item is one
// approval is how a seller abandons a publish halfway through, leaving a listing with no ladder.
const refreshCost = () => {
  const draft = readDraft()
  // An edit that reuses its offer mints nothing, and one that keeps its photos uploads nothing.
  // Both terms have to come out of the count or the number shown is a lie in the safe direction,
  // which is still a lie: a seller who is told thirty and sees four stops trusting the number.
  // M3: never for a fiat item. `approvalCount` and publish.ts enforce the same thing, so the
  // number shown here cannot drift from the events actually signed.
  const mint = !!node && draft.stock > 0 && !draft.noffer && !draft.fiat
  const n = approvalCount(draft, mint, uploads)
  const units = Math.max(0, draft.stock)
  const parts = [
    ...(uploads ? [`${uploads} photo upload${uploads === 1 ? '' : 's'}`] : []),
    ...(mint ? ['1 offer'] : []),
    ...(draft.noffer ? ['0 offers — this item already has one, at this price'] : []),
    ...(draft.fiat ? [`0 offers — priced in ${draft.fiat.currency}, so it stays cash at the table`] : []),
    '1 listing',
    `${units} availability step${units === 1 ? '' : 's'}`,
  ]
  $('#cost').textContent =
    `${n} signature${n === 1 ? '' : 's'}: ${parts.join(' + ')}. ` +
    `Your signer should ask once per kind and remember the rest — if it asks every time, it ignored the permissions we requested.`
}

// A publish ends the item, not the session. Nothing used to reset, and #slug is only auto-filled
// when it is empty — so a second publish in one page load went out under the FIRST item's `d`
// tag. NIP-01 replaces on (kind, pubkey, d), so item one vanished from the sale, its minted offer
// was orphaned and unwatchable, and item two silently carried item one's photo. The signer, the
// node pointer, the price and the stock are what a seller reuses between items, so those stay.
/**
 * Put the price row into the currency the item actually has — M3.
 *
 * `#price` is DISABLED rather than merely hidden. A `required` field inside a hidden wrapper is
 * still a constraint the form validates, and Chrome refuses to submit with "an invalid form
 * control is not focusable" — a submit button that silently does nothing, which is worse than the
 * refusal this feature replaces. Disabling takes it out of validation and out of the tab order in
 * one attribute.
 *
 * The currency is written with textContent and comes off a listing on a relay, so it goes through
 * `fiatCurrency` before it ever reaches here: letters only, bounded, and never a spelling of sats.
 */
const showFiat = (fiat: { amount: number; currency: string } | null) => {
  fiatCode = fiat?.currency ?? null
  $('#price-sats').hidden = !!fiat
  $<HTMLInputElement>('#price').toggleAttribute('disabled', !!fiat)
  $('#price-fiat').hidden = !fiat
  $('#price-fiat-note').hidden = !fiat
  $<HTMLInputElement>('#price-fiat-amount').toggleAttribute('disabled', !fiat)
  $('#price-fiat-currency').textContent = fiat?.currency ?? '—'
  $<HTMLInputElement>('#price-fiat-amount').value = fiat ? String(fiat.amount) : ''
}

const resetItem = () => {
  photos = []
  servers = []
  uploads = 0
  editing = null
  for (const id of ['#slug', '#title', '#summary', '#alt', '#photo']) {
    $<HTMLInputElement | HTMLTextAreaElement>(id).value = ''
  }
  $<HTMLInputElement>('#slug').toggleAttribute('readonly', false)
  // Back to sats. Without this the next item authored in the same page load would inherit the
  // last edited item's currency, which is the class of defect `resetItem` exists for — the
  // second-publish-under-the-first-item's-d bug in this same function.
  showFiat(null)
  $('#publish').textContent = 'Publish this item'
  $('#editing-note').hidden = true
  $('#cancel-edit').hidden = true
  $('#photo-state').textContent =
    'Resized in your browser to 1200, 480 and 160px. The original is never uploaded.'
  refreshCost()
}

// --- publish -----------------------------------------------------------------------------------
const onStep = (step: Step) => say(step.text, step.kind === 'fail' ? 'bad' : step.kind === 'done' ? 'ok' : 'busy')

const doPublish = async (event: SubmitEvent) => {
  event.preventDefault()
  if (!signer) return
  const draft = readDraft()

  // Validate here rather than at the signer: an error after three approvals is three wasted
  // taps on a phone.
  if (!draft.slug) return say('Give the item a title, or a slug.', 'bad')
  if (!draft.title) return say('Give the item a title.', 'bad')
  // M3. A fiat item is validated as its own price and never as sats, and neither the sats floor
  // nor the node's 10-sat minimum applies to it — it is not going to be invoiced at all.
  //
  // NOT `Number.isSafeInteger`, which is what this said for one slice: the SATS rule wearing the
  // fiat field's label. The decision is `admin.ts` `fiatPriceReason`, out here where a test can
  // reach it, for the same reason `noPublishSaleReason` is.
  if (draft.fiat) {
    const why = fiatPriceReason(draft.fiat.amount, draft.fiat.currency)
    if (why) return say(why, 'bad')
  } else if (!Number.isSafeInteger(draft.priceSats) || draft.priceSats < 0) {
    return say('Price must be a whole number of sats.', 'bad')
  }
  // Lightning.Pub hardcodes a 10-sat floor on what it will invoice (offerManager.ts:224,251 —
  // findings §13.7). Below it the node answers `code 5` and the seller never learns why.
  if (node && !draft.fiat && draft.stock > 0 && draft.priceSats < 10) {
    return say('A buyable item must be at least 10 sats — the node will not invoice less. Set stock to 0, or clear the node field, to list it as cash-only.', 'bad')
  }
  if (!Number.isSafeInteger(draft.stock) || draft.stock < 0 || draft.stock > 999) return say('Stock must be 0–999.', 'bad')

  $('#publish').toggleAttribute('disabled', true)
  try {
    const wasEdit = editing?.d === saleListingD(sale.d, draft.slug)
    const result = await publish(signer, node, draft, sale, onStep)
    ladder = { ...ladder, [result.d]: result.ladder[result.d]! }
    saveLadder()
    resetItem()
    $('#result').hidden = false
    $('#result-text').textContent =
      `${draft.title} is live on ${result.relaysOk}/${RELAYS.length} relays as ${result.d}` +
      (result.noffer ? ', with a Buy button.' : ', cash at the table.')
    $('#ladder-note').textContent =
      `${Object.keys(ladder).length} item(s) in this ladder. Save it as .ladder.json next to watch-sales.ts, then restart the watcher.` +
      (wasEdit
        ? ' You just edited an item, so this is not optional: the rungs your watcher is holding were cut from the OLD listing and are now older than what is on the relays, which means it would publish them and the relay would ignore it. It would keep reporting success while the item stayed on sale after it sold. Restarting the watcher on this file is what closes that.'
        : '')
    void loadPanel(false)
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), 'bad')
  } finally {
    $('#publish').toggleAttribute('disabled', !signer)
  }
}

// --- the sale (slice 9) ----------------------------------------------------------------------
//
// The masthead, and the collection every item's `a` tag points at. spec §10 called this "masthead
// editing"; what it actually was is that the builder had no sale at all — it imported the spike
// fixture's and stamped it on everybody's items. See ./sale.ts.

const readSale = (): SaleDraft => ({
  // NOT a form field, deliberately: it is also every item's `d` prefix, so a typo here orphans
  // everything the seller has ever published. ./sale.ts `saleD`.
  d: sale.d,
  title: $<HTMLInputElement>('#sale-title').value.trim(),
  summary: $<HTMLInputElement>('#sale-summary').value.trim(),
  location: $<HTMLInputElement>('#sale-location').value.trim(),
  g: normaliseGeohash($<HTMLInputElement>('#sale-geo').value),
})

const showSale = () => {
  $<HTMLInputElement>('#sale-title').value = sale.title
  $<HTMLInputElement>('#sale-summary').value = sale.summary
  $<HTMLInputElement>('#sale-location').value = sale.location
  $<HTMLInputElement>('#sale-geo').value = sale.g
  refreshSaleCost()
}

// Same honesty as the item form's count, and the number is the interesting part: ONE signature,
// and no new approval on the phone. `sign_event:30405` has been in PERMS since slice 4 and both
// Amber and nsec.app remember a grant per (app, type, kind) — findings §8 — so a seller who
// connected before this feature existed can publish a sale without touching their signer.
//
// IT ALSO OWNS THE BUTTON NOW. `#publish-sale` used to be enabled synchronously from
// `showSigner()`, before `void loadPanel()`'s four-relay read resolved — and a click in that
// window published a kind 30405 with an empty member list. The button's state and the sentence
// explaining it come from one answer, so a disabled button always says why it is disabled.
const refreshSaleCost = () => {
  const n = owned.length
  const reason = noPublishSaleReason({
    signedIn: !!signer,
    panelLoaded,
    items: n,
    answered: answered.length,
    relays: RELAYS.length,
  })
  $('#publish-sale').toggleAttribute('disabled', !!reason)
  // SHOW THE COUNT — item 13's second bullet. The seller is about to replace their whole
  // collection with these N items, and until now the number was only inferable from the list.
  $('#sale-cost').textContent = reason
    ? `Cannot publish yet: ${reason}`
    : `1 signature. It replaces your whole collection with these ${n} item${n === 1 ? '' : 's'}, in the order ` +
      `shown below — nostr has no edit, only replacement. Read from ${answered.length}/${RELAYS.length} relays.`
}

/**
 * Paint item 13's confirmation, or take it away.
 *
 * `replaceChildren` + `textContent`, never innerHTML: the strings are `d` tags read off a relay,
 * which is a stranger's input on a page that is about to sign something.
 *
 * The checkbox is cleared whenever the panel is hidden, so a tick can never survive into a later
 * publish that the seller has not been shown. A confirmation that is still ticked from last time
 * is not a confirmation.
 */
const showShrink = (dropped: string[]) => {
  const box = $('#sale-shrink')
  const ok = $<HTMLInputElement>('#sale-shrink-ok')
  box.hidden = dropped.length === 0
  if (!dropped.length) {
    ok.checked = false
    return
  }
  $('#sale-shrink-what').textContent =
    `This would un-list ${dropped.length} item${dropped.length === 1 ? '' : 's'} that your sale lists right now:`
  $('#sale-shrink-list').replaceChildren(
    ...dropped.map(d => {
      const li = document.createElement('li')
      li.textContent = d
      return li
    }),
  )
}

const doPublishSale = async (event: SubmitEvent) => {
  event.preventDefault()
  if (!signer) return
  // THE GUARD IS HERE, not only at the enable site. The button being disabled protects the one
  // path; this protects every caller, including the next entry point somebody adds. The ledger
  // named both fixes and preferred the smaller one; this is the one that survives.
  const blocked = noPublishSaleReason({
    signedIn: true,
    panelLoaded,
    items: owned.length,
    answered: answered.length,
    relays: RELAYS.length,
  })
  if (blocked) return say(blocked, 'bad')
  const draft = readSale()
  if (!draft.title) return say('Give the sale a name — it is the masthead.', 'bad')
  // A geohash the seller typed that is not one. Silently dropping it would publish a sale with no
  // location link and no explanation of why the field they filled in did nothing.
  const typed = $<HTMLInputElement>('#sale-geo').value.trim()
  if (typed && !draft.g) {
    return say('That is not a geohash. Geohashes use 0-9 and b-z without a, i, l or o — or press “Use my location”.', 'bad')
  }

  // ITEM 13'S LAST BULLET, and it sits AFTER the quorum gate on purpose. Below quorum the member
  // list is short because a relay was slow, which is a different problem with a different answer
  // ("Reload my items"); asking a seller to confirm un-listing items they never chose to drop
  // would train them to tick the box. Only a list read from a majority of relays is worth
  // comparing against.
  const next = owned.map(o => o.item.d)
  const dropped = droppedMembers(saleMembers, next)
  if (dropped.length && !$<HTMLInputElement>('#sale-shrink-ok').checked) {
    showShrink(dropped)
    return say(
      `Publishing this would un-list ${dropped.length} item${dropped.length === 1 ? '' : 's'}. ` +
        `Read the box above, then tick it if you meant to.`,
      'bad',
    )
  }

  $('#publish-sale').toggleAttribute('disabled', true)
  try {
    // EVERY member, every time. A kind 30405 is addressable, so this replaces the one on the
    // relays outright — handing it a subset silently un-lists the rest, which `orderBySale`
    // renders as strays at the foot of the storefront rather than dropping.
    const { relaysOk } = await publishSale(signer, draft, next, onStep)
    sale = draft
    // The relays now list exactly what was just sent, so the next publish is measured against
    // that and not against a list two edits old. Without this, one confirmed shrink would make
    // every subsequent publish ask again about items that are already gone.
    saleMembers = next
    showShrink([])
    $('#sale-state').textContent =
      `“${draft.title}” is live on ${relaysOk}/${RELAYS.length} relays as ${draft.d}, listing ${owned.length} item(s).` +
      (draft.g ? ' Its neighbourhood is now a tappable map link on your storefront.' : '')
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), 'bad')
  } finally {
    refreshSaleCost()
  }
}

// Native geolocation, because the alternative — typing a neighbourhood and having something turn
// it into coordinates — is a geocoding request to a third party, which is the exact dependency
// spec §10's "map of nearby sales" died on (/docs/spike-findings.md §31). This asks the browser,
// the browser asks the person, and nothing leaves the machine.
const locate = () => {
  if (!navigator.geolocation) return say('This browser has no geolocation. Type the geohash instead.', 'bad')
  say('Asking your browser where you are…')
  navigator.geolocation.getCurrentPosition(
    pos => {
      // 7 characters is ±76 m — the driveway, not the house. Publishing more precision than that
      // to four public relays is a decision nobody asked for.
      const g = geohashOf(pos.coords.latitude, pos.coords.longitude)
      $<HTMLInputElement>('#sale-geo').value = g
      say(`Geohash ${g} — about 76 metres across. Nothing was sent anywhere; publish the sale to use it.`, 'ok')
    },
    err => say(`Could not read your location: ${err.message}. Type the geohash instead.`, 'bad'),
    { enableHighAccuracy: false, timeout: 10_000 },
  )
}

// --- the sticker sheet (slice 9, design.md §4) ------------------------------------------------
const doStickers = async () => {
  const items = owned.map(o => o.item)
  if (!signer) return
  try {
    $('#make-stickers').toggleAttribute('disabled', true)
    say('Encoding one QR per item…')
    const url = siteUrl(await signer.getPublicKey(), gateway())
    const n = await buildSheet($('#sticker-sheet'), items, url)
    $('#sticker-sheet').hidden = n === 0
    $('#print-stickers').hidden = n === 0
    $('#stickers-state').textContent = n
      ? `${n} sticker(s) ready, each ≥2cm square. They point at ${url} — which is where your storefront will be, so build these AFTER you deploy, or the codes lead nowhere.`
      : 'Every item is sold, so there is nothing to sticker.'
    say(n ? 'Sticker sheet built. Press Print.' : 'Nothing to sticker.', n ? 'ok' : 'bad')
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), 'bad')
  } finally {
    $('#make-stickers').toggleAttribute('disabled', false)
  }
}

// --- the admin panel (slice 6) ---------------------------------------------------------------
// Everything here is either a public relay read or an event encrypted to the seller's own key.
// There is no node call in this file and there cannot be one: see the header of ./admin.ts for
// why a browser behind a Signer cannot read settled sales at all, and /spike/sales-report.ts for
// where that reading actually happens.
//
// Item titles and summaries come off a relay, which /CLAUDE.md says to treat as hostile. Every
// row below is built with createElement and textContent — never innerHTML — so a title
// containing markup is a title containing markup.
const metaLine = ({ item }: Owned): string => {
  const units = ladder[item.d]?.units
  const sold = soldCount(units, item)
  return [
    item.price ? `${item.price.amount.toLocaleString('en-US')} ${item.price.currency}` : 'no price',
    item.sold ? 'sold' : `${item.stock ?? 1} left`,
    sold === undefined ? '' : `${sold}/${units} gone`,
    item.offer ? 'Buy button' : 'cash only',
  ]
    .filter(Boolean)
    .join(' · ')
}

const renderItems = () => {
  const list = $('#items')
  list.textContent = ''
  for (const own of owned) {
    const { item } = own
    const li = document.createElement('li')

    const head = document.createElement('div')
    head.className = 'item-head'
    const title = document.createElement('strong')
    title.textContent = item.title
    const meta = document.createElement('span')
    meta.className = 'item-meta'
    meta.textContent = metaLine(own)
    head.append(title, meta)

    const row = document.createElement('div')
    row.className = 'row'
    const editable = draftFrom(item, own.event, sale.d)
    if (editable) {
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.textContent = 'Edit'
      edit.addEventListener('click', () => editItem(own, editable))
      row.append(edit)
      if (!item.sold) {
        const sold = document.createElement('button')
        sold.type = 'button'
        sold.textContent = 'Mark sold'
        sold.addEventListener('click', () => editItem(own, { ...editable, stock: 0 }, true))
        row.append(sold)
      }
    } else {
      // Both refusals are in admin.ts `draftFrom` and both are about not losing the seller's
      // data: this form is sats-only and addresses this sale only.
      const why = document.createElement('span')
      why.className = 'hint'
      // M3 removed the fiat half of this. What is left is the `d`-prefix refusal, plus a currency
      // this form cannot carry at all — a `price` tag whose currency is not letters, which no
      // tool of ours writes and a relay can still hand us.
      why.textContent =
        item.price && !isSats(item.price.currency) && !fiatCurrency(item.price.currency)
          ? `Priced in something this form cannot carry, so republishing it here would change what it says.`
          : `Published outside “${sale.d}”, so this form cannot address it without orphaning the original.`
      row.append(why)
    }

    const label = document.createElement('label')
    label.htmlFor = `note-${item.d}`
    label.textContent = 'Private note'
    const note = document.createElement('textarea')
    note.id = `note-${item.d}`
    note.rows = 2
    note.maxLength = MAX_NOTE
    note.value = notes[item.d] ?? ''
    note.placeholder = 'What you paid for it. Who is coming to collect it. What to say if they haggle.'
    note.addEventListener('input', () => {
      notes[item.d] = note.value
    })

    li.append(head, row, label, note)
    list.append(li)
  }
}

const loadPanel = async (withNotes = true) => {
  if (!signer) return
  $('#refresh-items').toggleAttribute('disabled', true)
  try {
    $('#items-state').textContent = 'reading the relays…'
    const pubkey = await signer.getPublicKey()
    const loaded = await loadItems(pool, RELAYS, pubkey)
    owned = loaded.items
    // What the sale on the relays lists today. A fresh read also means any warning the seller was
    // looking at is about a comparison that no longer holds, so it goes away with the old list.
    saleMembers = saleMemberDs(loaded.sale?.itemRefs, pubkey)
    showShrink([])
    // Both of these gate `#publish-sale`. `answered` is which relays actually contributed an
    // event, not which were asked — see admin.ts `loadItems`.
    answered = loaded.answered
    panelLoaded = true
    // SLICE 9. The sale comes off the relays rather than off the spike fixture, and its `d` is
    // what every item's `d` is prefixed with — so this has to land before the panel renders, or
    // `draftFrom` measures each item against the wrong prefix and every Edit button disappears.
    sale = draftFromSale(loaded.sale)
    sale.d = saleDOf(loaded.sale)
    showSale()
    // The notes come second and only on a full load: re-reading them mid-session would throw
    // away edits the seller has typed and not yet saved.
    if (withNotes) notes = await loadNotes(signer, pool, RELAYS)
    renderItems()
    $('#items-state').textContent =
      `${owned.length} item(s), read from ${answered.length}/${RELAYS.length} relays` +
      (loaded.sale ? ` · sale “${loaded.sale.title}”` : ' · no sale published yet — section 3')
    $('#notes-wrap').hidden = owned.length === 0
    $('#stickers-wrap').hidden = owned.length === 0
    $('#stickers-cost').textContent = `0 signatures. ${stickerItems(owned.map(o => o.item)).length} unsold item(s) get a sticker; sold ones do not, because the thing is gone.`
    refreshSaleCost()
    $('#refresh-items').textContent = 'Reload my items'
    $('#notes-cost').textContent =
      '1 signature, however many notes you changed — they are one encrypted event, not one each.'
  } catch (err) {
    // The read failed, so nothing below is safe to publish a replacement from. Both flags go back
    // rather than being left at whatever the last successful load said.
    panelLoaded = false
    answered = []
    saleMembers = []
    showShrink([])
    refreshSaleCost()
    $('#items-state').textContent = ''
    say(err instanceof Error ? err.message : String(err), 'bad')
  } finally {
    $('#refresh-items').toggleAttribute('disabled', !signer)
  }
}

/**
 * Load a published item back into the form.
 *
 * There is no edit event in nostr. NIP-01 replaces on (kind, pubkey, `d`), so an edit is a fresh
 * publish under the same `d` — which is why the slug goes read-only here. Changing it would
 * publish a SECOND item and leave the original on the relays with a ladder nothing re-cuts.
 */
const editItem = (own: Owned, draft: Draft, markingSold = false) => {
  editing = { d: own.item.d, noffer: draft.noffer }
  photos = draft.blobs
  servers = draft.servers
  uploads = 0 // already on Blossom; keeping them costs nothing
  $<HTMLInputElement>('#slug').value = draft.slug
  $<HTMLInputElement>('#title').value = draft.title
  $<HTMLTextAreaElement>('#summary').value = draft.summary
  showFiat(draft.fiat ?? null)
  if (!draft.fiat) $<HTMLInputElement>('#price').value = String(draft.priceSats)
  $<HTMLInputElement>('#stock').value = String(draft.stock)
  $<HTMLInputElement>('#alt').value = draft.alt
  $<HTMLInputElement>('#photo').value = ''
  $<HTMLInputElement>('#slug').toggleAttribute('readonly', true)
  $('#photo-state').textContent = draft.blobs.length
    ? `${draft.blobs.map(b => `${b.w}px`).join(', ')} already on Blossom. Leave the file field empty to keep them.`
    : 'No photo on this item yet.'
  $('#publish').textContent = markingSold ? `Mark “${draft.title}” sold` : `Publish changes to “${draft.title}”`
  $('#editing-note').hidden = false
  $('#editing-note').textContent = markingSold
    ? 'Its Buy button disappears as soon as this publishes, because a sold listing carries no offer pointer. The offer itself stays on your node — deleting it would take the buyer’s stored refund pointer with it, and a payment that lands late still has to be refundable.'
    : `Editing ${own.item.d}. It replaces the listing at the same address — nostr has no edit, only replacement — and re-cuts the availability ladder, so your watcher needs the new file afterwards.`
  $('#cancel-edit').hidden = false
  refreshCost()
  $('#item').scrollIntoView({ behavior: 'smooth', block: 'start' })
  say(markingSold ? 'Check it over, then publish.' : 'Loaded. Change what you need, then publish.', 'ok')
}

const doSaveNotes = async () => {
  if (!signer) return
  $('#save-notes').toggleAttribute('disabled', true)
  try {
    for (const [d, note] of Object.entries(notes)) if (!note.trim()) delete notes[d]
    say('Encrypting to your own key…')
    const ok = await saveNotes(signer, pool, notes, RELAYS)
    if (ok === 0) throw new Error('No relay took your notes. Nothing was lost — press it again.')
    say(`Notes saved on ${ok}/${RELAYS.length} relays. Only your key can read them.`, 'ok')
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), 'bad')
  } finally {
    $('#save-notes').toggleAttribute('disabled', !signer)
  }
}

// --- photos --------------------------------------------------------------------------------
const onPhoto = async (input: HTMLInputElement) => {
  const file = input.files?.[0]
  if (!file) return
  if (!signer) return say('Connect a signer first — each upload needs a signed authorisation.', 'bad')
  try {
    say('Resizing…')
    const rendered = await resize(file)
    say(`Uploading ${rendered.length} sizes to ${BLOSSOM.length} server…`)
    const uploaded = await upload(signer, rendered, (done, total) => say(`Uploading ${done}/${total}…`))
    const { blobs } = uploaded
    if (blobs.length === 0) throw new Error('No Blossom server accepted the photo. The listing can still publish without one.')
    photos = blobs
    servers = uploaded.servers
    uploads = blobs.length
    $('#photo-state').textContent = `${blobs.map(b => `${b.w}px`).join(', ')} on Blossom.`
    say(`Photo stored at ${blobs.length} size(s).`, 'ok')
    refreshCost()
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), 'bad')
  }
}

// --- deploy ------------------------------------------------------------------------------------
// Slice 5. The storefront's files already live in this app (public/site, put there by
// bundle-storefront.mjs), so "generate the site files" is a fetch rather than a build — a static
// page cannot run `vite build`, and inlining the bytes into the bundle would double an app that
// is itself fetched blob by blob from a gateway.
const gateway = () => $<HTMLInputElement>('#gateway').value.trim() || DEFAULT_GATEWAY

const onDeployStep = (step: DeployStep) => say(step.text, step.kind === 'done' ? 'ok' : 'busy')

const doDeploy = async () => {
  if (!signer) return
  $('#deploy').toggleAttribute('disabled', true)
  try {
    say('Reading the storefront…')
    const files = await loadStorefront()
    const result = await deploy(signer, RELAYS, files, {
      gateway: gateway(),
      // NIP-5A 5A.md:39-41 — both optional, both free, and they are what makes the manifest
      // legible to anything that indexes nsites.
      // The seller's own masthead, not the fixture's. 5A.md:39-41 — both optional, both free.
      meta: { title: sale.title, description: sale.summary },
    }, onDeployStep)

    $('#deployed').hidden = false
    const link = $<HTMLAnchorElement>('#site-url')
    link.href = result.url
    link.textContent = result.url
    $('#deploy-detail').textContent =
      `${result.files.length} files on ${result.servers.length} Blossom server(s), manifest on ` +
      `${result.relaysOk}/${RELAYS.length} relays. Site version ${result.aggregate.slice(0, 12)}…. ` +
      `The first request may time out while the gateway fetches the blobs — reload once.`
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), 'bad')
  } finally {
    $('#deploy').toggleAttribute('disabled', !signer)
  }
}

// The same honesty as the item form's signature count: a deploy is one signed kind 24242 per
// file plus the manifest and the server list.
const refreshDeployCost = async () => {
  // The list only — counting the files must not download them. They are fetched when somebody
  // actually presses Deploy.
  const n = (await storefrontPaths().catch(() => [])).length
  $('#deploy-cost').textContent = n
    ? `${n + 2} signatures: ${n} file uploads + 1 site manifest + 1 Blossom server list. ` +
      `The uploads are all one kind, so your signer should ask about them once.`
    : 'The storefront files are missing. Run `npm run build` in /builder.'
}

// --- wiring ------------------------------------------------------------------------------------
$('#nip07').addEventListener('click', () => void connect(connectNip07))
$('#bunker-url').addEventListener('click', () => {
  const input = $<HTMLInputElement>('#bunker-input').value
  void connect(() => connectBunkerURL(input))
})
$('#bunker-scan').addEventListener('click', () => void startScan())
$('#disconnect').addEventListener('click', () => {
  void signer?.close()
  signer = null
  forgetBunker()
  showSigner()
  say('Disconnected.', 'ok')
})
$('#node-input').addEventListener('change', e => setNode((e.target as HTMLInputElement).value, true))
$('#photo').addEventListener('change', e => void onPhoto(e.target as HTMLInputElement))
$('#item').addEventListener('submit', e => void doPublish(e as SubmitEvent))
for (const id of ['#price', '#stock', '#title']) $(id).addEventListener('input', refreshCost)
$('#title').addEventListener('blur', () => {
  const slug = $<HTMLInputElement>('#slug')
  if (!slug.value) slug.value = normaliseSlug($<HTMLInputElement>('#title').value)
})
$('#sale').addEventListener('submit', e => void doPublishSale(e as SubmitEvent))
$('#sale-locate').addEventListener('click', locate)
$('#make-stickers').addEventListener('click', () => void doStickers())
$('#print-stickers').addEventListener('click', () => window.print())
$('#refresh-items').addEventListener('click', () => void loadPanel())
$('#save-notes').addEventListener('click', () => void doSaveNotes())
$('#cancel-edit').addEventListener('click', () => {
  resetItem()
  say('Back to a new item. Nothing was changed.', 'ok')
})
$('#download-ladder').addEventListener('click', () => downloadLadder(ladderFile(loadLadder(), ladder)))
$('#deploy').addEventListener('click', () => void doDeploy())
$('#perms').textContent = PERMS.join(', ')

if (!hasNip07()) $('#nip07').setAttribute('disabled', 'true')
const saved = localStorage.getItem(NODE_KEY)
if (saved) {
  $<HTMLInputElement>('#node-input').value = saved
  setNode(saved, false)
}
showSigner()
showSale()
refreshCost()
void refreshDeployCost()
void resumeBunker().then(s => s && useSigner(s))
