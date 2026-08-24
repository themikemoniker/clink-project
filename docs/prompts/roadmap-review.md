# Brief: adversarial review of the README roadmap

Read `/CLAUDE.md` first, then `/docs/status.md`. This brief is subordinate to both.

## What exists

`/README.md` gained a Roadmap section written in one session. It holds **30 tasks** with stable
IDs — **1–22**, drawn from `docs/known-defects.md` and `docs/status.md`, and **M1–M8**, which are
**designs invented during that session and verified against nothing.** They are grouped into
seven milestones **A–G** plus a parallel upstream track.

Your job is to attack it. Do not rewrite the README — produce a report. The user decides what
lands.

## What the author actually read, and did not

Stated plainly so you can aim at the gaps rather than re-cover the ground:

- **Read:** `docs/runbook.md` in full; `docs/status.md` §§ summary, what-is-live, commands,
  blocked, slice 6, traps, document map; `docs/spike-findings.md` §§ 10, 11, 13.19, 13.27,
  and fragments of 12; `docs/spec.md` §§ 1–6 and fragments; `docs/clink-notes.md` § 8–9;
  `builder/src/main.ts:55-100`, `admin.ts` greps, `publish.ts` header, `render.ts:290-340`,
  `spike/authorize-manage.ts:1-80`, `watch-sales.ts` greps.
- **Read only truncated to 400 characters per row:** every table in `docs/known-defects.md`. The
  "why it is deferred" and "what fixing it looks like" columns are therefore largely unread.
- **Never opened:** `docs/design.md` (all six sections, including §2 "Image pipeline — biggest
  lever on perceived quality"), every file in `docs/prompts/`, `docs/spec.md` §§7–14,
  most of `docs/spike-findings.md`, and the whole of `storefront/src` and `builder/src` beyond
  the greps above.

## The four failure modes to hunt, in priority order

### 1. Items that already exist
This repo has done this twice. `docs/status.md`'s traps say it outright: *"§10's slice lines are
a plan written before the answers, not a to-do list… Check whether each item already exists
before building it."* Slice 9's plan listed a 404 page that had shipped in slice 1.

For every one of the 30 items: does the code already do this? Cite the file and line that proves
it, or say you checked and it does not.

### 2. Items that cannot exist
The other half of the same trap: *"check whether it can exist before scoping it."* Slice 8's plan
claimed a BOLT12 fallback that exists nowhere in this stack; slice 9's claimed a map that cannot
be built without a third-party hostname on every page load.

**Concentrate on M1–M8. They are the unverified ones.** Named suspicions from the author, each
of which you should confirm or refute from source:

- **M1** proposes wrapping the pre-signed availability ladder in a NIP-44-encrypted kind 30078,
  one event per item. Check: NIP-44 v2's maximum plaintext size against the real size of a ladder
  for a multi-unit item carrying photo tags; whether the four relays in `SALE_RELAYS` cap event
  size below that; and whether `d: lamppost-ladder-<slug>` collides with a reserved namespace the
  way `builder/src/notes.ts` avoids `clink-*` on this kind.
- **M4** proposes the watcher reading settled sales and publishing an encrypted summary to the
  seller under the watcher's own key. The author wrote "no rule moves." Test that: slice 3's
  design is that the watcher **holds no signing key**, and this gives it one. Is that consistent
  with `/CLAUDE.md` and with what the pitch claims on stage, or is it a real change of shape?
- **M5** proposes a second required `payer_data` key for pickup verification, sized **M**. Check
  what it actually costs: every existing offer declares `["refund_pointer"]`, and CLINK Manage
  `create` is not idempotent. Does this force a re-mint of every offer, hence new pointers, hence
  a re-publish of every listing and a re-cut of every ladder? If so the size is wrong.
- **M3** proposes NIP-09 kind 5 deletion plus removal from the kind 30405 member list. Check how
  that interacts with item 13's short-read defect, and whether the storefront would even stop
  rendering a deleted listing.
- **M8** asserts multi-precision geohash tags make proximity search work under exact-match
  filters. The convention is cited as NIP-CC. **The NIPs repo is not on this machine** — re-fetch
  and cite, or mark `UNVERIFIED`. Do not answer this from memory.

### 3. Work that belongs on the roadmap and is not on it
Sweep the surfaces the author never opened, listed above. `docs/design.md` §2 and §3 and the
seven files in `docs/prompts/` are the highest-yield. Report anything that would change what a
seller or buyer can do, or anything already promised in a brief and never built.

### 4. Mis-citations
Every file path, line number, function name, protocol kind, tag and error code in the roadmap was
written from a partial read. Verify them. `/CLAUDE.md`: *"Do not invent or recall from memory any
CLINK event kind, field name, tag name, or error code… If you cannot verify something, write
`UNVERIFIED` and ask."* Apply that to the roadmap as written, and to your own report.

## Also worth your judgement

- **The estimates are guesses.** S/M/L with no basis in this repo's velocity, which looks like
  nine slices across roughly two days. Say which are wrong by more than one band; ignore the rest.
- **The milestone order.** A→B→C→D→E→F→G. The contested call is **C before D** — editability
  ahead of unattended operation — argued on the grounds that A already covers known money loss,
  so D guards against rarer unknown failures while C is a cost paid on every restock. Attack it
  if it is wrong.
- **The dependency claims.** Each item carries parenthetical dependencies. Any that are backwards
  or missing?
- **Item 9's relocation.** It was moved from the durability group into milestone A on the claim
  that losing `spike/.refunds.json` is the same failure class as the watcher's double-pay race.
  Is that right?

## Output

A report, most-consequential first. Per finding:

- The task ID, or `MISSING` for work that should be on the roadmap and is not.
- Verdict: **already exists** / **cannot exist as described** / **mis-sized** / **mis-cited** /
  **missing** / **holds up**.
- The citation that proves it — file and line, or the spec text. No claim without one.
- What the roadmap should say instead, in one sentence.

Then a short list of anything you could not verify, marked `UNVERIFIED`, with what it would take.

**Do not edit `/README.md`.** Do not fix the code. Report only.
