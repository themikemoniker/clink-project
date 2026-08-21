// Spike: mint one purpose-made CLINK offer per buyable fixture item on the local Lightning.Pub,
// and write the resulting `noffer1…` strings where seed-listings.ts can tag them onto the
// kind 30402 events. Nothing can be bought until this has run — the slice-1 listings carry no
// `clink_offer` tag at all.
//
// KEY HANDLING NOTICE — same exception as seed-listings.ts. This reuses /spike/.dev-key, the
// throwaway seller identity. Per /docs/spec.md §1 one pubkey is the seller's identity, their
// listings, and their money, so the key that signs the listings is the key that owns the
// Lightning.Pub account. This used to say "delete both when slice 4 lands a real Signer" — that
// decision was REVERSED on 2026-08-21 and the key stays. See ./seed-listings.ts's header for
// why: deleting it takes this script, the seeder, deploy-nsite.ts and slice 3's watcher with it,
// along with the storefront's npub, its nsite URL and the node account holding the sale's sats.
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
// Usage: node mint-offers.ts [--key <file>] [--fixture <module>] [--nprofile <path|nprofile1...>] [--dry]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils.js'
import { REFUND_POINTER } from './fixture.ts'
import { arg, connectPub } from './pub-rpc.ts'

// REFUND_POINTER moved to ./fixture.ts in slice 4 — the builder mints offers over CLINK Manage
// and needs the same string, and this file cannot be imported (top-level effects). Re-exported
// so anything that imported it from here still works.
export { REFUND_POINTER }

const HERE = dirname(fileURLToPath(import.meta.url))
// `--key`/`--fixture` are what make this script serve a SECOND seller on the same Pub — a fixture
// is one seller's sale, and its offers are minted on the account that key owns. The state file is
// derived from the key rather than flagged separately: `.offers.json` is read by the seeder AND by
// watch-sales.ts, so one forgotten `--out` would silently point the live sale's watcher at another
// seller's noffers. Deriving it makes that unrepresentable. Default seller: paths unchanged.
const KEY = arg('key', '.dev-key')
const KEY_FILE = join(HERE, KEY)
const OUT_FILE = join(HERE, KEY === '.dev-key' ? '.offers.json' : `${KEY}.offers.json`)
// REFUND_POINTER stays a STATIC import above: it is one string for every seller by design, and a
// per-fixture copy of it is the exact drift fixture.ts's header exists to prevent.
const { ITEMS, listingD, offerPriceSats } = await import(arg('fixture', './fixture.ts'))

const DRY = process.argv.includes('--dry')

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE} — pass --key <file>, or run seed-listings.ts first`)
const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const pk = getPublicKey(sk)

// The guest pairing string: nprofile, no token. /CLAUDE.md rule 3 — the narrowest credential
// that works. `admin.connect` is nprofile:token and must never come near this file.
const { appPub, relays, rpc, close } = connectPub(sk, arg('nprofile', join(homedir(), 'lightning_pub', 'app.nprofile')))
console.log(`# node app pubkey ${appPub.slice(0, 12)}… on ${relays.join(', ')}`)
console.log(`# acting as       ${nip19.npubEncode(pk)}`)

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
  // Echo the flags back rather than the bare command: seeding the second seller's listings with
  // the first seller's key is a sale published under the wrong npub, on four public relays.
  const flags = KEY === '.dev-key' ? '' : ` --key ${KEY} --fixture ${arg('fixture', './fixture.ts')}`
  console.log(`# now run: node seed-listings.ts${flags}   (republishes the 30402s carrying clink_offer)`)
}
close()
process.exit(0)
