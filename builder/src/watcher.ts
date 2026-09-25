// M1 — the ladder travels over a relay instead of a USB stick.
//
// Before this, every publish ended at `main.ts` telling the seller to save `.ladder.json` next to
// `watch-sales.ts` and restart the watcher. Restock is an edit, so that was every restock during a
// live sale. Miss the step and either the watcher's `isStale` refuses to watch the item, or it
// publishes rungs the relay silently drops and the item stays on sale after it sold. The ladder
// also lived in `localStorage` keyed by pubkey, so a seller who edited from a second device
// produced a file that blinded the watcher to every item that device never published.
//
// The shape is `notes.ts`'s — NIP-44 inside a kind 30078 — and the reasoning about why the `d` tag
// is not `clink-*` is there too. What differs is the RECIPIENT: notes are encrypted to the
// seller's own key because only the seller's browser reads them, and a ladder is encrypted to the
// WATCHER's key because the watcher is what decrypts it. Only a holder of the seller's private key
// can open a self-encrypted payload, and the watcher must not need one. The kind, the `d` scheme
// and the bounded parse all live in `spike/ladder.ts`, shared with the watcher so there is one
// answer rather than two.
//
// IT COSTS NO NEW SIGNER PERMISSION. `sign_event:30078` (`signer.ts:49`) and `nip44_encrypt`
// (`:41`) have been in `PERMS` since slice 4, precisely so this would not need a second bunker
// approval. It DOES cost one extra signature per item publish, and `approvalCount` says so.
//
// THE PUBKEY ARRIVES BY PASTE, NOT BY DISCOVERY, and that is a security property rather than
// laziness. The builder has to know which pubkey to trust BEFORE it encrypts, and encrypting to an
// attacker's key hands them the lowest stock on every item in the sale. Generating the keypair
// here is out under /CLAUDE.md rule 2. So the watcher prints its npub on first run and a human
// carries it once, the way `.nmanage` already works.
// `nostr-tools/nip19`, NOT the `nostr-tools` barrel. Measured 2026-09-25: the barrel import
// pulled the whole library into the bundle and took the builder from 60.62 to 77.86 KB gzip,
// +17 KB for one function, on a page that renders from a cold gateway cache where /CLAUDE.md
// says every KB is a blob fetch. `deploy.ts:17` already imports from this submodule; every
// other file here imports `nostr-tools/pool` or `nostr-tools/pure` for the same reason.
import { decode } from 'nostr-tools/nip19'
import { SimplePool } from 'nostr-tools/pool'
import type { Event } from 'nostr-tools/pure'
import { LADDER_KIND, ladderD, type Rung } from '../../spike/ladder.ts'
import { SALE_RELAYS } from '../../spike/fixture.ts'
import type { Signer } from './signer.ts'

export const WATCHER_STORAGE_KEY = 'lamppost.watcher'

/**
 * The watcher's pubkey as hex, or null if that is not an npub.
 *
 * NPUB ONLY, DELIBERATELY, even though everything downstream wants hex. An npub is bech32 with a
 * checksum, and a raw 64-character hex string is not: a single mistyped character in hex is a
 * valid-looking pubkey belonging to nobody, and the failure it produces is a ladder the watcher
 * cannot decrypt, discovered during a sale. The checksum turns that into an error at paste time.
 * It is the same reason `authorize_npub` wanting hex is recorded as a trap in `/docs/status.md`
 * rather than accepted quietly.
 *
 * Pure, so every branch is testable without a browser or a relay.
 */
export const watcherPubkey = (input: string): string | null => {
  const trimmed = input.trim()
  if (!trimmed.startsWith('npub1')) return null
  try {
    const decoded = decode(trimmed)
    return decoded.type === 'npub' ? decoded.data : null
  } catch {
    return null
  }
}

/**
 * Wrap one item's ladder for the watcher and publish it. Returns how many relays took it.
 *
 * The payload is the existing `LadderFile` entry unchanged, `{units, noffer?, steps}`, so the same
 * bytes travel over the relay as sat in the file and there is one parser rather than two.
 *
 * The rungs are NOT published raw anywhere: they are signed public kind 30402s carrying later
 * `created_at`s than the listing, so publishing the sold-out one would mark the item sold
 * immediately. That is why they are wrapped, and it is the same reason `publish.ts` publishes the
 * listing alone.
 */
export const publishLadder = async (
  signer: Signer,
  watcher: string,
  d: string,
  rung: Rung,
  pool: SimplePool = new SimplePool(),
  relays: string[] = SALE_RELAYS,
): Promise<number> => {
  const event = await signer.signEvent({
    kind: LADDER_KIND,
    created_at: Math.floor(Date.now() / 1000),
    // Only the `d` tag. Every tag on a nostr event is public, and the entire point of this event
    // is that its content is not: a `p` tag naming the watcher would publish who watches this
    // shop, which is exactly the correlation the encryption is for.
    tags: [['d', ladderD(d)]],
    content: await signer.nip44Encrypt(watcher, JSON.stringify(rung)),
  })
  const results = await Promise.allSettled(
    pool
      .publish(relays, event as Event)
      .map(p => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000))])),
  )
  return results.filter(r => r.status === 'fulfilled').length
}
