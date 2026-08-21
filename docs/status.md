# Status — where the project is, and what to do next

**Read this first in a new session, then `/CLAUDE.md`.** It is the handoff note: current state,
the commands that reproduce it, and what is actually blocked. It is deliberately short and it
goes stale — where it disagrees with `/docs/spike-findings.md`, the findings win.

Last updated: **2026-08-21**, end of slice 7.

---

## One-paragraph summary

Slices 0 through 6 are done. A static page hosted on Nostr reads listings off public relays and
takes Lightning payments by sending CLINK invoice requests to the seller's own node over relays.
**This is proven with real money** — 6,000 sats settled on 2026-08-21 and the page read the
settlement receipt that nobody else can decrypt. A watcher on the seller's machine closes the
loop: it observes settlement on the node and republishes the listing, **holding no signing key**,
so `plants` reads as sold on the relays today. And as of slice 4 a seller authors items in a
static builder that holds no key either — signing through NIP-07 or a NIP-46 bunker, minting each
item's offer on their own node over **CLINK Manage (kind 21003)**. **Slice 5 closed the loop: the
builder now deploys the sale as a website**, hashing the storefront's files, mirroring them to
four Blossom servers and publishing the kind 15128 manifest — and the builder itself is deployed
as an nsite, which is the last thing `/CLAUDE.md` rule 5 was owed. **Slice 6 added the admin
panel** — edit, restock, mark sold and private notes, all of it either a public relay read or an
event encrypted to the seller's own key. There is no server of ours anywhere in it. **Slice 7
closed the loop the other way: the watcher now sends money back.** An oversold item is refunded
automatically over a CLINK Debit (kind 21002) from a separate key that holds no funds and no
identity, capped by the seller's own node rather than by our code — and the cap and the `BanDebit`
kill switch have both been watched firing. Next up is slice 8: the fallback payment path.

**The thing slice 6 found, and it is the one to say on stage.** "View settled sales" has no CLINK
path at all. Manage's only resource is the offer; there is no invoice or settlement resource
anywhere in CLINK; and the node's own `GetUserOfferInvoices` rides kind 21000, which is keyed on
a raw ECDH secret NIP-46 does not expose. **So the seller's own browser cannot see the seller's
sales.** That is not a gap we failed to close — it is what holding no key actually costs, and the
honest answer is two answers: the panel derives units-sold from the relays for free, and
`node spike/sales-report.ts` gives the money on the machine where the key already is.
Findings §13.25.

**The thing to know before touching slice 6.** The storefront is no longer compiled per seller.
It reads its own npub out of `location.hostname` (NIP-5A `5A.md:156-158`), so one build serves
any seller — that is what let the builder carry a pre-built copy at all. `SELLER_PUBKEY`,
`__SELLER_NPUB__` and `__SITE_URL__` are gone; `?seller=npub1…` is the dev fallback.

**And the one from slice 4, still true.** Moving authoring behind a Signer made Lightning.Pub's
native kind 21000 RPC *unreachable from the browser* — it is keyed on a raw ECDH secret that
NIP-46 does not expose (findings §13.18). Every node call the builder makes is CLINK, or it does
not happen. Anything still using kind 21000 (`mint-offers.ts`, `watch-sales.ts`,
`authorize-manage.ts`) is a script holding the raw key on the seller's own machine, and that is
now a deliberate boundary rather than an accident.

---

## What is live right now

| | |
|---|---|
| Storefront | `https://npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws.nsite.lol/` |
| Builder (slice 5, rule 5) | `https://npub1qqm97k4eg432zydvkclnhhnkyd7dgjxmndmaapk48jzms9uyl5qqlerxa2.nsite.lol/` |
| Slice-5 deploy test site | `https://npub1lfw6k46xe8theshxkw8sqwmja6u9svf90l09cyn3e02awvwmvxtqtmaeka.nsite.lol/` |
| Seller pubkey (throwaway) | `fb18e881362a772e1bff2fc260a5ff47cb01d3fa7a254349948603774cdb47a0` |
| Sale | kind 30405 `yardsale-2026-08`, 9 items on 4 public relays |
| Node | local Lightning.Pub 0.0.37 + LND, 1 private channel |
| Node liquidity | **90,374 inbound / 8,000 outbound**, measured 2026-08-21 — drifts with every sale |
| Node account | app user `0db5acc4…`, owned by `spike/.dev-key`, holding **8,000 sats** |
| Refund grant | **live** — `spike/.refund-key`, CLINK Debit, **8,000 sats/day**, expires 2026-09-20. `node spike/authorize-refunds.ts --show` |
| Blossom | **four** servers, verified — *for anything deployed after the slice-5 fix.* Two things predate it and are still on one server each: see the two single points of failure below |
| Storefront bundle | 31.0 KB gzip JS + 2.0 CSS + 2.4 HTML cold, + 3.9 KB QR chunk on Buy |
| Builder bundle | **57.3 KB gzip cold** (+4.3 for slice 6), + a built storefront in `public/site` (~99 KB raw) |

Four items are buyable; the rest deliberately are not:

| item | price | state |
|---|---|---|
| `mugs` | 1,000 sat | **`stock 1` of 3 — two units bought for real on 2026-08-21.** Re-verified 2026-08-21 after slice 6: the last unit is still there. The cheap demo item |
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
npm test            # 30 tests, node --test, no framework
npm run build       # tsc --noEmit && vite build
npm run size        # raw + gzip per asset
npm run dev         # http://localhost:5173

# the money path, against the running node
cd spike
npm test                               # 10 tests / 35 assertions, node --test — the ladder
node check-buy.ts                      # decline -> invoice -> price-mismatch refusal. Free.
node check-buy.ts <item> --pay         # prints an invoice and waits. COSTS REAL SATS.
node mint-offers.ts [--dry]            # idempotent; reuses offers by label
node seed-listings.ts                  # republishes the 30402s AND cuts .ladder.json
node watch-sales.ts [--once]           # slice 3: observe settlement, republish availability

# slice 5: deploy
node deploy-nsite.ts                   # storefront/dist -> 4 Blossom servers, 15128 + 10063
node deploy-nsite.ts --dry             # hash and build both events, publish nothing. Free
node deploy-nsite.ts --key .deploy-test-key    # deploy to a throwaway, not the live npub
node deploy-nsite.ts ../builder/dist --key .builder-key   # rule 5: the builder as an nsite
node check-deploy.ts <npub>            # relays, then Blossom, then the gateway. No key needed
node check-deploy.ts <npub> --skip-gateway     # skip the cache, check only what is true

# slice 7: refunds — the only thing here that spends
node authorize-refunds.ts              # ONCE, at the desk. Mints .refund-key, grants the debit
node authorize-refunds.ts --show       # list grants, change nothing
node authorize-refunds.ts --revoke     # THE KILL SWITCH. BanDebit. One call
node authorize-refunds.ts --cap 2000   # re-cap an existing grant (EditDebit)
node check-refund.ts                   # proves the cap AND BanDebit fire. Costs NOTHING.
                                       # Leaves the grant REMOVED — re-run authorize-refunds.ts
node watch-sales.ts --refunds          # slice 3's watcher, armed. Off without the flag

# slice 6: the admin panel
node check-admin.ts [<npub>]           # drives /builder's admin module against the LIVE sale.
                                       # No key, no node, publishes nothing. Free
node sales-report.ts [--json]          # settled sales: amounts, timestamps, refund pointers.
                                       # Reads .dev-key. The browser CANNOT do this — findings §13.25

# slice 4: authoring, against the running node
node authorize-manage.ts               # ONCE, at the desk. Grants Manage, writes .nmanage
node authorize-manage.ts --revoke      # takes the grant back
node check-manage.ts                   # mints a real offer over kind 21003. Exit 0 = it works
node check-manage.ts --clean           # deletes the offers those runs leave behind
node export-key-qr.ts --yes            # ONE-TIME: .dev-key -> nsec + QR, for the bunker import

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
2026-08-21 — it had never accepted a single blob and cost 21 x 20s of timeout per run.

**Blobs now live on four servers, and that was the highest-value infrastructure find.** It was
not a server hunt: BUD-11 11.md:50 requires the auth token be base64url, and three of the four
servers that will store an nsite's HTML reject base64url and accept standard base64
(findings §9, §13.23). `builder/src/blossom.ts` sends standard base64 and both deployed sites
report four complete mirrors.

`seed-listings.ts` carries the same two-line change but **has not been re-run**, so the fixture's
21 photos are still on `blossom.band` alone. Re-seeding mirrors them to four servers — and it
re-cuts `.ladder.json` and republishes all nine listings, so it needs `watch-sales.ts` restarted
after it, and it must not happen on demo day.

**And there is a second one, found on 2026-08-21 during slice 6 and not previously written down.**
`node spike/check-deploy.ts npub1lvvw…q0lalws --skip-gateway` passes every check and reports
**"1 complete mirror(s). ONE copy — a single garbage collection breaks this site."** The live
storefront was deployed *before* slice 5 found the base64 encoding bug, so its kind 10063 names
only `cdn.hzrd149.com` and its five site blobs live there alone. The two sites deployed after the
fix report four mirrors; the live one is not one of them.

So the demo has **two** single points of failure, both on Blossom, and they are different fixes:

| what | where | fix | safe to do on demo day? |
|---|---|---|---|
| the fixture's 21 item photos | `blossom.band` only | re-run `seed-listings.ts` | **no** — re-cuts the ladder, needs the watcher restarted |
| the live storefront's 5 site blobs | `cdn.hzrd149.com` only | re-run `deploy-nsite.ts` | **no** — the gateway caches the old build for an hour |

Neither is urgent and both are cheap on a quiet day. Doing them in the same sitting is the right
move, in this order: `mint-offers.ts` → `seed-listings.ts` → `deploy-nsite.ts` → restart
`watch-sales.ts` → `check-admin.ts` and `check-deploy.ts` to confirm.

`spike/.dev-key` and `spike/.offers.json` are gitignored and **not reproducible from the repo**.
Losing `.dev-key` loses the seller identity, the storefront's npub, and access to the 6,000 sats
sitting in that node account. Back it up before anyone acts on `seed-listings.ts`'s instruction
to delete it at slice 4.

---

## What is genuinely blocked, and on what

One spike question remains, and it **needs a phone.** Nothing blocks a slice. Full `NEEDS HUMAN`
blocks with exact commands live in `/docs/spike-findings.md`.

### The bunker import — key backed up 2026-08-21, import NOT yet done

`spike/.dev-key` is backed up to `~/.lamppost-key-backup/dev-key-2026-08-21.hex` (chmod 600,
verified to derive the same seller pubkey). **That backup is on this machine only — get a copy
off it.**

**`spike/.dev-key.nsec` and `spike/.dev-key.qr.svg` are still in the working tree** — the seller's
private key in two more formats, chmod 600 and gitignored. Asked again in slice 7 and the answer
was to leave them because the import is imminent. **Delete both the moment the scan is done**;
`node spike/export-key-qr.ts --yes` regenerates them in seconds if it is not. Losing this key loses the seller identity, the storefront's npub and nsite URL, and
access to the sats in the node account.

The import itself is unrun and needs a phone. `node spike/export-key-qr.ts --yes` writes the nsec
and a scannable QR, both gitignored and chmod 600; delete them straight after. Amber is the right
target rather than nsec.app — nsec.app stores the key on somebody else's server, which is the
custody claim this project spends §3.1 arguing it does not make, and q8's residual risk is
specifically about Amber's sign policy.

### The second Blossom server — **CLOSED 2026-08-21, and it was not a server hunt**

BUD-11 11.md:50 requires the auth token be base64url. Three of the four servers that will store
an nsite's HTML reject base64url and accept standard base64, so we had been locked to one server
by our own header since slice 1. Blobs now live on four, verified. Findings §9 and §13.23.

The residue: the fixture's 21 photos are still on `blossom.band` alone until `seed-listings.ts`
is re-run, which also re-cuts `.ladder.json` and needs the watcher restarted. Not demo-day work.

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

**Slice 4 turned this into a task with a button on it, and slice 5 added a second button.** The
builder sends the string below at connect; `bunker-scan` in `/builder` generates the
`nostrconnect://` URI carrying it. So the confirmation run is now: import `spike/.dev-key` into
your bunker, open the builder, click "Connect a bunker", scan, publish one item, **then press
Deploy**. That covers every unrun browser path in the project in one sitting.

Note `15128`, `10063` and `24242` in the string: slice 5 signs all three, and they have been in
`PERMS` since slice 4 precisely so this run would not need a second scan.

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

- **The bunker path needs a QR, and the first cut shipped the URI as text.** Amber connects by
  scanning (`nostr_connect_qr_description` in its own strings), and the builder runs on a laptop
  while the signer is a phone. Fixed by adding `uqr@0.1.3` — already pinned and justified for the
  storefront — dynamically imported so the NIP-07 path never fetches it.
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
cd builder   && npm run build     # tsc --noEmit clean; 142.8 KB raw / 50.8 KB gzip
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

## Slice 5 — what shipped, and the three things that were not in the description

Two new modules in `/builder`, one new spike script, one script turned inside out, and the
storefront's build-time constants deleted.

| file | what |
|---|---|
| `builder/src/deploy.ts` | hashing, the 5A aggregate, the QR injection, kind 15128 + 10063, the deploy |
| `builder/src/blossom.ts` | the BUD-11 auth and the mirror, lifted out of `photos.ts`. **The find** |
| `builder/bundle-storefront.mjs` | `prebuild`: builds /storefront into `builder/public/site` + a file list |
| `builder/public/404.html` | the builder is an nsite too, and 5A.md:196 requires one |
| `builder/src/deploy.test.ts` | 10 tests, `node --test`, same style as the other three suites |
| `spike/check-deploy.ts` | relays → Blossom → what the page would show → the gateway, last |
| `spike/deploy-nsite.ts` | now ~90 lines: a filesystem walk and a Signer over `.dev-key` |

### 1. The storefront was compiled per seller, and it is not any more

`main.ts` hardcoded `SELLER_PUBKEY`; `vite.config.ts` `define`d `__SELLER_NPUB__` and
`__SITE_URL__` and encoded the flyer QR from that URL. A generic builder cannot ship a bundle
with one seller's key in it, so **the whole `define` block is gone**.

An nsite's canonical URL *is* `<npub>.<gateway>` (`5A.md:136`) and a host server "MUST parse the
left-most DNS label… If the label is a valid `npub`, decode it and resolve the root site
manifest" (`5A.md:156-158`). The gateway already had to decode our npub to serve us the bytes;
the page reads the same label back out of `location.hostname`. `?seller=npub1…` is the fallback
for `npm run dev`, and it also covers Titan's `nsite://`, which is **not in NIP-5A at all** and
stays `UNVERIFIED`.

It lives in `storefront/src/listing.ts` — the trust boundary file — because it is one: whoever
controls the hostname controls whose signatures the page accepts. The bech32 checksum is
honoured rather than the string pattern-matched, so a flipped character resolves to *nobody*
rather than to a plausible wrong pubkey. 8 new assertions.

**The QR moved with it, from build time to deploy time.** The deployer knows the npub and the
gateway, so it substitutes the `<!--QR-->` marker in `index.html` on the way to Blossom, using
the `uqr` both apps already ship. The page still carries no encoder; the cold HTML went
**0.4 KB → 2.4 KB gzip**. That is the price of one generic build.

### 2. The second Blossom server was our own header, not a missing server

Findings §9 has asked a human for a second server since slice 1. It did not need one. BUD-11
11.md:50 says the auth token MUST be base64url; we complied, and three of the four servers that
will store an nsite's HTML answer `400` to base64url and `200` to standard base64:

| server | base64url | standard base64 |
|---|---|---|
| `cdn.hzrd149.com` | 201 | 201 |
| `blossom.primal.net` | 400 | **200** |
| `files.sovbit.host` | 400 | **200** |
| `nostr.download` | 400 | **201** |
| `blossom.band` | jpeg only | jpeg only |

Both sites deployed in slice 5 report **4 complete mirrors**, each blob verified to hash to its
own `path` tag. Mirroring costs no extra signatures either: 11.md:25 makes a token with no
`server` tag valid everywhere, so N blobs across M servers is N signatures — slice 4's
`photos.ts` signed per (blob, server) and now does not.

### 3. Rule 5's "bootstrap problem" is not one

Rule 5 says the builder deploys as an nsite. That reads like the builder must deploy itself; it
does not. Rule 5 is about the builder being *hosted* with no server of ours, and putting it on a
gateway is a **developer** action, not a seller action. So `node spike/deploy-nsite.ts
../builder/dist --key .builder-key` publishes it, using the same module the in-app deploy uses
for the seller's sale. One tool, two directories, no cycle.

What it did need was **its own identity**: a kind 15128 root site is one per pubkey
(`5A.md:16`), so a second site under the seller's key would silently replace their storefront.
Findings §13.22.

### Where the storefront's bytes come from

`builder/public/site/` — a built copy put there by a `prebuild` step, plus `public/site.json`
listing the paths. Vite copies `public/` verbatim, so the files stay files: the builder fetches
them from its own origin when somebody presses Deploy, and when the builder is an nsite they are
blobs in its own manifest (`/site/index.html`, `/site.json` — all verified serving from the
gateway). Inlining them as raw assets would have doubled the JS of an app that is itself fetched
blob by blob. The bundle grew **50.8 → 52.9 KB gzip**, all of it the deploy module.

### What slice 5 deliberately did not build

- **No preview, no redeploy diffing, no deploy history.** A kind `5128` manifest snapshot
  (`5A.md:60-65`) is what "show me the sale as it was" would use. Spec §6.4 rules it out for v1.
- **No named sites (kind 35128).** Two sites under one pubkey is the only thing they buy and the
  builder has its own key.
- **No gateway picker beyond a text field**, and no check that the gateway resolves. It is the
  one part of the URL we do not control, and a dropdown of gateways is a list that goes stale.
- **`seed-listings.ts` was not re-run.** It has the two-line encoding fix, but the fixture's 21
  photos are still on one server until somebody re-seeds. See above.

### Verified how

```
cd builder    && npm test                     # 20/20 (10 new)
cd storefront && npm test                     # 30/30 (8 new)
cd spike      && npm test                     # 8/8, unchanged
cd builder    && npm run build                # tsc clean; 148.3 KB raw / 52.9 KB gzip
cd spike      && node deploy-nsite.ts --dry   # hashes and signs, publishes nothing
cd spike      && node deploy-nsite.ts --key .deploy-test-key
cd spike      && node deploy-nsite.ts ../builder/dist --key .builder-key
cd spike      && node check-deploy.ts <npub>  # both sites
cd spike      && node check-manage.ts         # 13/13 after the blossom.ts lift
cd spike      && node check-buy.ts            # the money path, unchanged
```

`check-deploy.ts` is the one that matters. On both deployed sites it confirmed a signed kind
15128 with no `d` tag, an aggregate `x` tag that still matches its own `path` tags, a kind 10063
naming four servers, and **every blob served by every one of them, hashing to its own path tag**.
It also drove `sellerFromLocation` with the real hostname through the storefront's own parser
against the live relays: `npub1lvvw…q0lalws.nsite.lol` resolves and reads back the real sale —
masthead, 9 items, 4 with a Buy button, 3 sold. That is the hostname change proven end to end.

**What is NOT proven: the browser, again.** No Chrome extension was connected in this session, so
nothing has driven the builder's Deploy button or watched the deployed page paint. Every module
is exercised headlessly and every byte on the gateway is verified byte-identical, but the DOM
half of slices 4 and 5 is still unrun. It is the same run that answers spike q8 on hardware.

**And the gateway cache bit, exactly as documented.** A second deploy 10 minutes after the first
left `check-deploy.ts` reporting `/index.html` STALE while sections 1–3 passed — the tool named
the cache instead of a person finding it on demo day.

---

## Slice 6 — what shipped, and the bullet that was deleted rather than deferred

Two new modules in `/builder`, two new scripts in `/spike`, one function lifted into the tested
module, and **zero new dependencies in either package**.

| file | what |
|---|---|
| `builder/src/admin.ts` | read the sale back off the relays; listing → draft; offer reuse; units sold |
| `builder/src/notes.ts` | NIP-78 kind 30078, NIP-44 encrypted to self. One event for the whole shop |
| `builder/src/admin.test.ts` | 12 tests / 52 assertions, `node --test`, same style as the other four suites |
| `spike/sales-report.ts` | settled sales, run where the key already is. The deleted bullet's answer |
| `spike/check-admin.ts` | drives the shipped admin module against the LIVE sale. No key, no node |
| `spike/ladder.ts` | `isStale` and `nofferOf` — two pure functions, in the file that already has a test |

### 1. "View settled sales" has no CLINK path, so the bullet is gone

Three facts, each citable, and together they close it:

- **CLINK Manage's only resource is `"offer"`** (`clink-manage.md:29`), actions create/update/
  get/list/delete. The running node agrees exactly — `managementManager.ts:115-134` switches on
  those five and answers GFY 1 to anything else. There is no invoice or settlement resource
  anywhere in CLINK.
- **Settled sales live behind `GetUserOfferInvoices`** — `OfferInvoice { invoice, offer_id,
  paid_at_unix, amount, data }`, `structs.proto:902-908`, where `data` is the stored `payer_data`.
- **That call is reachable only over kind 21000.** `nostrMiddleware.ts:52-80` dispatches 21001,
  21002 and 21003 to their own managers with an early `return`; only what falls through reaches
  the RPC dispatcher. Kind 21000 is `decryptV1` on the raw ECDH x-coordinate, which NIP-46 does
  not expose (findings §13.18).

⇒ **The seller's own browser cannot read the seller's sales.** The workaround is disqualified
before it is written: a raw node key in the page breaks rules 2 and 3 at once and is not even
read-only — the same credential can call `PayInvoice` (findings §10).

Two answers shipped instead of one workaround:

- The panel shows **units sold, derived from the relays**, with no credential at all. The watcher
  already republishes stock as money arrives, so `units − stock` is how many have gone. Unknown
  for an item this browser never published, because nothing on a relay records what the stock
  started at — and saying nothing is the honest answer there.
- **`node spike/sales-report.ts`** gives the money, on the machine where the key is:

```
item                            price   sold   sats in   refundable   last settled
yardsale-2026-08-plants          6000    1/1      6000          1/1   2026-08-21T01:45:50.000Z
yardsale-2026-08-mugs            1000    2/3      2000          2/2   2026-08-21T02:35:45.000Z
...
# 3 settled invoice(s), 8000 sats received
```

It prints refund-pointer **presence** and never the pointer. A `refund_pointer` is an ndebit
addressed to the buyer's wallet, and `/CLAUDE.md` says not to log payloads carrying one.

This also constrains slice 7: an automatic refund cannot be reviewed in a browser before it is
sent, because the browser cannot see the invoice it would be refunding. Slice 7 is a process next
to the node or it is nothing. Findings §13.25.

### 2. The dangerous edit failure is the opposite of the one that was predicted

The slice brief expected a stale ladder rung to republish old text over new. That needs the edit
to land within `units` seconds of the original publish — a 1–3 second window for a yard-sale item
— so it is nearly unreachable.

What is reachable: **a relay answers `OK` to a replaceable event it does not store.** After an
edit the new listing is newer than every rung of the old ladder, so the watcher publishes a rung,
the relay accepts it and drops it, and `publish()` counts a success. The log says `3/4 relays`
and the item stays advertised as available for the rest of the sale. An oversell with a clean log
next to it, lasting until somebody notices.

`spike/ladder.ts` `isStale` now decides it, checked once at watcher startup against the live
listings; a stale item is refused loudly and by name rather than watched uselessly. Equal
timestamps are not stale (a sold-out item's live listing *is* its own last rung) and an item with
no live listing is not judged at all — "the relay is down" and "your ladder is stale" have
opposite remedies. Findings §13.26.

### 3. An edit is a re-publish, so the whole job is not losing anything

There is no edit event in nostr. The panel therefore reuses the **item form** as its edit form,
which is why slice 6 needed no second form and no framework (see the React answer below).

- **`1 + units` signatures**, not one. Restock *is* an edit: changing the quantity changes how
  many rungs there are. The cost line already showed this and now stops over-counting — an edit
  that keeps its photos uploads nothing, and one that keeps its price mints nothing.
- **The photos survive without re-uploading a byte.** Blossom is content-addressed, so the sha256
  comes back out of the URL (BUD-01). `imeta` finally has a reader too: `fallback` is read back so
  a save does not quietly take a four-server mirror down to one.
- **The offer is reused**, with the price re-derived from the pointer's own TLV 4 rather than
  trusted from the listing. Manage `create` is not idempotent, so re-minting on every save would
  leave a trail of payable offers; and the fixture's five are invisible to Manage anyway
  (findings §13.20), so reuse is the *only* edit path that works on the live demo.
- **The slug goes read-only during an edit.** Changing it would publish a second item and orphan
  the first.
- **Two kinds of item refuse to load into the form**, and both refusals protect data rather than
  restrict it: anything priced in fiat (`records` at 80 MXN would republish as 80 sats — there is
  no conversion in this project and no oracle to do one with) and anything addressed outside this
  sale's `d` prefix.

`spike/check-admin.ts` drives all nine live items through the round trip and **fails on anything
lost, reports anything gained**. That asymmetry is the point: NIP-01 replaces rather than
versions, so a dropped tag is unrecoverable, while a gained one is usually a pre-slice-4 listing
being brought up to date. All nine pass; the fixture's items gain an `imeta` tag they never had,
and the two seeded sold-with-`status`-only items gain `stock 0`.

### 4. "Mark sold" does not delete the offer, and that decision was owed before slice 7

Spec §7.4(a) said delete it; findings §13.17 disqualified that (it destroys the buyer's stored
refund pointer, and `GetUserOfferInvoices` is its only reader). The two untested candidates were
`UpdateUserOffer` to an unpayable price, or a loopback `callback_url` at mint time.

**Neither. Nothing is done to the offer at all.** Mark sold publishes the item at stock 0, and
`ladder.ts` `atStock` already strips the `clink_offer` tag there — so the listing stops
advertising a payable pointer and every storefront stops drawing a Buy button, while the offer row
sits untouched on the node with its invoice history intact. It costs no node call, adds no failure
mode to a path used at a table with a phone, and works on the fixture's items, which Manage cannot
touch. `builder/src/publish.ts` enforces it at one choke point: at stock 0 the offer is dropped
whatever the caller passed.

The window is unchanged and stays honest: a buyer on a cached page can still pay. Closing that
properly needs spec §7.4(b) — holding the CLINK service key ourselves — not a cleverer use of the
offer row.

### 5. The React question is closed, not deferred again

Spec §9 said to revisit here because "the admin panel actually wants tables, dialogs and toasts."
It wanted one list, two buttons per row and a textarea, and it reuses the item form for editing.

Measured: **the whole panel cost +4.3 KB gzip** (53.0 → 57.3). React plus ReactDOM is ~45 KB gzip
before a single component — ten times the feature it was supposed to help build, in an app that is
itself fetched blob by blob from a cold gateway (rule 5). The line is deleted from spec §9 and
`design.md` §5 rather than pushed to slice 9.

### 6. Private notes

Kind 30078, NIP-44 encrypted to the seller's own key, `d = "lamppost-shop"` — **not** `clink-*`,
which CLINK Beacon reserves on this kind (`clink-beacon.md:195`), and not `Lightning.Pub`, which
the running node still uses for its own beacon. No new machinery: the Signer already exposed
`nip44Encrypt`/`nip44Decrypt` and `sign_event:30078` has been in `PERMS` since slice 4, so this
costs no second bunker approval.

One event for the whole shop rather than one per item: one signature saves whichever note changed,
one query loads them all. Two tabs editing at once would last-write-win, which is a yard sale with
one seller and one laptop.

### Verified how

```
cd builder    && npm test                     # 32/32 (12 new)
cd builder    && npm run build                # tsc clean; 156.8 KB raw / 57.3 KB gzip
cd storefront && npm test                     # 30/30, unchanged
cd spike      && npm test                     # 10/10, 35 assertions (2 new tests, 15 new assertions)
cd spike      && node check-admin.ts          # ALL CHECKS PASSED against the 9 live items
cd spike      && node sales-report.ts         # 3 settled invoices, 8,000 sats, 3/3 refundable
cd spike      && node check-manage.ts         # 13/13, then --clean
cd spike      && node check-buy.ts            # the money path, unchanged
cd spike      && node watch-sales.ts --once   # the stale-ladder check passes on all 5
cd spike      && node deploy-nsite.ts --dry   # unchanged
```

`check-admin.ts` is the one that matters, and it is the `check-buy.ts` pattern again: it imports
`/builder/src/admin.ts` and `/builder/src/listing.ts` unmodified and drives them against the real
published sale. If it and the builder ever disagree, it is wrong.

**Still NOT proven: the browser half.** No NIP-07 extension and no bunker has driven any of this,
same as slices 4 and 5. Every module typechecks, builds and is exercised headlessly, and all 44
DOM selectors in `main.ts` resolve against `index.html` — but nobody has clicked Edit.
`/docs/prompts/browser-verify-and-deploy.md` is still the brief for that, and it now covers one
more surface than when it was written.

---

## Slice 7 — what shipped, and the two things the brief had wrong

Two new modules and three new scripts in `/spike`, one regex and one TLV parser lifted into
`/storefront` so three callers share them. **Zero new dependencies in any package.**

| file | what |
|---|---|
| `spike/ndebit.ts` | CLINK Debits kind 21002. `decodeNdebit`, `payDebit`, `payDebitBudget`, `k1For` |
| `spike/refund.ts` | `oversold`, `resolvePointer` (noffer *and* LNURL), the journal. **The tested one** |
| `spike/refund.test.ts` | 12 tests, `node --test`, same style as the other five suites |
| `spike/authorize-refunds.ts` | the one-time grant, with the raw key, at the desk |
| `spike/check-refund.ts` | proves the cap and `BanDebit` against the live node. Costs nothing |
| `builder/src/manage.test.ts` | Phase 0: the 9 tests `decodeNmanage` shipped without in slice 4 |

### 1. `EditDebit` is not the grant path, and nothing can create a grant on its own

`AuthorizeDebit` is commented out — that half of the brief is right (`methods.proto:690-694`).
But `EditDebit` opens with `if (!access) throw new Error("Debit does not exist")`
(`debitManager.ts:99-105`): it edits rules on a grant that already exists. `AddDebitAccess`, the
only insert, has two callers, and the only one that produces an *authorised* row is
`handleAuthorization` — reached from `RespondToDebit`, which answers a **pending** request.

So granting is a three-step dance and `authorize-refunds.ts` is that dance: the refund key sends a
kind 21002 **budget** request (no `bolt11`, so nothing is paid), the node pushes a
`LiveDebitRequest` to the owner's key on the kind 21000 channel with the fixed requestId
`"GetLiveDebitRequests"`, and the owner answers `RespondToDebit` with `AUTHORIZE` **and its own
rules** — the requestor proposes, the owner disposes. `pub-rpc.ts` gained an `onPush` hook for the
middle step. Findings §13.27.

Two shapes that each cost a round trip: **`DebitRule` nests its oneof under a `rule` key**
(`{rule:{type:'frequency_rule',frequency_rule:{…}}}` — flat returns `invalid request body` with no
field named), and **`authorize_npub` is HEX**, same misnomer as the Manage side, verified rather
than inherited.

### 2. `k1` cannot carry the idempotency, and a refund is the project's first write

The brief's candidate was to derive CLINK's single-use `k1` from the settled invoice so a double
refund is refused by the node. It marked the load-bearing part `UNVERIFIED` and said to read the
source. Read: `K1Debouncer` is an in-memory array with a **5-minute TTL**, swept once a minute,
lost on restart, and the `doNdebit` comment says so outright. Worse, `DedupeK1` runs **before** the
invoice is decoded or any rule is checked, so a request the node then refuses still burns its `k1`
— contradicting `clink-debits.md:167-171`. And a duplicate answers **code `1`**, not the `6` the
spec's example gives. Findings §13.28.

⇒ The derived `k1` stays as a second layer against a crash loop. The durable answer is
`spike/.refunds.json`, keyed on the settled invoice, **written before the payment** — because the
dangerous crash is "while paying", not "after paying". A row left `pending` is never retried
automatically; it is reprinted every five minutes until a human reconciles against the node.

That divergence also set a constant: a `failed` refund waits **6 minutes** before a retry, because
the derived `k1` is identical on a retry and would collide with the debouncer for 5 of them.

### 3. The one third-party server in the project is in the refund path, deliberately

`render.ts` accepts a Lightning address or an noffer, and the placeholder is `you@yourwallet.com`
— so the address is the common case. An noffer resolves over a relay (it is `buy.ts` with the roles
swapped, the watcher paying and the *buyer's* node serving). A Lightning address resolves over
**LNURL-pay, which is HTTPS to a host we do not control**.

Resolved, with a **seller-visible queue** when it fails: a `queued` row in the journal, reprinted
every five minutes, so a dead LNURL host is money the seller can hand over at the table rather than
money that quietly stayed put. The buy form's hint text now says which of the two has a server in
it. The stage line: *a Lightning address is a hostname, and a hostname is a server.*

### 4. The cap and the kill switch, watched firing

```
# 3. the cap — dropping it to 1 sat and sending a 10-sat debit
   node said: {"ok":false,"code":5,"error":"Invalid Amount","range":{"min":1,"max":1}}
# 4. the kill switch — restoring the cap to 8000, then BanDebit
   node said: {"ok":false,"code":1,"error":"Request Denied Warning"}
# 5. k1 replay
   second: {"ok":false,"code":1,"error":"K1 already processed"}
```

`check-refund.ts`, 21/21, and **it costs nothing**: every debit above is one the node refuses, and
a refusal is a rollback rather than a payment talked out of happening. Both checks run inside the
payment transaction (`assertDebitFrequency`), so they hold under concurrency and `BanDebit` stops a
payment already in flight.

**The live grant is 8,000 sats/day with a 30-day expiry**, on `spike/.refund-key`. Two honest
caveats, both in spec §12: 8,000 equals the node's whole outbound balance, so in normal operation
the balance binds before the rule does — which is why the proof moves the cap rather than spending
it; and an expiry rule **deletes** the grant on first use after it lapses (GFY 3), so re-arming is
the whole dance again. Do not let it lapse mid-demo.

### Verified how

```
cd storefront && npm test          # 31/31 (+1)
cd builder    && npm test          # 41/41 (+9), build clean, 57.37 KB gzip (+0.05)
cd spike      && npm test          # 22/22 (+12)
cd spike      && node check-manage.ts     # 20/20 — the mint dedupe, against the node. Then --clean
cd spike      && node check-refund.ts     # 21/21 — the cap and the kill switch. Costs nothing
cd spike      && node authorize-refunds.ts   # debit_id 2 AUTHORIZED, 8000/day
cd spike      && node watch-sales.ts --once  # unarmed, unchanged from slice 3
cd spike      && node check-buy.ts && node check-admin.ts && node sales-report.ts
```

### What is NOT proven, and it is the demo beat

**No refund has actually been paid.** Every debit driven so far is one the node refused, which is
what proves the cap and proves nothing about the happy path. Two links are untested on the wire:
`payDebit`'s `{"res":"ok"}` branch, and `resolvePointer`'s LNURL branch.

And there is a reason it could not be done incidentally: **all three settled invoices on the node
carry `@example.com` refund pointers**, left by `check-buy.ts`. A real oversell today would
correctly `queue` rather than pay. Proving the beat needs a fresh sale carrying a real pointer:

1. `node check-buy.ts yardsale-2026-08-mugs --pay` and pay it from a real wallet, supplying **that
   wallet's own Lightning address or noffer** as the refund pointer. 1,000 sats.
2. Engineer the oversell — `mugs` has one unit left, so a second payment does it, or re-cut the
   ladder with a lower `units`.
3. `node watch-sales.ts --refunds`. The money comes back.

Net cost is routing fees. It needs a wallet and a person, which is why slice 7 stopped here.

**Still NOT proven: the browser half**, unchanged across slices 4, 5, 6 and now 7 —
`/docs/prompts/browser-verify-and-deploy.md`.

---

## Traps that will cost an hour each

- **`AuthorizeDebit` is commented out, and `EditDebit` cannot create a grant either.** It throws
  `Debit does not exist`. The only way to create one is to answer a pending `LiveDebitRequest` with
  `RespondToDebit` — the three-step dance in `spike/authorize-refunds.ts`. Findings §13.27.
- **`DebitRule` nests its oneof under a `rule` key.** `{rule:{type:'frequency_rule',frequency_rule:
  {…}}}`. Sending it flat returns `invalid request body` naming no field.
- **`authorize_npub` wants HEX on the Debits side too**, not just Manage. Same misnomer.
- **CLINK's `k1` is in-memory on this node with a 5-MINUTE TTL** (not the 20 of the event-id
  deduper — they are different sets), lost on restart, and **consumed before validation**, so a
  refused request burns it. A duplicate answers code `1`, not `6`. Never build durable idempotency
  on it. Findings §13.28.
- **A debit frequency cap set to the node's balance can never fire**, because the balance binds
  first. Prove a cap by moving it down and crossing it, not by spending.
- **A debit expiry rule DELETES the grant** on first use after it lapses, rather than suspending
  it (GFY 3). Re-arming is the whole authorisation dance again.
- **`watch-sales.ts` spends only with `--refunds`.** Every other invocation is slice 3's watcher
  exactly as it was. Do not add refunds to a default path.
- **Losing `spike/.refunds.json` can double-pay a refund.** It is the only record that a refund
  happened; the node has no such field. Back it up, do not commit it.
- **Never log a refund pointer or a preimage.** The journal stores the *kind* of pointer
  ('noffer'/'address'/'none') and whether a preimage existed, never either value.
- **A NIP-46 bunker cannot speak kind 21000.** Every native Lightning.Pub RPC — `AddUserOffer`,
  `GetUserOffers`, `GetUserOfferInvoices`, `AuthorizeManage` — needs a raw ECDH secret NIP-46 does
  not expose (findings §13.18). In the browser it is CLINK or nothing. If you find yourself
  wanting `pub-rpc.ts` in the builder, stop: that is the wrong shape.
- **Manage `list` does not show natively-minted offers.** `management_pubkey` partitions them,
  asymmetrically — native sees everything, Manage sees only its own (findings §13.20). An empty
  Manage `list` on an account with five offers is not a bug.
- **`authorize_npub` wants a HEX pubkey despite the name.** It is stored as `app_pubkey` and
  matched against `event.pub`. An `npub1…` creates a grant that silently never matches.
- **`check-manage.ts` mints a real offer every run** and CLINK Manage's `create` is explicitly
  not idempotent (clink-manage.md:226). They are inert, but run `--clean` after. That mode
  refuses to delete any offer with a settled invoice, because deletion destroys the stored
  refund pointer (findings §13.17) — verified against `plants` (1 settled) and `mugs` (2).
- **`spike/.nmanage` carries the account pointer.** Same handling as the pairing string: seller's
  browser only, never a relay, never a log, never this repo. It is gitignored.
- **An item is `1 + units` signatures, not one.** Any UI that implies otherwise gets a seller
  abandoning a publish halfway, leaving a listing on the relays with no ladder behind it.
- **The ladder is cut from one version of the listings.** Edit a price, a title or a photo and
  you must re-seed before running the watcher, or it republishes the old text over the new with
  a newer `created_at`. `mint-offers.ts` → `seed-listings.ts` → `watch-sales.ts`, in that order.
- **A relay answers `OK` to a replaceable event it does not store.** This is how a stale ladder
  fails: silently, successfully, and forever. Edit an item without giving the watcher the new
  `.ladder.json` and it publishes rungs that are now older than the live listing, counts them as
  published, and the item stays on sale after it sells. `ladder.ts` `isStale` catches it at
  watcher startup; `check-admin.ts` section 4 reports it. Findings §13.26.
- **An edit is `1 + units` signatures and a new ladder file, not one signature.** Restock is an
  edit. Spec §7.5 said "one signature" until slice 6 and it was wrong by the width of the ladder.
- **A browser behind a Signer cannot read settled sales, and never will.** CLINK has no
  settlement resource and `GetUserOfferInvoices` rides kind 21000. If you find yourself designing
  a sales screen in `/builder`, stop — that is `spike/sales-report.ts`. Findings §13.25.
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
- **A kind 15128 root site is ONE PER PUBKEY** (`5A.md:16`). Deploying a second site under the
  same key silently replaces the first — no error, and the old blobs are still on Blossom but
  unreachable. The builder has its own key for exactly this reason (findings §13.22).
- **The BUD-11 auth header is standard base64 here, not the base64url the spec requires.**
  Three of the four servers that store an nsite's HTML reject base64url (findings §9). If a
  Blossom upload starts 400ing on a new server, check the encoding before anything else.
- **`/404.html` is served WITH a 404 status.** A verification script that checks `res.ok` will
  report NIP-5A's mandatory fallback as a failure (findings §13.24).
- **`spike/.deploy-test-key` and `spike/.builder-key` are gitignored and not reproducible.**
  Losing `.builder-key` loses the builder's nsite URL. Neither holds funds.
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
| `/docs/known-defects.md` | verified defects deferred out of the slice 0–5 review, plus the doc drift | |
| `/docs/spec.md` | architecture and the slice plan (§10) | |
| `/docs/design.md` | the two design surfaces | |
| `/builder` | the authoring app. Signer, CLINK Manage, photos, the ladder cut, the deploy | |
| `/docs/runbook.md` | the node: install, funding, demo-day checklist | |
| `/docs/prompts/` | session briefs for the work that comes next | |
| this file | where we are today | goes stale fastest |
