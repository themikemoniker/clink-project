Read these in full before writing any code:

1. `/docs/status.md`   — start here, especially "Slice 5 — what shipped" and the traps list
2. `/CLAUDE.md`        — project rules
3. `/docs/spec.md`     — §5 (signature budget), §9 (stack), §10 slices 4 and 5
4. `/docs/spike-findings.md` — §7, §8, §9, and §13 items 18, 22, 23, 24
5. `/docs/design.md`   — §1, §3, §5

Then read `/builder/src/*.ts`, `/builder/index.html`, `/storefront/src/main.ts`,
`/storefront/src/render.ts`, and `/spike/check-deploy.ts`.

Slices 0–5 are done and committed. **Build no new features.** This session closes the
one gap slices 4 and 5 both left open, then deploys.

## The job

Every module in `/builder` and `/storefront` is exercised headlessly — `npm test`
across three suites, plus `check-buy.ts`, `check-manage.ts` and `check-deploy.ts`
driving the real modules against the real node, real relays and real Blossom. What
has never run is **a browser**. No NIP-07 extension, no bunker, no DOM. The module
graph typechecks and builds and every selector in `main.ts` resolves against
`index.html` by inspection, but nobody has watched a page paint.

Fix that with Playwright, then deploy what you verified.

## The problems that are not in the one-line description

### 1. Playwright is a new dependency, and there is a fourth-test-pattern trap

`/CLAUDE.md` says justify every new dependency and ask before installing anything
global. Playwright downloads ~150 MB of browser binaries. It is a devDependency and
never reaches a user — but say the number out loud and **ask before installing**.

The subtler problem: `/docs/status.md` says tests are `node --test`, no framework,
three suites, *"do not start a fourth pattern."* Playwright ships its own runner with
its own config file, its own assertions and its own reporter. Using it would be
exactly the fourth pattern that line forbids.

There is a way to have both: `@playwright/test` is optional. `playwright` (or
`playwright-core`) is a library — `chromium.launch()`, `page.goto()`,
`page.click()` — and it can be driven from inside a `node --test` file with
`node:assert`. Same pattern, same runner, same `npm test`. Check this before
committing to it; if the library-only path turns out to cost more than the runner
saves, say so and take the runner, but make it a decision rather than a default.

Where it lives is the other half: `/builder/src/*.test.ts` is unit tests that run in
milliseconds and `npm test` is expected to be fast. A browser test that launches
Chromium and talks to public relays is not that. Decide whether it is a separate
script in `/spike` (the `check-*.ts` family, which is where "drive the real thing
against the real world" already lives) or a marked-slow test in `/builder`. The
`check-*.ts` family is the better fit and it keeps `npm test` honest.

### 2. Playwright cannot be either signer, and pretending otherwise is the whole risk

`/builder/src/signer.ts` has two paths. A NIP-07 extension is a real browser
extension; a NIP-46 bunker is a phone. Playwright is neither. So decide, deliberately,
what "verified in a browser" is going to mean here:

- **Inject a `window.nostr` shim** with `page.addInitScript`, backed by a throwaway
  key, exposing `getPublicKey`, `signEvent` and `nip44`. This exercises everything
  downstream of the Signer — the form, the cost line, the photo pipeline, the publish
  sequence, the ladder download, the deploy button, and the whole storefront — which
  is nearly all of the unrun surface. It does **not** exercise `connectNip07`,
  `connectBunkerURL`, `awaitBunkerScan` or `resumeBunker`.
- **A real NIP-46 bunker in-process.** nostr-tools ships `BunkerSigner`, which is the
  *client* half; the remote-signer half is not in the library. Writing one is a real
  piece of work and it would be our own code standing in for Amber, which is not the
  thing we want confidence about. Probably not worth it — but look before you rule it
  out, and if you rule it out, say so in the findings.
- **Leave the extension/bunker handshake to the human run.** Name it as still-unrun
  rather than quietly implying the browser run covered it.

**CORRECTED 2026-08-24, and it changes what the human run is.** This section said the
handshake was "one scan and it is already scheduled". It was not scheduled, and the scan
is not possible: **the operator is on iOS and Amber is Android-only** (`/docs/spec.md:244`).
`/docs/status.md` asserted the Amber import had both happened and not happened, six lines
apart, and the "has happened" line was false — it is now corrected there, along with what
it cost (the nsec and QR were deleted on its authority).

So the human half of this run is **a desktop NIP-07 extension**, not a phone:

- **nos2x is installed and verified (2026-08-24).** `connectNip07` at
  `/builder/src/signer.ts:90`. No phone, so this is no longer ⚑-blocked on hardware
  nobody has. Console on the live builder: `getPublicKey()` returns
  `fb18e881362a772e1bff2fc260a5ff47cb01d3fa7a254349948603774cdb47a0` and
  `typeof window.nostr.nip44` is `"object"` — `signer.ts:96` refuses an extension
  without the latter, because CLINK Manage (kind 21003) is NIP-44 encrypted.
- **RE-CHECK THE PUBKEY AFTER ANY SIGNER CHANGE.** The first import loaded a personal
  key. The builder would have signed as that npub, published to a storefront nobody
  reads, and reported success at every step. Two seconds of `getPublicKey()` is the
  whole guard. nos2x holds one key at a time — a separate Chrome profile for the demo
  keeps a personal identity out of every screenshot.
- **`perms` DOES NOT APPLY HERE, and three documents said it did until 2026-08-24.**
  `PERMS` is used only on the NIP-46 path (`signer.ts:143`, `createNostrConnectURI`).
  NIP-07 has no perms handshake; `connectNip07` calls `getPublicKey()` purely to provoke
  the extension's own prompt at connect rather than mid-publish (`:100`). So
  `/docs/spike-findings.md` §8's Amber/nsec.app measurements and q8's "Approve basic
  actions" residual risk describe a mechanism nos2x does not use.
- **So the predicted prompt count of 1 is a bunker-path number and must not be carried
  over.** What is genuinely unmeasured is how many prompts nos2x raises across the
  publish sequence — its model is per-site and remembered, not a grant. Count what
  happens and record that, rather than confirming a prediction made about Amber.
- nsec.app remains the fallback and costs the custody claim `/docs/spec.md` §3.1 spends
  pages making — the key sits on somebody else's server. Acceptable to verify with,
  wrong to demo with. Say which was used.

**The shim holds a private key in a page, so `/CLAUDE.md` rule 2 applies to it
directly.** It is a test-only throwaway, it must never be importable from
`/builder/src`, it must never be reachable from the shipped bundle, and the file it
lives in should say all three in its header. If you find yourself adding a
`window.nostr` fallback to `signer.ts` "for testing", you have taken a wrong turn:
that is a key path in the product.

### 3. A browser test that presses Deploy is not free, and it is not repeatable

Pressing Deploy uploads blobs to four public Blossom servers and replaces a kind
15128 on four public relays. Pressing Publish mints a **real offer** on the node
(CLINK Manage `create` is explicitly not idempotent, `clink-manage.md:226`) and puts
a real kind 30402 on public relays.

So: run against throwaway identities, not the seller's. `spike/.deploy-test-key`
exists for exactly this. Clean up the offers a publish test mints — `check-manage.ts
--clean` is the pattern, and note that it refuses to delete any offer with a settled
invoice because that would destroy the buyer's refund pointer (findings §13.17).

And the trap that will eat an hour if you design around it wrongly: **the gateway
caches for an hour.** A test that deploys and then loads `https://<npub>.<gateway>/`
to check the result will see the *previous* build and fail for the wrong reason. Test
the deployed page by loading a **local** `vite preview` with `?seller=<npub>`, and
verify the deploy itself with `check-deploy.ts`, which already separates the relays
and Blossom (the truth) from the gateway (a cache).

## What is actually unrun, and worth a test

Roughly in order of how badly a break would hurt:

- **The storefront index and detail render.** Nine items, three sold, one with no
  photo, one priced in pesos. Sold items must be struck through and stamped, not
  hidden (design.md §1).
- **The Buy panel's four states.** `render.ts` `renderBuy` swaps form → waiting →
  invoice → paid through one `aria-live` region. Only the `check-buy.ts` code path
  has ever run; the DOM half has not. Do **not** pay anything — drive it to the
  invoice state and stop. `mugs` has one unit left and it is for the stage.
- **The print stylesheet and the tear-off tabs.** design.md §3 calls the flyer the
  best physical artifact in the project. The QR is now injected at deploy time
  (slice 5), so this is the first time anything has checked that the injected
  `<symbol id="qr">` actually renders through `<use>` in the tabs. `page.pdf()` or
  `emulateMedia({ media: 'print' })` will show it.
- **The hostname fallback.** `?seller=` on localhost, and the "cannot tell whose sale
  this is" state when there is neither. Both are new in slice 5 and neither has been
  seen.
- **The builder's form.** The signature cost line updating as stock changes, the
  slug auto-fill on blur, the 10-sat floor refusal, the stock 0–999 bound.
- **The publish sequence and the ladder download.** An item is `1 + units`
  signatures; confirm the shim is asked for exactly that many, and that the
  downloaded `.ladder.json` is in the shape `watch-sales.ts` reads.
- **The deploy button.** The cost line, the progress steps, and the resulting URL.
- **Console errors on every page.** A page that renders correctly while throwing is
  a page one browser version away from blank.

You will not get all of that in one session. Rank it, do the top of the list
properly, and say what you left.

## Then deploy

Once the browser run is green, deploy for real. Two decisions, and **ask me both**:

1. **Does the live storefront npub get the generic build?** It is running slice 5's
   predecessor today and it works. Redeploying costs an hour of gateway cache during
   which new asset filenames 404 and it looks broken. If the sale is more than a day
   out, do it; if not, do not.
2. **Does the builder's nsite get redeployed** from
   `npub1qqm97k4eg432zydvkclnhhnkyd7dgjxmndmaapk48jzms9uyl5qqlerxa2`, or does it get a
   real identity? It is on a throwaway key generated during slice 5.

Verify every deploy with `node spike/check-deploy.ts <npub>` — relays and Blossom
first, gateway last and separately, because the gateway is a cache and not the truth.

## State you are inheriting

- **Node running.** ~~`mugs` is 1,000 sat with one unit left — the cheap item if anything
  genuinely needs a payment.~~ **STALE, corrected 2026-08-24: `mugs` is SOLD OUT 3/3.**
  `node spike/sales-report.ts` reports 4 settled invoices, 9,000 sats in the account and
  8,946 payable after the Pub's fee. **Do not spend anything on this account without
  reading item 6 first**: `mugs` being depleted is what makes it the oversell milestone B
  needs, a depleted offer stays payable (findings §13.17), and there is exactly ONE such
  oversell available with no way to make another without restocking. Burning it here would
  cost the demo beat. Do not spend `lamp` (30,000) to test plumbing either.
- **Two nsites are live**: the builder and a slice-5 test storefront. Both verified
  serving from four Blossom servers. URLs in `/docs/status.md`.
- **The live seller storefront still works** and is the demo. Prefer not to touch it.
- `spike/.dev-key`, `.deploy-test-key`, `.builder-key`, `.offers.json`, `.ladder.json`
  and `.nmanage` are gitignored and not reproducible. Backup of the seller key is at
  `~/.lamppost-key-backup/`.
- **`builder/public/site/` is generated** by `npm run build` in `/builder`. A fresh
  clone has no storefront to deploy until that runs.

## Gotchas that will cost an hour each

`/docs/status.md` has the full list. These bite this session:

- **The gateway caches for an hour.** Verify against the relay and Blossom, never
  against the gateway.
- **`/404.html` is served with a 404 status** (findings §13.24). `res.ok` is false
  for the one behaviour NIP-5A mandates.
- **A kind 15128 root site is one per pubkey** (`5A.md:16`, findings §13.22).
  Deploying two sites under one key silently replaces the first.
- **The BUD-11 auth header is standard base64 here, not the base64url the spec
  requires** (findings §9). If a Blossom upload starts 400ing, check that first.
- **`pool.subscribeMany(relays, filter, params)` takes a single filter OBJECT**
  in nostr-tools 2.24.3. An array makes strfry silently never fire.
- **`verifyEvent()` caches its verdict on the event object** (findings §13.10).
  Anything that builds an event by spreading another and re-verifies is exposed.
- **Never batch a Blossom auth.** One signed 24242 per blob; the same token is valid
  across every server, so mirroring is free of extra signatures but batching blobs
  into one token silently corrupts uploads.

## How to work

- No new features. If you find yourself editing `/builder/src` for anything other
  than a bug the browser run actually found, stop and ask.
- A bug the browser finds is worth fixing here — that is the point of running it —
  but fix the root cause, not the symptom, and add the headless test that would have
  caught it.
- Tests are `node --test`, no framework: `storefront/src/listing.test.ts` (30),
  `spike/ladder.test.ts` (20 assertions), `builder/src/listing.test.ts` and
  `builder/src/deploy.test.ts` (20 together). Add to that style.
- End with something demoable, then stop and report: what you ran, what the browser
  found, what is still unrun and why, what changed in `/docs/spec.md` and
  `/docs/status.md`, and what slice 6 needs from me. Do not roll into slice 6.
- Commit at the end, do not push.
- Ask before installing anything, and before writing outside `/docs`, `/spike`,
  `/storefront` and `/builder`.
