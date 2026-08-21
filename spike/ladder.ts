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
