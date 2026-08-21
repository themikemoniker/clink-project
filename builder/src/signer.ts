// The Signer. /CLAUDE.md rule 2: nothing in this codebase touches a private key except this
// module — and in the two paths below, neither does this module. A NIP-07 extension and a
// NIP-46 bunker both hold the key somewhere we cannot reach; we hand them an unsigned event and
// get a signed one back.
//
// /docs/spec.md §5 asks for one interface with every path behind it. nostr-tools 2.24.3 already
// declares it (`lib/types/signer.d.ts`: getPublicKey + signEvent) and `BunkerSigner` already
// implements it plus nip44Encrypt/nip44Decrypt, which is exactly §5's optional pair. A NIP-07
// `window.nostr` has the same four members with `nip44` nested one level down. So this file is
// the ~40 lines of glue that make those two the same type, and not an abstraction of our own.
//
// WHAT A BUNKER CANNOT DO, because it decides slice 4's whole transport choice: NIP-46 exposes
// get_public_key, sign_event, nip04_* and nip44_* and nothing else. There is no raw-ECDH method.
// Lightning.Pub's native kind 21000 RPC is keyed on sha256 of the ECDH x-coordinate, so a
// bunker-held key cannot speak it at all. CLINK Manage (kind 21003) is NIP-44 v2 and it can.
// See ./manage.ts and /spike/authorize-manage.ts.
import { BunkerSigner, createNostrConnectURI, parseBunkerInput, toBunkerURL } from 'nostr-tools/nip46'
import { generateSecretKey, getPublicKey, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

export type Signer = {
  getPublicKey(): Promise<string>
  signEvent(event: EventTemplate): Promise<VerifiedEvent>
  nip44Encrypt(pubkey: string, plaintext: string): Promise<string>
  nip44Decrypt(pubkey: string, ciphertext: string): Promise<string>
  label: string
  close(): Promise<void>
}

// Every kind this project asks a signer to sign, enumerated, because there is no "all kinds":
// Amber drops any `sign_event` perm carrying no kind (NostrConnectUtils.kt:128), and a kind
// left out of this string costs one extra prompt the first time it appears — then is
// remembered, because both Amber and nsec.app key a grant on (app, type, kind).
// /docs/spike-findings.md §8.
//
// 21003 is here and is NOT in the string /docs/spec.md §5 and findings §8 published: those
// predate slice 4, when nothing signed a CLINK event as the seller. The builder mints offers
// over CLINK Manage, which is a signed kind 21003, so leaving it out costs a prompt mid-demo.
export const PERMS = [
  'get_public_key',
  'nip44_encrypt',
  'nip44_decrypt',
  'sign_event:30402', // NIP-99 listing, and every rung of its availability ladder
  'sign_event:30405', // the sale collection
  'sign_event:21003', // CLINK Manage — mint the item's offer
  'sign_event:15128', // NIP-5A site manifest (slice 5)
  'sign_event:10063', // BUD-03 Blossom server list (slice 5)
  'sign_event:24242', // BUD-11 upload auth, one per blob
  'sign_event:30078', // NIP-78 private shop state (slice 6)
]

const CLIENT_KEY = 'lamppost.client-key'
const BUNKER_URI = 'lamppost.bunker'

const METADATA = { name: 'Lamppost', url: location.origin }

// A NIP-46 grant is keyed to the CLIENT's pubkey, not the seller's. Minting a fresh client key
// per page load would make the seller re-approve the connection every single session — so it
// is generated once and kept. findings §8, last paragraph.
//
// This IS a private key in localStorage, and it is the one place this project keeps one. It
// signs nothing but NIP-46 envelopes to the bunker: it is not the seller's identity, it holds
// no funds, and burning it costs one re-approval. Losing the distinction is how "no key
// handling outside the Signer" quietly becomes untrue, so: it lives here, it never leaves, and
// nothing else in the builder imports it.
const clientKey = (): Uint8Array => {
  const stored = localStorage.getItem(CLIENT_KEY)
  if (stored && /^[0-9a-f]{64}$/.test(stored)) return hexToBytes(stored)
  const sk = generateSecretKey()
  localStorage.setItem(CLIENT_KEY, bytesToHex(sk))
  return sk
}

/** Forget the bunker session. The client key survives, so reconnecting to the same bunker is
 *  still one approval rather than a fresh grant. */
export const forgetBunker = () => localStorage.removeItem(BUNKER_URI)

// --- NIP-07 -------------------------------------------------------------------------------
// nostr-tools' own WindowNostr type (lib/types/nip07.d.ts): getPublicKey, signEvent, and
// OPTIONAL nip04/nip44 objects. The optionality is load-bearing — an extension without nip44
// can sign a listing but cannot mint an offer over CLINK Manage, and finding that out at the
// publish step rather than the connect step is a bad half-published sale.
type WindowNostr = {
  getPublicKey(): Promise<string>
  signEvent(event: EventTemplate): Promise<VerifiedEvent>
  nip44?: { encrypt(pubkey: string, plaintext: string): Promise<string>; decrypt(pubkey: string, ciphertext: string): Promise<string> }
}

export const hasNip07 = () => typeof (window as { nostr?: WindowNostr }).nostr?.signEvent === 'function'

export const connectNip07 = async (): Promise<Signer> => {
  const nostr = (window as { nostr?: WindowNostr }).nostr
  if (!nostr) throw new Error('No NIP-07 extension found. Install Alby or nos2x, or use a bunker.')
  if (!nostr.nip44) {
    throw new Error(
      'This extension does not expose nip44. Minting an item’s offer needs it — CLINK Manage is NIP-44 encrypted. Use a NIP-46 bunker instead.',
    )
  }
  const nip44 = nostr.nip44
  await nostr.getPublicKey() // provoke the extension's permission prompt now, not mid-publish
  return {
    label: 'NIP-07 extension',
    getPublicKey: () => nostr.getPublicKey(),
    signEvent: e => nostr.signEvent(e),
    nip44Encrypt: (pk, text) => nip44.encrypt(pk, text),
    nip44Decrypt: (pk, ct) => nip44.decrypt(pk, ct),
    close: async () => {},
  }
}

// --- NIP-46 -------------------------------------------------------------------------------
const wrap = (bunker: BunkerSigner, label: string): Signer => ({
  label,
  getPublicKey: () => bunker.getPublicKey(),
  signEvent: e => bunker.signEvent(e),
  nip44Encrypt: (pk, text) => bunker.nip44Encrypt(pk, text),
  nip44Decrypt: (pk, ct) => bunker.nip44Decrypt(pk, ct),
  close: () => bunker.close(),
})

/** Paste a `bunker://…` URL or a `name@domain` NIP-05 the bunker advertises. The seller's
 *  signer initiated this one, so `perms` are not part of the URL — the bunker asks per kind and
 *  remembers, which is the 5-prompt path in findings §8, not the 33-prompt one. */
export const connectBunkerURL = async (input: string): Promise<Signer> => {
  const bp = await parseBunkerInput(input.trim())
  if (!bp) throw new Error('That is not a bunker:// URL or a NIP-05 a bunker answers for.')
  const bunker = BunkerSigner.fromBunker(clientKey(), bp)
  await bunker.connect()
  localStorage.setItem(BUNKER_URI, input.trim())
  return wrap(bunker, 'NIP-46 bunker')
}

/** The other direction, and the one that costs ONE approval: we generate a `nostrconnect://`
 *  URI carrying PERMS, the seller scans it with Amber (or pastes it into nsec.app), and the
 *  signer grants every kind at connect time.
 *
 *  The residual risk is a UI one and it is worth telling the seller about, because it looks
 *  like `perms` is unsupported: Amber's "Approve basic actions" sign policy DISCARDS the
 *  requested perms and installs its basic bundle instead, with no error (AmberUtils.kt:196-247,
 *  findings §8). None of this project's kinds are in that bundle, so the symptom is a prompt
 *  per kind rather than a failure. The default policy is the one that honours perms. */
export const bunkerConnectURI = (relays: string[], secret: string) =>
  createNostrConnectURI({ clientPubkey: getPublicKey(clientKey()), relays, secret, perms: PERMS, ...METADATA })

export const awaitBunkerScan = async (uri: string, signal: AbortSignal): Promise<Signer> => {
  const bunker = await BunkerSigner.fromURI(clientKey(), uri, {}, signal)
  // Store the resolved pointer, not the nostrconnect URI: that one carries a one-shot `secret`
  // and is spent. toBunkerURL is nostr-tools' own serialiser for the pointer we ended up with.
  localStorage.setItem(BUNKER_URI, toBunkerURL(bunker.bp))
  return wrap(bunker, 'NIP-46 bunker')
}

/** Reconnect on load if a previous session left a bunker URL behind. Never throws — a signer
 *  that will not answer is a connect screen, not a crash. */
export const resumeBunker = async (): Promise<Signer | null> => {
  const saved = localStorage.getItem(BUNKER_URI)
  if (!saved) return null
  try {
    return await connectBunkerURL(saved)
  } catch {
    return null
  }
}
