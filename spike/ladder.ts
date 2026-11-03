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
// `validateEvent` is the only value import, and nostr-tools is `"sideEffects": false`, so it shakes.
import { validateEvent, type Event } from 'nostr-tools/pure'

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


// ---------------------------------------------------------------------------------------------
// M1: the ladder travels over a relay instead of a USB stick.
//
// Everything in this block is the half both sides share and neither side needs a key for. The
// builder encrypts, the watcher decrypts, and the two have to agree on where the event lives, how
// big a payload is allowed to be, and which ladder wins when both a relay and a file have one.
//
// It changes the TRANSPORT and nothing else. `stepFor` in watch-sales.ts still re-verifies every
// rung's signature before publishing it, on the standing rule that nothing is published on the
// strength of where it was loaded from, so arriving over a relay buys a rung no authority that
// arriving in a file did not.

/** NIP-78 addressable application data, the same kind builder/src/notes.ts already uses. */
export const LADDER_KIND = 30078

// The ladder `d` mirrors the item's own `d` rather than being a name of its own, so that the pair
// is legible on a relay and so that two sales by one seller cannot collide: NIP-01 replaces on
// (kind, pubkey, d), and a shared `d` would mean the second sale silently overwrote the first.
//
// The prefix is clear of both neighbours on this kind. CLINK Beacon reserves `clink-*` on kind
// 30078 (`clink-beacon.md:195`, via /docs/clink-notes.md §6) and the running Lightning.Pub still
// publishes its own beacon under the legacy `d = "Lightning.Pub"` (`nostrPool.ts:53`), while
// `lamppost-shop` is taken by the private notes (builder/src/notes.ts:25).
//
// One argument, not two, and deliberately: the composed listing `d` is what both callers already
// hold. The builder has `listingD(sale.d, draft.slug)` at publish.ts:65 and the ladder file is
// keyed by the same string (seed-listings.ts:250). Taking (saleD, slug) here would put a second
// copy of the `${saleD}-${slug}` join rule in this file, where it could drift away from the one
// in builder/src/sale.ts:77 that decides what the listing is actually called.
const LADDER_D_PREFIX = 'lamppost-ladder-'
export const ladderD = (listingD: string): string => `${LADDER_D_PREFIX}${listingD}`

/**
 * The inverse: which item is this 30078 the ladder for, if it is one at all.
 *
 * The watcher cannot ask for ladders by name, because it does not know what the seller has
 * published until it has read them, and not knowing is the point of M1. So it subscribes to the
 * seller's 30078s and sorts them out with this, which makes this the function that decides what
 * counts as ours.
 *
 * Kind 30078 is shared ground and the seller's own key writes to it: `lamppost-shop` is the
 * private notes, and `clink-*` is reserved by CLINK Beacon. Reading one of those as a ladder
 * would be the watcher inventing an item the seller never listed, so anything that is not exactly
 * our prefix followed by a non-empty name is not ours.
 */
export const listingDOf = (d: string): string | undefined =>
  d.startsWith(LADDER_D_PREFIX) && d.length > LADDER_D_PREFIX.length
    ? d.slice(LADDER_D_PREFIX.length)
    : undefined

// Bounds on a payload that decrypted, because "it decrypted" only proves the seller encrypted it,
// not that what came back is what went in. Same discipline as `parseNotes` in
// builder/src/notes.ts: cap the plaintext, cap the entry count, never throw.
//
// 65,535 is NIP-44's plaintext ceiling and therefore the real cap here, not a round number chosen
// for looking like one. It is also why M1 is one event per item: measured 2026-08-26, the whole
// Mérida shop with photos is 57,741 bytes, 88.1% of this, and breaks at about nine items, while
// the fattest single item in it is 19,906 bytes, 30% of this.
export const MAX_LADDER_PLAINTEXT = 65_535
// A rung per unit, and the per-item ceiling is roughly 46 units of a photo-carrying item
// (/README.md, M1). This is the "no yard sale has this many" bound, not a protocol limit.
export const MAX_RUNGS = 256

/** One item's ladder: what `builder/src/publish.ts:47` writes and `watch-sales.ts` publishes. */
export type Rung = { units: number; noffer?: string; steps: Event[] }

/**
 * Bounded parse of a decrypted ladder payload. Never throws; a corrupt one reads as no ladder.
 *
 * This is the one genuinely new surface M1 adds. Everything else on the path is already checked:
 * the query filters on the seller's own pubkey and nostr-tools verifies the signature, so only
 * the seller's events arrive, and NIP-44 decryption with (watcher private, seller public) only
 * succeeds if the seller encrypted it. What is left is the JSON inside, which is why it is
 * bounded here and re-verified again downstream.
 *
 * Steps are checked for shape and not for validity, on purpose. A step is an event only once its
 * signature verifies, and that is `stepFor`'s job at the moment of publishing, against the live
 * listing. Verifying here as well would be the same work done twice and would still not be the
 * check that matters, because the ladder can go stale between arriving and being used.
 *
 * Shape means every consumer that reads a step BEFORE `stepFor` can do so safely: `nofferOf`
 * walks `tags`, and `isStale` takes the max of `created_at`. So each step must pass nostr-tools'
 * `validateEvent` (numeric `kind`, string `content`, numeric `created_at`, 64-hex `pubkey`, `tags`
 * a list of lists of strings; it does not look at `id` or `sig`, which `stepFor` verifies). On top
 * of that, and stricter than the library, `created_at` must be a non-negative safe integer: the
 * library takes any number, and `JSON.parse('1e999')` is `Infinity`, which would make `isStale`
 * answer "not stale" for ever. That bound is ours.
 */
export const parseRung = (plaintext: string): Rung | undefined => {
  if (typeof plaintext !== 'string' || plaintext.length > MAX_LADDER_PLAINTEXT) return undefined
  let value: unknown
  try {
    value = JSON.parse(plaintext)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { units, noffer, steps } = value as Record<string, unknown>
  if (typeof units !== 'number' || !Number.isInteger(units) || units < 0) return undefined
  if (!Array.isArray(steps) || steps.length > MAX_RUNGS) return undefined
  if (!steps.every(s => validateEvent(s) && Number.isSafeInteger(s.created_at) && s.created_at >= 0)) return undefined
  if (noffer !== undefined && typeof noffer !== 'string') return undefined
  return { units, ...(noffer === undefined ? {} : { noffer }), steps: steps as Event[] }
}

/** Where the ladder the watcher is about to use actually came from. */
export type LadderChoice = { rung?: Rung; source: 'relay' | 'file' | 'none'; warn?: string }

/**
 * Which ladder wins for one item, given what the relays said and what is on disk.
 *
 * Pure, and separate from the subscription, so that every branch is testable without a relay.
 *
 * The relay wins whenever it produced a ladder, because that is what the seller published most
 * recently and the file is whatever they last carried across by hand. The file stays as the
 * cold-start fallback rather than being deleted: it is what makes a first run work before the
 * seller has ever published a ladder, and what keeps a sale running when the relays are down.
 *
 * A FAILED read and an ABSENT ladder are deliberately different branches even though both fall
 * back to the file. watch-sales.ts:345 already binds the rule: "the relay is down" must not read
 * as "your ladder is stale". Their remedies differ, so their sentences differ. Waiting fixes one;
 * only re-publishing fixes the other.
 */
export const chooseLadder = (
  relay: Rung | undefined,
  file: Rung | undefined,
  relayFailed: boolean,
): LadderChoice => {
  // One relay answering is enough to know what the seller last published. That three others timed
  // out does not make it less true, so a relay ladder wins even from a partly broken read.
  if (relay) return { rung: relay, source: 'relay' }
  if (file)
    return {
      rung: file,
      source: 'file',
      warn: relayFailed
        ? 'could not read a ladder from the relays, so this is the file on disk and it may be ' +
          'older than what the seller last published'
        : undefined,
    }
  return {
    source: 'none',
    warn: relayFailed
      ? 'no ladder: the relays could not be read and there is none on disk either'
      : 'no ladder on the relays and none on disk, so this item is not watched',
  }
}

/**
 * The watcher's last-acted-on settled count per item, with a generation that a new ladder bumps.
 *
 * Kept beside the rung, not inside it: the rung is the payload the seller published, and nothing
 * that is merely the watcher's bookkeeping goes inside it.
 *
 * Why a generation and not a bare Map: a tick awaits the node, maybe a refund, and a publish before
 * it writes the count, and a new ladder can arrive over the subscription during any of them.
 * Deleting the count from a bare Map is undone when that tick resumes with the OLD rung and writes
 * it back; the next tick then sees an unchanged count and skips the new ladder. So a tick takes the
 * generation before its first await, and `record` refuses the write once a newer ladder has
 * invalidated the item. A refused write leaves no count, so the next tick recomputes.
 *
 * The refund path asks the same question through `current`: after the node read, and before each
 * refund row and each journal intent, so no buyer is paid against a rung a newer ladder replaced.
 */
export const soldCounts = () => {
  const sold = new Map<string, number>()
  const gens = new Map<string, number>()
  const generation = (d: string): number => gens.get(d) ?? 0
  const current = (d: string, gen: number): boolean => gen === generation(d)
  return {
    generation,
    get: (d: string): number | undefined => sold.get(d),
    /** A new ladder replaced this item's: forget the count and outdate every generation taken. */
    invalidate: (d: string): void => {
      sold.delete(d)
      gens.set(d, generation(d) + 1)
    },
    /** True while no ladder has replaced this item's since `gen` was taken. */
    current,
    /** Writes only if no ladder has replaced this item's since `gen` was taken. */
    record: (d: string, gen: number, count: number): boolean => {
      if (!current(d, gen)) return false
      sold.set(d, count)
      return true
    },
  }
}

/** What the watcher remembers about the event a ladder came from: enough to order it, no more. */
export type Stamp = { created_at: number; id: string }

export const stampOf = (ev: Stamp): Stamp => ({ created_at: ev.created_at, id: ev.id })

/**
 * Is `ev` newer than the event behind the ladder we hold? The one rule for the startup query AND
 * the live subscription, because relays delay and replay, and a rule that only one path applies
 * lets an older ladder walk back in through the other one. Rolling a ladder back rolls back stock
 * and, through `nofferOf`, possibly which offer is watched.
 *
 * Newer `created_at` wins and a tie breaks on the lowest id, compared as lowercase hex with `<`.
 * That is the product's existing reading of NIP-01 for addressable events,
 * storefront/src/listing.ts `newestPerAddress`, and seed-listings.ts says the same. So the same
 * event received twice is not newer than itself.
 */
export const supersedes = (held: Stamp | undefined, ev: Stamp): boolean =>
  !held || ev.created_at > held.created_at || (ev.created_at === held.created_at && ev.id < held.id)

/**
 * The stamp of the ladder held per item, beside the rung for the same reason the counts are.
 *
 * Comparing and recording are separate on purpose: a newer ladder can still be dropped before it
 * is held (watch-sales.ts `withOffer`, "no decodable offer"), and a stamp recorded for a ladder
 * that nothing holds would let it shadow every older one, including the one still being watched.
 */
export const ladderStamps = () => {
  const stamps = new Map<string, Stamp>()
  return {
    get: (d: string): Stamp | undefined => stamps.get(d),
    /** Call only once the ladder from `ev` has actually replaced the one held for `d`. */
    adopted: (d: string, ev: Stamp): void => {
      stamps.set(d, stampOf(ev))
    },
    /**
     * Nothing is held for `d`, but startup ruled on `ev` (refused it as STALE, or for no decodable
     * offer), so nothing older may win. Without it the item has no stamp and `supersedes` lets any
     * live ladder in, older or not.
     */
    refusedAtStartup: (d: string, ev: Stamp): void => {
      stamps.set(d, stampOf(ev))
    },
  }
}

/**
 * The stamps startup leaves behind: one for every item it read a relay ladder for. `at` is the
 * stamp of the event behind each relay ladder (watch-sales.ts `readRelayLadders`), and
 * `chooseLadder` lets a relay ladder always win, so every item in `at` is one startup then either
 * watched (`adopted`) or refused, whatever the reason (`refusedAtStartup`). Stamping by membership
 * in `at` rather than by refusal reason means a reason added later is covered too. An item not in
 * `at` (a file ladder, or a failed relay read) has no event to stamp and stays unstamped.
 */
export const startupStamps = (at: Map<string, Stamp>, watched: Iterable<string>) => {
  const stamps = ladderStamps()
  const kept = new Set(watched)
  for (const [d, ev] of at) {
    if (kept.has(d)) stamps.adopted(d, ev)
    else stamps.refusedAtStartup(d, ev)
  }
  return stamps
}

/**
 * The overlap between the startup ladder query and the live subscription that follows it.
 *
 * Between the two, the watcher queries the listings, may wait on a human at the refund prompt, and
 * runs a first tick, for as long as those take. A `since` read when the subscription opens leaves
 * every ladder the seller published in that time out of both results, for good. So the clock is
 * read here, when the window is made, which is before the startup query runs.
 *
 * Opening the window early means the subscription can hand back events the startup query already
 * returned. `startupStamps` already stamps every item startup ruled on, so `supersedes` refuses
 * those as not newer; this is the second layer, and it also covers an event that did not decrypt,
 * which leaves no stamp at all. Every event the startup query returned is recorded by id, whatever
 * startup then did with it, and the subscription drops one of those before it decrypts anything,
 * so it is neither decrypted nor reported twice. An event that is genuinely new is
 * untouched by this and still goes through `admitLive`, whose ordering half is `supersedes`.
 */
export const ladderWindow = (clock: () => number) => {
  const since = clock()
  const ids = new Set<string>()
  return {
    since,
    /** Call for every ladder event the startup query returned, kept or not. */
    record: (ev: { id: string }): void => {
      ids.add(ev.id)
    },
    seenAtStartup: (ev: { id: string }): boolean => ids.has(ev.id),
  }
}

/**
 * May a ladder that arrived over the live subscription replace what is held for its item?
 *
 * The two checks startup gave it, in startup's order, so a live ladder is trusted no further than
 * one read at startup. `'older'`: `supersedes` says it does not beat the event startup (or a
 * previous live ladder) already ruled on, including one startup refused (STALE or no decodable
 * offer), which is what `ladderStamps.refusedAtStartup` is for. `'stale'`: `isStale` says it was cut from a listing older
 * than `publishedAt`, so its rungs would publish as silent no-ops. Neither rule is restated here.
 *
 * `publishedAt` is the listing time the watcher knows, which is the one read at startup: a listing
 * edited while the watcher runs is not seen by this (README item 11, per-tick staleness).
 */
export const admitLive = (
  held: Stamp | undefined,
  ev: Stamp,
  steps: { created_at: number }[],
  publishedAt: number | undefined,
): 'older' | 'stale' | 'newer' =>
  !supersedes(held, ev) ? 'older' : isStale(steps, publishedAt) ? 'stale' : 'newer'
