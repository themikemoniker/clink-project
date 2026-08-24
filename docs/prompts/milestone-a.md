# Session brief: milestone A, all of it, in one PR

Supersedes `milestone-a-defects.md` (the code-only version, `a93baaa`). That brief scoped items
1-5 and deferred 9, 10 and 25 to a later session. They are in scope now, together with the tests,
the ledger, the roadmap and the PR — **milestone A ships as one branch and one pull request.**

Read these in full before writing any code:

1. **`/CLAUDE.md`** — project rules. Rule 2 and the money-path rules are the ones this session
   lives inside.
2. **`/docs/status.md`** — start here, especially "What is genuinely blocked" and the traps list.
3. **`/docs/known-defects.md`**, all of it, and **"Added by the review panel" twice**. Four
   confirmed rows and seven unverified claims are the entire defect input to this session.
4. **`/README.md`** § Roadmap, milestone A — items 1, 2, 3, 4, 5, 9, 10, 24, 25. Item **24 is
   already done** (`ac87512`, `sales-report.ts:56` is `arg('key', '.dev-key')`); do not redo it.
5. **`/docs/roadmap-review-findings.md`** — the 2026-08-23 review. Findings 1, 9, 13 and 18 and
   the "Items that hold up as written" section are about this session's items specifically.
   **Several things in it are already resolved; do not re-derive them.**
6. `/docs/spec.md` §7.3 (the refund design), §12 (security requirements).
7. `/docs/spike-findings.md` §10, §13.17, §13.20, §13.27, §13.28, §13.29 — the credential split,
   the depleted-offer behaviour, the Manage/native partition, the grant path, why `k1` cannot
   carry idempotency, and the cap firing.

Then read `/spike/watch-sales.ts`, `/spike/refund.ts`, `/spike/authorize-refunds.ts`,
`/spike/sales-report.ts`, `/builder/src/manage.ts`, `/builder/src/main.ts` and
`/storefront/src/render.ts` — the seven files this session touches.

## The job

**Make milestone A's claim true and land it as one reviewable PR:** *"nothing known-broken can
lose money or destroy a seller's work."*

That is items **1, 2, 3, 4, 5, 9, 10 and 25**, plus the two roadmap corrections the review found
and nobody applied, plus the tests, the ledger, the docs and the PR itself.

When this lands, item 6 — the real refund, which is the demo beat — becomes runnable. It is not
runnable today: `docs/known-defects.md` is explicit that the watcher must not be pointed at a real
node until 1 and 2 land, and item 6 depends on 1, 2 and 4.

**One satoshi is at stake in this whole session and it is item 25's**, which is a free wire test —
no `--pay`. Everything else is code plus `node --test`. If you find yourself about to pass `--pay`
or `--refunds` without `--once`, stop and ask.

## Order of work

The dependencies are real; this order is not a preference.

1. **1** — the in-flight guard and the monotonic journal. Everything downstream reads that journal.
2. **2** — the kill switch. With 1, this is what `known-defects.md` gates the real node on.
3. **4** — hostile input on the refund path. Item 6 needs it.
4. **9** — the startup reconcile. Builds on 1's monotonic `record`; do it after, not beside.
5. **3** + the two bullets of **13** that belong with it (see below). Same button, same class of loss.
6. **5** — triage the seven claims. Fix the one marked *fix on sight*.
7. **25** — one free wire test, then a decision.
8. **10** — the backup classification, procedure and restore drill.
9. Ledger, roadmap, docs, PR.

## What is NOT in this session

- **Item 6 (pay one real refund).** Milestone B, blocked on a phone and a funded wallet. This
  session's job is to make it *safe to run*, and to say plainly at the end whether it is.
- **Item 7 (the browser run).** Blocked on a phone, runs in parallel, gates nothing here.
- **Item 26 (the builder's nsite key).** A one-way decision that should be made soon, but it is
  not a defect and it does not belong in this diff.
- **Item 13's `refuse-to-shrink` bullet.** It stays in D. See "the two corrections" below — only
  two of item 13's three bullets come forward.

## The problems that are not in the one-line description

Line numbers below were verified against the tree on **2026-08-24**. Re-check them before trusting
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
monotonic. `record` is at `:361` and writes `journal[row.invoice] = {…}` unconditionally at `:370`;
`writeJournal` follows at `:380`.

Before landing it: **grep every writer and every reader of a journal row's `state`.** `settledByUs`
reads it to decide retryability, and there are four states in play (`pending`, `paid`, `failed`,
`queued`). If any legitimate flow needs to move a row *out* of `paid`, a blanket return breaks it
silently — which is the same class of bug as the one being fixed. If none does, say so in the
commit rather than leaving it inferred.

Land both fixes even though either alone breaks the chain. The ledger's reasoning is that the
second is the one that survives someone later adding a concurrent caller, and that is right.

### 3. The kill switch has two branches, and reading the grant back makes it *more* reliable, not less

`authorize-refunds.ts` mints the refund key at `:120` (`writeFileSync(REFUND_KEY_FILE, …
generateSecretKey() …)`), above **both** downstream branches: `--revoke` at `:191` and `--reset` at
`:202`. Both dereference the same `refundPub` (`:124`). A fix that guards only `--revoke` leaves a
second switch that improvises a key and reports success.

The third bullet — read the granted pubkey back from `GetDebitAuthorizations` and ban *that* — has
a helper already: `grants()`, which `--revoke` calls at `:194`, one line after it prints `BANNED`.
So the change is a reordering.

The objection to anticipate: *"now the kill switch needs the node."* It already does — `BanDebit`
is an RPC. Requiring the node is unavoidable; requiring the node **and** a local file is strictly
worse. Reading the pubkey from the node removes a failure mode rather than adding one. Write that
down, because it will look like added coupling to the next reader.

### 4. Half of item 4's fixes already exist, and one of them cannot be built in the current shape

Read `spike/refund.ts:200-260` before writing anything.

- **"Require https" is done.** `lnurlpUrl` builds `https://` by construction and guards the name
  half with `encodeURIComponent` against path traversal. `payRequestCallback` refuses a non-https
  callback and re-checks `url.protocol`. Do not rewrite these.
- **"Cap the redirect chain" is partly free.** `getJson` (`:246`) passes `redirect: 'follow'`,
  which inherits undici's default cap of 20. A hard cap is cheap, but it is not the interesting
  half.
- **The interesting half is that `redirect: 'follow'` makes a per-hop check impossible.** The
  roadmap says *"re-check after each redirect"*, and you cannot, because `fetch` follows them
  internally and hands you the final response. That forces `redirect: 'manual'` plus an explicit
  loop. **This is the real cost of item 4 and it is not in the one-line description.**
- **The private-address check is a TOCTOU trap.** `dns.resolve()` followed by `fetch(url)`
  re-resolves the name and is security theatre — a hostile pointer's DNS can answer differently
  the second time. The shapes that actually hold are a custom `undici` dispatcher with a `lookup`
  hook that vets each connection, or connecting to a vetted IP with an explicit `Host` header.
  **Pick one deliberately and say why**; if both cost more than this session has, an honest ledger
  row saying "the check is best-effort and here is the hole" beats a check that reads as a
  guarantee.
- **The body bound.** `MAX_BODY_BYTES` is declared at `:238`; `getJson` does `const text = await
  res.text()` and checks it at `:257`, one line later, so the 64 KB bound bounds nothing. Count
  bytes off the stream and abort. This one is small and unambiguous.

Both of these are **panel claims that have never been reproduced.** Reproduce first — a local
listener and a pointer aimed at it is a five-minute test — then fix. The ledger's own rule is that
a claim becomes an entry either way.

### 5. Item 9's shape changed on 2026-08-23, and the change is the whole item

The old brief deferred item 9 because *"an interactive prompt on a daemon's startup path is a
design decision, not a fix."* That is still true, so **make the decision and write it down** —
that is the first deliverable of this item, before any code.

What the review settled (findings §1), and what you must not undo: a `pending` row with a matching
outgoing payment produces a **prompt, never a transition**. The ledger is explicit that a match on
amount and time alone is evidence for a human and a different thing as an input to whether money
moves. Marking a row `paid` on that heuristic strands a buyer whose refund never went — a new way
for milestone A to lose money, not a guard against one. The roadmap as originally written got this
backwards and the review reversed it.

The parts that are already built, so you do not rebuild them:

- `matchingPayments(ops, sats, at)` at `refund.ts:167`, with amount and ±15-minute window tests
  already at `refund.test.ts:216-237`.
- `sales-report.ts --outgoing` (`:61`, `:201` `GetUserOperations`, `:218`) is the reporting half.
- `readJournal` at `refund.ts:115`; `JOURNAL_FILE = suffixed('.refunds.json')` at
  `watch-sales.ts:87`, already multi-seller; `journal` is loaded at `:120` **only under
  `--refunds`**, which is where the reconcile belongs.

What to build:

- At watcher startup under `--refunds`, read the node's outgoing payments and match them against
  journal rows.
- A `pending` row with a match **prompts** — *"the node has one 1,000-sat payment 40 seconds after
  this row was written — mark it paid? [y/N]"*. Decide and document what a non-TTY start does. A
  daemon under launchd has no stdin; a prompt that silently defaults is worse than either answer.
  Refusing to start is defensible, running with the row untouched and a loud log line is
  defensible, guessing is not.
- An oversell with **no journal row but a matching outgoing payment blocks the refund** and says
  why, rather than paying again.
- **Refuse to start with `--refunds` when the journal is missing but the node shows outgoing
  payments.** That is the "restored an old file" case and it must be loud.
- Tests: a pending row with a match, a pending row without one, an oversell with a matching
  payment and no row, and the missing-journal refusal. All against a stub — none of them touch
  the node.

Item 9 can only be *proven* once a real refund has been paid, which is item 6. Build it here, say
so in the PR body, and leave the proof to milestone B.

### 6. Item 10 is three different failure modes wearing one label

Sort the gitignored load-bearing files before writing any procedure. Verified present in `spike/`:
`.builder-key`, `.deploy-test-key`, `.dev-key`, `.merida-key`, `.ladder.json`,
`.merida-key.ladder.json`, `.merida-key.offers.json`, `.merida-key.nmanage`, `.offers.json`,
`.nmanage`, `.ndebit`, `.refund-key`.

- **Gone forever if lost:** `.builder-key`, `.deploy-test-key`. A kind 15128 root site is one per
  pubkey, so losing `.builder-key` loses the builder's nsite URL permanently. Neither holds funds,
  which is the only reason this is survivable at all. (This is also why item 26 exists — note the
  link, do not decide it here.)
- **Regenerable, but only by redoing work:** `.refund-key` (a new one needs the whole
  authorisation dance, and the live grant expires **2026-09-20**) and `.ladder.json`
  (`seed-listings.ts` re-cuts it, and the watcher must then be restarted).
- **Regenerable by nothing:** `.refunds.json`. That is item 9's entire reason for existing; say so
  in both places.
- The seller key backup exists **on one machine only**. Getting a copy off it is ⚑ — it is a human
  step with a second device, not something to do from this session. Write the procedure, name the
  step, and flag it in the PR body as the one thing the PR does not close.
- **Run one restore drill** and put the transcript in the PR: restore into a scratch directory,
  prove the watcher starts against it, prove `sales-report.ts --key` reads the right account.
  A procedure that has never been run is a belief.
- `.gitignore` already globs `spike/.*-key` and `spike/.*-key.*` on purpose — read the comment
  above those lines before touching it. Do not narrow it.

### 7. Item 25 is a claim in three documents, not a bug in our code

`ValidateExpectedData` checks only `typeof payerData[key] !== 'string'`, so `{"refund_pointer": ""}`
passes and the node issues the invoice. **Our page is safe** — `render.ts` gates on `isPointer`
before requesting — which is why nobody has hit it.

What it costs is a **claim**, in three places: spec §7.3's *"a payment that would be unrefundable is
therefore declined rather than accepted"*, design.md §4's *"unpayable by anything that cannot supply
`refund_pointer`"*, and slice 8's re-decision, which argues the alternative would produce a `queued`
row no human can act on. An empty pointer produces exactly that row.

- Drive it once against the live node — **free, no `--pay`** — and record the transcript.
- Then either narrow the three claims to what is actually true, or file it upstream beside items 21
  and 22. Both are acceptable; leaving three documents overstating a guarantee is not.
- **Do not weaken the form.** The page's `isPointer` gate is the thing that makes the claim true
  for our buyers, and it stays.
- M5 inherits this hole for its pickup code, so settling it here is what unblocks that later.

### 8. The `mintOffer` fix will look like it does nothing on the fixture

Item 3's first defect: `builder/src/manage.ts:170` is `existing?.find(o => o.label === label)` —
dedupe on label alone, so a price edit leaves two same-label offers and every later retry mints a
third. The fix is to match on the pair, label **and** the TLV-4 price.

The thing that will waste an hour: `listOffers` is CLINK Manage `list`, and **Manage `list` cannot
see natively-minted offers** (findings §13.20 — `management_pubkey` partitions the set,
asymmetrically). The fixture's five offers were minted natively. So an empty `list` against the
fixture account is correct behaviour, not a broken fix. Test against a Manage-created offer.

### 9. Item 3's second defect has two candidate fix sites and the ledger prefers the wrong one

`#publish-sale` is enabled synchronously at `builder/src/main.ts:116`
(`$('#publish-sale').toggleAttribute('disabled', !signer)`), before `void loadPanel()` resolves.
`owned` is `[]` until `loadPanel` assigns it at `:501`. A click in that window signs a kind 30405
with an empty member list and un-lists the whole sale.

The ledger names both fixes: *"Enable `#publish-sale` from `loadPanel`'s completion rather than from
`showSigner`, or gate `doPublishSale` on a `panelLoaded` flag. The first is smaller; the second
survives someone adding another entry point."*

Prefer the second, or both. A guard at the enable site protects one path; a guard inside
`doPublishSale` (`:340`) protects every caller. The roadmap's own bullet also asks for the *reason*
in the button label — a disabled control with no explanation is its own defect.

### 10. Two of the seven claims are already settled, and one is a copy fix

Item 5 is triage, not implementation. What the 2026-08-23 review already established, so you do not
spend the session re-deriving it:

- **`watch-sales.ts:327` was the wrong line.** The `k1` is sent at `:335`. And `spike/ndebit.ts:82-86`
  already reads `clink-debits.md:167-171` as a MUST that binds *when TLV 3 is present* — so sending
  a `k1` without one is not obviously forbidden. **Refute it or find a better citation; do not act
  on it as written.**
- **`render.ts:521` is real, and the trigger is narrower than "a rejection".** `submit.disabled` and
  `field.disabled` are set at `:517-518`, `const outcome = await requestInvoice(` is at `:521`, the
  re-enable is at `:540`, and there is no `try`. But `attempt` in `buy.ts` resolves rather than
  rejects on every network and protocol path — one `finish()` per branch plus a deadline. The
  reachable throws are **synchronous, before the promise**: `getConversationKey(sk, offer.pubkey)`
  at `buy.ts:130` on a pubkey that is not a valid curve point. So the fix is a `try`/`catch` **and**
  a question about whether `buyableOffer` should be refusing that offer upstream. One `node --test`
  case with a malformed offer pubkey is both the proof and the regression test.
- **`builder/index.html:206`** promises the seller "refund pointers" from `sales-report.ts`, which
  deliberately prints presence and never the value. One-line copy fix, no behaviour change.
- **`admin.ts:82`** — the line is `if (!sha256 || !SHA256.test(sha256) || !photo.w || !photo.h)
  return null`. Verified as cited. **Unverified: whether NIP-58 and Gamma really make the dimension
  element optional.** Read the specs before changing it; if the NIPs repo is not on this machine,
  re-fetch and cite, never recall.
- **`main.ts:507`** is `showSale()` inside `loadPanel`. Verified as cited. Unverified: whether it
  actually discards typed input in practice. Reproduce.

## The two corrections the review found and nobody applied

Both are in `docs/roadmap-review-findings.md` and neither made it into the README. You are editing
the roadmap in this PR anyway, so this is where they land.

**Finding §13 — item 13 is mis-placed. Half of one button is in A and the other half is in D.**
Item 3's second defect and item 13 are the same button: `#publish-sale` → `doPublishSale` →
`publishSale(signer, draft, owned.map(…))` at `main.ts:357`. Item 3 fixes *"fires before `owned` is
populated"*; item 13 fixes *"fires when `owned` is short"*. Fix one and the button can still drop
items — which is a kind 30405 replacement that un-lists real listings, exactly the loss A claims to
have closed.
- Bring item 13's **quorum** and **show-the-count** bullets into A, build them beside item 3.
  `main.ts:334` is already `const n = owned.length`, so the count is a display away.
- Item 13's **refuse-to-shrink** bullet **stays in D**, because shrinking is also what a legitimate
  delete looks like, and it entangles with M3 (findings §4). Do not build it here.
- Update the README so item 13 says this, rather than leaving the correction only in the findings.

**Finding §18 — items 5 and 17 are the same fix, scheduled twice.** Item 17's first bullet ("wrap
the Buy form's `requestInvoice`") is item 5's first bullet. Delete it from item 17 in milestone E;
item 5 owns it and closes it here. Item 17 keeps its second bullet (`noBuyReason` collapsing two
different failures into one sentence), which is a separate and still-open thing.

## Tests

- **`node --test`, no framework, three suites** — 58 storefront, 58 builder, 27 spike. **Do not
  start a fourth pattern**, do not add a runner, do not add a fixture library.
- Run all three before opening the PR: `cd storefront && npm test`, `cd builder && npm test`,
  `cd spike && npm test`. Report the counts before and after.
- Every non-trivial fix leaves one runnable check behind. Specifically:
  - **1** — two overlapping ticks against a stub, asserting **one** payment. This test is the
    deliverable as much as the guard is; it is the test the existing 27 did not have.
  - **1b** — a late `failed` cannot overwrite a `paid` row.
  - **2** — after `--revoke`, the grant list no longer contains the key. `check-refund.ts` already
    proves the cap and the ban without moving money (findings §13.29); extend it there rather than
    inventing a second harness. Also assert that both `--revoke` and `--reset` **refuse to run**
    with the key file absent.
  - **4** — a response larger than `MAX_BODY_BYTES` aborts mid-stream; a pointer resolving to a
    private or loopback address is refused; the redirect chain is capped.
  - **9** — the four cases named in problem 5 above, all against a stub.
  - **3** — a price edit does not mint a third offer; `doPublishSale` refuses before `loadPanel`
    settles.
  - **13** — a member list short of quorum does not publish.
  - **5** — a malformed offer pubkey does not leave the Buy form permanently disabled.
- **The storefront's byte budget is 33 KB gzip and slice 9 went 10 bytes over it.** Any change to
  `render.ts` or `buy.ts` costs bytes; report the delta. Use `npm run build`'s numbers, not
  `npm run size`'s — they differ by ~0.7% and mixing them is how a bundle appears to shrink.

## The administrative half

All of it in the same PR. None of it is optional — `/CLAUDE.md`'s "after each slice" rule is a
project rule, not a nicety.

**`/docs/known-defects.md`**
- The four confirmed rows for items 1, 2 and 3 get struck through and marked `CLOSED 2026-08-24`
  with the commit, in the same style as the slice-7 row that closed the idempotency defect.
- **All seven "Verified by nobody" claims move out**, each either into the ledger as an entry or
  into the refuted list with its reasoning. **That section should be empty when this session ends.**
  A claim you could not reproduce is a refutation and belongs in writing; do not leave one in limbo
  because it was inconvenient.
- Any new hole item 4 or 9 leaves open (the best-effort private-address check, the non-TTY prompt
  path) gets its own honest row.

**`/README.md`** § Roadmap
- Mark items 1, 2, 3, 4, 5, 9, 10 and 25 done in milestone A, in the style item 23 already uses —
  struck through with what was actually found, not silently deleted. **Task IDs are stable**
  (`README.md` says so explicitly): mark them, never renumber them.
- Apply the two corrections above: item 13's two bullets into A, item 17's first bullet deleted.
- Re-cut the "milestones at a glance" table: A's task list, and item 13 now appearing in both A and
  D with the split named.
- If item 10's ⚑ human step is still open, say so on the milestone rather than claiming A closed.
- Update A's own claim line to say whether it is now true, and state plainly that item 6 is
  unblocked.

**`/docs/status.md`**
- New "Last updated" date and a summary paragraph for this work. It is the handoff note; the next
  session reads it first.
- The traps list changes: the kill switch now reads the pubkey from the node, and the watcher now
  reconciles at startup. Both change what an operator does.

**`/docs/spec.md`**
- §7.3 if item 4 or 9 changed the refund design; §12 if the security requirements moved.
- Item 25's outcome: either narrow §7.3's "declined rather than accepted" claim to what is true, or
  record that it was filed upstream and stays as written.

**`/docs/runbook.md`**
- The backup and restore procedure from item 10, with the drill transcript's key lines.
- The kill switch's new behaviour, because the runbook is where somebody looks at 3am.

## The PR

- The branch is `review-fixes-slices-0-5`, clean and in sync with `origin` as of 2026-08-24.
  **Branch off it for this work** — `milestone-a` is the obvious name — and do not commit to `main`.
- **One commit per item**, in the order above. The PR is large by the user's explicit choice; atomic
  commits are what make it reviewable, and a reviewer must be able to read the money-path fixes
  without wading through the roadmap edit. Docs and roadmap are the last commit.
- Commit messages in this repo's house style: what broke, what it cost, what changed, and the
  reasoning that will not be obvious in six months. Read `ac87512` for the pattern.
- `gh pr create` against `main`. The PR body must carry:
  - The per-item table: what landed, the test that covers it, and the file it is in.
  - **Which of the seven panel claims were reproduced and which were refuted**, each with its
    reasoning.
  - What item 4 actually cost, and whether the per-hop private-address check got built or got an
    honest ledger row.
  - Item 9's non-TTY decision and why.
  - Item 25's wire-test transcript and which way the decision went.
  - Item 10's drill result, and the ⚑ human step the PR does not close.
  - The storefront gzip delta if `render.ts` or `buy.ts` was touched.
  - Test counts before and after, all three suites.
  - **Whether milestone A's claim is now true**, and a plain yes/no on whether item 6 is safe to run.
- Do not merge. Open it and stop.

## Traps that will cost an hour each

`/docs/status.md` has the full list. These bite this session:

- **`watch-sales.ts` spends only with `--refunds`.** Every other invocation is slice 3's watcher
  exactly as it was. Do not add refunds to a default path — and item 9's reconcile belongs inside
  that same gate.
- **Never log a refund pointer or a preimage.** The journal stores the *kind* of pointer
  (`'noffer'`/`'address'`/`'none'`) and whether a preimage existed, never either value. Item 9's
  prompt text and item 10's backup procedure both risk printing one; neither may.
- **CLINK's `k1` is in-memory with a 5-minute TTL and is consumed before validation.** Never build
  durable idempotency on it. `RETRY_AFTER_S = 6 * 60` exists to outlast it.
- **A debit frequency cap set to the node's balance can never fire.** Prove a cap by moving it down
  and crossing it. **Note this changed on 2026-08-23**: the account is at 9,000 against an 8,000/day
  cap, so the cap now binds first for the first time — spec §12 says to re-decide the number rather
  than inherit it.
- **A debit expiry rule DELETES the grant** on first use after it lapses. Re-arming is the whole
  authorisation dance again. The live grant expires **2026-09-20**.
- **Manage `list` does not show natively-minted offers.** See problem 8 above.
- **`sales-report.ts` now takes `--key`, and most of the repo's muscle memory predates it.** A
  command without it reports the default seller. Item 10's drill and item 9's reconcile both have
  to be seller-aware; `watch-sales.ts:80` and `sales-report.ts:56` are both `arg('key', '.dev-key')`
  now, so match that shape rather than inventing a third.
- **`/docs/spec.md` §10's slice lines are a plan written before the answers.** And so is any roadmap
  item: **check whether each thing already exists before building it, and whether it can exist
  before scoping it.** Problem 4 is this session's example — half of item 4 is already written and
  one bullet cannot be built in the current shape. Problem 5 is the other — `matchingPayments` and
  `--outgoing` are already there.

## How to work

- Fix the root cause, not the reported symptom. Several of these items name one call site and share
  a defect with a sibling — item 2's `--reset`, item 3's second entry point, item 13's second
  failure mode of item 3's button. Grep every caller before editing.
- A claim you cannot reproduce is a **refutation**, and it belongs in the ledger with the reasoning.
- Never guess a protocol detail. If the NIPs or CLINK specs are needed and not on this machine,
  re-fetch and cite. `UNVERIFIED` and a question beats a plausible answer.
- Ask before installing anything, and before writing outside `/docs`, `/spike`, `/storefront` and
  `/builder`.
- **Stop and ask rather than guessing** on: item 9's non-TTY behaviour if the reasoning does not
  settle it, item 4's private-address shape if both options overrun, and anything that would spend.

## End with

Stop and report — the PR body above is most of this, so write it once and reuse it:

1. What landed, per item, with the test that covers it.
2. Which of the seven panel claims were reproduced and which were refuted.
3. What item 4 cost, and whether the per-hop check got built or got a ledger row.
4. Item 9's non-TTY decision, item 25's outcome, item 10's drill result and its open ⚑ step.
5. The storefront gzip delta, if `render.ts` or `buy.ts` was touched.
6. Test counts, all three suites, before and after.
7. What changed in `/docs/spec.md`, `/docs/status.md`, `/docs/runbook.md` and `/README.md`.
8. **Whether milestone A's claim is now true** — "nothing known-broken can lose money or destroy a
   seller's work" — or which item is still standing between here and it. Say plainly whether item 6
   is safe to run.
9. The PR URL.
