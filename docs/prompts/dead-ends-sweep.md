# Session brief: close every dead end a machine with no key can close

One session, **four roadmap items**, one spine: a dead end is a place the app stops and tells
somebody nothing they can act on. Two are the seller's, one is the buyer's, one is the seller's
edit form refusing outright. All four are fully reachable on this machine, which has no node and
no keys. Work them in order, commit per item, do not stop between them to ask whether to continue.

This is deliberately a larger slice than the last two sessions. Batch the work. Save questions for
the two decisions named at the bottom, which are genuinely not yours to take.

## Read first, in this order

1. `/CLAUDE.md`. Rules 1 through 5 and the money-path rules are binding. Item 27 touches the
   refund path, so "treat every inbound event as hostile" applies to a DNS answer too.
2. `/docs/status.md`, and specifically the section **"THE SECOND MACHINE"** near the top. It
   records what this box has, what it cannot get, and which roadmap items are therefore
   unreachable. Do not re-derive it. It is 98 KB; grep it.
3. `/README.md` milestones D and E for items 13, 18, 27 and M3.
4. `/docs/known-defects.md` only when something fails, to see whether it is already known. Note
   the two most recent sections, "Added by item 8" and "Added by items 16 and 17", because both
   are open rows this session may touch.

Where `status.md` and `/docs/spike-findings.md` disagree, the findings win. Where a doc and the
code disagree, read the code and say so.

## The machine, stated once

No Lightning.Pub (nothing answers `127.0.0.1:1776`), no LND, no `lncli`, none of the gitignored
state, no NIP-07 extension in this browser profile. The four public relays and the four Blossom
servers ARE reachable, and `relay.damus.io` was returning 503 on the WebSocket handshake on
2026-08-25, so expect three of four to answer and do not treat that as a new fault.

Everything below is reachable without any of the missing hardware. If you find yourself wanting a
key, you have left the slice.

## Phase 0: prove the tree still runs (five minutes, not a phase to linger in)

```bash
cd storefront && npm install && npm test && npm run build && npm run size
cd ../builder  && npm install && npm test && npm run build
cd ../spike    && npm install && npm test
```

As of 2026-08-25 that is **75 / 70 / 42**, all green, `tsc` clean in both apps, and the
storefront's cold JS is **32,134 bytes gzip**. These are measurements, not promises. If a number
differs, report the actual output and say the document is stale rather than restating it.

**The byte budget is now the binding constraint and it was not before.** 32,134 against a 33 KB
budget leaves **866 bytes of headroom**. Items 16 and 17 spent 251. Nothing in this brief should
touch the storefront bundle much, but if you add a byte to `storefront/src`, measure first and
measure again, and if a change needs more than the headroom, stop and say so rather than raising
the budget on your own authority. Spec §9 records that the budget has been raised twice with
written reasoning, and §9.2 has the current accounting.

## Phase 1: item 18, make redeploying safe

`spike/check-deploy.ts` already walks relays, then Blossom, then the gateway, and its §4 reports
paths as `STALE` when the gateway serves different bytes than the manifest names. On 2026-08-25 it
reported 4 stale paths against a deploy that was completely healthy, because the nsite gateway
sends `cache-control: max-age=3600` (findings §7). The script says so in prose. It does not say
**how long is left**, which is the difference between "wait it out" and "something is wrong".

- Report the gateway's cache age next to the relay and Blossom state, so "did my deploy land" has
  one answer instead of three. The response headers are already in hand where §4 fetches.
- Read the actual headers rather than assuming: `age`, `cache-control`, `date`, `last-modified`.
  Do not guess which the gateway sends. Print what it actually returns and cite it.
- Document the cache-busting query-string escape hatch **if one exists**. Test it. If it does not
  exist, write `UNVERIFIED` and say what you tried, rather than documenting a hope.
- The third bullet, "build stickers after deploying", is a doc and ordering note. The builder's
  sticker sheet encodes the site URL, so a sheet printed before a deploy points at nothing.

`check-deploy.ts` is keyless, node-less and free, and it exited 0 on 2026-08-25 against
`npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws`. Run it before and after and
put both transcripts in the commit.

## Phase 2: item 27, first bullet, say the true reason

`LN_ADDRESS.test()` cannot tell a BIP-353 address from an LNURL-pay one, because they are the same
`user@domain` shape, so `resolvePointer` builds a `/.well-known/lnurlp/…` URL for a host that
serves no HTTPS at all. Measured 2026-08-24: `phoenixwallet.me` has NS records and no A or AAAA.
What it has is a TXT record at `<name>.user._bitcoin-payment.<domain>` carrying `bitcoin:?lno=…`.

- `spike/refund.ts`: `lnurlpUrl` is at `:294`, the `queued` outcome at `:101`, and `LN_ADDRESS` is
  imported from `../storefront/src/offer.ts` at `:28`. Verify those before citing them.
- When the LNURL hop fails to resolve, look up the BIP-353 TXT record. If it answers, the `queued`
  row should read *"that is a BIP-353 address and this refund path speaks LNURL-pay"* rather than
  naming DNS.
- **This is the money path, so the money-path rules bind.** A DNS answer is hostile input: bound
  the response, bound the time, and do not let a TXT lookup become a second unbounded network hop.
  `resolvePointer` is already two sequential fetches at a 10 s timeout each (`:182`).
- **DNS is free and this is verifiable here.** Resolve against the real `phoenixwallet.me` and a
  real LNURL host, and put both transcripts in the commit. Do not claim it works without them.
- Do **not** touch `payDebit`. Paying a BOLT12 offer is a feature, is not this item, and whether
  this Lightning.Pub can pay an offer at all is UNVERIFIED.

## Phase 3: item 13's last bullet, refuse to shrink a sale

Two of item 13's three bullets landed in milestone A. What is left: **a kind 30405 is a
replacement, so publishing a short member list silently un-lists real items.** The quorum rule
already refuses a read below a majority of relays. This is the other half: refuse to SHRINK an
existing sale without an explicit confirmation.

- The button is `#publish-sale` → `doPublishSale` → `publishSale(signer, draft, owned.map(…))`.
- Shrinking is also what a legitimate delete looks like, which is exactly why this has to land
  **before** M3's delete rather than after. Building it here is what unblocks that work for the
  machine that has the key.
- This is builder logic and is testable offline. It does not need a relay to prove: the decision
  is "the list I am about to publish is shorter than the one on the relays, so confirm".
- Assert the guard in `builder/src/*.test.ts`, and assert the confirmation UI renders in
  `builder/smoke.test.ts`. New markup that has never rendered is the defect item 8 exists to stop,
  and a confirmation nobody has seen paint is precisely that.

## Phase 4: M3's fiat half only

`builder/src/admin.ts:116` is `if (item.price && item.price.currency !== 'sats') return null`,
verified 2026-08-25. So `records` at 80 MXN can never be edited at all. The guard is right to
exist: a sats-only form would republish it as 80 sats, a silent 99.99% discount on something
somebody might then buy. "Refuse forever" is not the only way to be right.

- Carry currency and amount through the form as a **display price that stays unpayable**.
- **Check the currency comparison while you are in there, and do not assume the answer.** That
  guard is an exact match on lowercase `'sats'`. `storefront/src/listing.ts:174` accepts
  `/^sats?$/i`. If those two disagree, an item priced `sat` or `SATS` is buyable and not editable.
  The builder writes `'sats'` (`builder/src/listing.ts:109`) so this may be latent rather than
  live. **Measure it against the live sale before claiming either way.**
- **Take only the fiat half.** M3's delete is sequenced after phase 3 and needs a re-publish, so
  it belongs to the machine with the key. Do not build it. Do not build M6, which needs M3.
- Do not delete the offer on the node when retiring an item. That takes the buyer's stored refund
  pointer with it (findings §13.17). Not this session's problem, but do not write code that
  assumes otherwise.

## Rules for this session

- **Never guess a protocol detail.** No CLINK kind, field, tag or error code from memory, and the
  same for NIP-99, NIP-5A, NIP-78, BIP-353 and Blossom. Cite a spec file, source, or captured
  JSON, or write UNVERIFIED and ask.
- **Nothing that signs, publishes or spends, this whole session.** That rules out
  `seed-listings.ts`, `mint-offers.ts`, `deploy-nsite.ts`, every `authorize-*`, `check-buy --pay`,
  and `npm run capture`. DNS lookups, relay reads, Blossom reads and gateway reads are all free
  and all fine.
- **Evidence before assertions.** Do not say a thing passes without the command output. If you
  predicted 75 tests and got 74, report 74.
- **Every new branch of user-facing text must RENDER, not merely be unit-tested.** The harness
  exists: `storefront/smoke.test.ts` and `builder/smoke.test.ts`, wired into `npm test`, driving
  headless chromium offline against captured signed events. Playwright is pinned at 1.62.1 in both
  apps and its chromium is already on disk. Do not add a second browser automation stack, and do
  not install anything global without asking.
- **Watch each new assertion fail before trusting it.** Break the thing, see the red, revert, and
  say so in the commit. Two sessions have now done this and both found it cheap.
- **Build only what is scoped here.** No scaffolding for M4, M5, M6 or M8.
- Update `/docs/spec.md` at the end with what was learned, and say exactly what changed.

## Two decisions to bring back, not to take

1. **Item 27's buy side.** Should `isPointer` refuse a pointer the refund path cannot use? It
   moves the failure from after the sale to before it, and a settled invoice stores the pointer
   forever. But refusing means turning Phoenix buyers away outright, and a manual refund at the
   table may be the better trade for a yard sale. Name the options and the cost of each. **Do not
   let this be decided by whichever code path you happen to edit.**
2. **Item 26**, if it comes up: the builder is live on a throwaway slice-5 key, a kind 15128 root
   site is one per pubkey, and a real identity later means a new URL with no migration. That is a
   fork, it is one-way, and it is the operator's call.

## Known-open things you should not be surprised by

- **The live sale's `geo:` link points 5.9 km from the sale.** Slice 9 corrected the geohash in
  `spike/fixture.ts` to `9ewmxg9` and never republished, so the relays still serve `9ewmr4z`.
  Fixing it is a republish, so it is not this machine's job. Ledger row in `known-defects.md`.
- **Item 17's price-disagreement sentence has never rendered.** It cannot be reached from the
  smoke fixture without a signed listing whose price tag and `clink_offer` disagree. Also a ledger
  row. Do not "fix" it by weakening signature verification.

## End with

1. The actual test counts, build results and gzip size, as output rather than as claims.
2. What each of the four items landed, what it asserts, and what it deliberately does not.
3. The transcripts: `check-deploy.ts` before and after, and the two DNS resolutions.
4. The two decisions above, framed with their costs, for a human to answer.
5. Anything that turned out to need the machine with the node and the keys.
