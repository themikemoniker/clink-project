# Lamppost

Publish a yard-sale page and take Lightning payments on it, with no hosting account, no
domain, no TLS certificate, no payment processor, and no server of ours.

The sale page is a static site hosted on Nostr (NIP-5A manifest + Blossom blobs). The
listings are Nostr events (NIP-99 kind 30402, grouped by a kind 30405 sale). Payments are
negotiated over Nostr with **CLINK** and settle to the seller's own Lightning node.
The seller's identity, storefront, listings, and money are all one pubkey.

### The claim

> An LNURL storefront cannot exist on a static host, because LNURL needs an HTTPS endpoint
> to mint invoices. CLINK requests travel over relays to the seller's own node, so a purely
> static, serverless site can take money.

This is not a claim any more — 6,000 sats settled over it on 2026-08-21, from a page served
out of a Blossom cache with nothing of ours in the path.

### The honest caveats

- The seller's node must be **online**. It needs no public IP, no DNS, no TLS, and no open
  port — but it is a process running somewhere. A laptop that sleeps is a shop that closes.
- "No hosting account" rests on public Blossom servers accepting anonymous uploads. We do
  not run one and do not have an account; that is true and is the point. It is not "no
  infrastructure exists."
- **Receipts are private.** The CLINK receipt is NIP-44 encrypted to the payer and is a MAY,
  not a MUST. Nobody but the buyer can read it — not even the seller. This costs real
  features; see "What holding no key costs" below.
- No escrow, no chargebacks. Default to in-person pickup.

---

## Repo layout

| Path | What it is |
|---|---|
| `storefront/` | Buyer-facing sale page. Static, reads listings from public relays, sends CLINK requests. **32 KB gzip.** |
| `builder/` | Seller-facing authoring app. Static, holds no key, deploys itself as an nsite. |
| `spike/` | Throwaway scripts that touch a real node and a raw key: minting offers, the sale watcher, refunds, deploys. Not part of the product build. |
| `shots/` | Playwright screenshot capture for the submission PDF. |
| `docs/` | See the document map at the bottom. Read `docs/status.md` first. |

Node 24+ — it runs the `.ts` files in `spike/` directly, no build step. Each directory is its
own package; there is no monorepo tooling.

```bash
cd storefront && npm install && npm run dev     # http://localhost:5173
cd builder    && npm install && npm run dev     # builds the storefront first, so install that too
```

The builder carries a pre-built copy of the storefront in `public/site` (that is what it
deploys), so `npm run dev`/`build` in `builder/` shells out to a storefront build — install
`storefront/`'s dependencies before either.

Tests are `node --test`, no framework: `npm test` in `storefront/`, `builder/`, or `spike/`.
In the two app directories, `npm run size` prints raw and gzip bytes per asset — the storefront
has a **33 KB gzip budget**, enforced by review rather than by a tool.

Live, both served from Blossom with no host of ours in the path:

- Storefront — `https://npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws.nsite.lol/`
- Builder — `https://npub1qqm97k4eg432zydvkclnhhnkyd7dgjxmndmaapk48jzms9uyl5qqlerxa2.nsite.lol/`

One build of the storefront serves every seller: it reads its own npub out of
`location.hostname` (NIP-5A), so nothing is compiled per seller. `?seller=npub1…` is the dev
fallback. Gateways cache for up to an hour, so a page you just deployed may serve the previous
build for a while.

---

## Setup

Two halves. The buyer half is genuinely trivial. The seller half is one bootstrap step and
then a browser.

### Buyer — ShockWallet, and nothing else

[ShockWallet](https://shockwallet.app) is CLINK's reference wallet (named as such in
`clink-offers.md:345-350`, alongside Lightning.Pub as the reference server). A buyer:

1. Opens the storefront, taps **Buy**, pastes a refund pointer (a Lightning address or
   `noffer` — the form refuses without one, deliberately: a settled invoice stores that value
   forever and the node cannot fix it afterwards).
2. Scans the BOLT11 the page got back over relays, or scans the item's sticker QR, which
   encodes a storefront deep link rather than a raw `noffer`.

That is the whole buyer setup. No account, no app-store detour if they already have a
Lightning wallet, no extension.

### Seller — do you need to run a node?

**Yes, someone does.** ShockWallet is a wallet, not a node service; it does not host CLINK
offers. What it *can* do is hold your account **on somebody else's Lightning.Pub** — which is
the genuinely easy path, and the one to reach for first.

**Option A — no node of your own (easiest).** A Lightning.Pub operator gives you their guest
pairing string (`~/lightning_pub/app.nprofile` on their machine — this is *not*
`admin.connect`, it carries no admin authority). Paste it into ShockWallet and you have an
account on that node, created on your first authenticated call. Each account gets its own
independently-addressable offers, so one community Pub can host a market of sellers
(`docs/spike-findings.md` §11). Trade-offs, stated plainly: the node operator sees every
request, one Pub down is every seller down, and your sats rest in their node — that is
custody, and `docs/spec.md` §3.1 says so out loud.

**Option B — your own Lightning.Pub.** `docs/runbook.md` has the install gotchas measured on
a real macOS box, including the LND log-path bug that puts the node in a crash-restart loop,
and the liquidity finding that actually matters: you **cannot** bootstrap an empty node by
depositing on-chain — Pub pays the LSP out of a liquidity balance that is 0 on a fresh
install. Rent inbound instead. 7,157 sat bought 100,000 inbound for 90 days on 2026-08-21.

Either way, pair ShockWallet to the node. Scan with **Add Source**.

### The one step ShockWallet does not do for you yet

The builder signs through NIP-07 or a NIP-46 bunker and never touches a key. That is
non-negotiable (rule 2), and it has one hard consequence:

> A bunker exposes `sign_event` and `nip44_*`, but **not raw ECDH**. Lightning.Pub's native
> kind 21000 RPC is encrypted with a key derived from the private key itself, so **a bunker
> cannot speak kind 21000 at all.** Every node call the builder makes is CLINK kind 21003, or
> it does not happen. (`docs/spike-findings.md` §13.18)

CLINK Manage cannot bootstrap its own grant — `validateGrantAccess` needs a grant row for
every requestor, the owner included, and the only RPC that creates one is `AuthorizeManage`,
which is kind 21000. So exactly one call in the whole seller path needs the raw key, once, at
the desk:

```bash
cd spike
node authorize-manage.ts                          # your own node, default key
node authorize-manage.ts --key .my-key --nprofile nprofile1…   # a guest account on someone else's Pub
```

It prints an `nmanage1…` pointer. Paste that into the builder and nothing in the authoring
path ever needs a raw key again.

**Could ShockWallet replace even that step? Structurally yes, and this is worth checking.**
The node already has the wallet-side approval loop: an *ungranted* requestor sending a 21003
makes `handleAuthRequired` push a `GetLiveManageRequests` message to the account owner's key
"for ShockWallet to display", and the owner answers with `AuthorizeManage` — both kind 21000,
`auth_type = "User"`, i.e. exactly what a paired wallet can speak and a browser behind NIP-46
cannot (`docs/spike-findings.md` §13.19, `methods.proto:672-727`). Same three-step dance as
the refund debit grant, which we *have* driven end to end (§13.27).

**Whether ShockWallet's shipped UI surfaces that prompt is `UNVERIFIED`** — we granted
ourselves first, which skips it entirely, so we have never seen the prompt render. The check
is cheap: pair ShockWallet, point the builder at an account with no grant, send one 21003,
and see whether the wallet asks. If it does, Option A becomes zero scripts and the seller
never leaves their phone. The same `UNVERIFIED` applies to setting the refund debit's daily
cap from the wallet UI rather than over the raw RPC.

The portable fix for all of this is **CLINK Enroll (kind 21004)**, which provisions an account
and hands back `noffer`/`ndebit`/`nmanage` in one flow. The client SDK ships it;
Lightning.Pub 0.0.37 does not implement it (`actionKinds = [21000, 21001, 21002, 21003]`).
The account-provisioning step is written as one swappable function for the day it lands.

### Then, in the browser

1. Open the builder, connect a signer (NIP-46 bunker recommended — Amber or nsec.app).
   Grant the `perms` string on connect; it is the difference between **1 approval and 5** for
   a 10-item publish.
2. Paste the `nmanage1…` pointer. Author items — the builder mints each item's offer on your
   node over CLINK Manage, with `refund_pointer` marked required.
3. Publish, then deploy. The builder hashes the storefront's files, mirrors them to four
   Blossom servers, and publishes the kind 15128 manifest. Your sale is a website.
4. Run the watcher next to your node, one process per seller:

```bash
cd spike
node watch-sales.ts              # observe settlement, republish stock. Holds NO signing key.
node watch-sales.ts --refunds    # arm auto-refunds. Off without the flag.
node authorize-refunds.ts        # ONCE, before --refunds. Mints a separate key, grants a capped debit.
node authorize-refunds.ts --revoke   # THE KILL SWITCH. One call.
```

The watcher holds no signing key: an item's stock can only count down, so the seller
pre-signs every future stock state at publish time and the watcher just picks the right one
off the shelf. Refunds go out over a CLINK Debit from a key that holds no funds and no
identity, capped **by your node** rather than by our code — a bug in our watcher costs at most
one day's cap, and you can revoke without touching this repo. The cap and the `BanDebit` kill
switch have both been watched firing.

---

## What holding no key costs

One thing, and it is the most interesting finding in the project: **the seller's own browser
cannot see the seller's own sales.** Manage's only resource is the offer — there is no invoice
or settlement resource anywhere in CLINK — and the node's `GetUserOfferInvoices` rides kind
21000, which is keyed on the raw ECDH secret a bunker will not expose. So "view settled sales"
has no CLINK path at all.

The honest answer is two answers: the admin panel derives units-sold from the public relays
for free, and `node spike/sales-report.ts` gives you the money, on the machine where the key
already lives. (`docs/spike-findings.md` §13.25)

---

## Rules this codebase enforces

Not preferences. Violating any of these destroys the pitch.

1. **No backend.** No server, no database, no accounts, no API of ours.
2. **No key handling outside the Signer.** No nsec anywhere else — not in memory, not in
   config, not in logs.
3. **No node credentials leave the browser.** `admin.connect` is `nprofile:token` with full
   node authority. It is never in this repo, in config, in logs, or on a screen.
4. **No secrets in the repo.** CI signing is NIP-46.
5. **The builder itself deploys as an nsite.** If our own app needed a server, the thesis
   would be false. It doesn't; it's live.

And one working rule that matters more than it sounds: **never guess a protocol detail.**
No CLINK kind, field, tag, or error code goes into this codebase from memory. It comes from a
spec file, source, or captured event JSON, and it is citable — or it is marked `UNVERIFIED`
and someone asks. Where training data and a spec file disagree, the spec file wins.

---

## Roadmap

What stands between "it worked on demo day" and "a stranger can run their own sale on it."

Everything below comes from `docs/known-defects.md`, `docs/status.md`, `docs/prompts/`, or a
source read cited in place — these are verified behaviours of the code on this branch, not
speculation. Items 23–26 and the corrections to M1, M3, M4, M5 and 20 came out of the 2026-08-23
review in `docs/roadmap-review-findings.md`, which is where the measurements behind them live.

**How to read this.** The lettered **milestones** are the order of work, and each one is a claim
you can make when it is done. The numbered **task IDs are stable** — item 9 is always the journal
reconcile, M1 is always the ladder-over-a-relay — so they keep their identity when a milestone is
re-cut. Within a milestone, tasks are ordered by dependency; where two are independent they are
ordered by what a failure actually costs.

**⚑** = blocked on something outside a terminal — a phone, a funded wallet, a second person, or
somebody else's repo. There are deliberately **no time estimates here.** Nine slices shipped in
about two days; nothing in that record supports sizing this work, and a size column that is
uniformly wrong makes a milestone look schedulable when it is not. Sequence is the claim being
made, not duration.

### The milestones at a glance

| | When it is done you can say | Tasks | |
|---|---|---|---|
| **A** | Safe to point at a real node | ~~1, 2, 3, 4, 5, 9, 10, 24, 25~~ + 13's quorum and count | **done 2026-08-24**, one ⚑ step open |
| **B** | Nothing on the critical path is unexecuted | ~~8~~, 6, 7 | ⚑ (**8 done 2026-08-25**); 6 and 7 both need the machine with the node and the key |
| **C** | A sale you can change from your phone | ~~M1~~, 11, M2, **M3 (delete only)** | **M1 done 2026-08-26** (relay round trip proved under throwaway keys; publishing as the real seller needs the key). **M3's fiat half done 2026-08-26**; its delete needs a re-publish, so it needs the key |
| **D** | Runs unattended for a weekend | ~~13~~, 12, 14 | **13 closed 2026-08-26**, its last bullet with it |
| **E** | A stranger can set it up | ~~16~~, ~~18~~, 15, 17, 19, 26, **27 (buy side only)** | ⚑ (**16 done 2026-08-25**, and 17's `noBuyReason` half with it; **18 done 2026-08-26**, and its premise was wrong); **27's first bullet done 2026-08-26** — what is left of 27 is a decision, not a fix |
| **F** | The seller can see their own business | M4, M5 | liftable earlier |
| **G** | A shop rather than one weekend | M6, M7, M8 | |
| **∥** | Upstream — runs alongside, gates nothing | 20, 21, 22 | ⚑ |

**Item 13 appeared in two rows on purpose, and both are now closed.** It was mis-placed: it is the
same button as item 3's second defect, so its *quorum* and *show-the-count* bullets belonged in A
and landed there on 2026-08-24, while its *refuse-to-shrink* bullet stayed in D because shrinking
is also what a legitimate delete looks like. That last bullet **landed 2026-08-26**, and the way it
resolved the entanglement is worth keeping: a guard that cannot tell a mistake from an intention
must **ask** rather than decide. Task IDs are stable, so it kept its number in both places rather
than being split into a 13a and a 13b. `docs/roadmap-review-findings.md` §13.

### Milestone A — Safe to point at a real node — **CLOSED 2026-08-24, with one ⚑ step still open**

> **Nothing known-broken can lose money or destroy a seller's work.**
> **This is now true of the code.** Every defect that was known and broken on 2026-08-23 is
> closed, refuted, or an open ledger row with its cost written down. **Item 6 is safe to run.**

`docs/known-defects.md` gated pointing the watcher at a real node on items 1 and 2. Both landed,
with tests, so that gate is lifted: the watcher can no longer pay the same buyer twice, and the
kill switch can no longer report success on a grant it never touched.

**What the claim does NOT cover, said plainly rather than left to be discovered:**
- ⚑ **Item 10's human step.** The seller key's backup is on one machine. Losing that disk loses
  the seller identity and the 9,000 sats in its account, and no session at a terminal can fix it.
  The claim is about known-broken *code*; this is known-broken *storage*.
- **Item 7 has still never run**, and it is the largest source of *unknown* defects in the project
  — five slices of markup that has never rendered. It gates nothing here and it should begin the
  moment a phone is free. Whatever it finds is triaged into this list; A being closed means the
  known defects are closed, not that there are none.
- **Four open rows in `docs/known-defects.md`** were opened or confirmed by this milestone and
  deliberately not fixed: the address-range list is a named list rather than a proof, the reconcile
  cannot prompt a daemon, `authorize-refunds.ts` cannot arm the second seller, and we invent a `k1`
  the spec says not to. Each is there with its cost. None of them loses money or destroys work,
  which is why the claim survives them.

**~~1. The refund watcher can pay the same buyer twice~~ — CLOSED 2026-08-24 (`e070ca4`).**
Both prescribed fixes landed, because either alone breaks the chain and the second is the one that
survives somebody adding a concurrent caller. `inFlightGuard` DROPS an overlapping tick rather than
queueing it — queueing would build a backlog behind the slow refund that caused the overlap, and
each poll recomputes everything from the node anyway. `recordRefund` makes `paid` terminal, and it
lives on the **journal** rather than at the call site, so item 9's reconcile inherits the rule.
- **Grepped before landing the second one, as the ledger asked:** the only writer of a row's
  `state` is `watch-sales.ts`'s `record`, the only readers are `settledByUs` and the watcher's own
  printing, and nothing in the tree moves a row *out* of `paid`. A test asserts the guard is exactly
  one state wide, because breaking `pending → paid` silently would be the same class of bug.
- **There are two timers, and only one is guarded, deliberately.** `summarise()` on its five-minute
  loop is a pure reader — a synchronous snapshot of the in-memory journal, one `GetUserOperations`
  read, and printing. Guarding it would swallow the reminder of money still owed on exactly the run
  where the node answers slowly.
- **The test is the deliverable as much as the guard is.** `--once` installs no timer, so nothing
  can drive the interval that raced; the regression test drives the shape underneath it and a
  second test asserts the same stub double-pays with the guard removed.

**~~2. The kill switch can report success while the grant stays live~~ — CLOSED 2026-08-24
(`d77400a`).** It under-scoped by one branch and the review caught it (§9): `--reset` called
`ResetDebit` on the same improvised key, so guarding only `--revoke` would have left a second
switch reporting success. The mint moved below `--show`, `--revoke` **and** `--reset`; both kill
branches refuse rather than improvise; and the verdict is read back from
`GetDebitAuthorizations` — the success line is printed from the after-state and never from the RPC
returning.
- If the node still reports the key AUTHORIZED it throws and says to ban it from ShockWallet by
  hand. If the node reports no grant at all it prints no success line, names any **other** grants
  on the account, and exits 1.
- **The objection to expect, written into the file:** this does not make the kill switch need the
  node. `BanDebit` is an RPC — it already did. Requiring the node **and** a local file is strictly
  worse, which is why `--show` now works with no key file and `--npub <hex>` kills a grant from a
  machine that does not hold one.
- `check-refund.ts` drives `authorize-refunds.ts --revoke` rather than calling `BanDebit` directly,
  asserts no AUTHORIZED grant survives, and section 4b hides the key and asserts both branches exit
  non-zero, refuse, and mint nothing.
- **Left open:** `authorize-refunds.ts` is still hardcoded to `.dev-key`, so the second seller
  cannot arm refunds at all. New row in `docs/known-defects.md`.

**~~3. Two confirmed authoring defects that silently destroy a seller's sale~~ — CLOSED 2026-08-24
(`90dc844`), and it brought half of item 13 with it.**
- `mintOffer` now dedupes on the **pair** — label and the TLV-4 price — in a pure `matchingOffer`.
  Testing it against the fixture account would prove nothing either way: those five offers were
  minted natively and Manage `list` cannot see natively-minted offers (findings §13.20), so an
  empty list there is correct behaviour rather than a broken fix.
- `#publish-sale` is gated on `noPublishSaleReason()`, consulted **both** at the enable site and
  inside `doPublishSale`. The ledger named both fixes and preferred the smaller one; this takes the
  larger, because a guard at the sink protects every caller. `loadPanel` clears the flag again if
  the read throws.
- The reason is in the copy, because a disabled control with no explanation is its own defect.
- **Item 13's quorum and show-the-count bullets landed here** — same button, same class of loss.
  See item 13 in milestone D for what stayed there and why.

**~~4. Hostile input on the refund path~~ — CLOSED 2026-08-24 (`534a0ff`). Both claims were
reproduced first, and the item cost more than one line of it suggested.**
- **Reproduced** against a self-signed listener on 127.0.0.1: a 10 MB body arrived whole through
  the 64 KB "bound" in 34 ms, a callback of `https://127.0.0.1:8443/cb` was fetched and parsed, and
  `redirect: 'follow'` followed a self-redirect **21 times** (undici's default of 20).
- **Two of the bullets were already done and were not rewritten**: https is required on both hops
  by construction, and the name half is guarded against path traversal with `encodeURIComponent`.
- **The interesting half is that the roadmap's own shape could not be built.** `dns.resolve()` then
  `fetch(url)` re-resolves the name, so the address vetted is not the address connected to — a
  hostile pointer's DNS can answer differently the second time. And `redirect: 'follow'` hands back
  the *final* response, so "re-check after each redirect" is not expressible at all.
- **So the transport changed**, from `fetch` to `node:https` — stdlib, no new dependency. The name
  is resolved once, refused if **any** answer is private, and connected to at that exact address
  with `servername` and `Host` set, so TLS still validates against the hostname. Each redirect is a
  separate vetted request, capped at three, re-checked for https, under one deadline for the chain.
  The body is counted in **bytes** off the stream and the socket destroyed at the bound.
- `isPrivateAddress` is a pure exported function and fails closed. **It is a named range list, not
  a proof** — 6to4 and Teredo are not enumerated — and that gap is an honest row in
  `docs/known-defects.md` rather than a check that reads as a guarantee.

**~~5. Triage the seven remaining unverified panel claims~~ — CLOSED 2026-08-24. All seven moved,
and that section of `docs/known-defects.md` is now empty.** Four confirmed and fixed, three
confirmed and deliberately not fixed, none left in limbo.
- ~~`render.ts:521`~~ **Fixed (`63eb718`), and grepping every caller found a second victim.** The
  reachable throws are synchronous, before the promise: a `clink_offer` carrying 32 bytes that are
  not a curve point throws inside `getConversationKey`. `spike/refund.ts` awaits the same function
  **outside** its try/catch, so that throw killed the watcher's tick — every tick, paying nothing
  and journalling nothing. The fix is in `buy.ts`, which now honours the contract the rest of it
  already kept. `render.ts` keeps a `.catch` as the belt.
- ~~`refund.ts:257`~~ and ~~`refund.ts:221`~~ **— both reproduced, both fixed. See item 4.**
- ~~`builder/index.html:206`~~ **Fixed (`63eb718`).** The copy now says what `sales-report.ts`
  actually prints: a refundable **count**, never a pointer.
- ~~`spike/watch-sales.ts:468`~~ **— CONFIRMED at `:369`, and this roadmap's reading of it was
  wrong.** The bullet said the MUST binds only when TLV 3 is present, "so a `k1` sent without one
  is not obviously forbidden". `docs/clink-notes.md` §3.3, quoting `clink-debits.md:163-172`, has
  two bullets, and the second is *"Absent ⇒ the wallet MUST NOT invent one."* Our `.ndebit` carries
  no TLV 3 and we invent one. Not fixed — removing it loses the crash-loop guard and buys nothing
  back, and doing it properly is a session ndebit per refund, which is a design change. Ledger row,
  and a candidate for the upstream track beside 21 and 22.
- ~~`builder/src/admin.ts:86`~~ **— CONFIRMED, and this repo already held the citation.**
  `storefront/src/listing.ts:111-113` reads `58.md:31`, `58.md:34` and Gamma `spec.md:135` and says
  the dimension is optional; `blobFrom` requires it. The parser and the re-publisher disagree, in
  writing, in this repo. Not fixed: it is unreachable from anything this project writes (both
  writers always emit `WxH`), and the fix changes what gets signed on the edit path. Ledger row.
- ~~`builder/src/main.ts:544`~~ **— CONFIRMED from the code path.** `loadPanel` calls `showSale()`
  unconditionally and `loadPanel(false)` runs after every item publish. The file already guards the
  same hazard for notes one line below. **The user-visible half is UNVERIFIED** — `loadPanel`
  returns early without a signer, and a signer needs the phone, so it belongs to item 7. Ledger row.

**~~9. Reconcile the refund journal against the node at startup~~ — BUILT 2026-08-24 (`aee8a86`);
proof is item 6's.**
- The reconcile returns **findings, never transitions**. A `pending` row with a match prompts and
  says in the prompt that the match is on amount and time only; a row with no match is reported as
  having no evidence. The 2026-08-23 review reversed this item's original bullet (§1) and the
  reversal is load-bearing: marking a row `paid` on the heuristic records a refund that may never
  have been sent and strands the buyer.
- Only the **refusals** act without a human, because refusing costs a delay and deciding costs a
  payment. An oversell with no journal row but a matching outgoing payment is blocked and
  journalled `queued`; `--refunds` refuses to start when the journal file is absent and the node
  reports outgoing payments; and it refuses to arm at all if the node's outgoing payments cannot be
  read, because not knowing what has already been sent **is** the double-pay condition.
- **The non-TTY decision: a non-TTY start RUNS, transitions nothing, and says so loudly.** Refusing
  to start was the other defensible option and it is the wrong one, because this process is also
  slice 3's watcher — stop it and items stay advertised as available after they sell, which is a
  new loss rather than a guard against one. A `pending` row is already never retried and never
  dropped, so not asking returns it to exactly the state the watcher has always kept it in.
- Five tests, all against a stub. **It can only be *proven* once a real refund has been paid**,
  which is item 6.

**~~10. Make the un-regenerable files survivable~~ — CLOSED 2026-08-24 (`06e56a2`), except the ⚑
step, which is still open.** `docs/runbook.md` §5 sorts twelve gitignored files into gone-forever,
gone-forever-and-holds-money, redo-the-work, and recreated-by-nothing, and carries one backup
command and one restore procedure.
- **The drill was run**, into a scratch tree, from the archive alone, and its transcript is in the
  runbook — because a procedure that has never been run is a belief. It proved three things beyond
  "the files came back": file modes survive the `tar` round trip, the restored ladder is current
  enough that the stale-ladder check watches all five items, and `sales-report.ts --key` reaches
  the **second** seller's sub-account rather than silently reporting the first.
- It also found that both scripts resolve paths from their own file location and import
  `../storefront`, so a restore is a whole `spike/` next to a `storefront/`. The procedure says so.
- ⚑ **STILL OPEN, and this PR cannot close it.** `spike/.dev-key`'s backup is on **one machine**.
  Getting a copy off it is a human step with a second device — an encrypted stick or a hardware
  password manager, verified there. Named in the runbook and in the demo-day checklist.
- The `.builder-key` half is why item 26 exists. Noted, not decided here.

**~~24. The only tool that reports money is hardcoded to one seller~~ — CLOSED 2026-08-23
(`ac87512`), before this milestone's PR.** `spike/sales-report.ts:56` is `arg('key', '.dev-key')`,
matching `watch-sales.ts:83`, and the ladder and offers paths beside it got the same `suffixed()`
treatment. Exercised again by item 10's restore drill, which reads both accounts from a restore.

**~~25. An empty string satisfies a required `payer_data` key~~ — CLOSED 2026-08-24 (`35b6621`),
driven on the wire, free, and the hole is wider than this item described.**
`node spike/check-empty-pointer.ts` sends four kind 21001 requests and pays nothing:

```
declined        the key absent entirely (the control)
                code 1: Missing or invalid payer_data: refund_pointer
INVOICE ISSUED  the empty string
INVOICE ISSUED  one space
INVOICE ISSUED  a string that is not a pointer of any kind
```

- It is not that the empty string slips through. `ValidateExpectedData` checks only
  `typeof payerData[key] !== 'string'` (`offerManager.ts:148-152`), so what the node enforces is
  "the key is present and is a string" and **any** value buys an invoice.
- **The decision was to narrow the three claims**, which is done: `docs/spec.md` §7.3 and
  `docs/design.md` §4 now say what is true — the guarantee is our page's, not the node's — and
  slice 8's re-decision is annotated rather than rewritten, because its *conclusion* still holds.
- **The form was not weakened.** `render.ts`'s `isPointer` gate is the thing that makes the claim
  true for our buyers and it stays.
- Filing it upstream stays open and is now cheap, because that script is the reproduction an
  upstream issue wants. M5 inherits this hole for its pickup code, so settling it here is what
  unblocks that later.

### Milestone B — Nothing on the critical path is unexecuted

> **Every branch of the money loop has run once, on real hardware, with real sats.**
> ⚑ Blocked on a person with a phone and a funded wallet.

Code that has never executed is not a feature. Two of these have been carried across five
slices. ~~Item 6 genuinely must wait for A~~ — **A closed on 2026-08-24, so item 6 is unblocked**;
item 7 should already be underway.

**6. Pay one real refund, end to end ⚑** *(needed 1, 2 and 4 — **all three landed 2026-08-24**)*
**It is now safe to run.** The watcher cannot pay the same buyer twice, the kill switch cannot lie
about having stopped, and the pointer a stranger supplies can no longer aim the watcher at a
private address or feed it an unbounded body. Two things to know before the run:
- **Item 9's reconcile is built but has never been exercised**, because nothing has ever written a
  `pending` row. This run is what proves it. Run the watcher from a **terminal**, not launchd, so
  the prompt can be answered.
- **Re-decide the cap first.** `docs/spec.md` §12: the account is at 9,000 sats against an
  8,000/day frequency rule, so the cap now binds before the balance does — for the first time, and
  without anybody deciding it should. `node authorize-refunds.ts --cap <n>` re-caps in one call.

Every debit driven so far is one the node **refused**. That proves the cap and proves nothing
about the happy path. `payDebit`'s `{"res":"ok"}` branch has never executed on the wire —
**it is now the only branch of the refund path that has not.** `resolvePointer`'s LNURL branch was
proven end to end on 2026-08-24: an address at `coinos.io` returned a BOLT11 for exactly 1,000 sats
in 1,540 ms, both hops, with `invoiceSats` matching. It cost one free call. So what item 6 still
proves is the *payment*, not the resolution.
- **The pointer must be an LNURL-pay address, and Phoenix is not one.** A BIP-353 address
  (`…@phoenixwallet.me`) is the same `user@domain` shape and resolves to nothing this path can
  use — item 27, measured 2026-08-24. Wallet of Satoshi, Alby, Coinos, Blink or an `noffer` all
  work. Getting this wrong burns the oversell on a refund that cannot complete. **Since 2026-08-26
  it at least fails legibly** — the `queued` row names BIP-353 instead of DNS — but a legible
  failure still burns the one oversell there is, so this instruction is unchanged.
- `mugs` is already **sold out 3/3**, and a depleted offer stays payable (findings §13.17) — so
  a single `node check-buy.ts yardsale-2026-08-mugs --pay --pointer <a wallet you control>` **is**
  the oversell. No restocking, no second payment. 1,000 sats.
- `node watch-sales.ts --refunds`, and watch the money come back.
- Use the default seller, not the second one: `.merida-key` has **no refund grant armed**, so an
  oversell there is logged and not paid.
- Net cost is routing fees. Record the transcript in `docs/spike-findings.md` and close the two
  ledger rows that name these branches.

**7. The browser verification run ⚑**
Slices 4 through 9 shipped markup that has **never been rendered**: the sticker sheet has never
been printed, the `@media print` block has never run, `noBuyReason` and `missingItemNote` have
never painted, the `geo:` link has never been tapped. `docs/prompts/browser-verify-and-deploy.md`
is the script for one sitting that covers all of it.
- ~~**First: resolve the contradiction in `docs/status.md`**~~ — **RESOLVED 2026-08-24. The
  operator is on iOS and Amber is Android-only** (`spec.md:244`), so the import cannot have
  happened and the "it has happened" line was false. It mattered: `spike/.dev-key.nsec` and the
  QR were deleted in slice 9 *on that line's authority*. `export-key-qr.ts --yes` regenerates them.
- ~~**Pick a signer that exists on this operator's hardware.**~~ **DONE 2026-08-24: nos2x**, a
  desktop NIP-07 extension, holds the seller key and exposes `nip44`. No phone. Verified in the
  console — `getPublicKey()` returns `fb18e881…cdb47a0` and `typeof nip44` is `"object"`.
  **Check the pubkey after any signer change**: the first import loaded a personal key, which
  would have published to an npub the storefront never reads while reporting success throughout.
- **Do not carry the predicted signature count over.** `PERMS` is NIP-46 only (`signer.ts:143`);
  `connectNip07` (`:90`) never sends it and NIP-07 has no perms handshake. So findings §8's
  Amber/nsec.app measurements and q8's "Approve basic actions" risk describe a mechanism nos2x
  does not use, and **the predicted 1 was a bunker-path number.** Count nos2x's actual prompts
  across the publish sequence and record that instead — it is per-site and remembered, not granted.
- Publish one item, press Deploy, print a sticker sheet, tap a `geo:` link on a phone.
- Count the actual signature prompts and compare against the predicted 1.
- **The render-only half is DONE, 2026-08-25, on the machine with no key.** Item 8's harness
  drives it for free, so what is left here is genuinely only the publish/deploy/sign half.
  Verified painting against the live sale's events: `noBuyReason` on the fiat item ("Priced in
  MXN — cash at the table…") and on the free one ("Free — just ask when you get here."),
  `missingItemNote` on a deep link to a `d` that is not in the sale, the `geo:` link, the
  `@media print` block in both apps, and the sticker sheet's element and `hidden` state. A
  sold-out item correctly renders no `.buy` at all. **Five of the six surfaces this item calls
  "never rendered" have now rendered**; the sticker sheet has still never been *printed* with
  content in it, because building one needs a signer.
- **And the `geo:` tap is the one that failed.** It resolves to 20.6261, -103.3930, which is 5.9 km
  from Colonia Americana, because the corrected geohash was never published. Do not tap it on
  a phone expecting a pass; republish first.

**~~8. A smoke test so unrendered markup cannot accumulate again~~ LANDED 2026-08-25**, and it
did **not** need item 7 first, which is the part worth keeping. It was written on a second machine
with no node, no keys and no signer (`docs/status.md`, "THE SECOND MACHINE"), because the DOM is
not the money path. The two are only coupled in the sentence that said item 8 "needs 7".
- `storefront/smoke.test.ts` and `builder/smoke.test.ts`, two files, six assertions, wired into
  `npm test` (`node --test src/*.test.ts smoke.test.ts`) and into `tsconfig.json`'s `include` so
  `tsc --noEmit` type-checks them. Suites are now **64** in the storefront (61 + 3) and **70** in
  the builder (67 + 3). No page-object framework, and the run costs ~1.4 s per app.
- `playwright@1.62.1` as a devDependency in both apps, pinned to the version `shots/` already
  resolves so the chromium binary is shared and nothing downloads. **Zero bundle cost**: the
  storefront's cold JS is 31,883 bytes gzip before and after. Reasoning in spec §9.1.
- **No relay, node or key at test time.** `storefront/smoke-fixture.json` is the real signed kind
  30402/30405 events read off the four public relays once, replayed through a `window.WebSocket`
  stub, because `SimplePool` verifies every event and signing a fixture here would put a private
  key in the codebase against rule 2.
- **The roadmap bullet above was half wrong and the code said so.** `body > main { display: none }`
  is the *builder's* print rule; the storefront must print its `<main>` (that is the flyer) and
  hides `.buy` instead. Each app is asserted against the rule it actually has.
- Each assertion was **watched failing** before it was trusted: delete `required`, flip
  `body > main` to `block`, drop the storefront's `@media print { .buy }`. One failure each,
  all reverted.
- **It found a defect on its first run**, which is the argument for the whole item: the live sale's
  `geo:` link points **5.9 km** from the sale. Slice 9 corrected the geohash in `spike/fixture.ts`
  and never republished, so the relays still serve `9ewmr4z`. See `docs/known-defects.md`, "Added
  by item 8". **Fixing it is a republish and therefore item 7's machine, not this one.**

**~~23. One real payment into the second seller's sub-account~~ — ALREADY DONE, and nothing knew.**
This was written on 2026-08-23 as an open item, on the strength of
`docs/prompts/demo-day.md` §0.2 (*"The Mérida sub-account has never received money… the single
largest unproven thing in the demo"*) and `docs/status.md`'s `manage_id 2, balance 0`. **Both were
stale.** `node sales-report.ts --key .merida-key` reports `artesanias-jabon 800 1/12 800 sats in,
refundable 1/1, settled 2026-08-21T22:13:28Z` — hours after those two lines were written.
- **It arrived over the channel, not internally**, which is the distinction `demo-day.md` §0.2
  warns about: `lncli listchannels` reads 9,800 local against the two accounts' 9,000 + 800. A
  `PayInternalInvoice` between two accounts on this Pub is a database move that leaves channel
  local balance untouched, so the sum matching is the proof it was real Lightning.
- **So milestone B's claim survives**, and findings §11 — one Pub, a market of sellers, each with
  their own sub-account — is proven with money rather than argued.
- **Why nobody knew, and it is item 24:** the only tool that reports money could not see this
  account. The payment sat in the node for two days, invisible to every document, and adding one
  `--key` flag surfaced it in a single command. That is the item's real lesson and it is the
  reason 24 is not a nicety.
- Residual, and it is small: `.merida-key` still has no refund grant, so the oversell path has
  never run for this seller. That stays item 6's job on the default seller and does not need
  repeating here.

### Milestone C — A sale you can change from your phone

> **Editing stops requiring a file copy and a daemon restart.**

**Editing a live sale already works** — slice 6 shipped it: edit any item, restock, mark sold,
private notes, photos preserved without re-uploading a byte, and the offer reused rather than
re-minted so a save does not strand a payable pointer on the node. Items 3 and 13 harden that
path. What none of them fix is M1, which is the reason editing *feels* broken even though it
works.

**Why this comes before the unattended work.** Milestone A already fixes the known money-loss
defects, so D protects against *unknown* bad days — a process dying, a relay lagging. Those are
rarer than "the seller needs to restock the mugs", which happens continuously during a live sale
and today costs a file copy and a daemon restart every single time. M1 also reshapes items 11 and
12, so building D first means building parts of it twice.

**~~M1. The ladder has to travel over a relay, not a USB stick~~** **DONE 2026-08-26.** One kind
30078 per item, `d: lamppost-ladder-<listing d>`, NIP-44 encrypted from the seller to a new
`spike/.watcher-key` that owns nothing, spends nothing and signs nothing. The builder learns that
key by paste; the watcher mints it, prints its npub, and `node watch-sales.ts --watcher-key`
prints it without needing a node. Precedence is per item and the file is kept as the cold-start
fallback. The watcher SUBSCRIBES, so an edit needs no restart either. It cost no new signer
permission and exactly one more signature, which `approvalCount` now takes as a required argument.
Full reasoning and the two new measurements are in /docs/spec.md §9.4; the real four-relay round
trip is `node spike/check-ladder-relay.ts`, which needs no seller key. Still unproven until the
keyed machine runs it: publishing a ladder as the real seller and the live watcher picking it up
mid-sale. What follows is the problem statement as it stood.

Today every edit — and restock *is* an edit — ends at `builder/src/main.ts:366` (the line as it
stood before M1; the sentence now survives only as the no-watcher fallback at `main.ts:412`): *"Save it as
`.ladder.json` next to `watch-sales.ts`, then restart the watcher."* The seller downloads a file
from their browser, copies it onto the machine running the daemon, and restarts a process. Miss
the step and either `isStale` refuses to watch the item, or the watcher publishes rungs the relay
silently drops and the item stays on sale after it sells. The ladder also lives in `localStorage`
keyed by pubkey, so a seller who edits from a second device produces a file that blinds the
watcher to every item that device never published.
- The rungs are signed public kind 30402s — **publishing them raw would immediately advertise the
  lowest stock on every item.** They must be wrapped, not published.
- Wrap them the way `builder/src/notes.ts` already wraps private notes — NIP-44 inside a kind
  30078 — but **encrypt to the watcher's pubkey, not to the seller's own key.** `notes.ts` is
  encrypt-to-self because only the seller's browser ever reads it; here the *watcher* has to
  decrypt, and only a holder of the seller's private key can open a self-encrypted payload. It
  holds one today (`watch-sales.ts:148` reads `.dev-key`) purely because the fixture seller and
  the node account are one identity — a coincidence spec §12 says should be a separate key "where
  possible". Encrypting to self would turn that coincidence into a requirement. The shape is
  `notes.ts`'s; the recipient is not.
- `sign_event:30078`, `nip44_encrypt` and `nip44_decrypt` have been in `PERMS` since slice 4, so
  this costs **no new signer permission, no new dependency, and no second bunker approval**.
- One event per item (`d: lamppost-ladder-<slug>`), not one for the whole shop. **The binding cap
  is NIP-44's 65,535-byte plaintext ceiling, not a relay's event size** — measured 2026-08-23:
  `nos.lol` allows 131,072 and damus and primal a million, while the Mérida sale's whole-shop
  ladder is already **40,381 bytes at six items**, 62% of the NIP-44 ceiling, and hits it at nine
  — the same number of items the flyer holds (design.md §3). Per item the ceiling is ~46 units of
  a photo-carrying item, which no yard-sale item reaches. Measure a candidate shape against
  `spike/.merida-key.ladder.json`; do not go asking the relays.
- The `d` prefix is clear: CLINK Beacon reserves `clink-*` on this kind and `notes.ts` already
  takes `lamppost-shop`, so `lamppost-ladder-<slug>` collides with neither.
- The watcher subscribes instead of reading a file, and re-checks on every update rather than
  only at startup. Keep the file as the offline fallback; do not delete it.
- This removes the copy, the restart, and the single-browser dependence in one change. It does
  not remove item 11 — it changes what item 11 is for. See the note there.

**11. Close the ladder-staleness hole on the write side** *(needs M1, and shrinks because of it)*
The availability ladder is cut from one version of the listings. Edit a price, a title or a photo
without re-cutting it, and the watcher republishes the old text over the new with a newer
`created_at` — and a relay answers `OK` to a replaceable event it does not store, so this fails
silently, successfully, and forever. `isStale` catches it at watcher *startup*; nothing catches
an edit made while the watcher is running.
- Have the builder stamp the listing version the ladder was cut from into the ladder file.
- Have the watcher re-check staleness per tick, not only at startup, and stop publishing rungs
  for an item whose live listing has moved ahead of them.
- Fail loudly to the operator instead of continuing quietly.
- **M1 makes the remedy automatic but not the detection.** Once the ladder arrives over a relay,
  a stale one heals itself on the next edit instead of stranding the seller — but the watcher
  still needs to notice, for the cases M1 does not cover: the relay did not deliver, or the
  seller edited from a device whose publish failed. Build the check; it is just no longer the
  only thing standing between an edit and a silent oversell.

**M2. Make the seller's state recoverable** *(needs M1)*
After M1 the ladder survives losing a laptop. The manage pointer still does not: `.nmanage` is
pasted per browser and stored in `localStorage`, so a seller on a new device is back at a terminal.
- **This needs a decision before it needs code.** `docs/status.md`'s traps say the account pointer
  is "seller's browser only, never a relay, never a log" — an event NIP-44 encrypted to the
  seller's own key is arguably not "a relay" in the sense that rule means, but it is a relay in
  the sense that a rule can be read literally. Settle it explicitly and write the reasoning down.
- If yes: it rides in the same encrypted 30078 as the notes, and a new device is a bunker
  connection and nothing else.
- If no: say so in the UI, and make re-pasting the pointer a first-class step rather than an
  error state.

**M3. Retire an item, and edit a fiat one**
Two holes in the edit form that have nothing to do with each other except that both are refusals.
- ~~**Fiat items cannot be edited at all.**~~ **DONE 2026-08-26.** `Draft.fiat` carries currency
  and amount through and replaces the sats price tag, so `records` republishes as
  `["price","80","MXN"]`. What makes that safe is that **the offer cannot follow it**: `publish.ts`,
  `approvalCount` and `draftFrom` each refuse to mint or reuse one independently, and
  `fiatCurrency` refuses every spelling of sats so the two paths can never meet. The currency is
  read off the listing and can never be typed. `#price` is **disabled**, not merely hidden, because
  a `required` control in a hidden wrapper still blocks submit — asserted in chromium.
  - **The currency comparison was two questions.** The disagreement is REAL: `admin.ts` demanded
    the exact lowercase `sats` while `storefront/src/listing.ts` accepted `/^sats?$/i`, so an item
    priced `sat` or `SATS` was **buyable and uneditable**. It is also **LATENT**: measured against
    both live sales on 2026-08-26, all 17 listings write exactly `sats` or `MXN`. Closed by
    construction — one exported `isSats`, called from both — and **widened**, not narrowed, because
    tightening the storefront is a money-path change made to fix a builder bug. Cost: 6 bytes gzip
    (7 while `render.ts` still carried two literal copies of the regex; 6 once they were deleted).
- **Still open, and it is the delete:**
  **There is no delete.** "Mark sold" is the only retirement and the item stays on the storefront
  at stock 0 permanently. **Removing it from the kind 30405 member list hides nothing** — the
  storefront queries `{kinds: [30402, 30405], authors: [pubkey]}` and `orderBySale` only *sorts*,
  so a non-member falls to the foot of the page in `d` order and keeps rendering. That is the
  same demotion the ledger already records for a short read. So retirement is a re-publish at
  stock 0 with `status: sold` (which `ladder.ts` `atStock` already produces) plus an optional
  NIP-09 kind 5 request — and the NIP-09 half, the one relays honour at their discretion, is the
  only half that can stop a page drawing it.
- ~~**This has to land after item 13, not before.**~~ **Item 13's guard landed 2026-08-26, so
  this is unblocked.** M3's delete works *by* shrinking the member list, which is indistinguishable
  on the wire from item 13's slow-relay short read; the confirmation path now exists, so a
  legitimate delete has somewhere to go instead of tripping a refusal. The delete itself needs a
  re-publish and therefore the machine with the key.
- Do **not** delete the offer on the node when retiring an item. It takes the buyer's stored
  refund pointer with it (findings §13.17).

### Milestone D — Runs unattended for a weekend

> **A dead process, a slow relay or an expiring lease is visible rather than silent.**

The storefront's correctness depends on a Node process on somebody's machine. Right now nothing
anywhere says when it stops.

**12. Supervise the watcher**
The storefront's correctness depends on a Node process on the seller's machine, one per seller.
If it dies, stock goes stale and oversells stop being refunded, and nothing anywhere says so.
- A launchd plist (macOS) and a systemd unit (Linux) with restart-on-failure, in `docs/`.
- A heartbeat line on every tick so `lpub-log`-style tailing shows liveness.
- Exit non-zero and loudly on the conditions that must not be papered over: a stale ladder, a
  missing journal, a revoked grant.
- Do not build a monitoring service. A supervisor and a log line is the whole of it.

**~~13. Make publishing robust against a slow relay~~ CLOSED 2026-08-26** *(two bullets moved to A and landed there 2026-08-24; the third landed here)*
A kind 30405 is a replacement, so `publishSale` must send every member every time — and the
member list it is handed is whatever four relays returned on the last "Load my items". One slow
relay and pressing "Publish my sale" quietly un-lists real items.

**This item was mis-placed** (`docs/roadmap-review-findings.md` §13). It is the *same button* as
item 3's second defect — `#publish-sale` → `doPublishSale` → `publishSale(signer, draft,
owned.map(…))`. Item 3 fixed "fires before `owned` is populated"; this fixes "fires when `owned`
is short". Fixing one still leaves a button that can drop items, which is a kind 30405 replacement
that un-lists real listings — exactly the loss milestone A claims to have closed. So two of the
three bullets went to A and landed there on 2026-08-24:
- ~~Require a quorum of relays to answer before treating a member list as complete.~~ **DONE in A.**
  `loadItems` reports which relays contributed (`trackRelays`/`seenOn`); below a majority,
  publishing is refused.
- ~~Show the seller the member count they are about to publish~~ **DONE in A** — `#sale-cost` says
  how many items are about to replace the collection, and how many relays it was read from.
  ~~Surface which relays answered, so a partial read is visible rather than inferred.~~ **DONE in
  A** as a consequence: it is the same measurement the quorum rule needs.
- ~~**Still here, and deliberately:** refuse to shrink a sale without an explicit confirmation.~~
  **DONE 2026-08-26, and it is a SET DIFFERENCE rather than a length comparison.** "Shorter than
  the one on the relays" is a proxy: swap one item for another and the count is identical while a
  real listing is un-listed. `droppedMembers` asks which current members are missing from the
  replacement, **names them**, and requires an explicit tick. It sits **after** the quorum gate on
  purpose — below quorum the list is short because a relay was slow, and asking a seller to confirm
  that trains them to tick without reading. The confirmation is asserted rendering in
  `builder/smoke.test.ts`. This is what unblocks M3's delete for the machine with the key.

**14. Node liveness and the channel lease**
- The inbound channel is a **lease and it expires 2026-11-19.** Nothing watches it. Add the check
  to the runbook's day-to-day block and put the date somewhere that alarms.
- A laptop that sleeps is a shop that closes. `caffeinate -s` is the demo-day answer; an
  always-on host is the real one.
- Note that a successful invoice request proves nothing about *receiving* — only a settled
  payment does.

### Milestone E — A stranger can set it up

> **Onboarding is a phone and a browser, and someone we did not brief has run a sale.**
> ⚑ Ends blocked on a person who is not us.

This is where the thesis gets tested rather than asserted. Item 19 is the capstone and it cannot
happen before C — you cannot hand someone a workflow that requires copying a file onto your
laptop.

**15. Take the terminal out of seller onboarding** *(needs 7)*
Today a seller must run `spike/authorize-manage.ts` from a shell next to a raw key, because
`AuthorizeManage` is kind 21000 and a bunker cannot speak kind 21000. But the node already has
the wallet-side approval loop — an ungranted 21003 pushes `GetLiveManageRequests` to the account
owner's key "for ShockWallet to display", answered with `AuthorizeManage`, both kind 21000 and
both things a paired wallet *can* speak.
- **Verify first, it is five minutes:** pair ShockWallet, point the builder at an account with no
  grant, send one 21003, and see whether the wallet renders a prompt.
- If it does: make the builder's grant step "send a 21003 and wait", and delete the script from
  the happy path. A seller then never leaves their phone.
- Same session, settle the other open `UNVERIFIED`: whether the refund debit's daily cap can be
  set from the wallet UI rather than over the raw RPC.
- If it does not: file it upstream and keep the script, documented as the one terminal step.

**~~16. Show staleness instead of hiding it~~ LANDED 2026-08-25**
Availability is only as fresh as the watcher, and that is inherent to a serverless storefront
rather than a bug. The page used to present stale stock as current; it now dates it.
- `render.ts` `freshnessNote` renders "Availability as of 5 days ago" on the item, from the
  listing's own `created_at`. Relative rather than absolute, because the question a buyer is
  asking is "is this recent enough to drive over for", and "14:32" only answers that if you
  already know the time. `Intl.RelativeTimeFormat` is a browser global, so the phrasing costs no
  bytes and the plurals are not ours to get wrong. `now` is injected, so it tests without a clock.
- **Detail view only.** design.md §2.3 makes the index a scanning surface, and a timestamp on all
  nine rows is the same noise `stockNote` already refuses to print. The disclosure sits in front
  of the Buy button, which is where "is this still true" is the question being asked.
- **A sold item is not dated.** Stock only ever counts down (the pre-signed ladder, spec §7.3),
  so sold cannot go stale in the direction that costs a buyer a trip. Dating it would imply it
  might come back.
- **Print-hidden**, and that is the sharper half of the same idea: a relative phrase is frozen
  the moment it is on paper, and therefore false. The flyer foot already carries the honest
  version, which is that the list changes during the sale and the URL is where it changes.
- Still worth saying out loud in the demo. Disclosed staleness is a design property; undisclosed
  staleness is a lie the page tells.

**17. Remove the buyer's dead ends.** **The `noBuyReason` half LANDED 2026-08-25**
~~Wrap the Buy form's `requestInvoice` so a rejection re-enables the form and explains itself.~~
**That bullet was item 5's, scheduled twice** (`docs/roadmap-review-findings.md` §18), and item 5
closed it in milestone A on 2026-08-24. What is left is the half that was always separate:
- ~~Distinguish "this item has no offer" from "this item's offer disagrees with its price tag" —
  `noBuyReason` currently collapses both into one unhelpful sentence.~~ **DONE.** `listing.ts`
  `buyableOffer` now reports one bit, `priceDisagrees`, and `noBuyReason` branches on it.
  - **This reversed a judgement slice 8 made in writing.** Its test said the two were "reached two
    ways a buyer cannot tell apart **and does not need to**". The first half is still true; the
    second was wrong, and the reason is specific: the two cases differ in whether **the price on
    the page can be trusted**, which is the one thing a buyer acts on. A disagreement means the
    number above may be wrong and driving over with that much cash is a wasted trip. Every other
    way to have no offer leaves the price tag standing.
  - **One bit, not a reason code**, because exactly one distinction changes buyer behaviour. A
    pointer we cannot decode is grouped with an absent one deliberately: we do not know what it
    says, so we cannot accuse the price of being wrong. Sold, fiat and below-floor items are
    refused before any price is compared, so they can never set it.
  - **The new sentence is unit-tested and has never rendered**, which is worth naming given what
    item 8 is for. A mismatched item needs a signed 30402 whose price tag and `clink_offer`
    disagree; SimplePool verifies every event, and minting one needs a key (rule 2). The wrapper
    markup is proven via the fiat and free branches, which use the identical path. Ledger row in
    `docs/known-defects.md`.
- **Item 27 is the same class and is worse**, because that dead end is only reached *after* the
  buyer has paid: a BIP-353 refund pointer is accepted at buy time and is useless at refund time.
  **Still open**, and the nearest thing to this slice on the list.

**~~18. Make redeploying safe~~ LANDED 2026-08-26**
~~The nsite gateway sends `max-age=3600` and serves the previous build until it lapses.~~ **It
does not lapse, and that is the item's finding.** Measured 2026-08-26: the live manifest was
replaced 2026-08-21T18:11:43Z and the gateway was still serving the pre-replacement `index.html`
**4d 9h later**, 106× the advertised `max-age`, while `check-deploy.ts` §1 and §2 passed
throughout. Same on the builder's own nsite. The mechanism is UNVERIFIED.
- ~~Have `check-deploy.ts` report the gateway's cache age alongside the relay and Blossom state.~~
  **DONE**, and it reports what the gateway actually sends rather than a cache age it does not
  have: `age` is **not sent at all**, `last-modified` is the **Blossom blob's** mtime (the origin
  returns the identical value, so it dates the build and not the cache), `cache-control` is
  `public, max-age=3600`, and `etag` **is** the sha256 of the decompressed bytes — weak-tagged
  `W/"…"` under gzip, which makes `curl -sI <url>` a complete staleness check. §4 turns those into
  one verdict: `WAIT IT OUT` while the manifest is younger than `max-age`, `WAITING IS NOT THE FIX`
  once it is older and still stale.
- ~~Document the cache-busting query-string escape hatch, if one exists on the gateway.~~ **It
  does not exist, and that is now probed rather than believed.** §4 runs two probes on every stale
  run — a query string and `cache-control: no-cache` — and both returned the same stale bytes on
  2026-08-26. The stale copy is on the gateway's side and is not addressable from a client.
- ~~Build stickers **after** deploying~~ **already true in the app** — `builder/src/main.ts:551`
  says so on screen next to the sheet. What was missing was the ordering in the runbook (§8), and
  one correction: the sticker URL is derived from the pubkey and is stable across *re*-deploys, so
  this binds on the **first** deploy, not on every one.
- **Candidate spun out of this, not built:** the current kind 15128 answers from `relay.damus.io`,
  `nos.lol` and `purplepag.es` and **not** from `relay.nostr.band` or `relay.primal.net`, both in
  `SALE_RELAYS`. §1 queries the pool as a set and cannot show this. Whether it explains the
  gateway is UNVERIFIED.

**19. A second seller who is not us ⚑**
`docs/spec.md` §3.1 draws the line: two keys that are both ours is model 1; somebody else's sats
resting in our Pub is model 2, and model 2 means custody. Everything above is worth little until
one person we did not brief has run a sale.
- Write the guest-onboarding path down as a page a stranger can follow, not a set of commands
  we know by heart.
- Watch one person do it without helping. Every place they stop is a roadmap item.
- Be explicit with them about custody, correlation, and shared liveness before they take money.
- Needs item 24, or they cannot see what they earned.

**26. Decide whether the builder keeps the key it is running on** *(one-way, so decide it early)*
The builder — rule 5's own artifact, the thing that proves this project needs no server of ours —
is live on `npub1qqm97k4…`, a **throwaway key generated during slice 5**. It has been an open
question in `docs/prompts/browser-verify-and-deploy.md` since then and nothing has answered it.
- A kind 15128 root site is **one per pubkey**, so a real identity later means a **new URL**, and
  every link, slide, QR and printed reference to the old one breaks. There is no migration.
- So this is not a polish item, it is a fork: commit to the slice-5 key and treat it as permanent
  (which makes item 10's "gone forever if lost" protection meaningful rather than incidental), or
  move now, before anything else prints or publishes that URL.
- Either answer is fine. Leaving it unanswered while the URL spreads is the one that is not.

**27. A Phoenix buyer cannot be refunded** ~~, and nothing says so until after the sale~~ **— the seller is told now (2026-08-26); the BUYER still is not, and that half is a decision**
`LN_ADDRESS.test()` cannot tell a BIP-353 address from an LNURL-pay one — they are the same
`user@domain` shape — so `resolvePointer` builds a `/.well-known/lnurlp/…` URL for a host that
serves no HTTPS at all. **Measured 2026-08-24**: `phoenixwallet.me` has NS records on Route 53 and
no A or AAAA record, no `www`/`api`/`app` either. What it has is a TXT record at
`<name>.user._bitcoin-payment.<domain>` carrying a `bitcoin:?lno=…` BOLT12 offer. Phoenix is a
mainstream wallet, so this is the common case for one popular wallet rather than an edge one.

Found by running `resolvePointer` against a real address for the first time — the thing
`docs/known-defects.md` had recorded as never done since slice 7. It cost one free call, and no
offline test could have found it: every address a test server can bind is one `isPrivateAddress`
correctly refuses.

- ~~**Say the true reason.**~~ **DONE 2026-08-26.** `resolvePointer` looks up
  `<name>.user._bitcoin-payment.<domain>` when the **first** LNURL hop fails **permanently** (no
  address record, or a 4xx) and this exact address publishes a record starting `bitcoin:`. Per
  **address**, not per domain, so a typo cannot become a BIP-353 accusation. Bounded as hostile
  input: its own resolver at 2 s / 1 try, an outer **wall-clock** race, 16 records, 4 KB, a single
  validated DNS label, and it returns a **boolean** so the offer is never logged. Proven live
  against `matt@mattcorallo.com` (a published test vector) in 392 ms, and proven **not** to fire
  against `coinos.io`. **Still open here:** a real Phoenix address cannot be tested from a machine
  with no buyer — a made-up name is NXDOMAIN at the BIP-353 name too and correctly falls back.
- **Then decide the buy side, which is the larger half and is a decision rather than a fix.**
  Should `isPointer` refuse a pointer the refund path cannot use? It would move the failure from
  *after* the sale to *before* it — a settled invoice stores the pointer forever and the node
  cannot fix it afterwards (`docs/spike-findings.md` §13.17). But refusing means turning away
  Phoenix buyers outright, and a manual refund at the table may well be the better trade for a
  yard sale. **Name the answer; do not let it be decided by whichever code path someone edits
  first.** Related to item 17: this is a dead end the buyer only meets once the money is gone.
- **Paying a BOLT12 offer is a feature, not a fix, and it is not this item.** `payDebit` sends a
  BOLT11, and whether this Lightning.Pub can pay an offer at all is **UNVERIFIED**. That is a
  spike, and it lands after item 6 has proved the ordinary path.
- Ledger row with the full reasoning is in `docs/known-defects.md`, "Added by milestone A".

### Milestone F — The seller can see their own business

> **Settled sales and pickup verification, without a terminal and without holding a key.**
> Liftable earlier — see below.

**This can run parallel to E.** It is sequenced after only because E puts one real outside seller
in front of the app, and what that person struggles with should shape what this milestone
builds. If the "reads as a product" jump matters more than that feedback, pull it forward.

**M4. Let the seller see their sales in the browser after all**
`docs/spike-findings.md` §13.25 says the seller's browser cannot read the seller's sales, and
that is true — *directly*. It is not true transitively. The watcher already holds the credential
that can call `GetUserOfferInvoices`, and the watcher can publish.
- The watcher reads settled sales, NIP-44 encrypts a summary to the seller's pubkey, and
  publishes it as a kind 30078 under **a third key** — not `.dev-key` and not `.refund-key`. The
  browser subscribes and decrypts.
- **The "watcher holds no signing key" line is already false, and knowing that is what makes this
  buildable.** It reads the seller's secret key off disk (`watch-sales.ts:148`) and signs kind
  21000 with it (`pub-rpc.ts:97-99`). So the ledger's stated reason for keeping the refund journal
  off a relay — "the watcher holds no signing key by design, so it cannot publish a record of what
  it did" — is wrong on the facts. What slice 3 actually guarantees is narrower: the watcher signs
  no *listing*.
- **So one rule does move, and it should be written down rather than waved past.** Publishing
  under `.dev-key` would mean a daemon signing events as the seller, which is precisely the
  authority the pre-signed ladder exists to withhold. A third dedicated key keeps that guarantee —
  at the cost of being a **new credential and new pairing state**, which is what the one-time
  pairing below actually is. No server, no key custody change, and the seller's browser still
  holds no key; but this is not free of shape.
- Carry exactly what `spike/sales-report.ts` prints — amounts, timestamps, counts, refundability
  as a boolean — and **never a refund pointer or a preimage.** `/CLAUDE.md` forbids logging them
  and an event on a relay is worse than a log.
- The browser must verify the signature and the publishing pubkey before trusting a byte; a
  summary from an unknown key is an attacker telling the seller they got paid.
- One-time pairing so the browser knows which pubkey to trust.
- This is the single biggest "this reads as a product" change on either list.

**M5. Pickup verification** *(better after M4)*
The seller cannot decrypt the CLINK receipt, so when a buyer arrives at the table there is no way
to check that this person is the one who paid. **`docs/spec.md` §7.6 already designed this and
this item has to answer it before proposing anything else.** §7.6's mechanism is the buyer's
ephemeral request pubkey (`clink_requester_pub`, stored on the invoice): the seller's device shows
a QR challenge, the buyer's page signs it with that key, and the seller checks the signature
against the pubkey the watcher already synced. It is unbuilt for a named reason, not for want of a
design — the buyer's page drops that key on navigation, and persisting it is a rule-2 decision.
§7.6 also insists that if the key is ever kept it is kept for **both** pickup proof and buyer
messaging, and a `payer_data` code silently drops that pairing. It also proves less: a challenge
proves the person at the table holds the key that paid; a code proves they remember what they
typed.
- The mechanism already exists and is already in use: the offer's `payer_data` **required-key
  list**, which today carries `refund_pointer`. Declare a second key — a short pickup code the
  buyer types into the buy form.
- The seller looks it up in `sales-report.ts`, or in M4's panel at the table.
- Name the cost honestly: every required key is one more wallet that cannot pay without our form.
  Slice 8 already chose that trade deliberately, so this is consistent rather than new.
- **It does not force a re-mint, which is the expensive thing it looks like.** CLINK Manage
  `update` writes `payer_data` in place against the existing offer id, so the `noffer` is
  unchanged: no new pointer, no listing re-publish, no ladder re-cut, no `1 + units` signatures.
  One `update` per offer the builder minted. The exception is the five fixture offers, which were
  minted natively and which Manage cannot touch — and findings §13.20 already accepted that they
  get re-minted whenever they are first edited, so M5 inherits that cost rather than creating it.
- **`ValidateExpectedData` only checks `typeof … === 'string'`, so an empty string satisfies a
  required key.** The node will not enforce a pickup code any more than it enforces a refund
  pointer; the page has to, the way `render.ts` already gates on `isPointer`. See item 25 — that
  hole exists today and this item inherits it.

### Milestone G — A shop rather than one weekend

> **Lifecycle, blob durability, and being findable.**
> The loosest grouping here.

The loosest grouping here, and honestly three unrelated things. M7 is independent — pull it forward anywhere. M8 may be a *decision* rather than a task: "this is a share-a-link
product" is a legitimate answer that closes it.

**M6. A second sale, next month** *(needs M3)*
There is no answer today to "I want to run another sale." The sale's `d` is every item's `d`
prefix, so changing it orphans every item the seller has published — the `a` tags point at a
collection that no longer exists and `admin.ts` stops recognising the items. That is a lifecycle
hole rather than a bug, and it will be the first thing a returning seller hits.
- Decide the model: a new `d` per sale with an explicit migration, or one long-lived sale that
  items join and leave.
- Decide what archiving means for the listings, the offers on the node, and the nsite. An offer
  left payable forever is a liability; deleting it destroys refund pointers. Neither is chosen.
- Whatever is chosen, the storefront needs to render "this sale has ended" rather than an empty
  page or a stale one.

**M7. Blob durability** *(independent, pull it forward any time)*
The storefront's images and files live on public Blossom servers that owe nobody anything.
`blossom.band` has already dropped the site's JS and HTML on content-type sniffing, and the
fixture's 21 photos are still on that one server alone.
- A command that reports per-blob mirror count across the kind 10063 list and re-uploads anything
  below a threshold. `check-deploy.ts` already does the walk; this is the repair half.
- Run it on a schedule. Not on demo day — the gateway caches for an hour.

**M8. Discovery** *(independent)*
Nobody can find a sale they were not linked to. Nostr tag filters match **exactly**, with no
prefix matching, so a single `g` geohash tag is unfindable by proximity by construction.
- The multi-precision geohash convention is what makes exact-match filters usable for proximity —
  publish the geohash at several precisions rather than one. **The convention is NIP-CC
  (geocaching), not NIP-99; re-fetch and cite `CC.md` before building, the NIPs repo is not on
  this machine.**
- That is the cheap half. The expensive half is a buyer-facing search with no index of ours —
  which may mean this stays a "share a link" product, and that is a legitimate answer.

### Parallel track — Upstream, which fixes this for everyone

These gate nothing of ours and run alongside every milestone above. Each is small, each is
somebody else's repo, and item 22 is the single biggest ceiling on E.

**20. `LND_LOG_DIR` should default per-platform ⚑**
`settings.ts:116` hardcodes the Linux log path —
`chooseEnv('LND_LOG_DIR', dbEnv, resolveHome("/.lnd/logs/bitcoin/mainnet/lnd.log"), addToDb)`,
read by `unlocker.ts:104`. (Both this line and `docs/runbook.md` used to say `unlocker.ts:116`:
right line number, wrong file, which is an hour lost by whoever opens the PR.) So on macOS
`waitForLndSync` polls a file that
does not exist, times out at 300s, throws, and launchd restarts the node — every five minutes,
forever, while LND itself is perfectly healthy. A small PR to Lightning.Pub, and the kind of
ecosystem contribution judges notice.

**21. Report the BUD-11 base64url conflict ⚑**
The spec requires the auth token be base64url; three of the four Blossom servers that will store
an nsite's HTML reject base64url and accept standard base64. Somebody is wrong and it locked this
project to a single server for four slices. Report it with the transcript.

**22. CLINK Enroll (kind 21004) ⚑ — not ours to land**
The portable way to provision an account and receive `noffer`/`ndebit`/`nmanage` in one flow. The
client SDK ships it; Lightning.Pub 0.0.37 does not implement it. Until it lands, onboarding a
seller onto a shared Pub is a manual pairing string handed over out of band — which is the single
biggest ceiling on item 19. The account-provisioning step is already written as one swappable
function so that the day this lands, it is a small change here.

### Deliberately not on this roadmap

- **A sales screen that asks the node directly.** CLINK has no settlement resource and
  `GetUserOfferInvoices` rides kind 21000, which a bunker cannot speak. If you find yourself
  putting `pub-rpc.ts` in the builder, stop — that is the wrong shape, and no amount of wanting
  it changes the transport. M4 is the shape that works: the watcher asks, and tells the browser
  over a relay.
- **A map on the storefront.** A basemap is a third-party hostname on every page load. The sale's
  geohash as a `geo:` link is the whole feature.
- **A BOLT12 fallback.** BOLT12 is nowhere in this stack — not Lightning.Pub, not this LND
  build's `lncli` — and CLINK's "Offer" is an unrelated thing that shares a word.
- **Anything that needs a server of ours.** If a feature seems to need one, the answer is a
  signed event on a relay, or the feature does not ship.

---

## Documents

Read in this order:

| File | What it is |
|---|---|
| `docs/status.md` | **Start here.** Where the project is today, what is live, the exact commands that reproduce it, and what is blocked. Goes stale fastest. |
| `docs/spec.md` | Architecture and build plan. |
| `docs/spike-findings.md` | Verified facts, measured or read from source. **Where this disagrees with the spec, this wins.** |
| `docs/clink-notes.md` | CLINK field names, kinds, and error codes, as read from the spec repo. |
| `docs/runbook.md` | Operating the node: install gotchas, pairing, liquidity, demo-day checklist. |
| `docs/known-defects.md` | The defect ledger. |
