// One publish, end to end: mint the offer over CLINK Manage, sign the listing and every rung of
// its availability ladder, verify all of it through the storefront's own trust boundary, put the
// listing on the relays, and hand the seller the ladder file.
//
// No key here either — everything that signs goes through the Signer.
import { SimplePool } from 'nostr-tools/pool'
import type { Event } from 'nostr-tools/pure'
import { SALE_RELAYS } from '../../spike/fixture.ts'
import { parseListings, parseSales } from '../../storefront/src/listing.ts'
import { unitsOf } from '../../spike/ladder.ts'
import { mintOffer, type ManagePointer } from './manage.ts'
import { eventsToSign, type Draft } from './listing.ts'
import { listingD, saleTemplate, type SaleDraft } from './sale.ts'
import type { Signer } from './signer.ts'

export const RELAYS = SALE_RELAYS

export type Step =
  | { kind: 'offer'; text: string }
  | { kind: 'sign'; text: string; done: number; total: number }
  | { kind: 'publish'; text: string }
  | { kind: 'done'; text: string }
  | { kind: 'fail'; text: string }

export type Published = {
  d: string
  noffer?: string
  listing: Event
  ladder: LadderFile
  relaysOk: number
}

// EXACTLY the shape /spike/watch-sales.ts reads: { [d]: { units, noffer?, steps[] } }, steps[i]
// being the listing after i+1 units have sold. Matching it is the whole delivery mechanism —
// the seller drops this file next to the watcher and nothing on the watcher side changes.
//
// `noffer` is slice 6's one field addition and it closes an oversell in the COMMON case. The
// watcher used to infer the offer from a rung's `clink_offer` tag, which works for a multi-unit
// item and cannot work for a one-of-a-kind one: that item has exactly one rung, the stock-0 one,
// and ladder.ts `atStock` strips `clink_offer` there by design. The watcher then skipped the item
// entirely, it sold, and the storefront kept advertising it. Most yard-sale items are
// one-of-a-kind, so that was the common case rather than the edge one. Additive: a file written
// before this still resolves through the rung tag (ladder.ts `nofferOf`).
export type LadderFile = Record<string, { units: number; noffer?: string; steps: Event[] }>

/**
 * Publish one item.
 *
 * The order matters and is not arbitrary: the offer is minted FIRST, because its `noffer` goes
 * into the listing's `clink_offer` tag and therefore into every ladder rung. Minting after
 * signing would mean signing twice.
 */
export const publish = async (
  signer: Signer,
  node: ManagePointer | null,
  draft: Draft,
  sale: SaleDraft,
  onStep: (step: Step) => void,
): Promise<Published> => {
  const pubkey = await signer.getPublicKey()
  const d = listingD(sale.d, draft.slug)

  // --- 1. the offer, over CLINK Manage (kind 21003) -------------------------------------
  // Only for an item that can actually be bought. An item at stock 0 is published sold and
  // gets no offer at all — /docs/spec.md §7.4(a): a sold item's offer should not exist. An
  // item with no node configured is cash at the table, which is most of a yard sale.
  //
  // Slice 6: an EDIT arrives carrying the offer the item already advertises, and reuses it.
  // Manage `create` is explicitly not idempotent (clink-manage.md:226), so re-minting on every
  // save would leave a trail of payable offers the watcher does not watch; and the fixture's
  // five offers were minted natively and cannot be re-created here at all (findings §13.20).
  // `admin.ts` reusableOffer() only hands one over when the pointer's own TLV 4 still agrees
  // with the price being published, so a price change falls through to a fresh mint.
  //
  // Slice 7 closed the half that reuse did NOT cover: a FIRST publish that fails after this
  // point still left a payable offer behind, and pressing Publish again minted a second one.
  // `mintOffer` asks the node what it already has for this label before creating anything, so a
  // retry now finds its own previous attempt. /docs/known-defects.md, top row, now closed.
  //
  // At stock 0 the offer is dropped whatever the caller passed. That is "mark sold", and it is
  // the same thing ladder.ts `atStock` does at the bottom rung: the listing stops advertising a
  // payable pointer, and the offer itself is left alone on the node — DELETING it would destroy
  // the buyer's stored refund pointer, which `GetUserOfferInvoices` is the only reader of
  // (findings §13.17). Enforced here rather than at the call site so there is no version of
  // this that forgets.
  //
  // M3: A FIAT ITEM NEVER MINTS. `mintOffer` prices in sats, so minting for an item whose price
  // tag reads `80 MXN` would put a payable 80-SAT offer behind it — the exact 99.99% discount the
  // old "fiat cannot be edited at all" guard existed to prevent. Carrying the price through the
  // form is only safe because the offer cannot follow it. Enforced here and in `approvalCount`,
  // so the count shown and the events signed cannot drift apart.
  let noffer: string | undefined = draft.stock > 0 && !draft.fiat ? draft.noffer : undefined
  if (!noffer && node && draft.stock > 0 && !draft.fiat) {
    onStep({ kind: 'offer', text: 'Minting the offer on your node over CLINK Manage…' })
    const result = await mintOffer(signer, node, d, draft.priceSats)
    if (!result.ok) {
      // clink-manage.md:133-186 — GFY codes. 1 Request Denied, 2 Temporary Failure,
      // 3 Clock/replay, 4 Rate Limited, 5 Invalid Field/Value (+`field`), 6 Not Found.
      // Code 1 with no grant is the interesting one: it means /spike/authorize-manage.ts has
      // not been run for this key, and that is a sentence a person can act on.
      const hint =
        result.code === 1
          ? ' Has this key been authorised on the node? Run `node spike/authorize-manage.ts` once, at the desk.'
          : result.code === 3
            ? ' The node rejects requests more than ~30s from its own clock — check this machine’s time.'
            : result.field
              ? ` (field: ${result.field})`
              : ''
      throw new Error(`Could not mint the offer: ${result.error}.${hint}`)
    }
    noffer = result.offer.noffer
  }

  // --- 2. sign the listing AND the ladder ------------------------------------------------
  // An item is 1 + units signatures, not one. /docs/spec.md §5's budget did not have this term
  // because before slice 3 nothing pre-signed availability, and before slice 4 the ladder was
  // cut by a script holding a raw key.
  const now = Math.floor(Date.now() / 1000)
  const templates = eventsToSign({ ...draft, noffer }, pubkey, now, sale)
  const signed: Event[] = []
  for (const [i, template] of templates.entries()) {
    onStep({
      kind: 'sign',
      text: i === 0 ? 'Signing the listing…' : `Signing availability, ${templates.length - 1 - i} left…`,
      done: i,
      total: templates.length,
    })
    signed.push(await signer.signEvent(template))
  }

  const [listing, ...steps] = signed as [Event, ...Event[]]

  // --- 3. verify our own output before anything leaves ------------------------------------
  // Through storefront/src/listing.ts, the same door slice 3's watcher makes the ladder file go
  // through. It verifies the signature (after deleting nostr-tools' cached `verified` symbol —
  // findings §13.10, which bites anything that builds an event by spreading another) and
  // re-derives stock/status from the tags rather than trusting what we think we wrote.
  //
  // This is where a listing that advertises one price and points at an offer for another dies:
  // buyableOffer() drops the offer, `parsed.offer` comes back undefined, and we refuse to
  // publish rather than shipping an item with a Buy button that cannot work.
  const parsed = parseListings([listing], pubkey)[0]
  if (!parsed || parsed.d !== d) throw new Error('The listing we just signed does not survive our own parser. Nothing was published.')
  if (parsed.title !== draft.title) throw new Error('The title was altered in encoding. Nothing was published.')
  if (noffer && !parsed.offer) {
    throw new Error(
      `The offer the node minted does not match the price on the listing (${draft.priceSats} sats), so no Buy button would appear. Nothing was published.`,
    )
  }
  for (const [i, step] of steps.entries()) {
    const target = steps.length - i - 1
    const rung = parseListings([step], pubkey)[0]
    if (!rung || rung.d !== d) throw new Error(`Availability step ${i + 1} failed verification. Nothing was published.`)
    if (rung.sold !== (target === 0)) throw new Error(`Availability step ${i + 1} disagrees about being sold. Nothing was published.`)
  }

  // --- 4. publish the listing (and only the listing) ---------------------------------------
  // The rungs are NOT published. Publishing the stock-0 rung would mark the item sold
  // immediately: NIP-01 keeps the newest event per (kind, pubkey, d) and the rungs carry later
  // `created_at`s by construction. They exist for the watcher and nowhere else.
  onStep({ kind: 'publish', text: `Publishing to ${RELAYS.length} relays…` })
  const pool = new SimplePool()
  const results = await Promise.allSettled(
    pool
      .publish(RELAYS, listing)
      .map(p => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000))])),
  )
  pool.close(RELAYS)
  const relaysOk = results.filter(r => r.status === 'fulfilled').length
  if (relaysOk === 0) throw new Error('No relay accepted the listing. It is signed but nobody can see it — try again.')

  onStep({ kind: 'done', text: `Published to ${relaysOk}/${RELAYS.length} relays.` })

  return {
    d,
    noffer,
    listing,
    relaysOk,
    ladder: { [d]: { units: unitsOf(String(draft.stock)), noffer, steps } },
  }
}

/**
 * Publish the sale itself — the kind 30405 that carries the masthead and lists the members.
 *
 * SLICE 9, and it is the feature spec §10 called "masthead editing". Before this, `listingTags`
 * wrote `["a","30405:<seller>:yardsale-2026-08"]` on every item and **nothing in the builder ever
 * published a kind 30405 at all** — the only writer in the repo was `/spike/seed-listings.ts`. So
 * every seller who was not us had items pointing into a collection that did not exist, and their
 * storefront fell back to rendering its own name as the masthead. `spike/check-deploy.ts` prints
 * `(no kind 30405 — the page falls back to its own name)` for exactly this and it reads like a
 * graceful degradation rather than the missing half of a feature.
 *
 * ONE signature, and **no new bunker approval**: `sign_event:30405` has been in `signer.ts`
 * `PERMS` since slice 4, and both Amber and nsec.app key a remembered grant on (app, type, kind)
 * — findings §8. So a seller who connected before this shipped can publish a sale without
 * touching their phone.
 *
 * It is a replacement like any other (NIP-01 replaces on kind/pubkey/d), which means the caller
 * has to hand over EVERY member every time. Dropping one here silently un-lists it: the item
 * survives on the relays and `orderBySale` renders it as a stray at the foot of the page, which
 * is a demotion nobody asked for rather than a deletion. That is why this takes the panel's full
 * item list rather than a diff.
 */
export const publishSale = async (
  signer: Signer,
  sale: SaleDraft,
  itemDs: string[],
  onStep: (step: Step) => void,
): Promise<{ event: Event; relaysOk: number }> => {
  const pubkey = await signer.getPublicKey()
  onStep({ kind: 'sign', text: 'Signing the sale…', done: 0, total: 1 })
  const event = await signer.signEvent(saleTemplate(sale, pubkey, itemDs, Math.floor(Date.now() / 1000)))

  // Through the storefront's own parser, exactly as a listing is. A collection whose `title` did
  // not survive encoding is a masthead that renders as the site's fallback name, and the seller
  // would have no way to tell that from "the relay dropped it".
  const parsed = parseSales([event], pubkey)[0]
  if (!parsed || parsed.d !== sale.d) throw new Error('The sale we just signed does not survive our own parser. Nothing was published.')
  if (parsed.title !== sale.title) throw new Error('The sale title was altered in encoding. Nothing was published.')
  if (parsed.itemRefs.length !== itemDs.length) {
    throw new Error(`${itemDs.length - parsed.itemRefs.length} of your items would have been dropped from the sale. Nothing was published.`)
  }

  onStep({ kind: 'publish', text: `Publishing the sale to ${RELAYS.length} relays…` })
  const pool = new SimplePool()
  const results = await Promise.allSettled(
    pool
      .publish(RELAYS, event)
      .map(p => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000))])),
  )
  pool.close(RELAYS)
  const relaysOk = results.filter(r => r.status === 'fulfilled').length
  if (relaysOk === 0) throw new Error('No relay accepted the sale. It is signed but nobody can see it — try again.')
  onStep({ kind: 'done', text: `Sale published to ${relaysOk}/${RELAYS.length} relays.` })
  return { event, relaysOk }
}

/**
 * Hand the seller the ladder as a file.
 *
 * EVERY OTHER ROUTE IS CLOSED, and this is worth saying out loud because "just download a file"
 * looks lazy until you list them:
 *   * A relay cannot carry it. Publishing the stock-0 rung marks the item sold instantly —
 *     NIP-01 keeps the newest per (kind, pubkey, d), and the rungs are newer by construction.
 *   * A backend cannot carry it. /CLAUDE.md rule 1.
 *   * NIP-78 encrypted-to-self cannot carry it. The watcher holds no key to decrypt with, and
 *     that — holding no key — is the entire point of slice 3.
 * So: the browser hands it over, the seller drops it next to the watcher. The file is signed
 * public events and no key material, which is why passing it around by hand is safe.
 *
 * Merges into whatever the seller already has rather than replacing it, so publishing a second
 * item does not blind the watcher to the first.
 */
export const ladderFile = (existing: LadderFile, added: LadderFile): string =>
  JSON.stringify({ ...existing, ...added }, null, 2) + '\n'

export const downloadLadder = (json: string) => {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = '.ladder.json'
  a.click()
  URL.revokeObjectURL(url)
}
