# Session brief: milestone B — nothing on the critical path is unexecuted

Milestone A merged on 2026-08-25 (`500314a`, PR #2, sixteen commits). Its claim — *"nothing
known-broken can lose money or destroy a seller's work"* — holds, and it holds because an
adversarial review of that branch found **five defects the branch itself had introduced**, two of
which were the exact losses A claimed to close. Read that review's outcome before you trust
anything below: the lesson it encodes is that **a confident document written by the process that
did the work is a set of hypotheses, not a summary.** This brief is one of those documents.

Milestone B is items **6, 7 and 8**. When it is done you can say: *nothing on the critical path is
unexecuted.*

## Read first

1. **`/CLAUDE.md`** — rules 1, 2 and 3, and the money-path rules. Item 6 is the first time this
   project pays a stranger, so the money-path rules are not background this session.
2. **`/docs/status.md`** — the handoff note, rewritten 2026-08-24 for this session specifically.
   Its header names item 6's real gates. **Start there, not here.**
3. **`/docs/known-defects.md`** — "Added by milestone A", seven rows. Two are holes A's own fixes
   left. One is item 27.
4. **`/README.md`** § Roadmap items 6, 7, 8 and **27**, plus the "milestones at a glance" table.
5. **`/docs/prompts/browser-verify-and-deploy.md`** — the script for item 7. It was corrected on
   2026-08-24 and **had two traps in its inherited state**; read the correction notes, not just
   the steps.
6. `/docs/spec.md` §7.3 and §12 — the refund design and the security requirements, both edited by
   milestone A's review with measurements attached.
7. `/docs/spike-findings.md` §5, §11, §13.17, §13.27, §13.28, §13.29.

## The job

Three items, and **only one of them spends money.**

- **6 — pay one real refund, end to end.** The demo beat. `payDebit`'s `{"res":"ok"}` branch is the
  only part of the refund path that has never executed on the wire.
- **7 — the browser verification run.** Five slices of markup that has never rendered. The largest
  source of *unknown* defects in the project.
- **8 — a smoke test so unrendered markup cannot accumulate again.** Needs 7.

## Order of work

6 and 7 are independent and 8 needs 7. **Do item 6 first anyway**, because it is the one with money
in it, the one with a hard external deadline (the debit grant expires **2026-09-20**), and the one
whose failure modes are worth having a whole session's attention on.

## What is NOT in this session

- **Item 27** (BIP-353 refund pointers). Filed, in milestone E, and its first bullet is liftable —
  but lifting it here means editing the refund path on the day you first use it. Don't.
- **Item 26** (the builder's nsite key). Still a one-way decision nobody has made.
- **The ⚑ backup step.** `spike/.dev-key`'s only backup is on one machine. It is a human step with
  a second device and it does not belong in a coding session.

---

## Item 6 — the problems that are not in the one-line description

### 1. THERE IS EXACTLY ONE OVERSELL AND YOU CANNOT MAKE ANOTHER

`yardsale-2026-08-mugs` is **sold out 3/3**. A depleted offer stays payable (findings §13.17),
which is what makes one more payment against it an oversell rather than a sale. There is no second
one without restocking, and restocking re-cuts the ladder and needs the watcher restarted.

So **every decision below is a one-shot decision.** If the refund pointer is wrong, the oversell is
spent and the demo beat is gone until you rebuild the fixture.

### 2. THE POINTER MUST BE LNURL-PAY, AND A BIP-353 ADDRESS LOOKS IDENTICAL

This is item 27 and it was found the hard way on 2026-08-24. `LN_ADDRESS.test()` cannot tell
`name@phoenixwallet.me` from `name@coinos.io` — same `user@domain` shape — but Phoenix serves **no
HTTPS at all**: NS records on Route 53, no A or AAAA, no `www`/`api`/`app`. It publishes a BOLT12
offer in a TXT record at `<name>.user._bitcoin-payment.<domain>` instead.

**Verified working: `coinos.io`.** `resolvePointer('…@coinos.io', 1000)` returned a BOLT11 for
exactly 1,000 sats in 1,540 ms — both hops, `invoiceSats` matching. Wallet of Satoshi, Alby, Blink
and an `noffer` are also LNURL-pay. **Phoenix is not.**

**Resolve the pointer before you spend anything.** It is free — resolving returns an invoice nobody
pays — and it is the whole of the risk in problem 1:

```js
// node --experimental-strip-types, from spike/
import { resolvePointer } from './refund.ts'
console.log(await resolvePointer('<the pointer you are about to use>', 1000))
```

`{ ok: true }` means spend. Anything else means find another wallet **before** the oversell exists.

### 3. THE KILL SWITCH HAS NEVER BEEN EXECUTED, AND TESTING IT DESTROYS THE GRANT

**This is the one genuine decision in the session and it is not yours to default.**

Item 2 rebuilt `authorize-refunds.ts`'s kill switch so it reads the granted pubkey back from the
node rather than trusting a local file. Every branch of that work is **unexecuted code**: the
read-back, the "node still reports AUTHORIZED" throw, the `exit 1` on no-grant, and `--npub`. Item
6 arms a spend path whose off-switch has never been run.

`spike/check-refund.ts` §4 and §4b drive it properly — and the script **ends by calling
`ResetDebit`, removing the live grant on purpose.** Re-arming is the entire three-step
authorisation dance, and the current grant is `debit_id 2`, `AUTHORIZED`, 8,000/day, expiring
**2026-09-20**.

So: run the kill switch first and pay to re-arm it, or run item 6 with an untested off-switch.
**Ask the user. Do not pick one silently.** `node authorize-refunds.ts --show` is free and safe and
tells you the grant's current state without touching it.

### 4. THE CAP NOW BINDS BEFORE THE BALANCE, AND NOBODY CHOSE THAT

`node sales-report.ts` on 2026-08-24: **4 settled invoices, 9,000 sats in the account, 8,946
payable after the Pub's fee.** The frequency rule is **8,000 sats/day**.

Spec §12 sized that cap when 8,000 was the whole balance, so the balance bound first and the cap
was slack. It is not slack now. A 1,000-sat refund is comfortably inside both, so this does not
block the run — but §12 says to re-decide the number rather than inherit it, and inheriting it is
what has happened twice. `node authorize-refunds.ts --cap <n>`.

### 5. ITEM 9'S RECONCILE HAS NEVER RUN, BECAUSE NOTHING HAS EVER WRITTEN A `pending` ROW

This run is what exercises it. Two consequences:

- **Run the watcher from a terminal, not launchd.** The reconcile prompts, and a daemon has no
  stdin. A non-TTY start runs, transitions nothing, and says so loudly — which is correct and is
  also not what you want on the one run that could prove the prompt.
- **State as of 2026-08-24:** `spike/.refunds.json` does not exist and the node reports **0
  outgoing payments**, so `refuseToStart` evaluates false and the watcher will arm. After the first
  refund that changes: the journal becomes the only durable record that it happened, and a lost or
  restored journal alongside a non-zero outgoing count is a hard refusal to start. **Back the
  journal up the moment it exists** — `docs/runbook.md` §5, "regenerable by nothing".

### 6. THE COMMANDS, AND THE ONE THAT SPENDS

```bash
cd spike
node authorize-refunds.ts --show                  # free. What the node actually has
node sales-report.ts                              # free. Balance, settled, refundable counts
node sales-report.ts --outgoing                   # free. What the node has already sent

# THE ONE THAT SPENDS. --pay REQUIRES --pointer since slice 8 (check-buy.ts:24, :49-50) —
# an invoice that settles stores that pointer forever and the node cannot correct it.
node check-buy.ts yardsale-2026-08-mugs --pay --pointer <an LNURL-PAY address you control>

node watch-sales.ts --refunds                     # from a TERMINAL. Watch the money come back
```

Use the **default seller**, not `.merida-key`: that account has no refund grant armed and cannot be
given one — `authorize-refunds.ts` is hardcoded to `.dev-key` (open ledger row). An oversell there
is logged and never paid.

### 7. WHAT SUCCESS ACTUALLY LOOKS LIKE, SO YOU DO NOT DECLARE IT EARLY

`payDebit` returning `{"res":"ok"}` is the branch under test. A `pending` row means the node never
answered and whether money moved is **unknown** — that is not a failure and it is not a success, it
is the case item 9 exists for, and it is never retried automatically. A `queued` row needs a human.
Only `paid` plus the buyer's wallet showing 1,000 sats is the thing.

Record the transcript in `/docs/spike-findings.md` and close the ledger rows that name these
branches. **Never log the pointer or the preimage** — the journal stores the *kind* of pointer and
whether a preimage existed, never either value.

---

## Item 7 — the problems that are not in the one-line description

### 8. THE SIGNER IS ALREADY SET UP, AND THE WAY IT NEARLY WENT WRONG IS THE LESSON

**nos2x**, a desktop NIP-07 extension, holds the seller key and exposes `nip44`. No phone. Amber
was never available — it is Android-only and this operator is on iOS, which `docs/status.md`
asserted both ways for three slices before it was resolved.

**Re-check the pubkey after any signer change:**

```js
await window.nostr.getPublicKey()   // must be fb18e881362a772e1bff2fc260a5ff47cb01d3fa7a254349948603774cdb47a0
typeof window.nostr.nip44           // must be "object" — signer.ts:96 refuses without it
```

The first import loaded a **personal** key. It matched no project identity, and nothing would have
said so: the builder would have signed as that npub, published to a storefront nobody reads, and
reported success at every step. Two seconds of `getPublicKey()` is the entire guard. nos2x holds
one key at a time, so a separate Chrome profile keeps a personal identity out of every screenshot.

### 9. DO NOT CARRY THE PREDICTED SIGNATURE COUNT OVER

Three documents said "confirm the extension honours `perms`" until 2026-08-24. **`perms` does not
exist in NIP-07.** `PERMS` is used only on the NIP-46 path (`signer.ts:143`,
`createNostrConnectURI`); `connectNip07` (`:90`) never sends it and calls `getPublicKey()` purely to
provoke the extension's own prompt at connect rather than mid-publish (`:100`).

So findings §8's Amber/nsec.app measurements and q8's "Approve basic actions" residual risk describe
a mechanism nos2x does not use, and **the predicted count of 1 is a bunker-path number.** Count what
nos2x actually does across the publish sequence — its model is per-site and remembered — and record
that. Confirming a prediction made about different software is worse than measuring nothing.

### 10. WHAT IS ACTUALLY UNRUN

`docs/prompts/browser-verify-and-deploy.md` is the script. The surface: the sticker sheet has never
been printed, the `@media print` block has never run, `noBuyReason` and `missingItemNote` have never
painted, the `geo:` link has never been tapped.

**Do not spend anything to test plumbing.** That prompt's inherited-state section said *"`mugs` is
1,000 sat with one unit left — the cheap item if anything genuinely needs a payment"* until
2026-08-24. It was false since 2026-08-21 and it was a trap: `mugs` being **depleted** is exactly
what makes it item 6's oversell.

---

## Item 8 — the trap is the shape, not the code

Playwright is already installed in `shots/` (`playwright ^1.49.0`). **Reuse it.** There are 42 + 67
+ 61 `node --test` tests and none touch the DOM, which is how five slices of markup reached a demo
unrendered.

- One headless run per app: load the page, assert the Buy form renders and its required field is
  present, assert the print stylesheet hides `<main>`.
- Wire it into `npm test` so it is not a thing anyone remembers to do.
- **Resist building a page-object framework.** Two files, a handful of assertions. `shots/` is
  explicitly throwaway status — same as `spike/` — and this does not change that.
- Do not start a fourth test pattern. Do not add a runner. Do not add a fixture library.

---

## Traps that will cost an hour each

`/docs/status.md` has the full list. These bite this session:

- **There is no CI on this repo.** `statusCheckRollup` is empty; local `npm test` in all three
  directories is the only gate. Run them before any merge and report the counts.
- **`gh`'s active account silently reverts** to a second logged-in account between commands. It
  reverted twice on 2026-08-24 and cost two failed PR operations. `gh auth status` before any PR
  write, and `gh auth switch -u themikemoniker` if it has drifted.
- **`> file` truncates before the command runs.** A `gh pr view … > body.md` that fails leaves an
  empty file, and feeding that to `gh pr edit` wipes a PR body. It happened. `test -s` before any
  `--body-file`. (Recovery, if it happens again: `userContentEdits` in the GraphQL API holds the
  prior text.)
- **Never `cat spike/.dev-key`** or any `.nsec` into the terminal — with the `!` prefix that output
  lands in the transcript. `pbcopy < .dev-key` moves it to the clipboard with nothing printed.
- **`watch-sales.ts` spends only with `--refunds`.** Every other invocation is slice 3's watcher.
- **A debit expiry rule DELETES the grant** on first use after it lapses. **2026-09-20.**
- **`sales-report.ts` and `watch-sales.ts` both take `--key`**, and most of the repo's muscle memory
  predates it. A command without it reports the default seller.
- **Line-number citations shift.** Milestone A's own doc commit left ten citations that were right
  on `main` and wrong on the branch — including the row whose purpose is correcting a mis-citation.
  Re-verify any line number before trusting it, and after any diff that moves lines, re-verify the
  citations *you* wrote.

## How to work

- **Never guess a protocol detail.** The NIPs and CLINK spec repos are not on this machine.
  `/docs/clink-notes.md` is the authority on CLINK wire detail; `/docs/spike-findings.md` beats
  `/docs/spec.md`. `UNVERIFIED` and a question beats a plausible answer.
- **Before believing "X has never been tested", check what testing it costs.** The ledger row saying
  the LNURL branch had never resolved a real address sat open from slice 7 to 2026-08-24 and its
  fix column claimed it needed "a real settled sale" and "a wallet and a person". It needed one free
  call. That conflation — proving a mechanism versus running the demo — is this project's most
  expensive recurring mistake.
- **A claim you cannot reproduce is a refutation** and belongs in the ledger with its reasoning.
- Fix the root cause, not the reported symptom. Grep every caller before editing.
- Ask before installing anything, and before writing outside `/docs`, `/spike`, `/storefront`,
  `/builder` and `/shots`.
- **Stop and ask rather than guessing** on: the kill-switch decision (problem 3), the cap number
  (problem 4), and anything that would spend beyond the single planned oversell.

## The administrative half

Not optional — `/CLAUDE.md`'s "after each slice" rule is a project rule.

- **`/docs/spike-findings.md`** — item 6's transcript, and item 7's rendering findings. This is
  where measured facts live and it outranks `spec.md`.
- **`/docs/known-defects.md`** — close the rows item 6 proves. Any new hole gets an honest row: a
  guard that reads as a guarantee and is not one is worse than no guard.
- **`/README.md`** § Roadmap — mark 6, 7, 8 in item 23's style, struck through with what was
  actually found. **Task IDs are stable; never renumber.** Re-cut the glance table.
- **`/docs/status.md`** — new date, new handoff paragraph. It is what the next session reads first,
  and it has now twice contained two contradictory answers to the same question. If you cannot
  resolve one, mark it `UNVERIFIED` and write the question out rather than asserting both.
- **`/docs/runbook.md`** — the journal backup step, once a journal exists.

## End with

1. Whether item 6 paid, with the transcript and the journal row's final state.
2. The kill-switch decision that was made, and by whom.
3. Item 7's actual signature-prompt count, measured, not predicted.
4. What item 7 found that had never rendered — the whole point of it.
5. Item 8's two files and the `npm test` wiring.
6. Test counts, all three suites, before and after.
7. What changed in the four documents above.
8. **Whether milestone B's claim is now true** — "nothing on the critical path is unexecuted" — or
   which branch is still standing between here and it.
