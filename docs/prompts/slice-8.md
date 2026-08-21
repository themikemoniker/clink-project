Read these in full before writing any code:

1. **`/docs/known-defects.md`** — the deferral ledger. **The slice-7 section is four rows and two
   of them are on the money path.** Phase 0 below is mostly those.
2. `/docs/status.md`   — the handoff note. Read "Slice 7 — what shipped" and, more importantly,
   **"What is NOT proven, and it is the demo beat"** at the end of it
3. `/CLAUDE.md`        — project rules. Rule 1 and the money-path section are both this slice
4. `/docs/spec.md`     — §7.3 in full (it grew a lot in slice 7), §7.4, §7.6, §9's byte budget,
   §10 slice 8, §13 the demo script, and **§14's last bullet, which is this slice's to close**
5. `/docs/spike-findings.md` — **§6 in full, including the `NEEDS HUMAN` block, because that
   block stopped being secondary the moment slice 8 was scoped.** Then §5, §13.25
6. `/docs/clink-notes.md` — §2 in full (Offers, kind 21001), §8 (what `payer_data` carries)
7. `/docs/design.md` §4 — two QR types, and the `SPIKE` note under it that says the item sticker
   is undecided **"until slice 8 decides what happens to buyers without a refund pointer"**

Then read `/storefront/src/render.ts` in full — all 402 lines of it, because this slice lives
there — plus `/storefront/src/buy.ts`, `/storefront/src/listing.ts:1-120`, `/spike/refund.ts`
and `/spike/check-buy.ts`.

Slices 0–7 are done. **Slice 7 made the seller's node send money back. Slice 8 decides who is
allowed to pay in the first place**, and the honest version of that sentence is: slice 8 decides
which buyers we are willing to take money from without being able to give it back.

---

# Phase 0 — before any fallback code

### 0.1 Prove the refund. It is one command short of done and it needs a wallet

This is the top of the list because it is the demo beat of the *previous* slice and it is
unproven. `/docs/known-defects.md`'s slice-7 section has two rows for it: `payDebit`'s success
branch has never returned `ok`, and `resolvePointer`'s LNURL branch has never resolved a real
address. Everything else in slice 7 was driven at the real node; those two were not, because
every debit sent so far was one the node *refused* — which is what proves a cap and proves
nothing about a payment.

The reason it could not be done incidentally: **all three settled invoices on the node carry
`@example.com` refund pointers**, hardcoded at `spike/check-buy.ts:59` and `:72`. A real oversell
today correctly `queue`s rather than pays.

**The procedure, and it needs no restocking, which was not obvious.** `mugs` has one unit left,
and slice 6 decided that a depleted item's offer is *left on the node* rather than deleted
(spec §7.4, findings §13.17). `check-buy.ts` reads the noffer from `.offers.json`, not from the
listing — so **the offer is still payable after the item sells out.** That is not a bug, it is
precisely the §7.3 oversell, and it means two payments of the same 1,000-sat offer produce a
genuine oversell against a genuinely depleted item:

```bash
cd spike
node check-buy.ts yardsale-2026-08-mugs --pay     # 3rd unit -> stock 0, sold
node check-buy.ts yardsale-2026-08-mugs --pay     # the oversell
node watch-sales.ts --refunds                     # the money comes back
```

**One small thing blocks it:** `check-buy.ts` hardcodes the pointer, so add `--pointer <value>`
and pass a **real** Lightning address or noffer — one you control, because the refund lands
there. Net cost is 1,000 sats plus routing fees; the second 1,000 comes back.

Watch for, and record: whether `payDebit` returns a `preimage` (its absence proves nothing —
findings §5), what the journal row looks like at `paid`, and whether the LNURL host's JSON
survives `payRequestCallback`'s validation. If it does not, that validator is the bug and it is
worth more than the rest of this slice.

Do the noffer half too if you can — it exercises a completely different resolution path
(`buy.ts` with the roles swapped) and it is the path with no server in it.

### 0.2 Answer spike question 6, because it stopped being secondary

`/docs/spike-findings.md` §6's `NEEDS HUMAN` block has been open since slice 2 and has been
marked *secondary* ever since, on the correct reasoning that **our page is the client sending the
21001, so the pointer arrives whatever a third-party wallet does.** That reasoning holds for
every slice up to this one. Slice 8 is the slice about buyers who are *not* using our page, so
the question is now load-bearing and it is five minutes of work:

```bash
cd spike && node -p "require('./.offers.json')['yardsale-2026-08-lamp'].noffer"
```

Pay that from **ShockWallet on another device** and record whether it prompts for
`refund_pointer`, fails silently, or shows the node's error text. `lamp` is 30,000 sats, so do
not actually complete it — the decline is the answer, and the decline arrives before any money
moves.

**Why the answer changes the slice rather than decorating it:** if a CLINK wallet *can* be
prompted for an arbitrary `payer_data` key, then there is a middle tier of buyer who is
refundable without our page, and the fallback is much narrower than it looks. If it cannot, every
offer we mint is unpayable by anything but our own page, and that is the fact the whole slice is
built around.

### 0.3 `render.ts` is 402 untested lines and this slice is *all* `render.ts`

`/docs/known-defects.md` has carried this since the slice 0–5 review, with the fix column saying
`render.ts` "needs a DOM harness, which is a new dependency and a new test style; that is a
decision, not a follow-up fix." **Slice 8 is the slice that has to make the decision**, because
every line it writes lands in that file, and because the one bug this file has already shipped
(`LN_ADDRESS` rejecting two-character second-level domains — a buyer who could not buy) was
exactly the kind a test would have caught.

Do not start by installing jsdom. Look first at what is actually untested and what could be
lifted out: `declineText`, `isPointer`, `sats`, and whatever copy-selection logic this slice adds
are all pure functions sitting in a DOM file, and `storefront/src/offer.test.ts` already exists
to receive them. **Lifting the decisions out of the rendering is probably the whole fix**, the
way slice 6 lifted `isStale` and `nofferOf` into `spike/ladder.ts` rather than building a harness
for `watch-sales.ts`. If you conclude a real DOM harness is needed, say so with the measurement
that made you conclude it, and ask before adding the dependency.

### 0.4 Two rows from slice 7 that are cheap while you are in the file

- **A `pending` refund is reported and never resolved.** The watcher reprints it every five
  minutes and refuses to guess, which is correct. What is missing is making the human's job one
  glance: print the node's matching outgoing payments next to it (`GetUserOperations`, filtered
  by amount and time window). The ledger row has the shape.
- **`spike/.refunds.json` is the only record that a refund happened** and losing it can double-pay.
  The ledger names a buildable mitigation — reconcile against the node's outgoing payments at
  startup. It is a heuristic, not a key, and it should be labelled as one.

Both are optional. Neither should displace 0.1.

### 0.5 Ask me, do not decide

- **The bunker export.** `spike/.dev-key.nsec` and `spike/.dev-key.qr.svg` are still in the tree.
  Slice 7 asked and the answer was "leave them, the import is imminent". Ask whether the import
  happened. If it did, delete both. If it did not, ask again — this is the third slice they have
  survived and they are the seller's private key in two more formats.
- **Anything that spends.** 0.1 costs real sats and 0.2 involves a real wallet. Both need a human
  and a decision that is not the implementer's.

### 0.6 Still scheduled, still not now, still NOT on demo day

The two Blossom single points of failure in `/docs/status.md`. Unchanged since slice 6, still
cheap on a quiet day, still `mint-offers.ts` → `seed-listings.ts` → `deploy-nsite.ts` → restart
`watch-sales.ts` → `check-admin.ts` and `check-deploy.ts`. **Note that re-seeding now also matters
to the refund path**, because it re-cuts `.ladder.json` and the watcher's `units` per item is what
decides which settled invoices are oversells (`spike/refund.ts` `oversold`). Re-seed with the
watcher stopped, and check `sales-report.ts` afterwards.

**Do not fold in the browser run.** `/docs/prompts/browser-verify-and-deploy.md` is its own
session and now covers four slices' worth of unrun DOM.

---

# Phase 1 — Slice 8: the fallback payment path

Per spec §10: *BOLT11/BOLT12 for buyers without a CLINK-capable wallet, degrading to "pay and
message me" semantics. This is what makes it usable by actual neighbors next month. Copy must
state that a raw-QR payer forfeits the automatic refund, because they never supplied a
`payer_data` pointer (§7.3).*

## The one-line description contains a factual error, so start there

**BOLT12 does not exist on this node.** `grep -rni bolt12 ~/lightning_pub/src ~/lightning_pub/proto`
returns nothing at all. LND underneath is v0.21.2-beta, which has experimental BOLT12 support,
but Lightning.Pub exposes no path to it — there is no offer-creation RPC, no `lno1` anywhere, and
CLINK's own Offers spec is a different thing entirely despite the shared word "offer".

So the first thing this slice does is **correct spec §10 and §13 rather than attempt BOLT12**.
Write it as a finding with the grep in it. If you think a BOLT12 path exists, prove it from source
before building on it — and note that "the seller's node could expose one someday" is not a v1
feature, it is a sentence in the spec's non-goals.

That leaves BOLT11, which we already produce. Which means this slice is not really about a
payment format at all.

## What the slice is actually about

Three tiers of buyer, and the project currently serves exactly one of them:

| who | supplies `refund_pointer`? | reachable afterwards? | can pay today? |
|---|---|---|---|
| our page (kind 21001 client, ephemeral key) | **yes**, we ask in a form | yes — `clink_requester_pub` is on the invoice | **yes** |
| a CLINK wallet scanning a raw `noffer` | **0.2 answers this** | yes, same field | only if it can supply the key |
| anyone scanning a plain BOLT11 QR | no | **no** — nothing identifies them | no such QR exists yet |

Every offer we mint declares `payer_data: ["refund_pointer"]` required
(`spike/mint-offers.ts:78`, `builder/src/manage.ts:215`), and the node enforces it — a request
without it comes back `{"code":1,"error":"Missing or invalid payer_data: refund_pointer",…}`,
confirmed on the wire in slice 2. **That single line is what makes tiers 2 and 3 impossible**, and
it was a deliberate slice-2 decision: spec §7.3 says "a payment that would be unrefundable is
therefore declined rather than accepted. That is the correct default for oversell risk."

Slice 8 is the slice that decides whether that default is still right now that refunds actually
exist, and what the alternative costs.

## The three problems that are not in the one-line description

### 1. Relaxing the requirement is one line, and the consequences are not

Verified 2026-08-21, `offerManager.ts:139-142`:

```ts
ValidateExpectedData(userOffer, payerData) {
    const expectedKeys = userOffer.payer_data
    if (!expectedKeys || expectedKeys.length === 0) {
        return { passed: true, validated: {} }
    }
```

An offer minted with `payer_data: []` accepts **any** payer, stores **no** pointer, and is
payable by any wallet that can read a `noffer` — or, via `NewInvoice`, by anything at all. So a
"fallback offer" is genuinely one field at mint time. What it costs:

- **It is unrefundable by construction.** The settled invoice carries no `data`, so
  `spike/refund.ts` `resolvePointer` returns `{queue: true, error: 'no refund pointer on the
  settled invoice'}` and the watcher parks it in `.refunds.json` as `queued` — **forever**,
  reprinted every five minutes, and no human can act on it either, because nothing on that
  invoice says who paid. A deliberate design choice would arrive at the seller's terminal
  disguised as an unresolved bug.
- **`sales-report.ts` already reports it correctly** — the `refundable` column and the line "some
  settled invoices carry no refund pointer — an oversell on those cannot be paid back" — so the
  reporting half exists and the watcher half does not.
- **A second offer per item means a second pointer to publish.** A listing carries one
  `clink_offer` tag. Two offers means either two tags (and every storefront including ours has to
  decide which to draw), or a second QR that is not in the listing at all.

⇒ If a fallback offer ships, `spike/refund.ts` needs a state that means *deliberately
unrefundable* rather than *awaiting a human*, and the watcher must stop nagging about it. That is
a small change and it is not optional — it is the difference between a documented trade-off and a
permanent false alarm.

### 2. "Pay and message me" has no messaging, and the address it would use is ephemeral

The one-line description says the fallback degrades to "pay and message me" semantics. There is
no messaging anywhere in this project, and spec §14 has the open question that explains why it is
harder than it sounds:

> Where does buyer↔seller pickup messaging live — NIP-17 DMs to the **ephemeral payer pubkey**
> stored on the invoice as `clink_requester_pub`? Note that key is ephemeral by design, so the
> buyer's page must keep it or the thread is unreachable.

Three things follow, and they are all worth writing down before choosing:

- `clink_requester_pub` exists **only** for a kind 21001 payer. A tier-3 BOLT11 payer has no
  pubkey on the invoice at all, so "message me" cannot mean "we message you". It can only mean
  "here is how you reach the seller", which is a static string on the page.
- The buyer's ephemeral key is minted per purchase in `buy.ts` and dropped when the page
  navigates away (that is the `KEY HANDLING NOTICE` there, and it is correct). Any thread keyed
  on it dies with the tab unless something persists it — which is a new decision about storing
  key material in a browser, and rule 2 is watching.
- Spec §7.6's pickup proof has the *same* dependency and is also unbuilt. If you are going to
  keep the ephemeral key for one of these, keep it for both, and say so.

**The lazy version is almost certainly right**: a fallback payer gets a page that says how to
reach the seller and what they will need to say. Do not build a messaging system inside a slice
about payment formats. But make that a decision with a sentence behind it, not an omission.

### 3. There is a visible hole in the page today, and it is not the one the spec names

`renderBuy` opens with `if (!offer || !price) return false` (`storefront/src/render.ts`), so an
item with no offer renders **no buy panel at all**. Against the live fixture that is two items
with nothing actionable on them:

- **`records`, 80 MXN** — priced in fiat, cash at the table, deliberately no offer (there is no
  conversion in this project and no oracle to do one with, spec §6.1). The page shows a price and
  offers the buyer no way to act on it, and no explanation.
- **`boxes`, free** — shows "free" and no way to claim it.

Neither is a CLINK problem and neither is in the slice's one-line description, but both are
"buyers this page does not serve", which is exactly what the slice is for, and both are copy
rather than protocol. They may be the cheapest real win in the slice.

## Decisions this slice owns

- **Whether a fallback offer exists at all.** The three candidates: (a) mint a second offer per
  item with `payer_data: []` and accept unrefundable payments knowingly; (b) keep the requirement
  and make the *page* the fallback — the item QR encodes `#/item/<d>` and every path funnels
  through the form that asks for a pointer; (c) relax the requirement to *optional* rather than
  absent, so a wallet that can supply a pointer does and one that cannot still pays. **(b) is
  what `design.md` §4 already assumes and it is the only one that keeps slice 7's guarantee
  whole.** (c) is the interesting one and depends entirely on 0.2's answer. Pick one, and if it
  is not (b), say what happens to the refund promise on stage.
- **The item QR sticker, finally.** `design.md` §4 and spec §14's last bullet have both been
  waiting for this slice. Today the sticker encodes the storefront deep link because a raw noffer
  QR is a QR that cannot be paid. Confirm or change it, and update both documents either way —
  they are currently written as "undecided until slice 8".
- **What the copy says, and where.** Spec §10 requires it to state that a raw-QR payer forfeits
  the automatic refund. Decide whether that sentence appears *before* payment (it must) and
  whether it appears on the sticker, the item page, or both. `render.ts`'s hint text got its
  slice-7 rewrite for exactly this reason — a buyer asked for a pointer deserves to know what it
  buys them — so match that standard.
- **What the watcher does with a deliberately unrefundable settlement.** See problem 1. `queued`
  forever is wrong.
- **The byte budget, which is already blown.** Spec §9 says ~30 KB gzip JS; the storefront is at
  **31.31 KB** as of slice 7 (+0.3 for the `LN_ADDRESS` lift and the honest hint text). Slice 8
  adds copy and possibly a second flow. Either bring it back under, or change the number in §9
  with the reasoning — but do not let it drift silently a third time.
- **Whether `render.ts` gets tests, and of what kind.** See 0.3.

## Gotchas that will cost an hour each

`/docs/status.md` has the full list, and slice 7 added nine rows to it. These bite this slice:

- **BOLT12 is not on this node.** Grep before you build. `lncli` has it; Lightning.Pub does not.
- **`payer_data: []` means "no requirement", not "no such field"** (`offerManager.ts:139-142`).
  An offer minted that way is payable by anyone and refundable by nobody.
- **A depleted offer is still payable.** Slice 6 deliberately does not delete it and slice 7
  depends on that (findings §13.17). It is also how Phase 0's oversell test works. Do not
  "fix" it.
- **`clink_requester_pub` exists only for a kind 21001 payer.** A plain BOLT11 payer is anonymous
  to us, permanently. Any design that assumes we can reach them is wrong.
- **The three CLINK error envelopes differ.** Offers is `{"code":…,"error":…}` with **no** `res`;
  Debits and Manage are `{"res":"GFY",…}`. Offers code 1 carries a `payer_data` array of the
  missing keys, which is a Lightning.Pub extension and not in the spec (findings §6) — and it is
  the thing that lets the page re-prompt rather than just fail.
- **Never guess a CLINK kind, field, tag, or error code.** `/docs/clink-notes.md`, with citations.
  Write `UNVERIFIED` and ask.
- **Never log a preimage, a `refund_pointer` value, or a payload carrying one.** `spike/refund.ts`
  documents the one deliberate exception (the LNURL *host*, never the name half); match it.
- **`pool.subscribeMany` takes a single filter OBJECT** in nostr-tools 2.24.3.
- **Minimum payable is 10 sats**, hardcoded on the node (findings §13.7), and
  `MIN_PAYABLE_SATS` in `storefront/src/offer.ts` already knows.
- **`invoiceSats` is `^lnbc` only** as of slice 7's Phase 0. If a fallback path ever needs to
  display a testnet invoice, that is a deliberate change with a test attached, not a regex tweak.

## State you are inheriting

- **Node running**, 90,374 inbound / **8,000 outbound**, 3 settled invoices, all three carrying
  `@example.com` pointers. `node spike/sales-report.ts`.
- **The refund grant is LIVE**: `spike/.refund-key`, 8,000 sats/day, expires **2026-09-20**.
  `node spike/authorize-refunds.ts --show` to see it, `--revoke` to kill it. **The expiry deletes
  the grant on first use after it lapses** rather than suspending it, and re-arming is the whole
  three-step dance again — do not let it lapse mid-demo.
- **`mugs` has one unit left**, 1,000 sats, and its offer stays payable after depletion. That is
  the oversell test in 0.1 and it is the cheapest real money in the project.
- **Refunds are off by default.** `watch-sales.ts` spends only with `--refunds`.
- **`spike/.refunds.json` may not exist**, which is correct — nothing is owed.
- **The browser half is still unrun** across slices 4, 5, 6 and 7.
- **Two Blossom single points of failure**, see 0.6.
- Tests: storefront 31, builder 41, spike 22. Builder 157.07 KB raw / **57.37 KB gzip**;
  storefront **31.31 KB gzip** JS cold + 3.91 KB QR chunk.

## How to work

- **Phase 0 first, and commit it separately.** 0.1 in particular: proving slice 7 and building
  slice 8 in one commit means a refund bug and a fallback bug in the same afternoon.
- Build only this slice. The demo beat is "a neighbour with an ordinary wallet can buy the thing"
  — nothing else.
- Tests are `node --test`, no framework, six files across three packages (`storefront/src/
  listing.test.ts`, `offer.test.ts`, `builder/src/listing.test.ts`, `deploy.test.ts`,
  `admin.test.ts`, `manage.test.ts`, `spike/ladder.test.ts`, `refund.test.ts`). Add to that style;
  do not start a seventh pattern without saying why.
- **Anything that talks to the node gets a `spike/check-*.ts`** that drives the shipped modules,
  the way `check-buy.ts`, `check-manage.ts`, `check-deploy.ts`, `check-admin.ts` and
  `check-refund.ts` do. If this slice mints a differently-shaped offer, `check-buy.ts` is where it
  gets proved payable — and where it gets proved *unrefundable*, loudly, so nobody discovers that
  property later.
- If the slice contradicts the spec, fix the spec and say so. **§10's BOLT12 line is already
  wrong** and this slice owns correcting it.
- Reconcile the docs as you go, not at the end. Anything you find and do not fix goes in
  `/docs/known-defects.md` rather than your final report, so it survives the conversation.
  **`design.md` §4 and spec §14's last bullet are both explicitly waiting on this slice** — do not
  leave them saying "undecided".
- End with something demoable, then stop and report: what Phase 0 changed, what you built, what
  you ran to verify it, what changed in `/docs/spec.md` and `/docs/status.md`, and what slice 9
  needs from me.
- Commit at the end, do not push.
- Ask before installing anything, before writing outside `/docs`, `/spike`, `/storefront` and
  `/builder`, and **before anything that moves real money or changes what an existing offer
  requires.**
