// Slice 7 bootstrap: mint the watcher's refund key and grant it a CLINK Debit authorisation on
// the seller's node, capped by a node-enforced frequency rule. Run this ONCE, at the desk, next
// to the node. After it, the watcher can pay refunds and nothing else.
//
// It is the exact analogue of ./authorize-manage.ts and for the same structural reason: a grant
// cannot bootstrap itself over the transport it authorises. Manage needed one raw-key call
// because `AuthorizeManage` is kind 21000; this needs one because the only way to create a debit
// grant is for the ACCOUNT OWNER to answer a pending authorisation request, and the account owner
// is a raw key on this machine.
//
// ---------------------------------------------------------------------------------------------
// WHAT THE SLICE BRIEF GOT WRONG, verified 2026-08-21 against the running node's source.
//
// The brief said: "`AuthorizeDebit` is commented out. `EditDebit` is the grant path." The first
// half is right — methods.proto:690-694 has the whole `AuthorizeDebit` rpc inside a `/* … */`
// block. The second half is not.
//
//   * `EditDebit` (methods.proto:696-701, `auth_type = "User"`, `nostr = true`) is real and
//     reachable, and it takes `DebitAuthorizationRequest { authorize_npub, rules, request_id }`
//     exactly as the brief describes (structs.proto:755-759).
//   * But its FIRST LINE looks the grant up and throws when there is none:
//     `const access = await GetDebitAccess(...); if (!access) throw new Error("Debit does not
//     exist")` (debitManager.ts:99-105). It then only calls `UpdateDebitAccessRules`.
//     **`EditDebit` edits rules on a grant that already exists. It cannot create one.**
//   * `AddDebitAccess` — the only function that inserts a DebitAccess row — has exactly two
//     callers in the whole node (`grep -rn AddDebitAccess ~/lightning_pub/src`):
//     `debitStorage.ts:45`, which creates a row with `authorize: false` on the way to banning a
//     pubkey, and `debitManager.ts:153` inside `handleAuthorization`.
//
// So the ONLY path to an authorised grant is `handleAuthorization`, which is reached from
// `RespondToDebit` (methods.proto:714-719, `auth_type = "User"`, `nostr = true`) answering a
// pending request. And a request only becomes pending when a debit arrives from a pubkey with no
// grant: `doNdebit` returns `{status:'authRequired'}` and `handleAuthRequired` pushes a
// `LiveDebitRequest` to the account's own key (debitManager.ts:216-221).
//
// Hence the three-step dance below, which is what this script is:
//
//   1. the REFUND key sends a kind 21002 *budget* request — `{pointer, amount_sats, frequency}`.
//      A budget request carries no bolt11, so nothing is paid: `doNdebit` sees `frequency`, finds
//      no grant, and asks the owner (debitManager.ts:277-301). It costs zero sats.
//   2. the node pushes a `LiveDebitRequest` to the SELLER key over kind 21000, with the fixed
//      requestId "GetLiveDebitRequests". ./pub-rpc.ts's `onPush` hook catches it.
//   3. the SELLER key answers `RespondToDebit` with `AUTHORIZE` and OUR rules — not the ones the
//      request asked for. That is the important part: the requestor proposes, the owner disposes,
//      and what lands in the DebitAccess row is whatever the owner sent.
//
// `EditDebit` is still worth having and is used by `--cap`: once the row exists, changing the cap
// is one call and needs no dance. That is also how ./check-refund.ts proves the cap fires without
// spending the whole balance.
// ---------------------------------------------------------------------------------------------
//
// KEY HANDLING NOTICE. This touches two raw private keys, and they are deliberately different:
//
//   * /spike/.dev-key — the seller. Owns the node account, signs the listings, holds the sats.
//     Used here for exactly one thing: to answer the authorisation prompt as the account owner.
//   * /spike/.refund-key — MINTED BY THIS SCRIPT, gitignored, chmod 600. It is not an identity:
//     it signs no listings, owns no account, holds no funds, and appears in no published event.
//
//     WHAT IT CAN DO: ask the seller's node to pay a BOLT11, up to the frequency cap, per
//     interval. That is all. `doNdebit` resolves the account from the pointer and every payment
//     goes through `assertDebitFrequency` inside the payment transaction
//     (debitManager.ts:376-401).
//     WHAT IT CANNOT DO: read settlements, mint or delete offers, publish anything as the seller,
//     move money anywhere but to an invoice it hands over, or exceed the cap — the node refuses
//     with GFY 5 and the check runs in-transaction, so it holds under concurrency.
//     WHAT REVOKES IT: `node authorize-refunds.ts --revoke` (BanDebit), or one tap in
//     ShockWallet. Revocation is on the NODE, not in our code, which is the entire point.
//
// This separation is /docs/spike-findings.md §10 and /docs/spec.md §12: "User" scope on
// Lightning.Pub is not read-only, so the observe key — which watch-sales.ts holds — could call
// PayInvoice. The refund key is narrower than the key that watches, on purpose.
//
// Usage:
//   node authorize-refunds.ts                  # grant, at the default cap
//   node authorize-refunds.ts --cap 2000       # grant, or re-cap an existing grant, sats/day
//   node authorize-refunds.ts --days 30        # how long the grant lives before it self-deletes
//   node authorize-refunds.ts --show           # list grants, change nothing
//   node authorize-refunds.ts --revoke         # BanDebit: the kill switch
//   node authorize-refunds.ts --reset          # ResetDebit: remove the row entirely
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { ndebitEncode } from '@shocknet/clink-sdk/build/nip19Extension.js'
import { payDebitBudget } from './ndebit.ts'
import { arg, connectPub } from './pub-rpc.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = join(HERE, '.dev-key')
const REFUND_KEY_FILE = join(HERE, '.refund-key')
const OUT_FILE = join(HERE, '.ndebit')

// THE CAP. /docs/spec.md §12 and /CLAUDE.md: the refund path needs a hard cap, and the node
// should be the thing enforcing it rather than our code. 8,000 sats/day is the seller's choice,
// recorded 2026-08-21, and it is the node's entire current outbound balance — every sat of it
// created by three test sales.
//
// SAY THIS OUT LOUD RATHER THAN BURY IT: a cap equal to the balance cannot fire, because the
// balance runs out first. It bounds a bug to one day's worth of what the node can actually send,
// which is a real property, but it is not the property a cap is usually bought for. The mechanism
// is proved separately, by ./check-refund.ts, which drops the cap to a few sats, exceeds it
// deliberately, records the GFY, and puts it back.
const CAP_SATS = Number(arg('cap', '8000'))
// An expiry costs nothing and the grant carries both rules — `rules` is `repeated DebitRule` and
// `DebitRule` is a oneof, so two entries set two different rules (structs.proto:808-813). Note
// what expiry does on this node: `validateAccessRules` DELETES the grant on first use after it
// lapses and answers GFY 3 (debitManager.ts:443-449). It fails closed, and re-granting is this
// script again. Do not let it lapse mid-demo.
const DAYS = Number(arg('days', '30'))

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE} — run seed-listings.ts first`)
const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const sellerPub = getPublicKey(sk)

// The refund key is minted here rather than derived from anything, because a key derived from the
// seller's key would be the seller's key wearing a hat.
if (!existsSync(REFUND_KEY_FILE)) {
  writeFileSync(REFUND_KEY_FILE, bytesToHex(generateSecretKey()) + '\n', { mode: 0o600 })
  console.log(`# minted a new refund key at ${REFUND_KEY_FILE} (gitignored, chmod 600)`)
}
const refundSk = hexToBytes(readFileSync(REFUND_KEY_FILE, 'utf8').trim())
const refundPub = getPublicKey(refundSk)

if (refundPub === sellerPub) throw new Error('the refund key IS the seller key — refusing to grant it anything')

// The pushed authorisation request lands on the seller's own kind 21000 channel with the fixed
// requestId "GetLiveDebitRequests" (debitManager.ts:216-221). Catch it before we trigger it.
type LiveDebitRequest = { request_id: string; npub: string; k1?: string }
let pendingAuth: LiveDebitRequest | undefined
const waiters: ((req: LiveDebitRequest) => void)[] = []

const { appPub, relays, rpc, close } = connectPub(
  sk,
  arg('nprofile', join(homedir(), 'lightning_pub', 'app.nprofile')),
  res => {
    if (res?.requestId !== 'GetLiveDebitRequests' || typeof res.npub !== 'string') return
    // Only ours. The node would push one of these for any ungranted pubkey that debits this
    // account, and answering somebody else's would be granting a stranger spend authority.
    if (res.npub !== refundPub) {
      console.log(`# ignoring a debit request from ${res.npub.slice(0, 12)}… — not our refund key`)
      return
    }
    pendingAuth = res as LiveDebitRequest
    waiters.splice(0).forEach(fn => fn(pendingAuth!))
  },
)

console.log(`# node app pubkey ${appPub.slice(0, 12)}… on ${relays.join(', ')}`)
console.log(`# account owner   ${nip19.npubEncode(sellerPub)}`)
console.log(`# refund key      ${refundPub.slice(0, 16)}…  (holds no funds, no identity)`)

// The account pointer, exactly as ./authorize-manage.ts derives it: the default offer is the one
// whose offer_id EQUALS the account's app_user_id (offerManager.ts:30), and that equality is the
// only way to read app_user_id back out of this API. CLINK Debits wants it as the `pointer`.
// NEVER published — /docs/spec.md §6.1.
type OfferConfig = { offer_id: string; default_offer: boolean }
const offers: OfferConfig[] = (await rpc('GetUserOffers', {})).offers ?? []
const pointer = offers.find(o => o.default_offer)?.offer_id
if (!pointer) throw new Error('no default offer on this account — cannot determine the account pointer')

// `authorize_npub` is a misnomer in the proto, the same way it is on the Manage side
// (findings §13.19): the row stores `npub` and matches it against `event.pub`, which is 64-char
// HEX (debitStorage.ts:27-29 `GetDebitAccess(appUserId, authorizedPub)`, fed from
// `event.pub` at debitManager.ts:250). An `npub1…` here creates a grant that never matches
// anything. VERIFIED for Debits rather than inherited from Manage, as the brief asked.
type Grant = { debit_id: string; authorized: boolean; npub: string; rules?: unknown[] }
const grants = async (): Promise<Grant[]> => ((await rpc('GetDebitAuthorizations', {})).debits ?? []) as Grant[]

const describe = (list: Grant[]) => {
  if (list.length === 0) return console.log('#   (no debit grants on this account)')
  for (const g of list) {
    const mine = g.npub === refundPub ? '  <- our refund key' : ''
    console.log(`#   debit_id ${g.debit_id}  ${g.authorized ? 'AUTHORIZED' : 'banned    '}  ${g.npub.slice(0, 16)}…  rules ${JSON.stringify(g.rules ?? [])}${mine}`)
  }
}

if (process.argv.includes('--show')) {
  console.log('\n# debit grants on this account:')
  describe(await grants())
  close()
  process.exit(0)
}

// THE KILL SWITCH, and it is the node's rather than ours. `BanDebit` flips `authorized` to false
// (and creates the row first if there is none, debitStorage.ts:43-47), after which
// `assertDebitFrequency` throws `DebitUnauthorizedError` INSIDE the payment transaction — so it
// stops a refund that is already in flight, not merely the next one (debitManager.ts:376-401).
// /CLAUDE.md's "the refund path needs a kill switch" is this call.
if (process.argv.includes('--revoke')) {
  await rpc('BanDebit', { npub: refundPub })
  console.log(`\n# BANNED the refund key. Every further debit gets GFY 1, checked in-transaction.`)
  describe(await grants())
  close()
  process.exit(0)
}

// ResetDebit removes the row entirely rather than banning it (debitManager.ts:111-113 ->
// RemoveDebitAccess). After this the next debit re-triggers the authorisation dance, which is a
// different thing from a ban: a ban denies, a reset forgets.
if (process.argv.includes('--reset')) {
  await rpc('ResetDebit', { npub: refundPub })
  console.log(`\n# REMOVED the grant row. The next debit from this key would ask for authorisation again.`)
  describe(await grants())
  close()
  process.exit(0)
}

// --- the rules ------------------------------------------------------------------------------
// structs.proto:808-813 — `DebitRule` is a oneof of DebitExpirationRule or FrequencyRule, and
// `rules` is repeated, so both can be set. The TS shape of a proto oneof here is
// `{ type: '<field>', <field>: {...} }` (proto/autogenerated/ts/types.ts:5449-5459).
// NOTE THE `rule` WRAPPER, which the proto text does not make obvious and which cost a round
// trip to find. `DebitRule` is a message whose ONLY field is the oneof, so the generated shape is
// `{ rule: { type, <field> } }` and not `{ type, <field> }` (types.ts:1700-1702, and the
// validator at :1708-1717). Sending it flat returns `invalid request body` with no field name.
// The node's own reader agrees — `const { rule } = r; switch (rule.type)`, debitTypes.ts:40-41.
const now = Math.floor(Date.now() / 1000)
const rules = [
  {
    rule: {
      type: 'frequency_rule',
      frequency_rule: {
        // FrequencyRule { number_of_intervals, interval, amount } — structs.proto:801-805. The
        // node stores it as the tuple [number, unit, max] and sums this key's debit payments over
        // `IntervalTypeToSeconds(interval) * number` seconds (checkFrequencyCap,
        // debitManager.ts:404-425). `amount` is the CAP, not the per-payment size.
        number_of_intervals: 1,
        interval: 'DAY', // IntervalType enum: DAY | WEEK | MONTH (types.ts:467-471)
        amount: CAP_SATS,
      },
    },
  },
  { rule: { type: 'expiration_rule', expiration_rule: { expires_at_unix: now + DAYS * 86_400 } } },
]

const existing = (await grants()).find(g => g.npub === refundPub)

if (existing) {
  // The row is already there, so this is `EditDebit`'s actual job: rewrite the rules in place.
  // No dance, no prompt, and it works whether the row is authorised or banned — which is why
  // check-refund.ts can use it to move the cap down and back up around a deliberate breach.
  console.log(`\n# a grant for this key already exists (debit_id ${existing.debit_id}) — editing its rules`)
  if (!existing.authorized) {
    console.log('#   NOTE: it is currently BANNED. Editing rules does not unban it; run --reset then re-run this.')
  }
  await rpc('EditDebit', { authorize_npub: refundPub, rules })
} else {
  // The dance. See the header for why there is no shorter route.
  console.log(`\n# no grant yet. Asking for one the only way the node allows:`)
  console.log(`#   1. the refund key sends a kind 21002 BUDGET request (no bolt11, so nothing is paid)`)

  const arrived = new Promise<LiveDebitRequest>((resolve, reject) => {
    if (pendingAuth) return resolve(pendingAuth)
    waiters.push(resolve)
    setTimeout(() => reject(new Error('the node never pushed a LiveDebitRequest — is it running, and is this the right nprofile?')), 30_000)
  })

  // Deliberately not awaited before we start listening: the push races the response.
  const budget = payDebitBudget(refundSk, { pubkey: appPub, relay: relays[0]!, pointer }, {
    amountSats: CAP_SATS,
    frequency: { number: 1, unit: 'day' },
  })

  const req = await arrived
  console.log(`#   2. the node pushed one (request_id ${req.request_id.slice(0, 12)}…)`)

  // The owner disposes. We send OUR rules, not the ones the request proposed — the node stores
  // `debit.rules` off this response verbatim (handleAuthorization, debitManager.ts:153-157).
  await rpc('RespondToDebit', {
    npub: refundPub,
    request_id: req.request_id,
    response: { type: 'authorize', authorize: { rules } },
  })
  console.log(`#   3. the account owner authorised it with a ${CAP_SATS} sat/day cap`)

  const answered = await budget
  if (!answered.ok) console.log(`#   (the budget request itself answered: code ${answered.code} — ${answered.error})`)
}

// --- verify against the node, never against what we just sent -------------------------------
const after = await grants()
const ours = after.find(g => g.npub === refundPub)
console.log('\n# debit grants on this account:')
describe(after)

if (!ours) throw new Error('the node does not report a grant for the refund key — nothing was granted')
if (!ours.authorized) throw new Error('the node reports the grant as banned')

const freq = JSON.stringify(ours.rules ?? [])
if (!freq.includes(String(CAP_SATS))) {
  throw new Error(`the node did not record a ${CAP_SATS} cap. It reports: ${freq}`)
}

// --- the pointer the watcher will use --------------------------------------------------------
// clink-debits.md:19-22 — ndebit TLVs: 0 node service pubkey, 1 relay, 2 optional pointer.
// Encoded with the reference implementation rather than by hand, same reasoning as
// ./authorize-manage.ts: /spike already depends on @shocknet/clink-sdk and this is a bech32
// checksum on the money path. NO TLV 3: a session k1 belongs to one interaction, and
// clink-debits.md:30-31 says a session ndebit "MUST NOT be published as a user's primary
// clink_debit". This is the static pointer; the per-refund k1 is derived at payment time from
// the settled invoice (./ndebit.ts `k1For`).
const ndebit = ndebitEncode({ pubkey: appPub, relay: relays[0]!, pointer })
writeFileSync(OUT_FILE, ndebit + '\n', { mode: 0o600 })

console.log(`
# GRANTED. The refund key may now pay invoices from this account, up to ${CAP_SATS} sats/day,
# until ${new Date((now + DAYS * 86_400) * 1000).toISOString()}, and may do nothing else.
#
# wrote the ndebit pointer to ${OUT_FILE}  (gitignored, chmod 600)
#   ${ndebit.slice(0, 24)}…${ndebit.slice(-6)}   ${ndebit.length} chars
#
# It carries the account pointer, so treat it like the pairing string: this machine only, never a
# relay, never a log, never this repo (/docs/spec.md §6.1).
#
# NEXT, and do this BEFORE any refund runs unattended:
#   node check-refund.ts        # proves the cap fires and BanDebit stops a payment. Costs NOTHING
#
# The kill switch, any time:
#   node authorize-refunds.ts --revoke`)

close()
process.exit(0)
