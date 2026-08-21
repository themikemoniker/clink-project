// Spike: mint one purpose-made CLINK offer per buyable fixture item on the local Lightning.Pub,
// and write the resulting `noffer1…` strings where seed-listings.ts can tag them onto the
// kind 30402 events. Nothing can be bought until this has run — the slice-1 listings carry no
// `clink_offer` tag at all.
//
// KEY HANDLING NOTICE — same exception as seed-listings.ts. This reuses /spike/.dev-key, the
// throwaway seller identity. Per /docs/spec.md §1 one pubkey is the seller's identity, their
// listings, and their money, so the key that signs the listings is the key that owns the
// Lightning.Pub account. Delete both when slice 4 lands a real Signer.
//
// TRANSPORT: this is NOT CLINK. Offer CRUD over CLINK is Manage, kind 21003, and Lightning.Pub
// gates every Manage request — including one signed by the account's own key — behind an
// `AuthorizeManage` grant it does not auto-issue (/docs/spike-findings.md §13.4). The native
// RPC transport does not: kind 21000, the Pub's own xchacha20 envelope, `auth_type = "User"`,
// and `NostrUserAuthGuard` auto-creates an account for any pubkey that asks
// (nostrMiddleware.ts:13-18, gated by `application.allow_user_creation`). So this needs no
// approval, no wallet, and no human. Slice 4's builder should still speak Manage — it is the
// portable path and the one worth demoing — and it should budget the one grant prompt.
//
// Usage: node mint-offers.ts [--nprofile <path|nprofile1...>] [--dry]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { SimplePool, finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { xchacha20 } from '@noble/ciphers/chacha.js'
import { base64 } from '@scure/base'
import { ITEMS, listingD, offerPriceSats } from './fixture.ts'

// The one payer_data key this project defines, decided in slice 2 because offers are minted
// here and getting it wrong means re-minting every offer (/docs/spec.md §7.3). CLINK enumerates
// no payer_data keys at all (/docs/clink-notes.md §8), so the name is ours. Declared REQUIRED on
// every offer: Lightning.Pub then refuses to issue an invoice to a payer who did not supply a
// refund pointer, which turns "we hope we can refund an oversell" into a form field.
export const REFUND_POINTER = 'refund_pointer'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = join(HERE, '.dev-key')
const OUT_FILE = join(HERE, '.offers.json')

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const DRY = process.argv.includes('--dry')

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE} — run seed-listings.ts first`)
const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const pk = getPublicKey(sk)

// The guest pairing string: nprofile, no token. /CLAUDE.md rule 3 — the narrowest credential
// that works. `admin.connect` is nprofile:token and must never come near this file.
const pairing = arg('nprofile', join(homedir(), 'lightning_pub', 'app.nprofile'))
const nprofile = (existsSync(pairing) ? readFileSync(pairing, 'utf8') : pairing).trim()
const decoded = nip19.decode(nprofile)
if (decoded.type !== 'nprofile') throw new Error('--nprofile must be an nprofile1… or a file holding one')
const APP_PUB = decoded.data.pubkey
const RELAYS = decoded.data.relays?.length ? decoded.data.relays : ['wss://relay.lightning.pub']
console.log(`# node app pubkey ${APP_PUB.slice(0, 12)}… on ${RELAYS.join(', ')}`)
console.log(`# acting as       ${nip19.npubEncode(pk)}`)

// --- kind 21000 transport ----------------------------------------------------------------
// Lightning.Pub's own RPC envelope, and it is neither NIP-04 nor NIP-44: xchacha20 keyed on
// sha256 of the ECDH x-coordinate, payload = base64(0x01 ‖ nonce[24] ‖ ciphertext).
// Source: ~/lightning_pub/src/services/nostr/nip44v1.ts, used at nostrPool.ts:111,177.
const shared = sha256(secp256k1.getSharedSecret(sk, hexToBytes('02' + APP_PUB)).slice(1, 33))
const seal = (plaintext: string) => {
  const nonce = randomBytes(24)
  const body = new TextEncoder().encode(plaintext)
  return base64.encode(new Uint8Array([1, ...nonce, ...xchacha20(shared, nonce, body)]))
}
const open = (payload: string) => {
  const buf = base64.decode(payload)
  if (buf[0] !== 1) throw new Error(`unsupported envelope version ${buf[0]}`)
  return new TextDecoder().decode(xchacha20(shared, buf.subarray(1, 25), buf.subarray(25)))
}

const pool = new SimplePool()
const pending = new Map<string, (res: any) => void>()
// One filter OBJECT — nostr-tools 2.24.3 (/docs/spike-findings.md §13.9).
pool.subscribeMany(RELAYS, { kinds: [21000], '#p': [pk], authors: [APP_PUB] }, {
  onevent: e => {
    let res: any
    try {
      res = JSON.parse(open(e.content))
    } catch (err) {
      return console.log(`#   undecryptable response: ${String(err).slice(0, 80)}`)
    }
    pending.get(res.requestId)?.(res)
  },
})

const rpc = async (rpcName: string, body: unknown, timeoutMs = 15_000): Promise<any> => {
  const requestId = bytesToHex(randomBytes(16))
  // nostrMiddleware.ts:92 rejects the request unless authIdentifier equals the event pubkey.
  const content = seal(JSON.stringify({ rpcName, authIdentifier: pk, requestId, body }))
  const event = finalizeEvent(
    { kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [['p', APP_PUB]], content },
    sk,
  )
  const answered = new Promise<any>((resolve, reject) => {
    pending.set(requestId, resolve)
    setTimeout(() => reject(new Error(`${rpcName}: no response in ${timeoutMs}ms`)), timeoutMs)
  })
  await Promise.any(pool.publish(RELAYS, event))
  const res = await answered.finally(() => pending.delete(requestId))
  if (res.status !== 'OK') throw new Error(`${rpcName}: ${res.reason ?? JSON.stringify(res)}`)
  return res
}

// --- mint --------------------------------------------------------------------------------
type OfferConfig = {
  offer_id: string
  noffer: string
  label: string
  price_sats: number
  payer_data: string[]
  default_offer: boolean
}

const existing: OfferConfig[] = (await rpc('GetUserOffers', {})).offers ?? []
// NEVER touch or publish the default offer: its offer_id IS the account's app_user_id, i.e.
// the pointer that addresses this account in CLINK Debits and Manage. Publishing it hands every
// visitor a channel to push approval prompts at the seller (/docs/spike-findings.md §3).
const mine = new Map(existing.filter(o => !o.default_offer).map(o => [o.label, o]))
console.log(`# ${existing.length} offer(s) on the account, ${mine.size} purpose-made`)

const wanted = ITEMS.map(item => ({ item, sats: offerPriceSats(item) })).filter(
  (x): x is { item: (typeof ITEMS)[number]; sats: number } => x.sats !== undefined,
)

const offers: Record<string, { noffer: string; price_sats: number; payer_data: string[] }> = {}
for (const { item, sats } of wanted) {
  const label = listingD(item)
  const base = { label, price_sats: sats, payer_data: [REFUND_POINTER], callback_url: '', token: '', rejectUnauthorized: false }
  let offer = mine.get(label)

  if (DRY) {
    console.log(`# would ${offer ? 'reuse' : 'create'} ${label.padEnd(26)} ${String(sats).padStart(7)} sats`)
    continue
  }
  if (!offer) {
    // Manage `create` is explicitly not idempotent (clink-manage.md:226) and neither is this —
    // N runs would mint N offers. Matching on the label first is what keeps re-runs safe.
    const { offer_id } = await rpc('AddUserOffer', base)
    offer = (await rpc('GetUserOffer', { offer_id })) as OfferConfig
    console.log(`# created ${label.padEnd(26)} ${String(sats).padStart(7)} sats  ${offer.offer_id.slice(0, 12)}…`)
  } else if (offer.price_sats !== sats || !offer.payer_data?.includes(REFUND_POINTER)) {
    await rpc('UpdateUserOffer', { ...base, offer_id: offer.offer_id })
    offer = (await rpc('GetUserOffer', { offer_id: offer.offer_id })) as OfferConfig
    console.log(`# updated ${label.padEnd(26)} ${String(sats).padStart(7)} sats  ${offer.offer_id.slice(0, 12)}…`)
  } else {
    console.log(`# reused  ${label.padEnd(26)} ${String(sats).padStart(7)} sats  ${offer.offer_id.slice(0, 12)}…`)
  }

  // Trust the node's echo of nothing. The listing must advertise the price the node will
  // actually charge, and the storefront re-checks the same thing off the noffer's own TLVs.
  if (offer.price_sats !== sats) throw new Error(`${label}: node says ${offer.price_sats} sats, fixture says ${sats}`)
  if (!offer.payer_data?.includes(REFUND_POINTER)) throw new Error(`${label}: node did not record required ${REFUND_POINTER}`)
  if (offer.default_offer) throw new Error(`${label}: refusing to publish the account's default offer`)
  offers[label] = { noffer: offer.noffer, price_sats: offer.price_sats, payer_data: offer.payer_data }
}

if (!DRY) {
  writeFileSync(OUT_FILE, JSON.stringify(offers, null, 2) + '\n')
  console.log(`\n# wrote ${Object.keys(offers).length} noffer(s) to ${OUT_FILE}`)
  console.log('# now run: node seed-listings.ts   (republishes the 30402s carrying clink_offer)')
}
pool.close(RELAYS)
process.exit(0)
