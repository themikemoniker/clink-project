Read these in full before writing any code:

1. **`/docs/known-defects.md`** — the deferral ledger. Phase 0 below is mostly this file
2. `/docs/status.md`   — the handoff note. Slice 6 rewrote most of it
3. `/CLAUDE.md`        — project rules. The money-path section is this slice
4. `/docs/spec.md`     — §7.2, §7.3, §7.4, §8, §10, §11 q10, §12
5. `/docs/spike-findings.md` — **§10 in full, it is the whole transport answer.** Then §5, §6,
   and §13 items 1, 16, 17, 25, 26
6. `/docs/clink-notes.md` — **§3 in full** (Debits, kind 21002) and §7 (expiry and replay)

Then read `/spike/watch-sales.ts`, `/spike/sales-report.ts`, `/spike/pub-rpc.ts`,
`/spike/authorize-manage.ts`, `/storefront/src/buy.ts` and `/storefront/src/render.ts:200-330`.

Slices 0–6 are done. **This slice writes money out of the seller's node for the first time.**
Everything in the project so far either reads, or signs something a human approved. Phase 0
exists because of that.

---

# Phase 0 — before any refund code

Do these first, in this order. They are all small, they are all in the ledger, and every one of
them is something you would otherwise be building refund logic on top of.

**Re-run the whole suite before you start**, so a failure two hours from now is unambiguously
yours. End of slice 6 it was:

```bash
cd storefront && npm test && npm run build     # 30 tests
cd ../builder && npm test && npm run build     # 32 tests, 156.8 KB raw / 57.3 KB gzip
cd ../spike   && npm test                      # 10 tests / 35 assertions
node check-buy.ts                              # free
node check-admin.ts                            # free, no key, no node
node sales-report.ts                           # 3 settled, 8,000 sats, 3/3 refundable
node check-manage.ts && node check-manage.ts --clean   # mints a REAL offer, then removes it
node check-deploy.ts <npub> --skip-gateway
node deploy-nsite.ts --dry
```

### 0.1 Offer minting has no idempotency key — fix it

Top row of `/docs/known-defects.md`. `publish()` calls `createOffer` unconditionally before
anything is signed, so any failure after that point — declined signature, bunker timeout, relay
refusal — leaves a payable offer behind, and pressing Publish again mints another. Manage
`create` is explicitly not idempotent (`clink-manage.md:226`).

It was deferred out of the review pass because it was money-path code and that pass was told not
to touch the money path. **You are the money-path slice.** It reads directly against
`/CLAUDE.md`'s "every retry on the money path must be idempotent, keyed on a settlement
identifier", and you are about to add a second retry on the same path.

The fix is in the ledger: implement Manage `list` in `builder/src/manage.ts`, dedupe on
`label === listingD(slug)` before `create`, reuse if the price agrees. `list` filters on
`management_pubkey` and the builder's own offers carry it (findings §13.20), so it will in fact
see a previous mint — unlike the fixture's five, which stay invisible and stay fine, because
slice 6 made an edit reuse the listing's existing pointer instead (`admin.ts` `reusableOffer`).

`spike/mint-offers.ts:64-91` already does exactly this shape over the native RPC. Copy the
reasoning, not the transport.

### 0.2 `decodeNmanage` has no tests, and you are about to write its twin

`builder/src/manage.ts:51-89` is a bech32 TLV parser that decides which node pubkey the builder
sends offer mints to, and it has zero tests. Its sibling `decodeNoffer` has 10.

This matters now rather than later because **slice 7 needs `decodeNdebit`, which is the same
parser again** — `ndebit` TLVs are `0` service pubkey, `1` relay, `2` optional pointer id, `3`
optional 32-byte `k1` (`/docs/clink-notes.md` §3.1). Writing a third TLV decoder while the
second is untested is how you end up with three.

~8 tests in a new `builder/src/manage.test.ts`, mirroring `offer.test.ts`'s cases: corrupt
checksum, wrong prefix, truncated TLV, missing pointer, non-`wss://` relay. Half an hour, no new
dependency. Then write `decodeNdebit` the same way, with TLV `3` length-checked at exactly 32
bytes.

### 0.3 Two one-liners while you are in there

- **Testnet invoices are accepted.** `storefront/src/offer.ts:121` matches
  `^ln(?:bc|tb|bcrt|sb)`. Drop the alternation to `^lnbc`, add one assertion. It matters more
  this slice than last: you are about to *pay* a BOLT11 that arrived from a buyer's wallet, and
  the same question applies on that side.
- **`storefront/src/buy.ts:117` has no `KEY HANDLING NOTICE`.** It is the only key in shipped
  browser code and the only rule-2 exception without the block every spike script carries. A
  grep for `KEY HANDLING` should not miss it. Documentation only.

### 0.4 Needs me, so ask early

- **The bunker export.** `spike/.dev-key.nsec` and `spike/.dev-key.qr.svg` are still in the
  working tree, chmod 600 and gitignored, and they are the seller's private key in two more
  formats. Slice 6 asked and did not get an answer. **Ask again before doing anything with
  them** — `export-key-qr.ts --yes` regenerates them when the import actually happens.
- **The refund cap number.** Default proposal below; confirm it with me before it goes on the
  node.

### 0.5 Scheduled, not now, and NOT on demo day

The two Blossom single points of failure, both recorded in `/docs/status.md`. Neither is urgent,
both are cheap on a quiet day, and doing them in one sitting is the right move:
`mint-offers.ts` → `seed-listings.ts` → `deploy-nsite.ts` → restart `watch-sales.ts` →
`check-admin.ts` and `check-deploy.ts`. Re-seeding re-cuts `.ladder.json`; redeploying hits the
hour-long gateway cache.

**Do not fold in the browser run.** `/docs/prompts/browser-verify-and-deploy.md` is its own
session and now covers three slices' worth of unrun DOM.

---

# Phase 1 — Slice 7: refunds

Per spec §10: *the watcher auto-refunds oversold items using the buyer pointer our page put in
`payer_data`, paying via a kind 21002 debit from a separate watcher key whose grant carries a
node-enforced frequency cap. Test the cap and the `BanDebit` kill switch against a funded node
before the demo.*

## The transport is already answered, for once

Every slice from 2 to 6 had a transport blocker underneath its one-line description. This one
does not — **findings §10 did that work already** and it is the most complete section in the
findings. Read it before anything else. The short version, all of it cited there:

- `admin.connect` is never needed. Confirmed against every RPC the watcher touches.
- The narrowest credential that permits refunds is a **CLINK Debit grant with a frequency rule,
  held by a separate watcher key**.
- The grant's frequency rule is `[number, unit, max]` and the node checks it **inside the payment
  transaction** (`assertDebitFrequency`, `debitManager.ts:376-401`), not as an advisory
  pre-check — so it holds under concurrency.
- The kill switch already exists: `BanDebit` / `ResetDebit` (`debitManager.ts:108-113`).

⇒ `/CLAUDE.md`'s "the refund path needs a hard cap and a kill switch" is satisfiable **by the
node**, which is enormously better than by our code. A bug in the watcher then costs at most one
interval's cap, and the seller revokes without touching anything of ours.

## The three problems that are not in the one-line description

### 1. `AuthorizeDebit` is commented out. `EditDebit` is the grant path

Verified 2026-08-21 against the running node's proto:

- `methods.proto:690-694` — the whole `AuthorizeDebit` rpc is inside a `/* … */` block.
- `methods.proto:696-701` — `EditDebit(DebitAuthorizationRequest) returns (Empty)`,
  `auth_type = "User"`, `nostr = true`. **This is the live one.**
- `structs.proto:755-759` — `DebitAuthorizationRequest { authorize_npub, repeated DebitRule
  rules, optional request_id }`.
- `structs.proto:808-813` — `DebitRule` is a `oneof` of `DebitExpirationRule` *or*
  `FrequencyRule`, and `rules` is repeated, so **both can be set**. Findings §10 only mentions
  the frequency one; an expiry on the grant is free and is worth taking.
- `GetDebitAuthorizations` is `auth_type = "User"`, `nostr = true` (`methods.proto:666`), so the
  grant is listable — check it before granting, the way slice 4 learned to with
  `GetManageAuthorizations`.

So slice 7 needs **`spike/authorize-refunds.ts`**, the exact analogue of
`spike/authorize-manage.ts`: run once, at the desk, with the raw key, because the grant cannot
bootstrap itself over the transport it authorises. Write it that way and say so in the header.

Assume nothing about `authorize_npub` beyond its name being a lie — it was **hex, not npub**, for
Manage (findings §13.19), and an `npub1…` created a grant that silently never matched. Verify
which it is here rather than inheriting the assumption, and record the answer.

### 2. Turning a refund pointer into a BOLT11, and this is the real blocker

The buyer supplies the pointer through our own page. `storefront/src/render.ts:210-213` accepts
**a Lightning address or an noffer** — and the placeholder is `you@yourwallet.com`, so the
address is the common case, not the edge one.

Those are two completely different resolutions:

- **noffer → BOLT11** is a kind 21001 request, which is `storefront/src/buy.ts` with the roles
  swapped: the watcher becomes the paying client and the *buyer's* node is the service. The
  shape is proven and the module exists. Note `buy.ts` mints an ephemeral key per request by
  design; decide whether the watcher does the same or signs as the refund key, and note that the
  settlement receipt comes back encrypted to whoever signed (findings §5).
- **Lightning address → BOLT11 is LNURL-pay over HTTPS**, i.e. **a third-party server in the
  refund path**. It is not *our* server, so it is not a rule 1 violation — but it is a
  dependency this project does not have anywhere else, it is unauthenticated, and it is the
  first time a refund's success would depend on somebody else's uptime. **This is the decision
  the slice owns.** Options, and pick one rather than working around it:
  - Resolve it, and say plainly on stage that a Lightning address is a hostname and a hostname
    is a server. Honest, and it keeps the common case working.
  - Refuse addresses and require an noffer, which makes the refund path as serverless as the
    rest of the project and makes the buy form worse for every buyer who has never heard of an
    noffer.
  - Resolve addresses but fall back to a **seller-visible unpaid-refund queue** when resolution
    fails, so a dead LNURL host is a line in a report rather than money that quietly stayed put.

  Whichever you choose, `render.ts`'s hint text has to end up telling the truth, and today it
  says "A Lightning address or noffer" without qualification.

### 3. Idempotency, and this is the hard one

`/CLAUDE.md`: *every retry on the money path must be idempotent, keyed on a settlement
identifier.* Slice 3 satisfied that trivially, because the watcher only ever **reads** — stock is
recomputed from the node every poll, nothing is persisted, and a replayed request that never
became a payment cannot move it (spec §8).

**A refund is the project's first write.** The failure is obvious once stated: the watcher pays a
refund, crashes before recording it, restarts, recomputes the same oversell from the node, and
pays it again. The node has no "already refunded" field on an invoice, so there is nowhere
obvious for that state to live — and a file next to the watcher is exactly the kind of local
state slice 3 was pleased to avoid.

The candidate worth trying first, and it is the same move slice 3 made — **let the node hold the
state**: CLINK Debits define `k1` as a **single-use session identifier** scoped to the pointer,
consumed when the service accepts a request for approval or payout, with duplicates answered GFY
`6` `"K1 already processed"` (`clink-debits.md:163-172`, `:279`, via `/docs/clink-notes.md` §3.3).
Derive the `k1` deterministically from the settled invoice — which is already the project's
idempotency key everywhere else — and a double refund becomes a GFY the node issues, not a bug we
have to be careful about.

**`UNVERIFIED`, and verify it before building on it:** whether Lightning.Pub persists consumed
`k1`s across a restart, or holds them in memory the way it holds its event-id deduper
(findings §13.1 — that one is in-memory with a 20-minute TTL and **loses the set on restart**). If
it is in-memory, this candidate collapses and you need a real answer. Read
`debitManager.ts` and the storage layer, do not infer it from the spec.

Note also `assertDebitFrequency` distinguishes a standing authorised grant from an "explicit
one-off" and denies on a ban row either way (`debitManager.ts:376-401`) — read that function
whole before deciding what a retry looks like.

## Decisions this slice owns

- **The cap number.** Ask me. Default proposal: the node's outbound is **8,000 sats**, all of it
  created by three test sales, and refunds cannot precede sales — so a cap of 8,000/day is
  already generous and 2,000/day covers the demo (`mugs` is 1,000). Do not set a round number
  that is bigger than the balance; the point of the cap is that a bug costs less than everything.
- **Which key.** Findings §10 is explicit that the observe key and the refund key must be
  **separate**, and today `watch-sales.ts` observes with `spike/.dev-key`, which is also the
  seller's identity and owns the account. Slice 7 adds `spike/.refund-key`, gitignored, holding
  no funds and no identity. Say in the header what it can and cannot do.
- **Automatic, or confirmed?** A browser cannot review a refund before it is sent — it cannot see
  the invoice it would be refunding (findings §13.25). So a human in the loop means a terminal
  prompt next to the node, not a UI. Decide, and note that "the money comes back with no
  intervention" is the demo beat spec §10 asks for.
- **What happens to an unrefundable settlement.** `sales-report.ts` already reports pointer
  presence per invoice (3/3 today). An oversell against an invoice with no usable pointer needs a
  loud, persistent, seller-visible answer — not a log line that scrolls away.
- **Whether the depleted offer's fate changes.** Slice 6 decided nothing is done to the offer,
  precisely so `GetUserOfferInvoices` keeps resolving and slice 7 can still read the pointer
  (spec §7.4, findings §13.17). If slice 7 finds a reason to revisit that, it is the one slice
  entitled to — but the burden is on you to show the refund path survives it.

## Gotchas that will cost an hour each

`/docs/status.md` has the full list. These bite this slice:

- **`AuthorizeDebit` is commented out** (`methods.proto:690`). Use `EditDebit`.
- **`authorize_npub` was HEX despite the name** on the Manage side. Check, do not assume.
- **The three CLINK error envelopes differ.** Offers is `{"code":…,"error":…}` with no `res`;
  Debits and Manage are `{"res":"GFY",…}`. Debits code `5` carries `range`, code `4` carries
  `retry_after` (`/docs/clink-notes.md` §3.5). One parser for all three is a bug.
- **A "User" credential is not read-only** — the same key can call `PayInvoice` (findings §10).
  That is the entire reason for a separate refund key.
- **Never delete a depleted offer.** It takes the buyer's stored refund pointer with it, and
  `GetUserOfferInvoices` is its only reader (findings §13.17).
- **Relays replay kind 21001** and Lightning.Pub's deduper is in-memory with a 20-minute TTL,
  lost on restart (findings §13.1). The settled invoice is the idempotency key, never an event id.
- **A missing `preimage` does not mean an internal transfer**, whatever `clink-offers.md:333`
  says — measured on a real external payment (findings §5). A Debits ACK is
  `{"res":"ok","preimage":…}` for a standard payment and bare `{"res":"ok"}` for an internal one
  (`/docs/clink-notes.md` §3.4), so absence proves nothing on either flow.
- **A relay answers `OK` to a replaceable event it does not store** (findings §13.26). Not a
  refund problem, but it is how the *availability* half fails silently, and slice 7 will be
  restarting the watcher a lot.
- **`pool.subscribeMany` takes a single filter OBJECT** in nostr-tools 2.24.3.
- **Never log a preimage, a `refund_pointer` value, or a full payload carrying one.**
  `sales-report.ts` prints pointer *presence* for exactly this reason — match that posture.
- **Never guess a CLINK kind, field, tag, or error code.** They are in `/docs/clink-notes.md`
  with citations. Write `UNVERIFIED` and ask.

## State you are inheriting

- **Node running**, 90,374 inbound / **8,000 outbound**, measured 2026-08-21. The account holds
  8,000 sats across three settled invoices — `plants` 6,000 and `mugs` 2×1,000 — all three
  carrying a usable refund pointer. `node spike/sales-report.ts` prints it.
- **`mugs` has one unit left, on purpose.** 1,000 sats, the cheap item for anything needing a
  real payment. Do not spend `lamp` (30,000) to test plumbing. **An oversell test costs at least
  two `mugs` payments and there is only one unit left** — plan how you are going to produce a
  real oversell before you need one, because re-stocking `mugs` is an edit and an edit re-cuts
  its ladder.
- **The admin panel exists** (slice 6) and can edit, restock and mark sold. Restocking `mugs`
  from the builder is now a supported operation — and it needs the watcher restarted afterwards.
- **The browser half is still unrun** across slices 4, 5 and 6.
- **Two Blossom single points of failure**, see 0.5.

## How to work

- **Phase 0 first, and commit it separately.** A refund bug and an idempotency bug in one commit
  is a bad afternoon.
- Build only this slice. The demo beat is "the money comes back" — nothing else.
- Tests are `node --test`, no framework, five files across three packages
  (`storefront/src/listing.test.ts`, `offer.test.ts`, `builder/src/listing.test.ts`,
  `deploy.test.ts`, `admin.test.ts`, `spike/ladder.test.ts`). Add to that style; do not start a
  sixth pattern.
- **Anything that talks to the node gets a `spike/check-*.ts` that drives the shipped module**,
  the way `check-buy.ts`, `check-manage.ts`, `check-deploy.ts` and `check-admin.ts` do. For this
  slice that means a `check-refund.ts` that proves the cap and `BanDebit` **before** any refund
  runs unattended. Spec §10 and `/CLAUDE.md` both require this and it is not negotiable.
- **Prove the cap by exceeding it**, deliberately, with a small amount, and record the GFY. A cap
  nobody has seen fire is not a cap.
- If the slice contradicts the spec, fix the spec and say so.
- Reconcile the docs as you go, not at the end. Anything you find and do not fix goes in
  `/docs/known-defects.md` rather than your final report, so it survives the conversation.
- End with something demoable, then stop and report: what Phase 0 changed, what you built, what
  you ran to verify it, what changed in `/docs/spec.md` and `/docs/status.md`, and what slice 8
  needs from me.
- Commit at the end, do not push.
- Ask before installing anything, before writing outside `/docs`, `/spike`, `/storefront` and
  `/builder`, and **before anything that moves real money or writes a grant to the node.**
