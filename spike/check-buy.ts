// Spike: drive the storefront's REAL buy path against the running node, end to end.
//
// `npm test` in /storefront covers the parsers. It cannot cover the half that matters most —
// does a kind 21001 request built by our code get an invoice out of a real Lightning.Pub — so
// this does, by importing the shipped modules rather than re-implementing them. If this file
// and the storefront ever disagree, this file is wrong.
//
// It needs the node running and /spike/.offers.json present (run mint-offers.ts first). It
// spends nothing on its own: an invoice is a request for money, not a payment.
//
// With --pay it stops at the invoice and waits for a human to pay it from a phone, which is the
// one thing left that no amount of code can prove — see /docs/spike-findings.md §1.
//
// THE REFUND POINTER IS AN ARGUMENT AS OF SLICE 8, and the reason is a defect this file shipped.
// It hardcoded `check-buy@example.com`, so all three settled invoices on the live node carry a
// pointer that resolves to nothing — which made slice 7's refund path unprovable by construction
// (a real oversell today correctly `queue`s rather than pays) and left two rows open in
// /docs/known-defects.md. A test fixture that writes unusable data into the one field the money
// path reads back is not a placeholder, it is a slice that cannot be finished.
//
// So --pay now REQUIRES --pointer. An invoice that settles is a permanent row on the node
// carrying whatever this file put in `payer_data`, and the node has no way to correct one later.
//
// Usage: node check-buy.ts [item-d-tag] [--offers <file>] [--pay] [--pointer <address-or-noffer>]
//   default item = the CHEAPEST offer, because the node's inbound is rented and small
//   --offers picks WHICH SELLER to buy from — `.merida-key.offers.json` is the second seller's,
//   whose noffers point at their own sub-account on the same Pub (findings §11)
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeNoffer, invoiceSats, isPointer } from '../storefront/src/offer.ts'
import { requestInvoice } from '../storefront/src/buy.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const argOf = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const OFFERS_FILE = join(HERE, argOf('offers', '.offers.json'))
if (!existsSync(OFFERS_FILE)) throw new Error(`no ${OFFERS_FILE} — run mint-offers.ts first`)

type Minted = { noffer: string; price_sats: number; payer_data: string[] }
const offers: Record<string, Minted> = JSON.parse(readFileSync(OFFERS_FILE, 'utf8'))
const WAIT_FOR_PAYMENT = process.argv.includes('--pay')

// The same shape check the buy form makes (storefront/src/offer.ts `isPointer`), run here for the
// same reason: /spike/refund.ts is what eventually pays this, and a pointer it cannot resolve is
// a queued row and a manual handover rather than a refund.
const pointerArg = process.argv[process.argv.indexOf('--pointer') + 1]
const POINTER = process.argv.includes('--pointer') ? (pointerArg ?? '') : 'check-buy@example.com'
if (process.argv.includes('--pointer') && !isPointer(POINTER)) {
  throw new Error(`--pointer ${JSON.stringify(POINTER)} is neither a Lightning address nor an noffer`)
}
if (WAIT_FOR_PAYMENT && !process.argv.includes('--pointer')) {
  throw new Error(
    '--pay needs --pointer <lightning-address-or-noffer>.\n' +
      '  A settled invoice stores this value forever and it is the ONLY route the refund path has\n' +
      '  back to the buyer. The default `check-buy@example.com` is deliberately unresolvable, and\n' +
      '  three invoices on this node already carry it. Pass a wallet you control.',
  )
}
// Cheapest first: the node has 98,160 sat of rented inbound (findings §1) and two of the four
// fixture items are priced above it. A fixed-price offer is not range-checked, so those two
// hand you a perfectly valid invoice that can never settle.
const cheapest = Object.entries(offers).sort((a, b) => a[1].price_sats - b[1].price_sats)[0]![0]
const label = process.argv[2]?.startsWith('--') ? cheapest : (process.argv[2] ?? cheapest)
const minted = offers[label]
if (!minted) throw new Error(`no offer for ${label}; have: ${Object.keys(offers).join(', ')}`)

const offer = decodeNoffer(minted.noffer)
if (!offer) throw new Error('the storefront refuses to decode the noffer we just minted')
console.log(`# ${label} — ${minted.price_sats} sats`)
console.log(`#   service ${offer.pubkey.slice(0, 12)}…  relay ${offer.relay}  priceType ${offer.priceType}  TLV price ${offer.priceSats}`)
// NEVER LOG THE POINTER ITSELF (/CLAUDE.md, and /spike/refund.ts's header draws the same line):
// it is a credential addressed to a wallet and the name half identifies a person. The KIND is
// what a person running this needs to see, and it is what the journal stores too.
console.log(`#   refund pointer: ${decodeNoffer(POINTER) ? 'an noffer' : 'a Lightning address'}${process.argv.includes('--pointer') ? '' : ' (the UNRESOLVABLE default — --pay would refuse)'}`)

let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`)
  if (!ok) failures++
}

// 1. The refund pointer is REQUIRED. A request without it must be declined, and the decline must
// carry Lightning.Pub's `payer_data` array so the page can re-prompt instead of guessing.
console.log('\n# no payer_data — expect a typed decline, code 1')
const declined = await requestInvoice(offer, {}, minted.price_sats, label, () => {})
console.log(`   ${JSON.stringify(declined)}`)
check(!declined.ok && declined.code === 1, 'declined with code 1')
check(!declined.ok && declined.payerData?.includes('refund_pointer') === true, 'names refund_pointer as the missing key')

// 2. The price-agreement check is the one that stops a node charging what it likes. Ask for the
// same offer while expecting a different number and the page must refuse the invoice it gets.
console.log('\n# expecting the wrong price — the page must refuse the invoice')
const wrong = await requestInvoice(offer, { refund_pointer: POINTER }, minted.price_sats + 1, label, () => {})
console.log(`   ${JSON.stringify(wrong)}`)
check(!wrong.ok && wrong.code === 0, 'refused rather than displayed')

// 3. With the pointer and the right price, an invoice. Last, because in --pay mode its
// subscription has to stay open — every requestInvoice closes the previous one.
console.log('\n# with a refund pointer — expect a bolt11')
let receipt: ((r: Record<string, unknown>, e: unknown) => void) | undefined
const settled = new Promise<{ payload: Record<string, unknown>; event: any }>(resolve => {
  receipt = (payload, event) => resolve({ payload, event })
})
const paid = await requestInvoice(
  offer,
  { refund_pointer: POINTER },
  minted.price_sats,
  label,
  (payload, event) => receipt!(payload, event),
)
if (paid.ok) {
  console.log(`   bolt11 ${paid.bolt11.slice(0, 40)}…  (${paid.bolt11.length} chars)`)
  check(paid.sats === minted.price_sats, `invoice is for ${minted.price_sats} sats`)
  check(invoiceSats(paid.bolt11) === minted.price_sats, 'the BOLT11 itself agrees')
} else {
  console.log(`   ${JSON.stringify(paid)}`)
  check(false, 'got an invoice')
}

if (WAIT_FOR_PAYMENT && paid.ok) {
  // The receipt is NIP-44 encrypted to the ephemeral key this process just minted and to nothing
  // else (clink-offers.md:307-343). No polling, no backend, no seller involvement: if this line
  // ever prints, the storefront's showPaid() fires for the same reason.
  console.log(`\n# pay this from a phone — ${minted.price_sats} sats\n`)
  console.log(paid.bolt11)
  console.log(`\nlightning:${paid.bolt11}`)
  console.log(`\n# waiting up to 15 minutes for the kind 21001 receipt…`)
  const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 15 * 60_000).unref())
  const outcome = await Promise.race([settled, timeout])
  check(outcome !== 'timeout', 'settlement receipt arrived, readable by the payer key alone')
  if (outcome === 'timeout') {
    console.log('   (nothing arrived — invoice expired, or the payment never landed)')
  } else {
    // Paste all of this into /docs/spike-findings.md §5. Two things it settles that no amount
    // of source-reading could: whether a `preimage` is present (clink-offers.md:327-333 makes
    // it a MUST for a standard Lightning payment; paymentSideEffects.ts:222 never sends one),
    // and whether the receipt carries `clink_version` (the one place §5 says it does).
    console.log('\n# receipt payload (decrypted)\n' + JSON.stringify(outcome.payload, null, 2))
    console.log('\n# receipt event (raw, content still encrypted — only this process can read it)')
    console.log(JSON.stringify(outcome.event, null, 2))
    check('preimage' in outcome.payload === false, 'no preimage, as findings §5 predicts (a MUST the reference server skips)')
    check(
      outcome.event.tags?.some((t: string[]) => t[0] === 'clink_version') === true,
      'receipt carries clink_version, unlike the response (findings §2)',
    )
  }
}

console.log(failures === 0 ? '\n# all checks passed' : `\n# ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
