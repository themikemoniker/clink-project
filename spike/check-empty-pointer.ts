// Item 25: an empty string satisfies a REQUIRED `payer_data` key, and three of our documents say
// it cannot. This drives the claim at the running node so the sentence in /docs/spec.md §7.3 is
// measured rather than believed.
//
// THE CLAIM UNDER TEST. `/docs/spec.md` §7.3: "a payment that would be unrefundable is therefore
// declined rather than accepted." `/docs/design.md` §4 says the offer is "unpayable by anything
// that cannot supply `refund_pointer`". Slice 8's re-decision rests on the same thing: it argues
// the alternative would produce a `queued` journal row no human can act on. An empty pointer
// produces exactly that row, so if the node issues an invoice for one, all three overstate a
// guarantee.
//
// Read from source first (findings §22, roadmap-review-findings §22): `ValidateExpectedData`
// checks only `typeof payerData[key] !== 'string'` (offerManager.ts:148-152), so any string
// passes, including the empty one. That was a source read. This is the wire.
//
// IT COSTS NOTHING AND IT CANNOT PAY. Every call here is a kind 21001 invoice REQUEST. Requesting
// is free — an invoice is a request for money, not a payment — and this file has no --pay mode to
// forget to leave off. Whatever comes back is printed as a prefix and never settled.
//
// OUR PAGE IS SAFE AND MUST STAY SAFE. `storefront/src/render.ts` gates the Buy form on
// `isPointer` before it will request anything, which is why nobody has hit this. Nothing here
// weakens that gate; it drives the NODE directly, the way a client that is not ours would.
//
// Usage: node check-empty-pointer.ts [item-d-tag] [--offers <file>]
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeNoffer } from '../storefront/src/offer.ts'
import { requestInvoice, closeBuy } from '../storefront/src/buy.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const argOf = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const OFFERS_FILE = join(HERE, argOf('offers', '.offers.json'))
if (!existsSync(OFFERS_FILE)) throw new Error(`no ${OFFERS_FILE} — run mint-offers.ts first`)

type Minted = { noffer: string; price_sats: number; payer_data: string[] }
const offers: Record<string, Minted> = JSON.parse(readFileSync(OFFERS_FILE, 'utf8'))
const cheapest = Object.entries(offers).sort((a, b) => a[1].price_sats - b[1].price_sats)[0]![0]
const label = process.argv[2]?.startsWith('--') ? cheapest : (process.argv[2] ?? cheapest)
const minted = offers[label]
if (!minted) throw new Error(`no offer for ${label}; have: ${Object.keys(offers).join(', ')}`)

const offer = decodeNoffer(minted.noffer)
if (!offer) throw new Error('the storefront refuses to decode the noffer we just minted')

console.log(`# ${label} — ${minted.price_sats} sats, payer_data ${JSON.stringify(minted.payer_data)}`)
console.log(`#   service ${offer.pubkey.slice(0, 12)}…  relay ${offer.relay}`)
console.log('#   every request below is free. Nothing here can pay.\n')

// The value sent, and what a `queued` journal row would say about it if the invoice ever settled.
const cases: { name: string; payerData: Record<string, string> }[] = [
  { name: 'the key absent entirely (the control — this is the documented decline)', payerData: {} },
  { name: 'the empty string', payerData: { refund_pointer: '' } },
  { name: 'one space', payerData: { refund_pointer: ' ' } },
  { name: 'a string that is not a pointer of any kind', payerData: { refund_pointer: 'not-a-pointer' } },
]

let issued = 0
for (const { name, payerData } of cases) {
  const outcome = await requestInvoice(offer, payerData, minted.price_sats, 'item 25 probe', () => {})
  closeBuy() // each request leaves a receipt subscription open; nothing here reads one
  if (outcome.ok) {
    issued++
    console.log(`  INVOICE ISSUED  ${name}`)
    console.log(`                  ${outcome.bolt11.slice(0, 28)}… ${outcome.sats} sats — NOT paid, and it will expire`)
  } else {
    console.log(`  declined        ${name}`)
    console.log(`                  code ${outcome.code}: ${outcome.error}`)
  }
}

console.log(
  issued === 0
    ? `
# The node declined every one of them. /docs/spec.md §7.3's "a payment that would be unrefundable
# is therefore declined rather than accepted" holds as written, and item 25 is closed as refuted.`
    : `
# ${issued} of ${cases.length - 1} unusable pointers got a BOLT11.
#
# So the guarantee is narrower than three of our documents state. What the node enforces is
# "the key is PRESENT and is a string" — ValidateExpectedData checks nothing else
# (offerManager.ts:148-152). What our documents claim is "a payment that would be unrefundable is
# declined", and these invoices would be exactly that: a settlement carrying a pointer
# resolvePointer cannot use is a 'queued' journal row, reprinted every five minutes, that no human
# can act on because nothing on the invoice identifies who paid.
#
# What still holds, and it is the half that matters for OUR buyers: storefront/src/render.ts gates
# the Buy form on isPointer, so no invoice this project's page requests can carry one of these.
# The claim is true of our page and false of the node. Narrow the documents to say so.`,
)

process.exit(0)
