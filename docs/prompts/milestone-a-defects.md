# Session brief: milestone A, the code half

Read these in full before writing any code:

1. **`/CLAUDE.md`** — project rules. Rule 2 and the money-path rules are the ones this session
   lives inside.
2. **`/docs/status.md`** — start here, especially "What is genuinely blocked" and the traps list.
3. **`/docs/known-defects.md`**, all of it, and **"Added by the review panel" twice**. Four
   confirmed rows and seven unverified claims are the entire input to this session.
4. **`/README.md`** § Roadmap, milestone A — items 1, 2, 3, 4, 5.
5. **`/docs/roadmap-review-findings.md`** — the 2026-08-23 review. Findings 1, 9 and 18 and the
   "Items that hold up as written" section are about this session's items specifically. **Several
   things in it are already resolved; do not re-derive them.**
6. `/docs/spec.md` §7.3 (the refund design), §12 (security requirements).
7. `/docs/spike-findings.md` §10, §13.27, §13.28, §13.29 — the credential split, the grant path,
   why `k1` cannot carry idempotency, and the cap firing.

Then read `/spike/watch-sales.ts`, `/spike/refund.ts`, `/spike/authorize-refunds.ts`,
`/builder/src/manage.ts`, `/builder/src/main.ts` and `/storefront/src/render.ts` — the six files
this session touches.

## The job

**Close every confirmed defect on the money and authoring paths, and turn the seven unverified
panel claims into ledger entries.** Items 1, 2, 3, 4 and 5.

When this is done, milestone A's claim is *"nothing known-broken can lose money or destroy a
seller's work"*, and item 6 — the real refund, which is the demo beat — becomes runnable. It is
not runnable today: `docs/known-defects.md` is explicit that the watcher should not be pointed at
a real node until 1 and 2 land, and item 6 depends on 1, 2 and 4.

**Nothing in this session spends a satoshi.** All of it is code plus `node --test`. The one thing
that wants the live node is item 2's assertion, and `check-refund.ts` already proves the cap and
the ban without moving money (findings §13.29). If you find yourself about to pass `--pay` or
`--refunds` without `--once`, stop and ask.

## What is NOT in this session, and why

- **Item 9 (the startup reconcile).** Its shape changed on 2026-08-23 — it prompts rather than
  transitions — and an interactive prompt on a daemon's startup path is a design decision, not a
  fix. It also cannot be *proven* until a refund has actually been paid, which is item 6. It is the
  natural next session.
- **Item 10 (backups).** Ops, a second machine, and a restore drill. Not a code session.
- **Item 25 (empty string satisfies a required `payer_data` key).** One free wire test against the
  node, then a decision about whether to narrow three documents' claims or file upstream. Take it
  as a stretch if items 1-5 land early; do not let it displace them.
- **Item 7 (the browser run).** Blocked on a phone, runs in parallel, gates nothing here.

## The problems that are not in the one-line description

Line numbers below were verified against the tree on **2026-08-23**. Re-check them before trusting
one; this repo has had two mis-citations that each cost an afternoon.

### 1. There are two timers, and the guard only covers one

Item 1's fix is *"`let ticking = false` around the interval callback"*. There are **two**
`setInterval`s in `watch-sales.ts`: the tick at `:520` (`POLL_MS = 5_000`, `:92`) and a
`summarise()` at `:523` on a five-minute loop, installed only under `--refunds`. Decide explicitly
whether `summarise` can overlap a refunding tick and whether that matters — it reads the journal
and the node's outgoing payments, so it is a reader, but say so rather than assuming it.

`--once` never installs either timer: `:512-518` runs one `await tick()`, then `summarise()`, then
exits. **So the regression test cannot drive the timer.** It has to call `tick` (or the function
under it) twice with overlapping awaits against a stub. That is the whole reason this bug survived
27 spike tests.

### 2. The second fix turns the journal into a state machine, and something already reads it

*"`if (journal[row.invoice]?.state === 'paid') return` at the top of `record`"* makes the journal
monotonic. `record` is at `:361` and writes `journal[row.invoice] = {…}` unconditionally at `:370`.

Before landing it: **grep every writer and every reader of a journal row's `state`.** `settledByUs`
reads it to decide retryability, and there are four states in play (`pending`, `paid`, `failed`,
`queued`). If any legitimate flow needs to move a row *out* of `paid`, a blanket return breaks it
silently — which is the same class of bug as the one being fixed. If none does, say so in the
commit rather than leaving it inferred.

Land both fixes even though either alone breaks the chain. The ledger's reasoning is that the
second is the one that survives someone later adding a concurrent caller, and that is right.

### 3. The kill switch has two branches, and reading the grant back makes it *more* reliable, not less

`authorize-refunds.ts` mints the refund key at `:119`, above **both** downstream branches:
`--revoke` at `:191` and `--reset` at `:202`. Both dereference the same `refundPub`. A fix that
guards only `--revoke` leaves a second switch that improvises a key and reports success.

The third bullet — read the granted pubkey back from `GetDebitAuthorizations` and ban *that* —
has a helper already: `grants()` at `:169`, which `--revoke` calls at `:194`, one line after it
prints `BANNED`. So the change is a reordering.

The objection to anticipate: *"now the kill switch needs the node."* It already does — `BanDebit`
is an RPC. Requiring the node is unavoidable; requiring the node **and** a local file is strictly
worse. Reading the pubkey from the node removes a failure mode rather than adding one. Write that
down, because it will look like added coupling to the next reader.

### 4. Half of item 4's fixes already exist, and one of them cannot be built in the current shape

Read `spike/refund.ts:200-260` before writing anything.

- **"Require https" is done.** `lnurlpUrl` (`:202-212`) builds `https://` by construction and
  guards the name half with `encodeURIComponent` against path traversal. `payRequestCallback`
  (`:215-234`) refuses a non-https callback at `:221` and re-checks `url.protocol` at `:227`. Do
  not rewrite these.
- **"Cap the redirect chain" is partly free.** `getJson` (`:245-258`) passes `redirect: 'follow'`,
  which inherits undici's default cap of 20. A hard cap is cheap, but it is not the interesting
  half.
- **The interesting half is that `redirect: 'follow'` makes a per-hop check impossible.** The
  roadmap says *"re-check after each redirect"*, and you cannot, because `fetch` follows them
  internally and hands you the final response. That forces `redirect: 'manual'` plus an explicit
  loop. **This is the real cost of item 4 and it is not in the one-line description.**
- **The private-address check is a TOCTOU trap.** `dns.resolve()` followed by `fetch(url)` re-
  resolves the name and is security theatre — a hostile pointer's DNS can answer differently the
  second time. The shapes that actually hold are a custom `undici` dispatcher with a `lookup` hook
  that vets each connection, or connecting to a vetted IP with an explicit `Host` header. **Pick
  one deliberately and say why**; if both turn out to cost more than this session has, an honest
  ledger row saying "the check is best-effort and here is the hole" beats a check that reads as a
  guarantee.
- **The body bound.** `getJson` does `const text = await res.text()` and checks `MAX_BODY_BYTES`
  on the line after (`:256-257`), so the 64 KB bound bounds nothing. Count bytes off the stream
  and abort. This one is small and unambiguous.

Both of these are **panel claims that have never been reproduced.** Reproduce first — a local
listener and a pointer aimed at it is a five-minute test — then fix. The ledger's own rule is that
a claim becomes an entry either way.

### 5. Two of the seven claims are already settled, and one is a copy fix

Item 5 is triage, not implementation. What the 2026-08-23 review already established, so you do
not spend the session re-deriving it:

- **`watch-sales.ts:327` was the wrong line.** The `k1` is sent at `:335`. And
  `spike/ndebit.ts:82-86` already reads `clink-debits.md:167-171` as a MUST that binds *when TLV 3
  is present* — so sending a `k1` without one is not obviously forbidden. **Refute it or find a
  better citation; do not act on it as written.**
- **`render.ts:521` is real, and the trigger is narrower than "a rejection".** `submit.disabled`
  and `field.disabled` are set at `:517-518`, the re-enable is at `:540`, and there is no `try`.
  But `attempt` in `buy.ts` resolves rather than rejects on every network and protocol path — one
  `finish()` per branch plus a deadline. The reachable throws are **synchronous, before the
  promise**: `getConversationKey(sk, offer.pubkey)` at `buy.ts:130` on a pubkey that is not a valid
  curve point. So the fix is a `try`/`catch` **and** a question about whether `buyableOffer` should
  be refusing that offer upstream. One `node --test` case with a malformed offer pubkey is both the
  proof and the regression test.
- **`builder/index.html:206`** promises the seller "refund pointers" from `sales-report.ts`, which
  deliberately prints presence and never the value. One-line copy fix, no behaviour change.
- **`admin.ts:82`** — the line is `if (!sha256 || !SHA256.test(sha256) || !photo.w || !photo.h)
  return null`. Verified as cited. **Unverified: whether NIP-58 and Gamma really make the dimension
  element optional.** Read the specs before changing it; if the NIPs repo is not on this machine,
  re-fetch and cite, never recall.
- **`main.ts:507`** is `showSale()` inside `loadPanel`. Verified as cited. Unverified: whether it
  actually discards typed input in practice. Reproduce.

### 6. The `mintOffer` fix will look like it does nothing on the fixture

Item 3's first defect: `builder/src/manage.ts:170` is `existing?.find(o => o.label === label)` —
dedupe on label alone, so a price edit leaves two same-label offers and every later retry mints a
third. The fix is to match on the pair, label **and** the TLV-4 price.

The thing that will waste an hour: `listOffers` is CLINK Manage `list`, and **Manage `list` cannot
see natively-minted offers** (findings §13.20 — `management_pubkey` partitions the set,
asymmetrically). The fixture's five offers were minted natively. So an empty `list` against the
fixture account is correct behaviour, not a broken fix. Test against a Manage-created offer.

### 7. Item 3's second defect has two candidate fix sites and the ledger prefers the wrong one

`#publish-sale` is enabled synchronously at `builder/src/main.ts:116`
(`$('#publish-sale').toggleAttribute('disabled', !signer)`), before `void loadPanel()` resolves.
A click in that window signs a kind 30405 with an empty member list.

The ledger names both fixes: *"Enable `#publish-sale` from `loadPanel`'s completion rather than
from `showSigner`, or gate `doPublishSale` on a `panelLoaded` flag. The first is smaller; the
second survives someone adding another entry point."*

Prefer the second, or both. A guard at the enable site protects one path; a guard inside
`doPublishSale` (`:357`) protects every caller. The roadmap's own bullet also asks for the *reason*
in the button label — a disabled control with no explanation is its own defect.

## Traps that will cost an hour each

`/docs/status.md` has the full list. These bite this session:

- **`watch-sales.ts` spends only with `--refunds`.** Every other invocation is slice 3's watcher
  exactly as it was. Do not add refunds to a default path.
- **Never log a refund pointer or a preimage.** The journal stores the *kind* of pointer
  (`'noffer'`/`'address'`/`'none'`) and whether a preimage existed, never either value.
- **CLINK's `k1` is in-memory with a 5-minute TTL and is consumed before validation.** Never build
  durable idempotency on it. `RETRY_AFTER_S = 6 * 60` exists to outlast it.
- **A debit frequency cap set to the node's balance can never fire.** Prove a cap by moving it
  down and crossing it. **Note this changed on 2026-08-23**: the account is at 9,000 against an
  8,000/day cap, so the cap now binds first for the first time — spec §12 says to re-decide the
  number rather than inherit it.
- **A debit expiry rule DELETES the grant** on first use after it lapses. Re-arming is the whole
  authorisation dance again. The live grant expires **2026-09-20**.
- **Manage `list` does not show natively-minted offers.** See problem 6 above.
- **Tests are `node --test`, no framework, three suites** — 58 storefront, 58 builder, 27 spike.
  **Do not start a fourth pattern.**
- **The storefront's byte budget is 33 KB gzip and slice 9 went 10 bytes over it.** Any change to
  `render.ts` or `buy.ts` costs bytes; report the delta. Use `npm run build`'s numbers, not
  `npm run size`'s — they differ by ~0.7% and mixing them is how a bundle appears to shrink.
- **`/docs/spec.md` §10's slice lines are a plan written before the answers.** And so is any
  roadmap item: **check whether each thing already exists before building it, and whether it can
  exist before scoping it.** Problem 4 above is this session's example — half of item 4 is already
  written and one bullet cannot be built in the current shape.

## How to work

- Fix the root cause, not the reported symptom. Two of these items name one call site and share a
  defect with a sibling — item 2's `--reset`, item 3's second entry point. Grep every caller before
  editing.
- Every non-trivial fix leaves one runnable check behind, in the existing `node --test` style. The
  race in item 1 specifically needs a test with two overlapping ticks against a stub asserting one
  payment — that test is the deliverable as much as the guard is.
- A claim you cannot reproduce is a **refutation**, and it belongs in the ledger with the reasoning.
  Do not leave a claim in limbo because it was inconvenient.
- Never guess a protocol detail. If the NIPs or CLINK specs are needed and not on this machine,
  re-fetch and cite. `UNVERIFIED` and a question beats a plausible answer.
- Ask before installing anything, and before writing outside `/docs`, `/spike`, `/storefront` and
  `/builder`.
- The branch is `review-fixes-slices-0-5` and it is pushed. Branch off it or continue on it —
  ask — but do not commit to `main`.

## End with

Stop and report:

1. What landed, per item, with the test that covers it.
2. **Which of the seven panel claims were reproduced and which were refuted**, each with its
   reasoning, and move all seven into `/docs/known-defects.md` either way — the "Verified by
   nobody" section should be empty when this session ends.
3. What item 4 turned out to actually cost, and whether the per-hop private-address check got built
   or got an honest ledger row.
4. The storefront gzip delta, if `render.ts` was touched.
5. What changed in `/docs/spec.md` and `/docs/status.md`, per `/CLAUDE.md`'s "after each slice"
   rule.
6. **Whether milestone A's claim is now true** — "nothing known-broken can lose money or destroy a
   seller's work" — or which item is still standing between here and it. Item 6 is what unblocks
   next, so say plainly whether it is safe to run.

Commit at the end. Do not roll into item 9.
