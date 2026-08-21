Read these in full before writing any code:

1. `/docs/status.md`   — start here
2. `/CLAUDE.md`        — project rules
3. `/docs/spec.md`     — §6.1, §6.2 (NIP-78), §6.3, §7.4, §7.5, §8, §9, §10, §14
4. `/docs/spike-findings.md` — §10, §12, and §13 items 12, 16, 17, 18, 19, 20
5. `/docs/clink-notes.md` — **§4 in full.** It decides this slice
6. `/docs/design.md`   — §5

Then read `/builder/src/*.ts`, `/spike/watch-sales.ts`, `/spike/ladder.ts`,
`/spike/check-manage.ts` and `/storefront/src/listing.ts`.

Slices 0–5 are done. Build slice 6 only.

## Slice 6 — Admin panel

Per spec §10: edit, restock, mark sold, view settled sales, private notes via NIP-78.

## The problems that are not in the one-line description

Slices 2, 3, 4 and 5 each had a blocker underneath the one-liner, and each was the
transport. This one has three, and the first is the same shape again.

### 1. "View settled sales" has no CLINK path at all

This is the one to spend your first hour on, because it may delete a bullet from the
slice.

CLINK Manage's **only resource is `"offer"`** (`clink-manage.md:29`), with actions
`create`, `update`, `get`, `list`, `delete` (`clink-manage.md:33-92`). There is no
invoice resource, no settlement resource, no payment history. Verify that against
`/docs/clink-notes.md` §4 and the spec file itself rather than taking this sentence
for it — but if it holds, the consequence is hard:

**Settled sales live behind `GetUserOfferInvoices`, which is a kind 21000 native RPC,
which a NIP-46 bunker cannot speak** (findings §13.18 — it is keyed on the raw ECDH
x-coordinate and NIP-46 exposes no raw-ECDH method). The builder is a browser app
behind a Signer. So a browser admin panel **cannot see the seller's sales**, and no
amount of building will change that.

Options, and this needs a decision rather than a workaround:

- **Drop it from slice 6** and say why on stage. It is a real architectural
  consequence of holding no key, not a missing feature, and it is the kind of honest
  limit that reads well next to the custody argument in spec §3.1.
- **Derive it from the relays instead.** The watcher already publishes availability,
  and the ladder rung that is currently live tells you how many units have gone. That
  is public information the page can read with no credential at all — it is *less*
  than the node knows (no amounts, no timestamps, no payer data) but it is the number
  a seller actually wants at a yard sale, and it costs nothing.
- **A script, not the panel.** `watch-sales.ts` already holds a node credential and
  already calls `GetUserOfferInvoices` every tick. A `spike/sales-report.ts` is
  twenty lines. It runs where the key already is, which is the honest place for it.
- **Do not** solve it by giving the browser a raw node key. That is rule 2 and rule 3
  at the same time, and it hands the page spend authority over the seller's balance
  (findings §10: there is no observer scope in Lightning.Pub — the same credential
  that reads operations can call `PayInvoice`).

Whatever you pick, the finding goes in `/docs/spike-findings.md` §13 with the
citation, because it constrains slice 7's UI too.

### 2. An edit is not an edit — it is a re-cut ladder and a re-mint

`/spike/ladder.ts`'s own header states the ceiling: *"the ladder is cut from one
version of the listing. Editing the price or the title mid-sale invalidates it,
because a stale ladder step would republish the old text over the new."* Slice 4
moved the cut into the browser, so editing one item means:

- re-signing the listing **and every rung** — `1 + units` signatures, again
- handing the seller a **new `.ladder.json`** and getting them to restart the watcher
- if the price changed, **re-minting the offer**, because the storefront refuses to
  draw a Buy button when the listed price and the noffer's TLV 4 disagree
  (`publish.ts` checks this before anything is published, deliberately)

And there is a window: between publishing the edited listing and the watcher picking
up the new ladder, the watcher holds rungs carrying the **old** text with `created_at`
values that are newer by construction. One sale in that window republishes the old
title over the new one. NIP-01's newest-per-address rule, working exactly as designed,
against you.

Decide how the UI handles that window. Ordering the steps so the ladder file is
downloaded before the listing is published is one answer; making the watcher refuse a
rung whose content disagrees with what is currently on the relay is another and is
more robust but touches slice 3's shipped watcher. Pick one, say why, and make the
copy tell the seller the truth about the cost — spec §5 is a UX-critical budget and a
seller told "just edit the price" who then faces thirty approvals abandons it.

### 3. The fixture's offers are invisible to the tool that would edit them

Findings §13.20, measured: `createOffer` over Manage stamps `management_pubkey`, and
Manage `list` only returns offers carrying its own requestor's. The five offers on
the live sale were minted over the **native** kind 21000 RPC by `mint-offers.ts` and
carry an empty `management_pubkey`.

So an admin panel that lists offers over Manage shows **zero** on an account with
seven, and an edit flow through Manage cannot touch the ones the demo actually runs
on. Spec §14 has been holding this decision for slice 6: re-mint them through Manage,
or keep a native path.

Note what "keep a native path" really costs — the native RPC needs a raw key, so it
means a script next to the node, not a button. And note what re-minting costs: a new
`noffer`, therefore a re-signed listing, therefore a re-cut ladder, for every item.
Re-minting `mugs` mid-demo would also orphan its settled invoice history from the new
offer, which is where slice 7's refund pointers live (findings §13.17).

### 4. The React question comes due here, and spec §9 says so explicitly

*"Revisit at slice 6, which is where the admin panel actually wants tables, dialogs
and toasts. If it does, that is a real reason and this line changes again; 'the spec
said React' is not one."*

Two things have changed since that was written. The builder is now itself an nsite
(rule 5), fetched blob by blob from a gateway, and it already carries a built copy of
the storefront in `public/site`. So the cost of a framework is now paid by a page a
seller loads from a cold gateway, not by a dev server. Measure before deciding, and
if the answer is still no, delete the line from spec §9 rather than deferring it to
slice 9.

## Decisions this slice owns

- **What "view settled sales" becomes**, per §1 above.
- **The edit window**, per §2 above.
- **The fixture's five native offers**, per §3 above.
- **Whether `mark sold` deletes the offer.** Spec §7.4(a) says it should. Findings
  §13.17 says deleting a depleted offer destroys the buyer's stored refund pointer,
  because `GetUserOfferInvoices` is its only reader and it throws once the row is
  gone — which would break slice 7 in its own core case. The ladder already drops the
  `clink_offer` tag at stock 0, so the listing stops advertising it either way. The
  untested candidate is `UpdateUserOffer` to a price outside the payable range.
  **This decision is owed before slice 7 and slice 6 is where it lands.**
- **Reordering the sale.** Slice 4 deferred kind 30405 re-signing to here: a new item
  appears at the foot because `orderBySale` renders collection members first and
  strays after. Reordering is one signature; decide whether it is worth a UI.
- **NIP-78 private notes.** Kind 30078, encrypted to self. The Signer already exposes
  `nip44Encrypt`/`nip44Decrypt` for arbitrary pubkeys, so encrypt-to-self works with
  no new machinery, and `sign_event:30078` has been in `PERMS` since slice 4. Read
  spec §6.2 for what the field is actually for before designing a notes UI.

## Gotchas that will cost an hour each

`/docs/status.md` has the full list. These bite this slice:

- **A NIP-46 bunker cannot speak kind 21000.** In the browser it is CLINK or nothing.
  If you reach for `pub-rpc.ts` in `/builder`, that is the signal you took a wrong
  turn (findings §13.18).
- **Manage `list` does not show natively-minted offers.** An empty list on an account
  with seven offers is not a bug (findings §13.20).
- **`authorize_npub` wants a HEX pubkey despite the name.** An `npub1…` creates a
  grant that silently never matches (findings §13.19).
- **CLINK Manage `create` is not idempotent** (`clink-manage.md:226`). N identical
  requests make N offers. `update`, `get`, `list`, `delete` are idempotent.
- **`update` MUST NOT add new fields to an offer** (`clink-manage.md:193`).
- **Never publish the account's default offer.** Its `offer_id` *is* the account
  pointer.
- **The three CLINK error envelopes differ.** Offers is `{"code":…,"error":…}` with
  no `res`; Debits and Manage are `{"res":"GFY",…}`. One parser for all three is a bug.
- **The gateway caches for an hour.** Do not redeploy on demo day.
- **A kind 15128 root site is one per pubkey** (findings §13.22). The builder and the
  storefront have separate identities and must keep them.
- **Never guess a CLINK kind, field, tag, or error code.** They are in
  `/docs/clink-notes.md` with citations. Write `UNVERIFIED` and ask.

## State you are inheriting

- **Node running**, 90,160 inbound / 8,000 outbound. `mugs` is 1,000 sat with one
  unit left — the cheap item for anything needing a real payment. Do not spend `lamp`
  (30,000) to test plumbing.
- **Two nsites live**, both verified on four Blossom servers: the builder and a
  slice-5 test storefront. The seller's live storefront is the demo — slice 6 can
  break it, so prefer a throwaway.
- **Blobs are on four Blossom servers now**, but the fixture's 21 photos are still on
  `blossom.band` alone until `seed-listings.ts` is re-run. Re-seeding re-cuts
  `.ladder.json` and needs the watcher restarted, so it is not demo-day work — but it
  is the last single point of failure in the demo and slice 6 is a reasonable place
  to spend it.
- **The browser half may still be unrun.** Check `/docs/status.md` before assuming
  the builder's DOM has ever been driven.
- `check-manage.ts` mints a real offer per run; `--clean` removes them, and refuses
  any offer with a settled invoice.

## Still open and needing me

- **The bunker import**, if the browser session has not closed it.
- **Question 6, wallet half** — does ShockWallet supply `payer_data`? Still secondary;
  our page is the client. It changes slice 8's copy and design.md §4.
- **Titan's `nsite://`** — `location.hostname` there is `UNVERIFIED`. The `?seller=`
  fallback covers it either way, but nobody has run the page in Titan.

## How to work

- Build only this slice. No scaffolding for slice 7 — and specifically **no refund
  code**, even though §7.4 and the `mark sold` decision above will make it tempting.
  Slice 7 needs a node-enforced frequency cap and a tested `BanDebit` kill switch
  before it goes near a real node, and half of it built early is worse than none.
- Tests are `node --test`, no framework: `storefront/src/listing.test.ts` (30),
  `spike/ladder.test.ts` (20 assertions), `builder/src/listing.test.ts` and
  `builder/src/deploy.test.ts` (20 together). Add to that style; do not start a fifth
  pattern.
- Anything that talks to the node gets a `spike/check-*.ts` that drives the shipped
  module, the way `check-buy.ts`, `check-manage.ts` and `check-deploy.ts` do. If it
  cannot be verified headlessly, tell me early.
- If the slice contradicts the spec, fix the spec and say so.
- End with something demoable, then stop and report: what you built, what you ran to
  verify it, what changed in `/docs/spec.md` and `/docs/status.md`, and what slice 7
  needs from me.
- Commit at the end, do not push.
- Ask before installing anything, and before writing outside `/docs`, `/spike`,
  `/storefront` and `/builder`.
