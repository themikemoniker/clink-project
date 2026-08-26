// M1's publish half: the availability ladder travels over a relay instead of a downloaded file.
//
// The shape is builder/src/notes.ts's, NIP-44 inside a kind 30078, and the recipient is not. The
// notes are encrypted to self because only the seller's browser ever reads them; here the
// *watcher* has to decrypt, and only a holder of the seller's private key could open a
// self-encrypted payload. It holds one today (`watch-sales.ts:148` reads `.dev-key`) purely
// because the fixture seller and the node account are one identity, a coincidence /docs/spec.md
// §12 says should be a separate key where possible. Encrypting to self would make it permanent.
//
// This costs NO new signer permission: `nip44_encrypt` (signer.ts:41) and `sign_event:30078`
// (signer.ts:49) have both been in PERMS since slice 4, precisely so neither slice 6's notes nor
// this would need a second bunker approval.
//
// It DOES cost one more signature per item, and `approvalCount` says so. The encryption is not a
// signature and is not counted: main.ts renders the number as "N signatures" and tells the seller
// their signer should ask once per kind, so the number has to mean signEvent calls.
import { decode } from 'nostr-tools/nip19'
import type { SimplePool } from 'nostr-tools/pool'
import type { VerifiedEvent } from 'nostr-tools/pure'
import { SALE_RELAYS } from '../../spike/fixture.ts'
import { LADDER_KIND, ladderD, MAX_LADDER_PLAINTEXT, type Rung } from '../../spike/ladder.ts'
import type { Signer } from './signer.ts'

/** Where the pasted watcher npub lives between sessions. Same namespace as signer.ts's two keys. */
export const WATCHER_KEY = 'lamppost.watcher'

/**
 * Read a pasted watcher pubkey, or refuse it.
 *
 * The builder learns this key by PASTE and not by discovery, and this function is the reason that
 * is safe to do. The builder must know which pubkey to trust *before* it encrypts, because
 * encrypting to an attacker's key hands them the lowest stock on every item in the sale, which is
 * exactly what the roadmap says must never become public. There is no signature to check here and
 * nothing to fall back on, so the only defence is refusing anything that is not a public key.
 *
 * Generating the keypair here instead is out under /CLAUDE.md rule 2: the watcher generates it,
 * prints its npub on first run, and a human carries it once. Same as `.nmanage` already works.
 */
export const watcherPubkey = (raw: string): string | undefined => {
  const trimmed = raw.trim()
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase()
  try {
    const { type, data } = decode(trimmed)
    // `type` matters as much as the checksum: an nsec pasted into this box decodes perfectly
    // well, and encrypting to it would be both wrong and the one paste error that puts a private
    // key in this field.
    return type === 'npub' ? data : undefined
  } catch {
    return undefined
  }
}

/**
 * Sign one item's ladder, encrypted to the watcher.
 *
 * Separate from publishing it so the whole payload can be proven without a relay: what a relay
 * adds is /spike/check-ladder-relay.ts's job, on demand and under a throwaway key.
 *
 * The payload is the existing `LadderFile` entry unchanged (publish.ts:47), so the same bytes are
 * on the relay as in the file. That is what makes the watcher's precedence a straight swap and
 * lets both paths share one parser instead of drifting into two.
 */
export const ladderEvent = async (
  signer: Signer,
  watcher: string,
  listingD: string,
  rung: Rung,
): Promise<VerifiedEvent> => {
  const plaintext = JSON.stringify(rung)
  // Refuse here rather than letting the watcher's bounded parse drop it silently later. The
  // watcher's refusal happens on another machine, hours on, and reads as "this item has no
  // ladder"; the seller is standing in front of this one. This is the NIP-44 plaintext ceiling,
  // the binding cap on the whole design and the reason it is one event per item.
  if (plaintext.length > MAX_LADDER_PLAINTEXT) {
    throw new Error(
      `${listingD}: this item's availability ladder is ${plaintext.length} bytes, over the ` +
        `${MAX_LADDER_PLAINTEXT}-byte encryption limit. Publish it with fewer photos or less stock.`,
    )
  }
  return signer.signEvent({
    kind: LADDER_KIND,
    created_at: Math.floor(Date.now() / 1000),
    // NIP-78 says nothing beyond the `d` tag, and nothing else may go here. Every tag on a nostr
    // event is public, and the entire point of this event is that its contents are not: the rungs
    // inside are signed public listings, and publishing them raw would advertise the lowest stock
    // on every item in the sale (/README.md, M1).
    tags: [['d', ladderD(listingD)]],
    content: await signer.nip44Encrypt(watcher, plaintext),
  })
}

/** Send it. Returns how many relays took it, the way `saveNotes` and the listing publish do. */
export const publishLadder = async (
  pool: SimplePool,
  event: VerifiedEvent,
  relays: string[] = SALE_RELAYS,
): Promise<number> => {
  const results = await Promise.allSettled(
    pool
      .publish(relays, event)
      .map(p => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000))])),
  )
  return results.filter(r => r.status === 'fulfilled').length
}
