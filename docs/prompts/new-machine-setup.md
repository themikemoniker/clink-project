# Session brief: stand this repo up on a new machine, then item 8

This is a **fresh clone on a machine that has never run this project.** Before you plan anything,
know what is and is not here, because the roadmap assumes hardware that is absent:

- Node v24.6.0, npm 11.5.1. Fine.
- **No Lightning.Pub** (nothing answers `http://127.0.0.1:1776/api/health`), **no LND, no `lncli`.**
- **None of the gitignored state exists**: `spike/.dev-key`, `.offers.json`, `.ladder.json`,
  `.refund-key`, `.nmanage`, `.ndebit`, `.refunds.json`. There is no other clone on this disk to
  copy them from.
- The seller key is not in a NIP-07 extension in this browser profile.

Everything the repo says about a 9,000 sat account, a live debit grant and a sold-out `mugs` is
true of **another machine**. Do not reason as though that state is reachable from here.

## Read first, in this order

1. `/CLAUDE.md`, the rules. Rules 1 through 5 and the money-path rules are binding on this session.
2. `/docs/status.md`, the handoff note. Read the header paragraph, "What is live right now", and
   "Commands that reproduce the state". It is 98 KB; do not read it all, grep it.
3. `/README.md` sections Setup and Roadmap (milestone B, items 6, 7, 8).
4. `/docs/known-defects.md` only when a test fails and you need to know whether it is known.

Where `status.md` and `/docs/spike-findings.md` disagree, the findings win. Where a doc and the
code disagree, read the code and say so.

## Phase 1: setup, and prove it runs here

Each directory is its own npm package, there is no monorepo tooling, and `builder` shells out to a
storefront build, so `storefront` must be installed first.

```bash
cd storefront && npm install && npm test && npm run build && npm run size
cd ../builder  && npm install && npm test && npm run build && npm run size
cd ../spike    && npm install && npm test
```

Expected, from `/README.md` and `/docs/status.md`: 58 tests in `storefront`, 58 in `builder`,
27 in `spike`, all `node --test`, no framework. `npm run build` is `tsc --noEmit && vite build`,
so a type error fails the build. The storefront has a **33 KB gzip JS budget** (spec section 9,
raised in slice 9) and was last measured at 32.01. `npm run size` prints the number, report it.

**These are predictions, not facts.** If a count or a byte figure differs, the document is stale
and you say so with the actual output rather than restating the document.

If something fails: do not patch around it. Find the cause, and check whether it is already in
`/docs/known-defects.md` before treating it as new.

## Phase 2: prove the app actually works here, without a node

Two dev servers and two free scripts. None of this signs, spends, publishes, or needs a key.

```bash
cd storefront && npm run dev
# open http://localhost:5173/?seller=npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws
```

The `?seller=` query param is the dev fallback. In production the storefront reads its npub out of
`location.hostname` (NIP-5A). That npub is the live sale, so the page should paint nine items read
from four public relays: `mugs` sold out, `plants` sold, `lamp` and two others buyable, `records`
fiat, `boxes` free. **The relays are the only external dependency in this phase, and they are
real.** If the grid is empty, that is a relay-read failure, not a missing node, and it is worth
diagnosing before anything else.

```bash
cd builder && npm run dev     # authoring UI, cannot sign without a NIP-07 extension
cd spike
node check-admin.ts npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws
node check-deploy.ts npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws
```

Both are documented as free, keyless and node-less. `check-admin.ts` drives the shipped admin
module against the live sale; `check-deploy.ts` checks relays, then Blossom, then the gateway.
Note that the gateway is a cache with a one hour TTL (findings section 7), so a gateway mismatch is
usually not a broken deploy. `blossom.primal.net` answers with a 302; that is expected.

**Do not run anything else in `/spike`.** `mint-offers.ts`, `seed-listings.ts`, `watch-sales.ts`,
`check-buy.ts`, `check-manage.ts`, `authorize-manage.ts`, `authorize-refunds.ts`, `check-refund.ts`,
`sales-report.ts`, `deploy-nsite.ts` and `export-key-qr.ts` all need a key or a node or both, and
some of them publish or spend. `seed-listings.ts` re-cuts the ladder and must not run casually.
`npm run capture` in `shots/` needs the node up. If you think you need one of these, stop and ask.

## Phase 3: write down what this machine cannot do

Before touching the roadmap, add a short section to `/docs/status.md` recording the second-machine
situation: what is installed, what state is absent, and therefore which roadmap items are
unreachable from here. Be specific about item 6, whose gates in the status header assume a node,
a live grant, and exactly one remaining oversell. This is the handoff note; a future session on
this machine will otherwise re-derive all of it.

## Phase 4: continue the roadmap, item 8

Item 6 is out of scope on this machine, for the reasons above. **Do not attempt it.** Item 7 is the
browser verification run, and its publish and deploy half needs the seller key in a signer, which is
not here. The render-only half (the `@media print` block, the sticker sheet, `noBuyReason`,
`missingItemNote`, the `geo:` link) can be exercised against the dev servers, and doing that first
is useful input to item 8.

**Item 8 is the target: a headless smoke test so unrendered markup cannot accumulate again.**
From the roadmap:

- Playwright is already a devDependency in `shots/`. Reuse it, do not add a second browser
  automation stack. Justify the dependency wiring per `/CLAUDE.md` working style.
- One headless run per app. Load the page, assert the Buy form renders and its required field is
  present, assert the print stylesheet hides `<main>`.
- Wire it into `npm test` so nobody has to remember it.
- **Resist building a page-object framework. Two files, a handful of assertions.**

The existing 58 + 58 unit tests touch no DOM, which is exactly how five slices of markup reached a
demo unrendered. That is the defect this closes.

Note that `npx playwright install` downloads browser binaries. Ask before installing anything
global, per `/CLAUDE.md`.

## Rules for this session

- **Never guess a protocol detail.** No CLINK kind, field, tag or error code from memory. Cite a
  spec file, source, or captured JSON, or write `UNVERIFIED` and ask.
- **Build only the slice requested.** No scaffolding for future items.
- **Evidence before assertions.** Do not say a thing passes without the command output. If you
  predicted 58 tests and got 57, report 57.
- **Nothing that spends, publishes or signs**, this whole session.
- After the work, update `/docs/spec.md` with what was learned and tell me exactly what changed.

## End with

1. The actual test counts, build results and gzip sizes, as output rather than as claims.
2. Whether the live storefront rendered from the relays on this machine, and any defect that
   surfaced doing it.
3. What item 8 landed, what it asserts, and what it deliberately does not assert.
4. The honest list of what remains unreachable until this machine has a node and the keys, or
   until the work moves back to the machine that has them.
