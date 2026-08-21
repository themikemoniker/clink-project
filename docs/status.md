# Status — where the project is, and what to do next

**Read this first in a new session, then `/CLAUDE.md`.** It is the handoff note: current state,
the commands that reproduce it, and what is actually blocked. It is deliberately short and it
goes stale — where it disagrees with `/docs/spike-findings.md`, the findings win.

Last updated: **2026-08-21**, end of slice 4.

---

## One-paragraph summary

Slices 0 through 4 are done. A static page hosted on Nostr reads listings off public relays and
takes Lightning payments by sending CLINK invoice requests to the seller's own node over relays.
**This is proven with real money** — 6,000 sats settled on 2026-08-21 and the page read the
settlement receipt that nobody else can decrypt. A watcher on the seller's machine closes the
loop: it observes settlement on the node and republishes the listing, **holding no signing key**,
so `plants` reads as sold on the relays today. And as of slice 4 a seller authors items in a
static builder that holds no key either — signing through NIP-07 or a NIP-46 bunker, minting each
item's offer on their own node over **CLINK Manage (kind 21003)**. There is no server of ours
anywhere in it. Next up is slice 5: deploy from the app.

**The thing to know before touching slice 5.** Moving authoring behind a Signer made
Lightning.Pub's native kind 21000 RPC *unreachable from the browser* — it is keyed on a raw ECDH
secret that NIP-46 does not expose (findings §13.18). Every node call the builder makes is CLINK,
or it does not happen. Anything still using kind 21000 (`mint-offers.ts`, `watch-sales.ts`,
`authorize-manage.ts`) is a script holding the raw key on the seller's own machine, and that is
now a deliberate boundary rather than an accident.

---

## What is live right now

| | |
|---|---|
| Storefront | `https://npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws.nsite.lol/` |
| Seller pubkey (throwaway) | `fb18e881362a772e1bff2fc260a5ff47cb01d3fa7a254349948603774cdb47a0` |
| Sale | kind 30405 `yardsale-2026-08`, 9 items on 4 public relays |
| Node | local Lightning.Pub 0.0.37 + LND, 1 private channel |
| Node liquidity | **90,160 inbound / 8,000 outbound** — drifts with every sale |
| Node account | app user `0db5acc4…`, owned by `spike/.dev-key`, holding **8,000 sats** |
| Bundle | 30.9 KB gzip cold + 3.9 KB QR chunk on demand. Budget is **gzip** |

Four items are buyable; the rest deliberately are not:

| item | price | state |
|---|---|---|
| `mugs` | 1,000 sat | **`stock 1` of 3 — two units bought for real on 2026-08-21.** The cheap demo item |
| `plants` | 6,000 sat | paid 2026-08-21, and **the watcher has marked it sold on the relays** |
| `lamp` | 30,000 sat | buyable, `stock 3` — the expensive one, still untouched |
| `bike` | 180,000 sat | has an offer, but priced **above inbound** — invoice issues, payment cannot settle |
| `couch` | 210,000 sat | same |
| `records` | 80 MXN | fiat, cash at the table, no offer by design |
| `boxes` | free | no offer |
| `table`, `mirror` | sold | seeded sold, so no offer was ever minted for them |

---

## Commands that reproduce the state

Nothing here needs a build step; Node 24 runs the `.ts` files directly.

```bash
# storefront
cd storefront
npm test            # 27 assertions, node --test, no framework
npm run build       # tsc --noEmit && vite build
npm run size        # raw + gzip per asset
npm run dev         # http://localhost:5173

# the money path, against the running node
cd spike
npm test                               # 8 tests / 20 assertions, node --test — the ladder
node check-buy.ts                      # decline -> invoice -> price-mismatch refusal. Free.
node check-buy.ts <item> --pay         # prints an invoice and waits. COSTS REAL SATS.
node mint-offers.ts [--dry]            # idempotent; reuses offers by label
node seed-listings.ts                  # republishes the 30402s AND cuts .ladder.json
node watch-sales.ts [--once]           # slice 3: observe settlement, republish availability
node deploy-nsite.ts                   # blobs to Blossom, kind 15128 + 10063 to relays

# slice 4: authoring, against the running node
node authorize-manage.ts               # ONCE, at the desk. Grants Manage, writes .nmanage
node authorize-manage.ts --revoke      # takes the grant back
node check-manage.ts                   # mints a real offer over kind 21003. Exit 0 = it works

# node health
export PATH="$HOME/lnd:$PATH"
lncli state && lncli listchannels | grep -E 'active|local_balance|remote_balance'
curl -s http://127.0.0.1:1776/api/health
```

**Ordering matters.** `mint-offers.ts` → `seed-listings.ts` → `watch-sales.ts`. The builder is a
separate track that does the first two itself, per item, for items authored in it.

**The builder does not replace the seeder, and slice 4 did not delete it.** The fixture's nine
items and five offers are still seeded by the scripts, and those offers went over the native kind
21000 RPC — which means **CLINK Manage cannot see or edit them** (findings §13.20). Nothing is
broken; an edit flow through Manage just cannot touch them. Slice 6 decides whether to re-mint.
 The seeder cuts
the pre-signed ladder from the listings it publishes, so any edit to a price, a title or a photo
means re-seeding before the watcher runs, or the watcher would republish the old text over the
new. `seed-listings.ts` takes ~1 minute since `cdn.satellite.earth` came out of its default on
2026-08-21 — it had never accepted a single blob and cost 21 x 20s of timeout per run. **Blobs
now live on exactly one server**, which is one garbage collection from a broken storefront; a
second server that takes anonymous uploads is still the highest-value infrastructure find.

`spike/.dev-key` and `spike/.offers.json` are gitignored and **not reproducible from the repo**.
Losing `.dev-key` loses the seller identity, the storefront's npub, and access to the 6,000 sats
sitting in that node account. Back it up before anyone acts on `seed-listings.ts`'s instruction
to delete it at slice 4.

---

## What is genuinely blocked, and on what

One spike question remains, and it **needs a phone.** Nothing blocks a slice. Full `NEEDS HUMAN`
blocks with exact commands live in `/docs/spike-findings.md`.

### Question 6, wallet half — does a third-party wallet supply `payer_data`?

```bash
cd spike && node -p "require('./.offers.json')['yardsale-2026-08-lamp'].noffer"
```

Pay that from **ShockWallet on another device**. Record whether it prompts for
`refund_pointer`, fails silently, or shows the node's error text.

This is now *secondary* — our page is the client sending the 21001, so the pointer arrives
whatever a wallet does. What the answer changes is slice 8's copy and `/docs/design.md` §4: if
no wallet can supply the key, every offer we mint is unpayable by anything but our own page,
and an item-QR sticker must point at the item page rather than the offer. We have already
assumed that worst case in the design.

### Question 8, bunker prompt count — **ANSWERED 2026-08-21 from source**

**1 prompt** for a 10-item publish with `perms` granted at connect, **5** if `perms` is ignored
entirely. Both Amber and nsec.app honour `perms` for arbitrary kinds, Amber's *default* sign
policy is the one that persists them, and both key a remembered grant on `(app, type, kind)` — so
twenty kind-`24242` Blossom auths cost one approval between them. The old 33-prompt floor assumed
a seller who declines to remember anything thirty-three times. Nothing is over the ~15 threshold,
so **slice 4 builds the publish flow as planned.**

**Slice 4 turned this into a task with a button on it.** The builder sends the string below at
connect; `bunker-scan` in `/builder` generates the `nostrconnect://` URI carrying it. So the
confirmation run is now: import `spike/.dev-key` into your bunker, open the builder, click
"Connect a bunker", scan, and publish one item.

Note `21003`, which every earlier copy of this string omitted — nothing signed a CLINK event as
the seller before slice 4. Note `30405`. And note that neither signer accepts a bare `sign_event`
with no kind:

```
perms=get_public_key,nip44_encrypt,nip44_decrypt,sign_event:30402,sign_event:30405,sign_event:21003,sign_event:15128,sign_event:10063,sign_event:24242,sign_event:30078
```

Read from source, not measured on hardware. One confirmation run remains, and the residual risk
is a UI one: Amber's "Approve basic actions" policy silently discards the requested perms and
gives you the no-`perms` path with no error. Citations and the exact code paths are in findings
§8.

---

## Slice 3 — what shipped, and the bit that was not in the description

Three new files in `/spike`, one refactor, no storefront changes at all.

| file | what |
|---|---|
| `ladder.ts` | `atStock` / `unitsOf` / `targetStock` + the reasoning. 3 functions |
| `ladder.test.ts` | 8 tests, 20 assertions, `node --test`, same style as the storefront's |
| `watch-sales.ts` | the watcher: poll, derive, publish |
| `pub-rpc.ts` | the kind 21000 transport, lifted out of `mint-offers.ts` (findings §13.13) |

**The blocker underneath the one-line description was signing.** Republishing a kind 30402
means signing as the seller, and `/CLAUDE.md` rule 2 says the watcher must not hold the key.
No substitute key works: a listing's authority *is* its signature.

The answer, and it is worth stating on stage: **a yard-sale item has a finite set of future
states.** Stock 3 can only become 2, 1, 0. So the seller signs all of them at seed time and the
watcher holds a bundle of already-signed events — an availability ladder — publishing the right
rung when money arrives. Each rung's `created_at` increases as stock falls, so NIP-01's
newest-per-address rule makes a replayed or out-of-order publish a no-op: availability cannot
run backwards by construction. Full reasoning in spec §7.2 and the header of `spike/ladder.ts`.

Consequences worth carrying forward:

- **The watcher holds no signing key.** Not "the narrowest credential" — none. It still holds a
  node credential to *read* settlements, and that one is not read-only (findings §10).
- **Spike question 8 never applied to slice 3.** A bunker-signing watcher would have prompted
  the seller's phone once per sale, mid-yard-sale. This one signs nothing. (q8 was separately
  answered from source the same day — `perms` is honoured — which makes that watcher buildable
  but not preferable: a standing `sign_event:30402` grant next to an always-on process is what
  holding no key avoids.)
- **No persisted idempotency state.** Remaining stock = `units − |distinct settled invoices|`,
  recomputed from the node each poll. The node holds the state; a restart recomputes it; a
  replayed kind 21001 that never became a payment cannot move it.

Two things measured while building that changed the spec:

1. **`GetLiveUserOperations` cannot attribute a payment to an item.** `UserOperation` carries no
   `offer_id` (`structs.proto:634-646`), so the live feed has to be followed by
   `GetUserOfferInvoices` anyway — and it pushes once, so a watcher that was down never learns.
   Spec §7.2 ranked it first; the ranking is now inverted. Findings §13.16.
2. **Deleting a depleted offer would destroy the buyer's refund pointer.** Spec §7.4(a) makes
   "delete the offer on sellout" v1's strict mode. `GetUserOfferInvoices` throws once the offer
   row is gone, and it is the only way the stored `payer_data` leaves the node. An oversell *is*
   a post-depletion settlement, so shipping that would break slice 7 in its own core case. **The
   watcher does not delete offers.** Findings §13.17, and it needs a decision before slice 7.

### What slice 3 deliberately did not build

- **No `InventoryPolicy` interface** (spec §8). One implementation, and the second one is
  disqualified — that is scaffolding.
- **No live storefront updates.** The page still reads once at load; a visitor watching an item
  sell sees it on refresh. `storefront/src/nostr.ts` marks where a subscription would go.
- **No offer retirement, no refunds.** Slice 7.

### Verified how

```
cd spike && npm test                     # 8/8
cd storefront && npm test                # 27/27, unchanged
cd spike && node mint-offers.ts --dry    # transport still talks to the node after the lift
cd spike && node seed-listings.ts        # 9 ladder steps for 5 items
cd spike && node watch-sales.ts          # then pay something
```

**Proven with real money, 2026-08-21, for 2,000 sat total.** `mugs` exists precisely so this did
not cost 60,000: same shape as `lamp` (sats-priced, `stock 3`, identical ladder) at 1/30th the
cost per settlement. Two payments through `check-buy.ts yardsale-2026-08-mugs --pay`:

```
02:34:12  yardsale-2026-08-mugs: 1 sold -> stock 2, 3/4 relays
02:35:51  yardsale-2026-08-mugs: 2 sold -> stock 1, 3/4 relays
```

Read back off the public relays through the storefront's own parser after each: `stock=2` then
`stock=1`, both `buyable=yes`, `created_at` at base+1 and base+2 — the ladder's rungs, in order.

What the money closed that the tests could not: **the node reports two distinct settled invoices
against one `offer_id`, and `settledCount` counts them as 2.** That was the last untested link;
everything else on the path was already covered by `ladder.test.ts`.

**The watcher also self-healed, unplanned and worth demoing.** Re-seeding republished `plants` as
available with a fresh `created_at`; the watcher put it straight back to sold on its first tick,
because remaining stock is recomputed from the node rather than remembered. That is a better
stage beat than the sellout — it shows where the state actually lives.

`mugs` has **one unit left on purpose**: a 1,000-sat item to sell live on stage instead of a
30,000-sat one. Paying it takes the ladder to its last rung — sold, `clink_offer` tag dropped.

---

## Slice 4 — what shipped, and the two things that were not in the description

`/builder`, a second Vite app: Vite + TypeScript, no framework, **zero new runtime dependencies**.
Plus two spike scripts, and one constant moved.

| file | what |
|---|---|
| `builder/src/signer.ts` | the Signer. NIP-07 + NIP-46, `PERMS`, persisted client key |
| `builder/src/manage.ts` | CLINK Manage kind 21003 client + `nmanage` decoder |
| `builder/src/photos.ts` | canvas resize to 1200/480/160, one kind 24242 auth per blob |
| `builder/src/listing.ts` | the 30402 tags, the `imeta` tag, the ladder cut. **The tested one** |
| `builder/src/publish.ts` | mint → sign → verify → publish → hand over the ladder file |
| `builder/src/main.ts` | the form |
| `spike/authorize-manage.ts` | the one-time Manage grant + the `nmanage` pointer |
| `spike/check-manage.ts` | drives the builder's real modules against the live node |

### 1. A Signer makes the native RPC unreachable, so the transport chose itself

`/docs/spec.md` §14 framed CLINK Manage vs the native kind 21000 RPC as portability against
convenience. It is not a trade-off. Kind 21000 is encrypted with Lightning.Pub's own v1 envelope
— xchacha20 keyed on `sha256` of the raw ECDH x-coordinate (`nostrPool.ts:110-114`, `176-190`) —
and NIP-46 exposes `sign_event`, `nip04_*`, `nip44_*`, `get_public_key` and nothing else. There is
no way to ask a bunker for a shared secret. Kind 21003 takes the other branch of that same `if`
and is NIP-44 v2. **A bunker-held key can speak CLINK and cannot speak the native RPC**, full
stop. Findings §13.18 had already read this from source; slice 4 measured it and built on it.

Two corrections fell out of building it:

- **The `AuthorizeManage` grant costs zero prompts, not one.** It is `auth_type = "User"`
  (`methods.proto:678-683`), so the account's own key issues its own grant. The one-prompt path
  is `handleAuthRequired`, which only fires for an *ungranted* requestor. Findings §13.19.
- **Manage and the native RPC do not see the same offers**, asymmetrically: native
  `GetUserOffers` sees everything, Manage `list` sees only offers carrying its own
  `management_pubkey`. Findings §13.20. The fixture's five are native and stay native.

Because `AuthorizeManage` is itself kind 21000, it cannot bootstrap over Manage — hence
`spike/authorize-manage.ts`, run once at the desk with the raw key. After it, nothing in the
authoring path touches a key.

### 2. The ladder is authored now, and every route to the watcher was closed

Slice 3's watcher publishes rungs `seed-listings.ts` cut from the raw key. Behind a Signer, the
builder cuts them — so **an item is `1 + units` signatures**, a term `/docs/spec.md` §5's budget
did not have. Same kind throughout, so a remembered `sign_event:30402` grant still makes it one
approval; the builder shows the real count anyway, because a seller told "one approval" who then
sees thirty abandons the publish and leaves a listing with no ladder.

Delivering them is the harder half, and every obvious route is closed: a relay marks the item
sold instantly (NIP-01 keeps the newest per `(kind, pubkey, d)` and the rungs are newer by
construction), a backend is rule 1, and NIP-78-to-self needs a key the watcher deliberately does
not have. So the browser downloads `.ladder.json` in exactly the shape `watch-sales.ts` already
reads and the seller drops it next to the watcher. **Nothing on the watcher side changed.**

### What slice 4 deliberately did not build

- **No React, Tailwind or shadcn/ui**, against `/docs/spec.md` §9 and `design.md` §5 — corrected
  in §9. One form, an upload list and a connect screen; native `<form>`/`<label>`/`<input>`/
  `<output>` cover it. Revisit at slice 6 if the admin panel really wants tables and toasts.
- **No blurhash.** The tag question is answered — NIP-92 `imeta`, NIP-94 field names, both cited
  in findings §13.21 — and we write `imeta` with `x`, `dim`, `alt` and `fallback`. A blurhash
  needs an encoder here and a decoder inside the storefront's 30 KB budget, to replace a flat
  tone that already works.
- **No edit flow.** Editing an item means re-cutting its ladder (a stale rung republishes old
  text over new with a newer `created_at`) and re-minting through Manage. Slice 6.
- **No 30405 re-signing.** A new item appears at the foot of the sale, because `orderBySale`
  renders collection members first and strays after. Reordering is slice 6.
- **No deploy.** Slice 5. The builder itself is not yet an nsite, so rule 5 is still owed.

### Verified how

```
cd builder   && npm test          # 10/10
cd builder   && npm run build     # tsc --noEmit clean; 141.5 KB raw / 50.2 KB gzip
cd storefront && npm test         # 27/27, unchanged
cd spike     && npm test          # 8/8, unchanged
cd spike     && node mint-offers.ts --dry    # still talks to the node after REFUND_POINTER moved
cd spike     && node authorize-manage.ts     # granted manage_id 1 on the live node
cd spike     && node check-manage.ts         # 13/13 checks, a REAL offer minted over kind 21003
```

`check-manage.ts` is the one that matters, and it is the `check-buy.ts` pattern: it imports
`/builder/src/manage.ts` and `/builder/src/listing.ts` unmodified and drives them against the
running Lightning.Pub. It mints a real offer, confirms the node priced it correctly in the
noffer's TLV 4, confirms `refund_pointer` was recorded required, confirms it is not the account's
default offer, and then confirms the storefront's own parser would draw a Buy button on the
resulting listing and walk the ladder `2 -> 1 -> 0`. If it and the builder ever disagree, it is
wrong.

**What is NOT proven: the browser half.** No NIP-07 extension and no bunker has driven this — no
Chrome extension was connected in the session that built it. The module graph typechecks, builds,
and every DOM selector in `main.ts` resolves against `index.html`, but connecting Amber and
publishing an item from a real browser is unrun. That run is also spike question 8's hardware
confirmation — see below.

---

## Traps that will cost an hour each

- **A NIP-46 bunker cannot speak kind 21000.** Every native Lightning.Pub RPC — `AddUserOffer`,
  `GetUserOffers`, `GetUserOfferInvoices`, `AuthorizeManage` — needs a raw ECDH secret NIP-46 does
  not expose (findings §13.18). In the browser it is CLINK or nothing. If you find yourself
  wanting `pub-rpc.ts` in the builder, stop: that is the wrong shape.
- **Manage `list` does not show natively-minted offers.** `management_pubkey` partitions them,
  asymmetrically — native sees everything, Manage sees only its own (findings §13.20). An empty
  Manage `list` on an account with five offers is not a bug.
- **`authorize_npub` wants a HEX pubkey despite the name.** It is stored as `app_pubkey` and
  matched against `event.pub`. An `npub1…` creates a grant that silently never matches.
- **`spike/.nmanage` carries the account pointer.** Same handling as the pairing string: seller's
  browser only, never a relay, never a log, never this repo. It is gitignored.
- **An item is `1 + units` signatures, not one.** Any UI that implies otherwise gets a seller
  abandoning a publish halfway, leaving a listing on the relays with no ladder behind it.
- **The ladder is cut from one version of the listings.** Edit a price, a title or a photo and
  you must re-seed before running the watcher, or it republishes the old text over the new with
  a newer `created_at`. `mint-offers.ts` → `seed-listings.ts` → `watch-sales.ts`, in that order.
- **Availability is only as fresh as the watcher.** A page loaded while it is down shows stale
  stock. That is inherent to a serverless storefront, not a bug — say it out loud in the demo.
- **`pool.subscribeMany(relays, filter, params)` takes a single filter OBJECT** in nostr-tools
  2.24.3. An array makes strfry answer `bad req: provided filter is not an object` and the
  subscription silently never fires.
- **A successful invoice request proves nothing about receiving.** A fixed-price offer is not
  range-checked, so a 0-channel node returns a valid BOLT11 it cannot settle. Only a paid
  invoice proves the node works (findings §1).
- **The three CLINK error envelopes differ.** Offers is `{"code":…,"error":…}` with no `res`;
  Debits and Manage are `{"res":"GFY",…}`. One parser for all three is a bug.
- **Be lenient on receive, strict on send.** Lightning.Pub omits `clink_version` on 21001
  *responses* but includes it on *receipts* — so the tag's presence signals nothing.
- **A missing `preimage` does not mean an internal transfer**, whatever `clink-offers.md:333`
  says. Measured on a real external payment (findings §5).
- **Redeploying does not appear immediately.** The nsite gateway sends
  `cache-control: public, max-age=3600` and serves the previous build until it lapses. The
  relays and Blossom update instantly; the gateway does not. **Do not redeploy on demo day.**
- **Never publish the account's default offer.** Its `offer_id` *is* the account pointer.
- **Never delete a depleted offer.** It takes the buyer's stored refund pointer with it —
  `GetUserOfferInvoices` is the only reader and it throws once the offer row is gone
  (findings §13.17). This corrects spec §7.4(a).
- **Never guess a CLINK kind, field, tag, or error code.** They are in `/docs/clink-notes.md`
  with citations. Write `UNVERIFIED` and ask.

---

## Document map

| file | what it is | authority |
|---|---|---|
| `/CLAUDE.md` | project rules — non-negotiable | highest |
| `/docs/clink-notes.md` | CLINK kinds, fields, error codes, quoted with citations | wins on protocol detail |
| `/docs/spike-findings.md` | measured evidence, `NEEDS HUMAN` blocks | wins over spec.md |
| `/docs/spec.md` | architecture and the slice plan (§10) | |
| `/docs/design.md` | the two design surfaces | |
| `/builder` | slice 4's authoring app. Signer, CLINK Manage, photos, the ladder cut | |
| `/docs/runbook.md` | the node: install, funding, demo-day checklist | |
| this file | where we are today | goes stale fastest |
