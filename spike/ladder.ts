// The availability ladder — slice 3's answer to the problem that is not in its one-line
// description: **republishing a kind 30402 means signing as the seller, and the watcher must
// not hold the seller's key** (/CLAUDE.md rule 2, /docs/spec.md §5). A listing's authority is
// its signature, so no substitute key can publish stock updates without breaking the trust the
// storefront depends on (/docs/spike-findings.md §11: identity comes from the listing
// signature, never from the payment pointer).
//
// The resolution: a yard-sale item has a *finite, knowable* set of future states. An item with
// stock 3 can only ever be 2, 1, or 0. So the seller signs all of them at publish time, in the
// same sitting that signs the listing, and the watcher holds no key at all — only a bundle of
// events the seller already signed. It publishes the right one when it sees money arrive.
//
// What that buys:
//   * The watcher's key material is *none*. Not "the narrowest credential" — none.
//   * A compromised watcher can publish only states the seller authorised. It cannot invent a
//     price, retitle an item, or resurrect a sold one (see the created_at note below).
//   * Signing happens at the desk, before the sale, not on a phone during it. That is why
//     spike question 8 (does a NIP-46 signer honour `perms` for arbitrary kinds?) no longer
//     gates this slice: a bunker-signing watcher would need one approval per sale, mid-yard-
//     sale. A pre-signed ladder needs none, whatever `perms` turns out to do.
//
// The ceiling, stated plainly: the ladder is cut from one version of the listing. Editing the
// price or the title mid-sale invalidates it, because a stale ladder step would republish the
// old text over the new. Re-run the seeder after any edit and the ladder is re-cut with it.
// ponytail: finite pre-signed ladder; if inventory becomes unbounded or mid-sale edits become
// routine, this becomes a NIP-46-signing watcher and q8 becomes blocking again.

// An item with no `stock` tag is one unit — that is what "for sale, then gone" means, and it
// is how storefront/src/listing.ts already reads it (`stock: undefined` = "the seller did not
// say", with `status` carrying the sold/not-sold answer).
export const unitsOf = (stock: string | undefined): number =>
  stock === undefined ? 1 : Number(stock)

// The listing's tags as they should read once `n` units remain. Both ways of saying sold move
// together: Gamma spec.md:124 `stock` is a count, NIP-99 99.md:43 `status` is active|sold, and
// storefront/src/listing.ts honours either — so leaving one behind would publish a listing that
// contradicts itself.
export const atStock = (tags: string[][], n: number): string[][] =>
  tags
    .map(t =>
      t[0] === 'stock' ? ['stock', String(n)]
      : t[0] === 'status' ? ['status', n === 0 ? 'sold' : 'active']
      : t,
    )
    // /docs/spec.md §7.4(a): a sold item's offer should not exist. The tag goes with it, so a
    // sold listing is not still advertising a payable pointer to a page that cached it.
    .filter(t => n > 0 || t[0] !== 'clink_offer')

// How many units remain, given how many settled invoices the node reports for this item's
// offer. Clamped at zero: overselling is real (/docs/spec.md §7.3) and is slice 7's refund to
// handle, not a reason to publish a negative stock tag.
export const targetStock = (units: number, settled: number): number =>
  Math.max(0, units - Math.max(0, settled))

/**
 * Has this ladder been superseded by a newer listing on the relays?
 *
 * Slice 6 made this question real. A rung's `created_at` is later than the listing it was cut
 * from, by construction — that is what makes availability monotone. Edit the item and the NEW
 * listing is later than every rung of the OLD ladder, which inverts the relationship the whole
 * mechanism rests on.
 *
 * The failure is silent, which is why it is worth a function and a test. A relay that already
 * holds a newer replaceable event still answers OK to an older one; it simply does not store it.
 * So the watcher publishes, counts a success, logs "3/4 relays" — and the item stays advertised
 * as available for the rest of the sale. That is an oversell with a clean log beside it.
 *
 * Equal is not stale: a sold-out item's live listing IS its own last rung. An item with no live
 * listing at all is not judged either — "the relay is down" must not read as "your ladder is
 * stale", because the remedy for one is waiting and the remedy for the other is re-publishing.
 */
export const isStale = (steps: { created_at: number }[], publishedAt: number | undefined): boolean =>
  publishedAt !== undefined && steps.reduce((n, s) => Math.max(n, s.created_at), 0) < publishedAt

/**
 * Which offer is this item's, from the ladder file alone.
 *
 * The offer id decides what the watcher polls for settlement, so getting it from the wrong place
 * is how an item sells without anybody noticing. Three sources, in descending order of authority:
 *
 *   1. **The ladder's own `noffer`**, written by whoever cut it — `builder/src/publish.ts` for an
 *      authored item, `seed-listings.ts` for a fixture one. Authoritative because it is written
 *      in the same breath as the rungs, from the same offer the listing advertises.
 *   2. **A rung's `clink_offer` tag.** Correct for anything with more than one unit, and it is
 *      what a pre-slice-6 ladder file has. It fails on exactly the common case: a one-of-a-kind
 *      item has a single rung, the stock-0 one, and `atStock` strips `clink_offer` there by
 *      design. That was a real oversell — the item sold, the watcher never watched it, and the
 *      storefront kept its Buy button (`/docs/known-defects.md`, closed 2026-08-21).
 *   3. **`.offers.json`**, which only `mint-offers.ts` writes and only for the fixture's items.
 *      Purely a compatibility fallback now.
 */
export const nofferOf = (
  rung: { noffer?: string; steps: { tags: string[][] }[] },
  fallback?: string,
): string | undefined =>
  rung.noffer ?? rung.steps.flatMap(step => step.tags).find(t => t[0] === 'clink_offer')?.[1] ?? fallback

// --- M1: the ladder travels over a relay instead of a USB stick (2026-09-25) -------------------
//
// Everything above is slice 3 and is about WHAT the watcher publishes. This is about how the
// ladder REACHES it, and it exists because every edit used to end at `builder/src/main.ts:366`
// telling the seller to save `.ladder.json` next to `watch-sales.ts` and restart the watcher.
// Restock is an edit, so that was every restock during a live sale. Miss the step and either
// `isStale` above refuses to watch the item, or the watcher publishes rungs the relay silently
// drops and the item stays on sale after it sold.
//
// THE RUNGS ARE NOT PUBLISHED RAW. They are signed public kind 30402s, so publishing them would
// immediately advertise the lowest stock on every item, and `publish.ts` already says the rungs
// exist "for the watcher and nowhere else". They are wrapped: NIP-44 inside a kind 30078, the
// shape `builder/src/notes.ts` already uses for private notes.
//
// ENCRYPTED TO THE WATCHER'S PUBKEY, NOT TO THE SELLER'S OWN KEY, and that is the one thing that
// differs from `notes.ts`. Notes are encrypt-to-self because only the seller's browser ever reads
// them. Here the WATCHER decrypts, and only a holder of the seller's private key can open a
// self-encrypted payload. `watch-sales.ts:115` holds one today purely because the fixture seller
// and the node account are one identity, which spec §12 says should be a separate key "where
// possible"; encrypting to self would turn that coincidence into a permanent requirement. So the
// recipient is a third key, `spike/.watcher-key`, which owns nothing, spends nothing and signs
// nothing. Its only power is decrypting ladders.
//
// WHAT THIS DOES NOT DO, said plainly because the project makes a nearby claim that must not blur:
// it does NOT make the watcher keyless. `.dev-key` is still the node observe credential. What
// slice 3 guarantees is narrower and is unchanged: the watcher signs no LISTING.
//
// THE TRUST CHAIN IS THREE LAYERS AND THE THIRD ALREADY EXISTS. The query filters
// `authors: [SELLER]` and nostr-tools verifies signatures, so only the seller's own 30078s arrive.
// NIP-44 decryption with (watcher private, seller public) succeeds only if the seller encrypted
// it. And `stepFor` in `watch-sales.ts` still verifies every rung independently before publishing
// it, under "Never publish an event on the strength of where it was loaded from." So the transport
// change costs no new trust work at the publish moment. The genuinely new surface is the bounded
// parse of the decrypted plaintext below, and `notes.ts` `parseNotes` is the pattern it copies:
// cap the plaintext, cap the entry count, cap each field, never throw, read a corrupt payload as
// no ladder.

/** NIP-78 addressable application data, the same kind `notes.ts` uses. */
export const LADDER_KIND = 30078

/**
 * The `d` tag for one item's ladder.
 *
 * ONE EVENT PER ITEM, not one for the whole shop, and that was settled by measurement rather than
 * preference (spec §9.5, reproduced from `spike/merida-fixture.ts`): the whole-shop ladder for an
 * 8-item sale is 57,741 bytes with photos, **88.1% of NIP-44's 65,535-byte plaintext ceiling**,
 * and the mean per item puts the ceiling at about 9 items, which is the same number the flyer
 * holds (design.md §3). Per item the fattest real item is `jabon` at 19,906 bytes, 30% of the
 * ceiling, so this leaves roughly 3.3x headroom on the worst case. The binding cap is NIP-44's
 * plaintext ceiling and not a relay's event size limit, which was measured 2026-08-23 at 131,072
 * on nos.lol and about a million on damus and primal.
 *
 * THE PREFIX COLLIDES WITH NEITHER of the two things that own names on this kind. CLINK Beacon
 * reserves `clink-*` (clink-beacon.md:195, via /docs/clink-notes.md §6) and the running
 * Lightning.Pub still publishes a legacy `d = "Lightning.Pub"` (`nostrPool.ts:53`); `notes.ts`
 * takes `lamppost-shop`.
 *
 * It takes the item's whole `d` rather than `(saleD, slug)`, which is a deviation from the M1
 * brief's table and is the same string either way: `builder/src/sale.ts:77` is
 * `listingD = (saleD, slug) => \`${saleD}-${slug}\``, and the watcher only ever has a `d` whole —
 * its ladder file is keyed by it. A two-argument version would make the watcher re-split a string
 * it never split, on a separator that lives in a file it cannot import.
 */
export const ladderD = (listingD: string): string => `lamppost-ladder-${listingD}`

/** One item's ladder: exactly `builder/src/publish.ts`'s `LadderFile` entry, unchanged. */
export type Rung = { units: number; noffer?: string; steps: LadderStep[] }

/**
 * A rung as it survives the bounded parse: structurally an event, semantically unjudged.
 *
 * Deliberately NOT `nostr-tools`' `Event`. Asserting that here would be a claim this parse cannot
 * make: nothing below checks a signature. `stepFor` is what verifies a rung, and it re-parses
 * stock and status out of the tags rather than trusting an index, so the authority stays in one
 * place and this type stays honest about being shaped rather than trusted.
 */
export type LadderStep = {
  id: string
  pubkey: string
  sig: string
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

// Bounds on a payload that decrypted, because "the seller wrote it" is only true until a relay
// hands us something that decrypts. MAX_PLAINTEXT is NIP-44's own plaintext ceiling, so anything
// over it could not have been a NIP-44 payload in the first place. MAX_STEPS follows the stock
// bound the builder already enforces (`builder/src/main.ts`: 0 to 999), plus one; the plaintext
// cap binds long before it on any real item, and it is here so a malformed `steps` cannot make us
// walk a million-element array before the size check would have caught it.
const MAX_PLAINTEXT = 65_535
const MAX_STEPS = 1_000
const MAX_TAGS = 100
const MAX_NOFFER = 2_000
const MAX_CONTENT = 8_000

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

/**
 * Bounded parse of one decrypted ladder payload. Never throws; anything wrong reads as no ladder.
 *
 * Returning null rather than throwing is the same choice `parseNotes` makes and it matters more
 * here: this runs inside the watcher's tick, and a throw would take down the process that is the
 * only thing republishing stock. A corrupt ladder must cost exactly one unwatched item, named in
 * the startup report, and nothing else.
 */
export const parseLadder = (plaintext: unknown): Rung | null => {
  if (typeof plaintext !== 'string' || plaintext.length > MAX_PLAINTEXT) return null
  let value: unknown
  try {
    value = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>

  // `units` decides which rung `stepFor` reaches for (`rung.steps[rung.units - target - 1]`), so a
  // float or a negative here would index into nothing and throw there instead of here.
  const { units, noffer, steps } = raw
  if (!Number.isSafeInteger(units) || (units as number) < 0 || (units as number) > MAX_STEPS) return null
  if (noffer !== undefined && (typeof noffer !== 'string' || noffer.length > MAX_NOFFER)) return null
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) return null

  const out: LadderStep[] = []
  for (const step of steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return null
    const s = step as Record<string, unknown>
    // `pubkey` is not optional and forgetting it is not cosmetic: `stepFor` re-verifies every
    // rung through `parseListings`, which cannot check a signature without it. A parse that
    // dropped it would hand the watcher rungs that fail verification on every tick, which is a
    // ladder that silently never publishes. Found by this file's own round-trip test.
    if (typeof s.id !== 'string' || typeof s.pubkey !== 'string' || typeof s.sig !== 'string') return null
    if (typeof s.kind !== 'number' || !Number.isSafeInteger(s.kind)) return null
    if (!Number.isSafeInteger(s.created_at)) return null
    if (typeof s.content !== 'string' || s.content.length > MAX_CONTENT) return null
    if (!Array.isArray(s.tags) || s.tags.length > MAX_TAGS || !s.tags.every(isStringArray)) return null
    out.push({
      id: s.id,
      pubkey: s.pubkey,
      sig: s.sig,
      kind: s.kind,
      created_at: s.created_at,
      tags: s.tags as string[][],
      content: s.content,
    })
  }
  // A ladder whose step count disagrees with its own `units` is the shape `stepFor` would throw
  // on, one tick at a time, for the rest of the sale. Refuse it once, here.
  if (out.length !== units) return null
  return { units: units as number, noffer: noffer as string | undefined, steps: out }
}

/** Where a watched item's ladder came from, and whether the choice was made blind. */
export type LadderChoice = { rung: Rung | null; source: 'relay' | 'file' | 'none'; degraded: boolean }

/**
 * Precedence, per item: the relay wins when it decrypts, the file is the cold-start fallback.
 *
 * Pure, and separate from every relay call, because the branch that matters most cannot be
 * arranged on demand: `relayFailed` is the case `watch-sales.ts:204` already writes the rule for —
 * *"the relay is down" must not read as "your ladder is stale"*. The remedy for one is waiting and
 * the remedy for the other is re-publishing, so conflating them sends the seller to fix the wrong
 * thing. Hence `degraded`, which is what makes the warning loud rather than a log line.
 *
 * KEEP THE FILE. Do not delete it. It is what a watcher starts from when the relays are
 * unreachable, and M1 removes the copy-and-restart rather than the file.
 *
 * The contradictory input is handled rather than assumed away: a failed read that nonetheless
 * produced a decrypted ladder yields an authentic rung (NIP-44 with the seller's pubkey is what
 * authenticated it), but the read may have been partial, so the file still wins when there is one
 * and the relay's copy is used only when there is not. Either way `degraded` is true, because
 * nothing here knows how much of the read was missing.
 */
export const chooseLadder = (relay: Rung | null, file: Rung | null, relayFailed: boolean): LadderChoice => {
  if (relayFailed) {
    if (file) return { rung: file, source: 'file', degraded: true }
    if (relay) return { rung: relay, source: 'relay', degraded: true }
    return { rung: null, source: 'none', degraded: true }
  }
  if (relay) return { rung: relay, source: 'relay', degraded: false }
  if (file) return { rung: file, source: 'file', degraded: false }
  return { rung: null, source: 'none', degraded: false }
}
