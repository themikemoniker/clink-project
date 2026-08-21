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
import { SALE } from '../../spike/fixture.ts'
import { approvalCount, normaliseSlug, type Draft } from './listing.ts'
import { decodeNmanage, type ManagePointer } from './manage.ts'
import { BLOSSOM, resize, upload } from './photos.ts'
import { deploy, DEFAULT_GATEWAY, loadStorefront, storefrontPaths, type DeployStep } from './deploy.ts'
import { downloadLadder, ladderFile, publish, RELAYS, type LadderFile, type Step } from './publish.ts'
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
// Every ladder published this session, so the file the seller downloads covers all of them and
// not just the last one.
let ladder: LadderFile = {}

const NODE_KEY = 'lamppost.nmanage'

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
  $('#deploy').toggleAttribute('disabled', !signer)
  if (signer) void signer.getPublicKey().then(pk => {
    $('#whoami').textContent = `${signer!.label} — ${pk.slice(0, 8)}…${pk.slice(-8)}`
  })
}

const useSigner = (s: Signer) => {
  signer = s
  showSigner()
  say(`Connected via ${s.label}.`, 'ok')
  refreshCost()
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
const readDraft = (): Draft => ({
  slug: normaliseSlug($<HTMLInputElement>('#slug').value || $<HTMLInputElement>('#title').value),
  title: $<HTMLInputElement>('#title').value.trim(),
  summary: $<HTMLTextAreaElement>('#summary').value.trim(),
  priceSats: Number($<HTMLInputElement>('#price').value),
  stock: Number($<HTMLInputElement>('#stock').value),
  alt: $<HTMLInputElement>('#alt').value.trim(),
  blobs: photos,
  servers: BLOSSOM,
})

// The signature count, shown BEFORE the seller starts. /docs/spec.md §5 is a UX-critical budget
// and slice 4 adds a term to it: an item is 1 + units, not 1. A UI that implies one item is one
// approval is how a seller abandons a publish halfway through, leaving a listing with no ladder.
const refreshCost = () => {
  const draft = readDraft()
  const n = approvalCount(draft, !!node && draft.stock > 0)
  const units = Math.max(0, draft.stock)
  const parts = [
    `${draft.blobs.length} photo upload${draft.blobs.length === 1 ? '' : 's'}`,
    ...(node && draft.stock > 0 ? ['1 offer'] : []),
    '1 listing',
    `${units} availability step${units === 1 ? '' : 's'}`,
  ]
  $('#cost').textContent =
    `${n} signature${n === 1 ? '' : 's'}: ${parts.join(' + ')}. ` +
    `Your signer should ask once per kind and remember the rest — if it asks every time, it ignored the permissions we requested.`
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
  if (!Number.isSafeInteger(draft.priceSats) || draft.priceSats < 0) return say('Price must be a whole number of sats.', 'bad')
  // Lightning.Pub hardcodes a 10-sat floor on what it will invoice (offerManager.ts:224,251 —
  // findings §13.7). Below it the node answers `code 5` and the seller never learns why.
  if (node && draft.stock > 0 && draft.priceSats < 10) {
    return say('A buyable item must be at least 10 sats — the node will not invoice less. Set stock to 0, or clear the node field, to list it as cash-only.', 'bad')
  }
  if (!Number.isSafeInteger(draft.stock) || draft.stock < 0 || draft.stock > 999) return say('Stock must be 0–999.', 'bad')

  $('#publish').toggleAttribute('disabled', true)
  try {
    const result = await publish(signer, node, draft, onStep)
    ladder = { ...ladder, [result.d]: result.ladder[result.d]! }
    $('#result').hidden = false
    $('#result-text').textContent =
      `${draft.title} is live on ${result.relaysOk}/${RELAYS.length} relays as ${result.d}` +
      (result.noffer ? ', with a Buy button.' : ', cash at the table.')
    $('#ladder-note').textContent =
      `${Object.keys(ladder).length} item(s) in this ladder. Save it as .ladder.json next to watch-sales.ts, then restart the watcher.`
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), 'bad')
  } finally {
    $('#publish').toggleAttribute('disabled', !signer)
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
    const { blobs } = await upload(signer, rendered, (done, total) => say(`Uploading ${done}/${total}…`))
    if (blobs.length === 0) throw new Error('No Blossom server accepted the photo. The listing can still publish without one.')
    photos = blobs
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
      meta: { title: SALE.title, description: SALE.summary },
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
$('#download-ladder').addEventListener('click', () => downloadLadder(ladderFile({}, ladder)))
$('#deploy').addEventListener('click', () => void doDeploy())
$('#perms').textContent = PERMS.join(', ')

if (!hasNip07()) $('#nip07').setAttribute('disabled', 'true')
const saved = localStorage.getItem(NODE_KEY)
if (saved) {
  $<HTMLInputElement>('#node-input').value = saved
  setNode(saved, false)
}
showSigner()
refreshCost()
void refreshDeployCost()
void resumeBunker().then(s => s && useSigner(s))
