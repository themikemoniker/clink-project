// Slice 6 — private shop notes. NIP-78 kind 30078, NIP-44 encrypted to the seller's own key.
//
// /docs/spec.md §6.2: cost basis, internal notes, restock reminders, buyer contact log. Never in
// a public listing tag. There is no new machinery here at all — the Signer already exposes
// `nip44Encrypt`/`nip44Decrypt` for an arbitrary pubkey, so encrypting to yourself is the same
// call with your own pubkey on both ends, and `sign_event:30078` has been in PERMS since slice 4
// precisely so this would not cost a second bunker approval.
//
// THE `d` TAG IS NOT `clink-*`, deliberately. CLINK Beacon reserves that prefix on kind 30078 —
// `clink-node`, `clink-node-operator`, `clink-node-operator-revoke`, "and future names"
// (clink-beacon.md:195, via /docs/clink-notes.md §6) — and the running Lightning.Pub still
// publishes its own beacon under the legacy `d = "Lightning.Pub"` (`nostrPool.ts:53`), so that
// name is spoken for too.
//
// ONE EVENT FOR THE WHOLE SHOP, not one per item. Saving any note is then one signature and one
// publish, and loading them is one query. The cost is that two browser tabs editing notes at
// once would have the last save win — which is a yard sale with one seller and one laptop, so it
// is not a race worth code. ponytail: if notes ever become multi-device, this splits into one
// addressable event per item keyed on the listing's `d`.
import type { SimplePool } from 'nostr-tools/pool'
import { SALE_RELAYS } from '../../spike/fixture.ts'
import type { Signer } from './signer.ts'

export const NOTES_KIND = 30078 // NIP-78 addressable application data
export const NOTES_D = 'lamppost-shop'

export type Notes = Record<string, string>

// Bounds on our own decrypted plaintext, because "our own" is only true until a relay hands us
// something that decrypts. Generous for a yard sale, small enough to stay a bound.
const MAX_PLAINTEXT = 64 * 1024
const MAX_ENTRIES = 500
export const MAX_NOTE = 2_000

/** Bounded parse of the decrypted blob. Never throws; a corrupt note map reads as no notes. */
export const parseNotes = (plaintext: string): Notes => {
  if (typeof plaintext !== 'string' || plaintext.length > MAX_PLAINTEXT) return {}
  let value: unknown
  try {
    value = JSON.parse(plaintext)
  } catch {
    return {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Notes = {}
  for (const [d, note] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ENTRIES)) {
    if (typeof note === 'string' && note.trim()) out[d.slice(0, 200)] = note.slice(0, MAX_NOTE)
  }
  return out
}

/**
 * The seller's notes, or none.
 *
 * Only the newest event matters — NIP-01 keeps one per (kind, pubkey, `d`) — but relays disagree
 * about which that is, so this takes the newest of whatever comes back rather than the first.
 * A note that will not decrypt is not an error worth showing: it means a different key wrote it.
 */
export const loadNotes = async (
  signer: Signer,
  pool: SimplePool,
  relays: string[] = SALE_RELAYS,
): Promise<Notes> => {
  const pubkey = await signer.getPublicKey()
  const events = await pool.querySync(relays, {
    kinds: [NOTES_KIND],
    authors: [pubkey],
    '#d': [NOTES_D],
  })
  const newest = events
    .filter(ev => ev.pubkey === pubkey && ev.content.length <= MAX_PLAINTEXT * 2)
    .sort((a, b) => b.created_at - a.created_at)[0]
  if (!newest) return {}
  try {
    return parseNotes(await signer.nip44Decrypt(pubkey, newest.content))
  } catch {
    return {}
  }
}

/** Write the whole note map back. One signature, whichever note changed. Returns relays that took it. */
export const saveNotes = async (
  signer: Signer,
  pool: SimplePool,
  notes: Notes,
  relays: string[] = SALE_RELAYS,
): Promise<number> => {
  const pubkey = await signer.getPublicKey()
  const event = await signer.signEvent({
    kind: NOTES_KIND,
    created_at: Math.floor(Date.now() / 1000),
    // NIP-78 says nothing beyond the `d` tag, and nothing else belongs here: every tag on a
    // nostr event is public, and the whole point of this event is that its content is not.
    tags: [['d', NOTES_D]],
    content: await signer.nip44Encrypt(pubkey, JSON.stringify(notes)),
  })
  const results = await Promise.allSettled(
    pool
      .publish(relays, event)
      .map(p => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000))])),
  )
  return results.filter(r => r.status === 'fulfilled').length
}
