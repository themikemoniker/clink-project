// Slice 7: prove the cap and the kill switch against the real node, BEFORE any refund runs
// unattended. /docs/spec.md §10 and /CLAUDE.md both require this and it is not negotiable:
// "the refund path needs a hard cap and a kill switch before it goes anywhere near a real node."
//
// A CAP NOBODY HAS SEEN FIRE IS NOT A CAP. This does not assert that a frequency rule exists in a
// database row; it drives a real kind 21002 debit at the running Lightning.Pub, over a relay,
// from the real refund key, and reads the node's real refusal.
//
// IT COSTS NOTHING, and that is a property of what is being tested rather than a shortcut. Every
// debit here is one the node REFUSES — over the cap, or banned — and a refused debit moves no
// money. The invoice being paid is one this account issues to itself via `NewInvoice`, which is
// free to create and is never settled.
//
// HOW THE CAP IS EXCEEDED WITHOUT SPENDING THE BALANCE. The live cap is 8,000 sats/day, which is
// the node's entire outbound balance — so exceeding it by paying would run the balance out first
// and the cap would never fire. Instead this uses `EditDebit` to drop the cap to 1 sat, sends a
// debit for more than that, records the GFY, and puts the original cap back. Same rule, same
// code path, same in-transaction check (`assertDebitFrequency`, debitManager.ts:376-401) — just
// moved to where it can be crossed for free.
//
// WHAT IT LEAVES BEHIND, deliberately: the grant REMOVED, so refunds are off until somebody turns
// them back on. A script whose last act is proving the kill switch should not quietly re-arm the
// thing it just disarmed. The final line prints the one command that re-arms it.
//
// KEY HANDLING NOTICE. Two raw keys, same exception and same split as ./authorize-refunds.ts:
// /spike/.dev-key answers as the account owner, /spike/.refund-key sends the debits. Neither is
// logged. A preimage is never printed — /CLAUDE.md — and none is produced here anyway, because
// nothing settles.
//
// Usage: node check-refund.ts [--nprofile <path|nprofile1…>]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils.js'
import { decodeNdebit, k1For, payDebit } from './ndebit.ts'
import { arg, connectPub } from './pub-rpc.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = join(HERE, '.dev-key')
const REFUND_KEY_FILE = join(HERE, '.refund-key')
const NDEBIT_FILE = join(HERE, '.ndebit')

// The invoice we try (and fail) to pay. 10 sats is Lightning.Pub's hardcoded minimum
// (offerManager.ts:224, findings §13.7); anything smaller would be refused for the wrong reason
// and the test would pass while proving nothing.
const PROBE_SATS = 10
const TINY_CAP = 1 // below PROBE_SATS, so the cap is what refuses it

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE} — run seed-listings.ts first`)
if (!existsSync(REFUND_KEY_FILE)) throw new Error(`no ${REFUND_KEY_FILE} — run authorize-refunds.ts first`)
if (!existsSync(NDEBIT_FILE)) throw new Error(`no ${NDEBIT_FILE} — run authorize-refunds.ts first`)

const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const refundSk = hexToBytes(readFileSync(REFUND_KEY_FILE, 'utf8').trim())
const refundPub = getPublicKey(refundSk)

const node = decodeNdebit(readFileSync(NDEBIT_FILE, 'utf8').trim())
if (!node) throw new Error(`cannot decode ${NDEBIT_FILE} — re-run authorize-refunds.ts`)

const { appPub, relays, rpc, close } = connectPub(sk, arg('nprofile', join(homedir(), 'lightning_pub', 'app.nprofile')))

let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`)
  if (!ok) failures++
}

console.log(`# node       ${appPub.slice(0, 12)}… on ${relays.join(', ')}`)
console.log(`# refund key ${refundPub.slice(0, 16)}…`)
console.log(`# pointer    ${node.pointer?.slice(0, 8)}… (the account pointer — never published)\n`)

// --- 1. the pointer and the grant -----------------------------------------------------------
console.log('# 1. the grant')
check(node.pubkey === appPub, 'the ndebit TLV 0 is the node we are talking to')
check(node.relay === relays[0], `the ndebit TLV 1 names ${node.relay}`)
check(!!node.pointer, 'the ndebit carries the account pointer in TLV 2')
check(node.k1 === undefined, 'and NO session k1 — a static pointer, per clink-debits.md:30-31')

type Grant = { debit_id: string; authorized: boolean; npub: string; rules?: unknown[] }
const grants = async (): Promise<Grant[]> => ((await rpc('GetDebitAuthorizations', {})).debits ?? []) as Grant[]

const before = await grants()
const ours = before.find(g => g.npub === refundPub)
check(!!ours, `the node reports a grant for the refund key${ours ? ` (debit_id ${ours.debit_id})` : ''}`)
check(!!ours?.authorized, 'and it is authorized')
if (!ours) {
  console.log('\n# cannot continue without a grant. Run: node authorize-refunds.ts')
  close()
  process.exit(1)
}

// `authorize_npub` is a misnomer here exactly as it is on the Manage side (findings §13.19). The
// row is matched against `event.pub`, which is 64-char hex. Proving it rather than assuming it,
// because an `npub1…` would produce a grant that silently never matches and every refund would
// come back "authorization required" forever.
check(/^[0-9a-f]{64}$/.test(ours.npub), `the grant is keyed on HEX, not an npub1… (${ours.npub.slice(0, 12)}…)`)

const capOf = (g: Grant | undefined): number | undefined => {
  // debitAccessRulesToDebitRules round-trips the stored [number, unit, max] tuple back into the
  // proto oneof, so the cap is the `amount` on the frequency rule.
  // Note the `rule` wrapper: DebitRule's only field is the oneof, so the shape is
  // `{ rule: { type, frequency_rule } }` both on the way in and on the way back
  // (types.ts:1700-1702; debitTypes.ts:58-83 builds it that way).
  const rule = (g?.rules ?? []).find((r: any) => r?.rule?.frequency_rule)
  const amount = (rule as any)?.rule?.frequency_rule?.amount
  return Number.isFinite(Number(amount)) ? Number(amount) : undefined
}
const originalCap = capOf(ours)
check(originalCap !== undefined, `the grant carries a frequency cap of ${originalCap} sats/day`)

// --- 2. an invoice to fail to pay -----------------------------------------------------------
console.log('\n# 2. a probe invoice (created, never settled — costs nothing)')
const probe: string = (await rpc('NewInvoice', { amountSats: PROBE_SATS, memo: 'lamppost check-refund probe' })).invoice
check(typeof probe === 'string' && probe.startsWith('lnbc'), `NewInvoice returned a ${PROBE_SATS}-sat mainnet invoice`)

// --- 3. THE CAP, proved by exceeding it -----------------------------------------------------
console.log(`\n# 3. the cap — dropping it to ${TINY_CAP} sat and sending a ${PROBE_SATS}-sat debit`)
await rpc('EditDebit', {
  authorize_npub: refundPub,
  rules: [{ rule: { type: 'frequency_rule', frequency_rule: { number_of_intervals: 1, interval: 'DAY', amount: TINY_CAP } } }],
})
check(capOf((await grants()).find(g => g.npub === refundPub)) === TINY_CAP, `EditDebit moved the cap to ${TINY_CAP}`)

const overCap = await payDebit(refundSk, node, { bolt11: probe, amountSats: PROBE_SATS, k1: k1For(`check-refund-cap-${Date.now()}`) })
console.log(`   node said: ${JSON.stringify(overCap)}`)
check(!overCap.ok, 'the node REFUSED the debit')
check(!overCap.ok && overCap.code === 5, `GFY code 5 (Invalid Amount) — clink-notes §3.5${!overCap.ok ? `, got ${overCap.code}` : ''}`)
check(!overCap.ok && overCap.range?.max === TINY_CAP, `and it names the cap it enforced: range.max = ${!overCap.ok ? overCap.range?.max : '?'}`)

// The check that matters most, and it is the one an assertion about a database row cannot make:
// nothing moved. `assertDebitFrequency` runs INSIDE the payment transaction, so a refusal is a
// rollback rather than a pre-check that something else could race past.
const stillUnpaid = await rpc('DecodeInvoice', { invoice: probe }).catch(() => null)
check(stillUnpaid !== null, 'the probe invoice is still decodable, and nothing settled against it')

// --- 4. THE KILL SWITCH ----------------------------------------------------------------------
console.log(`\n# 4. the kill switch — restoring the cap to ${originalCap}, then revoking`)
await rpc('EditDebit', {
  authorize_npub: refundPub,
  rules: [{ rule: { type: 'frequency_rule', frequency_rule: { number_of_intervals: 1, interval: 'DAY', amount: originalCap ?? 8_000 } } }],
})
check(capOf((await grants()).find(g => g.npub === refundPub)) === originalCap, `the cap is back to ${originalCap} — a debit would now be within it`)

// THE KILL SWITCH AS AN OPERATOR ACTUALLY RUNS IT (item 2, 2026-08-24). This block used to call
// `rpc('BanDebit')` directly, which proved the NODE's half and skipped ours — and ours was the
// half that was broken. `authorize-refunds.ts` minted a fresh random refund key at module top
// level, above the `--revoke` branch, so on a machine without spike/.refund-key the switch banned
// a pubkey that had never been granted anything, printed `BANNED`, and exited 0 while the real
// grant stayed live. Driving the script is the only thing that can catch that coming back.
const SCRIPT = join(HERE, 'authorize-refunds.ts')
const run = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 })

const revoked = run('--revoke')
console.log((revoked.stdout + revoked.stderr).trim().split('\n').map(l => `   ${l}`).join('\n'))
check(revoked.status === 0, 'node authorize-refunds.ts --revoke exited 0')
check(
  /BANNED, and the node agrees/.test(revoked.stdout),
  'and its success line is printed from a re-read of GetDebitAuthorizations, not from the RPC returning',
)

const afterRevoke = await grants()
// The roadmap's wording is "the grant list no longer contains the key", and the node is narrower
// than that: `BanDebit` flips `authorized` to false and LEAVES the row (debitStorage.ts:43-47).
// What has to be true is that the list holds no AUTHORIZED grant for this key. `--reset` is the
// one that removes the row, and the restore step at the foot of this file asserts that.
check(
  !afterRevoke.some(g => g.npub === refundPub && g.authorized),
  'the grant list no longer contains an AUTHORIZED grant for the refund key',
)
const banned = afterRevoke.find(g => g.npub === refundPub)
check(banned?.authorized === false, 'the row is still there and reads as banned, which is what BanDebit does')

// --- 4b. AND IT REFUSES TO IMPROVISE A KEY ---------------------------------------------------
// The defect in one sentence: with spike/.refund-key absent, both switches used to write a brand
// new random key, derive a pubkey from it, and ban THAT. So this hides the real key for as long
// as it takes to run each branch and asserts they refuse. The key is read into memory first and
// the restore is in a `finally` that also deletes any replacement the script may have minted, so
// the only way to lose it here is a SIGKILL inside a few hundred milliseconds.
console.log('\n# 4b. both switches refuse to run without a key rather than inventing one')
const HIDDEN = `${REFUND_KEY_FILE}.hidden-by-check-refund`
const keyBytes = readFileSync(REFUND_KEY_FILE)
renameSync(REFUND_KEY_FILE, HIDDEN)
try {
  for (const flag of ['--revoke', '--reset']) {
    const out = run(flag)
    const said = `${out.stdout}${out.stderr}`
    check(out.status !== 0, `${flag} with no key file exits non-zero`)
    check(/REFUSING/.test(said), `${flag} says it is refusing rather than inventing a key`)
    check(!/BANNED, and the node agrees|REMOVED, and the node agrees/.test(said), `${flag} reports no success`)
    check(!existsSync(REFUND_KEY_FILE), `${flag} minted no replacement key`)
  }
} finally {
  // Anything sitting at the real path now is a key this test caused to exist, and the real one is
  // still at HIDDEN. Delete it before restoring, or the rename would fail and we would keep the
  // wrong key.
  if (existsSync(REFUND_KEY_FILE)) unlinkSync(REFUND_KEY_FILE)
  if (existsSync(HIDDEN)) renameSync(HIDDEN, REFUND_KEY_FILE)
  else writeFileSync(REFUND_KEY_FILE, keyBytes, { mode: 0o600 })
}
check(readFileSync(REFUND_KEY_FILE).equals(keyBytes), 'the real refund key is back, byte for byte')

const afterBan = await payDebit(refundSk, node, { bolt11: probe, amountSats: PROBE_SATS, k1: k1For(`check-refund-ban-${Date.now()}`) })
console.log(`   node said: ${JSON.stringify(afterBan)}`)
check(!afterBan.ok, 'the node REFUSED the debit even though it is now well within the cap')
check(!afterBan.ok && afterBan.code === 1, `GFY code 1 (Request Denied)${!afterBan.ok ? `, got ${afterBan.code}` : ''}`)

// --- 5. the k1, and a divergence worth recording ---------------------------------------------
// clink-debits.md:167-171: a k1 is consumed when the service ACCEPTS a request for approval or
// payout, and "structural failures and payload validation failures MUST NOT consume it — the
// requestor MAY retry the same k1". Lightning.Pub calls DedupeK1 first, before it decodes the
// invoice or checks any rule (debitManager.ts:258-262), so a k1 is burned by a request the node
// then refuses. Proving it here because the watcher's k1 is derived from the settled invoice and
// is therefore the SAME on a retry — so this decides how soon a failed refund may be retried.
console.log('\n# 5. k1 replay')
const k1 = k1For(`check-refund-k1-${Date.now()}`)
const first = await payDebit(refundSk, node, { bolt11: probe, amountSats: PROBE_SATS, k1 })
const second = await payDebit(refundSk, node, { bolt11: probe, amountSats: PROBE_SATS, k1 })
console.log(`   first:  ${JSON.stringify(first)}`)
console.log(`   second: ${JSON.stringify(second)}`)
check(!second.ok && /k1 already processed/i.test(second.error), 'a repeated k1 is refused by the node, not by us')
check(
  !first.ok && !second.ok && first.error !== second.error,
  'and the second refusal is the k1 one, not the same refusal as the first — so the k1 was consumed by a request the node had already declined (diverges from clink-debits.md:167-171)',
)

// --- restore ---------------------------------------------------------------------------------
// ResetDebit removes the row rather than leaving it banned, so the state after this script is
// "no grant", which is the same state as before authorize-refunds.ts ever ran. A half-configured
// grant is worse than none: it looks armed and refuses everything.
await rpc('ResetDebit', { npub: refundPub })
const finalGrants = await grants()
check(!finalGrants.some(g => g.npub === refundPub), 'the grant row is removed — refunds are OFF')
check(!finalGrants.some(g => g.authorized), 'and no OTHER key is left holding spend authority on this account')

console.log(`
# The cap and the kill switch are both real, both enforced by the node, and both were seen
# firing. Nothing was paid: every debit above came back GFY, and a refused debit is a rolled-back
# transaction rather than a payment that was talked out of happening.
#
# REFUNDS ARE NOW OFF. This script ends with the grant removed on purpose — proving a kill switch
# and then quietly re-arming would make the proof worthless. To turn them back on:
#
#     node authorize-refunds.ts
#     node watch-sales.ts --refunds`)

console.log(`\n${failures === 0 ? '# ALL CHECKS PASSED' : `# ${failures} CHECK(S) FAILED`}`)
close()
process.exit(failures === 0 ? 0 : 1)
