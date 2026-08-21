Read these in full before writing any code:

1. **`/docs/known-defects.md`** — new, written by the review agent. Read it first
2. `/docs/status.md`   — the handoff note, and see the warning below about it
3. `/CLAUDE.md`        — project rules
4. **`/docs/prompts/slice-6.md`** — the slice brief. It is the *what*; this file is
   the *first hour*. Read both before starting
5. `/docs/spec.md`     — §6.1, §6.2, §6.3, §7.4, §7.5, §8, §9, §10, §14
6. `/docs/spike-findings.md` — §10, §12, and §13 items 12, 16, 17, 18, 19, 20
7. `/docs/clink-notes.md` — **§4 in full.** It decides this slice

Slices 0–5 are done. A review agent has since gone over the codebase in this same
directory. Build slice 6 — but not until you know what it changed.

## Spend your first hour here, before writing anything

**The docs describe the codebase as it was at the end of slice 5, and a review pass
has happened since.** `/docs/status.md`, `/docs/spec.md` and `/docs/spike-findings.md`
were all written by the session that shipped slice 5, and the review agent has been
editing at least `docs/spec.md` and `docs/status.md` on top of that. Where they
disagree with the code, **the code wins** — that is the reverse of this project's
usual rule, and it applies only until you have reconciled them.

```bash
git log --oneline 8e0931f..HEAD          # 8e0931f is slice 5. Everything after is review
git diff --stat 8e0931f..HEAD
```

At the time this brief was written the review agent had work in flight in
`builder/src/main.ts`, `docs/spec.md`, `docs/status.md`, `spike/fixture.ts`,
`spike/mint-offers.ts` and `spike/watch-sales.ts`, plus a new `docs/known-defects.md`
with a "Documentation drift" section. Find out what actually landed.

Three of those files are load-bearing in ways the filename does not show:

- **`spike/fixture.ts` is imported by `/builder`.** `SALE` in `builder/src/listing.ts`
  and `main.ts`, `SALE_RELAYS` in `publish.ts`, `REFUND_POINTER` in `manage.ts`. A
  change there is a change to what the builder publishes, not just to the seeder.
- **`spike/mint-offers.ts`** mints the offers the *live* sale's Buy buttons point at.
- **`spike/watch-sales.ts`** is what keeps the live storefront's availability honest.

**Then re-run the whole verification suite before you build anything**, so that a
failure two hours from now is unambiguously yours:

```bash
cd storefront && npm test && npm run build
cd ../builder && npm test && npm run build
cd ../spike   && npm test
node check-buy.ts                    # the decline path. Free
node check-manage.ts                 # mints a REAL offer. Run --clean after
node check-deploy.ts <npub>          # relays, Blossom, then the gateway last
node deploy-nsite.ts --dry           # hashes and signs, publishes nothing
```

Record the numbers you get. `/docs/status.md` quotes test counts in several places
(30 / 20 / 8 at the end of slice 5, and some older 27/10 figures further down that
were already stale) and a review pass usually moves them.

**Do not re-litigate the review agent's fixes.** They were reviewing; you are adding.
If a fix looks wrong to you, say so to me in a sentence and carry on with the slice —
do not revert it, and do not "improve" it while you are in the file.

**Reconcile the docs as you go, not at the end.** If `known-defects.md` names
documentation drift, fixing the drift you actually touched is part of this session.
Anything you find and do not fix, add to `known-defects.md` rather than to your final
report, so it survives the conversation.

## Re-derive the live state from the world, not from status.md

`/docs/status.md`'s "What is live right now" table is a snapshot, and the review agent
may have run scripts against the node and the relays. Before you trust any of it:

```bash
export PATH="$HOME/lnd:$PATH"
lncli state && lncli listchannels | grep -E 'active|local_balance|remote_balance'
curl -s http://127.0.0.1:1776/api/health
node spike/mint-offers.ts --dry            # what offers actually exist on the account
node spike/check-deploy.ts <seller-npub>   # what the relays and Blossom actually hold
```

Two numbers that matter and drift with every sale: the node's inbound/outbound, and
`mugs`' remaining stock. `mugs` is the 1,000-sat item that exists so nothing has to
spend `lamp` (30,000) to test plumbing, and one unit was deliberately left unsold for
the stage. If it is gone, say so — that changes what can be demoed live.

## The slice

**`/docs/prompts/slice-6.md` is the brief.** It is committed and current, and it names
the three problems underneath "edit, restock, mark sold, view settled sales, private
notes". Do not re-derive them. The headline so you know what is coming:

**"View settled sales" may have no CLINK path at all.** CLINK Manage's only resource
is `"offer"` (`clink-manage.md:29`) — create, update, get, list, delete. No invoice
resource, no settlement resource. Settled sales live behind `GetUserOfferInvoices`,
a kind 21000 native RPC, which a NIP-46 bunker cannot speak (findings §13.18). So a
browser admin panel behind a Signer **cannot see the seller's sales.** Verify that
against the spec file yourself, then decide what the bullet becomes — it is an
architectural consequence of holding no key, not a missing feature, and it may delete
a line from the slice.

The other two: an edit is a re-cut ladder and possibly a re-minted offer, with a
window in which a stale rung republishes old text over new; and the fixture's five
offers were minted natively, so CLINK Manage cannot see or edit them (findings §13.20).

`/docs/prompts/slice-6-worktree.md` is **superseded** — it exists for the case where
two agents work in parallel, which is not what is happening. Ignore it.

## Also unowned, ranked

If slice 6 stalls on the question above, any of these beats guessing:

1. **Delete the bunker export, or do the import.** `spike/.dev-key.nsec` and
   `spike/.dev-key.qr.svg` have been in the working tree since 2026-08-20. They are
   `chmod 600` and gitignored, and they are **the seller's private key in two more
   formats**. `/docs/status.md` says they go "the moment the import is done" and the
   import has not happened. `export-key-qr.ts --yes` regenerates them when it is time.
   **Ask me before deleting key material** — but do ask, because waiting has a cost
   and nothing else on this list does.

2. **Re-seed, to mirror the fixture's photos.** The last single point of failure in
   the demo: 21 photos on `blossom.band` alone. `seed-listings.ts` already carries the
   slice-5 encoding fix, so one run puts them on four servers. It also re-cuts
   `.ladder.json` and republishes all nine listings, so the watcher must be restarted
   after it, and **it must not happen on demo day.**

3. **The browser run.** Still unrun — no browser has ever driven either app.
   `/docs/prompts/browser-verify-and-deploy.md` is the brief. It wants its own session
   and its own decision about Playwright, so do not fold it into this one; but if the
   review agent did it, read what it found before building any admin UI.

4. **The React question.** Spec §9 defers it to slice 6 explicitly: *"the admin panel
   actually wants tables, dialogs and toasts. If it does, that is a real reason and
   'the spec said React' is not one."* Two things changed since it was written: the
   builder is now itself an nsite fetched blob by blob from a cold gateway, and it
   carries a built storefront in `public/site`. Measure before deciding, and if the
   answer is still no, **delete the line from spec §9** rather than deferring it again.

## Gotchas that will cost an hour each

`/docs/status.md` has the full list. These bite this slice:

- **A NIP-46 bunker cannot speak kind 21000.** In the browser it is CLINK or nothing.
  Reaching for `pub-rpc.ts` in `/builder` means you took a wrong turn (findings §13.18).
- **Manage `list` does not show natively-minted offers.** An empty list on an account
  with seven is not a bug (findings §13.20).
- **CLINK Manage `create` is not idempotent** (`clink-manage.md:226`). N requests, N
  offers. `update` MUST NOT add new fields (`clink-manage.md:193`).
- **Never delete a depleted offer.** It takes the buyer's stored refund pointer with
  it — `GetUserOfferInvoices` is the only reader and it throws once the row is gone
  (findings §13.17). This is also the "mark sold" decision slice 6 owes.
- **`authorize_npub` wants a HEX pubkey despite the name.**
- **The three CLINK error envelopes differ.** One parser for all three is a bug.
- **`pool.subscribeMany` takes a single filter OBJECT** in nostr-tools 2.24.3.
- **`verifyEvent()` caches its verdict on the event object** (findings §13.10).
- **A kind 15128 root site is one per pubkey** (findings §13.22). The builder and the
  storefront have separate identities and must keep them.
- **The gateway caches for an hour.** Verify deploys against the relay and Blossom,
  never against the gateway. `node spike/check-deploy.ts <npub>` does it in that order,
  and reports the gateway last and separately for exactly this reason.
- **Never guess a CLINK kind, field, tag, or error code.** They are in
  `/docs/clink-notes.md` with citations. Write `UNVERIFIED` and ask.

## How to work

- Build only this slice. **No refund code**, even though the "mark sold" decision will
  make it tempting — slice 7 needs a node-enforced frequency cap and a tested
  `BanDebit` kill switch before it goes near a real node, and half of it built early is
  worse than none.
- Tests are `node --test`, no framework, four files across three packages. Add to that
  style; do not start a fifth pattern.
- Anything that talks to the node gets a `spike/check-*.ts` that drives the shipped
  module, the way `check-buy.ts`, `check-manage.ts` and `check-deploy.ts` do. If slice
  6 cannot be verified headlessly, tell me early.
- If the slice contradicts the spec, fix the spec and say so.
- End with something demoable, then stop and report: **what the review pass changed and
  what you had to reconcile**, what you built, what you ran to verify it, what changed
  in `/docs/spec.md` and `/docs/status.md`, and what slice 7 needs from me.
- Commit at the end, do not push.
- Ask before installing anything, before writing outside `/docs`, `/spike`,
  `/storefront` and `/builder`, and before running anything that writes to the node,
  the relays or Blossom.
