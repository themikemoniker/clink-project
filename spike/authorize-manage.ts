// Slice 4 bootstrap: authorise the seller's own key to manage offers over CLINK Manage, and
// write the `nmanage1…` pointer the builder pastes in. Run this ONCE, at the desk, next to the
// node. After it, nothing else in the authoring path needs a raw key.
//
// WHY THIS SCRIPT HAS TO EXIST, and it is the thing slice 4's one-line description hides.
// The builder signs through a NIP-46 bunker. A bunker exposes get_public_key, sign_event,
// nip04_* and nip44_* — and nothing else. It does NOT expose raw ECDH. Lightning.Pub's native
// kind 21000 RPC is encrypted with the Pub's own v1 envelope: xchacha20 keyed on
// sha256(ECDH-x), `base64(0x01 ‖ nonce[24] ‖ ct)` (nostrPool.ts:110-114 and 176-190, via
// ./pub-rpc.ts). Deriving that key needs the private key itself, so **a bunker cannot speak
// kind 21000 at all.** Kind 21003 — CLINK Manage — takes the other branch of that same `if`
// and is NIP-44 v2, which a bunker signs and encrypts happily.
//
// So the transport choice in /docs/spec.md §14 was never really a choice once the Signer
// landed: Manage is not merely the portable path, it is the only offer-minting path a
// NIP-46 seller can drive. See /docs/spike-findings.md §14.
//
// The one thing Manage cannot bootstrap is its own grant. `validateGrantAccess`
// (managementManager.ts:254-273) needs a ManagementGrant row for every requestor, owner
// included (findings §13.4), and the only way to create one is `AuthorizeManage` — which is
// `auth_type = "User"` over kind 21000 (methods.proto:678-683). Hence: one raw-key call, once,
// here, rather than a raw key living in the browser forever.
//
// KEY HANDLING NOTICE — same /spike/.dev-key exception as mint-offers.ts, and the same reason
// it survives slice 4 (see /docs/status.md). This script needs the raw key precisely because a
// Signer cannot do this one call.
//
// Usage: node authorize-manage.ts [--nprofile <path|nprofile1…>] [--revoke]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils.js'
import { nmanageEncode } from '@shocknet/clink-sdk/build/nip19Extension.js'
import { arg, connectPub } from './pub-rpc.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = join(HERE, '.dev-key')
const OUT_FILE = join(HERE, '.nmanage')

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE} — run seed-listings.ts first`)
const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const pk = getPublicKey(sk)

const { appPub, relays, rpc, close } = connectPub(sk, arg('nprofile', join(homedir(), 'lightning_pub', 'app.nprofile')))
console.log(`# node app pubkey ${appPub.slice(0, 12)}… on ${relays.join(', ')}`)
console.log(`# authorising     ${nip19.npubEncode(pk)}`)

// The account pointer. `GetUserOffers` appends the default offer if it is missing, and the
// default offer is the one whose offer_id EQUALS the account's app_user_id
// (offerManager.ts:30 `default_offer: offer.app_user_id === offer.offer_id`; created that way
// at offerStorage.ts:11-16). That equality is the only way to read our own app_user_id back
// out of this API, and app_user_id is what CLINK Manage wants as its `pointer`.
//
// It is NEVER published. /docs/spec.md §6.1: the default offer's id IS the account pointer, and
// publishing it hands every visitor a channel to push authorization prompts at the seller. It
// goes to a gitignored file and into the seller's own browser, nowhere else — which is also why
// this script prints a truncated preview rather than the value.
type OfferConfig = { offer_id: string; default_offer: boolean }
const offers: OfferConfig[] = (await rpc('GetUserOffers', {})).offers ?? []
const pointer = offers.find(o => o.default_offer)?.offer_id
if (!pointer) throw new Error('no default offer on this account — cannot determine the account pointer')

// `authorize_npub` is a misnomer in the proto: the grant is stored as `app_pubkey`
// (managementStorage.ts:15) and matched against `event.pub`, which is a 64-char HEX pubkey
// (managementManager.ts:254 `validateGrantAccess(appUserId, requestorPub)`). Sending an
// `npub1…` here creates a grant that can never match anything.
type Grant = { manage_id: string; authorized: boolean; npub: string }

if (process.argv.includes('--revoke')) {
  await rpc('ResetManage', { npub: pk })
  console.log(`# revoked the manage grant for ${pk.slice(0, 12)}…`)
  close()
  process.exit(0)
}

// addGrant is CreateAndSave, not an upsert (managementStorage.ts:15) — running this twice would
// leave two rows. getGrant is a FindOne so it would still work, but check first anyway: this is
// the same reason mint-offers.ts matches on label before creating.
const before: Grant[] = (await rpc('GetManageAuthorizations', {})).manages ?? []
const existing = before.find(g => g.npub === pk)
if (existing?.authorized) {
  console.log(`# already authorised (manage_id ${existing.manage_id}) — leaving it alone`)
} else {
  const grant: Grant = await rpc('AuthorizeManage', { authorize_npub: pk, ban: false })
  if (!grant.authorized) throw new Error('node returned a banned grant')
  console.log(`# granted manage_id ${grant.manage_id}`)
}

// clink-manage.md:13-16 — nmanage TLVs: 0 wallet server pubkey, 1 relay, 2 optional pointer id.
// Encoded with the reference implementation rather than by hand: /spike already depends on
// @shocknet/clink-sdk, and this is a bech32 checksum on the money path (findings §13.14 rules
// the SDK out of the *storefront* bundle for size; a throwaway Node script has no such budget).
const nmanage = nmanageEncode({ pubkey: appPub, relay: relays[0]!, pointer })
writeFileSync(OUT_FILE, nmanage + '\n', { mode: 0o600 })

console.log(`
# wrote the nmanage pointer to ${OUT_FILE}  (gitignored, chmod 600)
#   ${nmanage.slice(0, 24)}…${nmanage.slice(-6)}   ${nmanage.length} chars
#
# Paste the whole line from that file into the builder's "seller's node" field:
#   cat ${OUT_FILE} | pbcopy
#
# It carries the account pointer, so treat it like the pairing string: seller's browser only,
# never a relay, never a log, never this repo (/docs/spec.md §6.1).`)
close()
process.exit(0)
