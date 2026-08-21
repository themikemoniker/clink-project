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
// Usage: node check-buy.ts [item-d-tag] [--pay]
//   default item = the CHEAPEST offer, because the node's inbound is rented and small
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeNoffer, invoiceSats } from '../storefront/src/offer.ts'
import { requestInvoice } from '../storefront/src/buy.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OFFERS_FILE = join(HERE, '.offers.json')
if (!existsSync(OFFERS_FILE)) throw new Error(`no ${OFFERS_FILE} — run mint-offers.ts first`)

type Minted = { noffer: string; price_sats: number; payer_data: string[] }
const offers: Record<string, Minted> = JSON.parse(readFileSync(OFFERS_FILE, 'utf8'))
const WAIT_FOR_PAYMENT = process.argv.includes('--pay')
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
const wrong = await requestInvoice(offer, { refund_pointer: 'check-buy@example.com' }, minted.price_sats + 1, label, () => {})
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
  { refund_pointer: 'check-buy@example.com' },
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
