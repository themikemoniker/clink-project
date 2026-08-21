// Spike: drive the builder's REAL CLINK Manage path against the running node, end to end.
//
// Same contract as check-buy.ts — it imports the shipped modules rather than re-implementing
// them, so if this file and the builder ever disagree, this file is wrong. `npm test` in
// /builder covers the tag-building and the ladder; it cannot cover the half that matters most,
// which is whether a kind 21003 event built by our code mints a real offer on a real
// Lightning.Pub. This does.
//
// It costs nothing: minting an offer is not a payment. It DOES create a row on the node, and
// `create` is explicitly not idempotent (clink-manage.md:226), so re-running mints another
// offer. They are inert — nothing points at them — but they accumulate. `--clean` removes them.
//
// KEY HANDLING NOTICE. The builder ships two Signer paths and neither of them is this one: a
// browser has an extension or a bunker, and both hold the key out of reach. This script needs
// a Signer object and has no browser, so it wraps /spike/.dev-key in nostr-tools' own
// PlainKeySigner plus its nip44 functions — the same /CLAUDE.md rule-2 exception check-buy.ts
// already runs under, for the same reason. It adds no key path to the builder.
//
// Usage: node check-manage.ts [--label <text>] [--sats <n>] [--clean]
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPublicKey, finalizeEvent, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import { hexToBytes } from '@noble/hashes/utils.js'
import { createOffer, decodeNmanage } from '../builder/src/manage.ts'
import { eventsToSign, listingD, type Draft } from '../builder/src/listing.ts'
import { parseListings } from '../storefront/src/listing.ts'
import type { Signer } from '../builder/src/signer.ts'
import { arg, connectPub } from './pub-rpc.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = join(HERE, '.dev-key')
const NMANAGE_FILE = join(HERE, '.nmanage')

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE} — run seed-listings.ts first`)
if (!existsSync(NMANAGE_FILE)) throw new Error(`no ${NMANAGE_FILE} — run authorize-manage.ts first`)

const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const pk = getPublicKey(sk)

const node = decodeNmanage(readFileSync(NMANAGE_FILE, 'utf8').trim())
if (!node) throw new Error(`the builder refuses to decode ${NMANAGE_FILE} — re-run authorize-manage.ts`)

// The stand-in Signer. Deliberately the narrowest possible shim over the raw key: four methods,
// no storage, no reconnection, nothing the browser paths have.
const signer: Signer = {
  label: 'spike PlainKeySigner',
  getPublicKey: async () => pk,
  signEvent: async (e: EventTemplate) => finalizeEvent(e, sk) as VerifiedEvent,
  nip44Encrypt: async (to, text) => encrypt(text, getConversationKey(sk, to)),
  nip44Decrypt: async (to, ct) => decrypt(ct, getConversationKey(sk, to)),
  close: async () => {},
}

console.log(`# node    ${node.pubkey.slice(0, 12)}… on ${node.relay}`)
console.log(`# acting  ${pk.slice(0, 12)}…`)
console.log(`# pointer ${node.pointer.slice(0, 8)}… (the account pointer — never published)\n`)

let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`)
  if (!ok) failures++
}

// --- --clean: delete the offers previous runs left behind ---------------------------------
//
// Over the NATIVE kind 21000 RPC, not over Manage, for two reasons. `DeleteUserOffer` keys on
// (app_user_id, offer_id) with no management_pubkey check (offerStorage.ts:27-29), so it works
// regardless of which transport minted the row — and adding a `delete` action to the builder's
// Manage client for a cleanup chore would be shipping an unused code path into the money side.
// Slice 6 can add it when an admin panel actually needs it.
//
// THE GUARD IS THE POINT. findings §13.17: deleting an offer destroys the stored `payer_data`
// for every invoice under it, because GetUserOfferInvoices throws "Offer not found" once the
// row is gone and it is the only reader. That is the buyer's refund pointer. These check offers
// have never been paid, so deleting them is safe — but "safe because I believe nothing paid it"
// is not a guard, so we ask the node and refuse anything with a settled invoice.
const PREFIX = 'check-manage-'
if (process.argv.includes('--clean')) {
  const { rpc, close } = connectPub(sk, arg('nprofile', join(homedir(), 'lightning_pub', 'app.nprofile')))
  type OfferRow = { offer_id: string; label: string; default_offer: boolean }
  const offers: OfferRow[] = (await rpc('GetUserOffers', {})).offers ?? []
  const mine = offers.filter(o => !o.default_offer && o.label?.startsWith(PREFIX))
  console.log(`# ${offers.length} offer(s) on the account, ${mine.length} labelled ${PREFIX}*\n`)

  for (const offer of mine) {
    const res = await rpc('GetUserOfferInvoices', { offer_id: offer.offer_id, include_unpaid: false })
    const settled = Array.isArray(res.invoices) ? res.invoices.length : 0
    if (settled > 0) {
      console.log(`  KEEP  ${offer.label} — ${settled} settled invoice(s). Deleting it would destroy the refund pointer (findings §13.17).`)
      continue
    }
    await rpc('DeleteUserOffer', { offer_id: offer.offer_id })
    console.log(`  gone  ${offer.label}  ${offer.offer_id.slice(0, 12)}…`)
  }

  const after: OfferRow[] = (await rpc('GetUserOffers', {})).offers ?? []
  console.log(`\n# ${after.length} offer(s) remain: ${after.filter(o => !o.default_offer).map(o => o.label).join(', ') || '(none but the default)'}`)
  close()
  process.exit(0)
}

// --- mint one offer over CLINK Manage, kind 21003 -----------------------------------------
const SATS = Number(arg('sats', '1234'))
const LABEL = arg('label', `check-manage-${Math.floor(Date.now() / 1000)}`)

console.log(`# minting "${LABEL}" at ${SATS} sats over kind 21003…`)
const result = await createOffer(signer, node, LABEL, SATS)

if (!result.ok) {
  console.log(`  FAIL  create: code ${result.code} — ${result.error}${result.field ? ` (field ${result.field})` : ''}`)
  if (result.code === 1) {
    console.log('        code 1 with no grant means authorize-manage.ts has not run for this key.')
  }
  process.exit(1)
}

check(true, `create returned an offer: ${result.offer.id.slice(0, 12)}…`)
check(result.decoded.priceSats === SATS, `noffer TLV 4 prices it at ${result.decoded.priceSats} (asked ${SATS})`)
check(result.decoded.pubkey === node.pubkey, 'noffer TLV 0 points at the same node we asked')
check(result.decoded.relay === node.relay, `noffer TLV 1 names ${result.decoded.relay}`)
check(result.offer.id !== node.pointer, 'the minted offer is NOT the account default offer')
check(result.offer.payer_data.includes('refund_pointer'), 'the node recorded refund_pointer as required')

// --- the listing that would carry it -------------------------------------------------------
// The point of doing this here rather than only in the unit test: the noffer is a REAL one from
// a real node, so this is the end-to-end version of "a listing whose advertised price and whose
// offer disagree is not buyable". If the storefront can see a Buy button on this, a buyer can.
const draft: Draft = {
  slug: 'check-manage',
  title: 'Manage check item',
  summary: 'Minted by spike/check-manage.ts. Not published to any relay.',
  priceSats: SATS,
  stock: 2,
  alt: '',
  noffer: result.offer.noffer,
  blobs: [],
  servers: [],
}

const events = eventsToSign(draft, pk, Math.floor(Date.now() / 1000)).map(t => finalizeEvent(t, sk))
const parsed = events.map(e => parseListings([e], pk)[0])

check(parsed.every(Boolean), `${events.length} events (1 listing + ${events.length - 1} ladder rungs) survive the storefront parser`)
check(parsed[0]?.d === listingD('check-manage'), `d tag is ${parsed[0]?.d}`)
check(!!parsed[0]?.offer, 'the storefront would draw a Buy button — the listed price and the minted offer agree')
check(parsed[0]?.offer?.priceSats === SATS, `and it would pay ${parsed[0]?.offer?.priceSats} sats`)
check(parsed.map(p => p?.stock).join(',') === '2,1,0', `ladder walks stock ${parsed.map(p => p?.stock).join(' -> ')}`)
check(parsed[parsed.length - 1]?.sold === true, 'the last rung reads as sold')
check(events[events.length - 1]!.tags.every(t => t[0] !== 'clink_offer'), 'and it no longer advertises the offer')

console.log(`
# NOTHING WAS PUBLISHED. These events exist only in this process.
#
# The offer is real and is now on the node, under this key's management_pubkey. It is inert —
# no listing points at it, so nobody can find it — but every run mints another one, because
# CLINK Manage's create is explicitly not idempotent (clink-manage.md:226).`)

console.log(`\n${failures === 0 ? '# ALL CHECKS PASSED' : `# ${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
