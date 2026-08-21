# Status — where the project is, and what to do next

**Read this first in a new session, then `/CLAUDE.md`.** It is the handoff note: current state,
the commands that reproduce it, and what is actually blocked. It is deliberately short and it
goes stale — where it disagrees with `/docs/spike-findings.md`, the findings win.

Last updated: **2026-08-21**, end of slice 3.

---

## One-paragraph summary

Slices 0, 1, 2 and 3 are done. A static page hosted on Nostr reads listings off public relays and
takes Lightning payments by sending CLINK invoice requests to the seller's own node over relays.
**This is proven with real money** — 6,000 sats settled on 2026-08-21 and the page read the
settlement receipt that nobody else can decrypt. A watcher on the seller's machine now closes
the loop: it observes settlement on the node and republishes the listing, **holding no signing
key**, so `plants` reads as sold on the relays today. There is no server of ours anywhere in it.
Next up is slice 4: the Signer abstraction and real authoring — which is where spike question 8
finally has to be answered.

---

## What is live right now

| | |
|---|---|
| Storefront | `https://npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws.nsite.lol/` |
| Seller pubkey (throwaway) | `fb18e881362a772e1bff2fc260a5ff47cb01d3fa7a254349948603774cdb47a0` |
| Sale | kind 30405 `yardsale-2026-08`, 8 items on 4 public relays |
| Node | local Lightning.Pub 0.0.37 + LND, 1 private channel |
| Node liquidity | **92,160 inbound / 6,000 outbound** — drifts with every sale |
| Node account | app user `0db5acc4…`, owned by `spike/.dev-key`, holding **6,000 sats** |
| Bundle | 30.9 KB gzip cold + 3.9 KB QR chunk on demand. Budget is **gzip** |

Three items are buyable; the rest deliberately are not:

| item | price | state |
|---|---|---|
| `plants` | 6,000 sat | paid 2026-08-21, and **the watcher has now marked it sold on the relays** |
| `lamp` | 30,000 sat | buyable, `stock 3` — the multi-unit demo item |
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

# node health
export PATH="$HOME/lnd:$PATH"
lncli state && lncli listchannels | grep -E 'active|local_balance|remote_balance'
curl -s http://127.0.0.1:1776/api/health
```

**Ordering matters.** `mint-offers.ts` → `seed-listings.ts` → `watch-sales.ts`. The seeder cuts
the pre-signed ladder from the listings it publishes, so any edit to a price, a title or a photo
means re-seeding before the watcher runs, or the watcher would republish the old text over the
new. `seed-listings.ts` takes ~7 minutes, almost all of it `cdn.satellite.earth` timing out on
21 blobs; blossom.band takes them all.

`spike/.dev-key` and `spike/.offers.json` are gitignored and **not reproducible from the repo**.
Losing `.dev-key` loses the seller identity, the storefront's npub, and access to the 6,000 sats
sitting in that node account. Back it up before anyone acts on `seed-listings.ts`'s instruction
to delete it at slice 4.

---

## What is genuinely blocked, and on what

Two spike questions remain, **both need a phone.** Neither blocked slice 3; question 8 blocks
slice 4. Full `NEEDS HUMAN` blocks with exact commands live in `/docs/spike-findings.md`.

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

### Question 8, bunker prompt count — the highest-value unknown left, and now slice 4's

Pair a NIP-46 bunker (Amber, nsec.app) using a `nostrconnect://` URI carrying
`perms=sign_event:30402,sign_event:15128,sign_event:10063,sign_event:24242`, publish 10 listings
with 2 photos each, and report the **prompt count** plus the signer's name and version.

**If it exceeds ~15, the publish flow needs redesigning before slice 4 builds a UI on top of
it.** It briefly looked like it gated slice 3 as well — a watcher signing each stock update
through a bunker would prompt the seller's phone during their own yard sale. Slice 3's watcher
signs nothing, so this is a slice-4 question again. Blossom auth batching is dead (findings §9), so NIP-46 `perms` is the only remaining lever
and nobody has verified any signer honours it for arbitrary kinds. There is no probe script for
this yet; writing one is ~40 lines against `nostr-tools/nip46` and does not require the real
Signer abstraction.

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
- **Spike question 8 no longer gates slice 3, only slice 4.** A bunker-signing watcher would
  have prompted the seller's phone once per sale, mid-yard-sale. This one signs nothing.
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
cd spike && node seed-listings.ts        # 6 ladder steps for 4 items
cd spike && node watch-sales.ts --once   # -> plants: 1 sold -> stock 0 (SOLD), 2/4 relays
```

Then read back off the public relays through the storefront's own parser: `plants` is
`sold=true`, `buyable=no`, `created_at` exactly one second after the base listing. **The gap
this slice was pointed at is closed** — the 6,000-sat payment from 2026-08-21 now shows on the
page.

**Not yet proven with money: the multi-unit decrement.** `lamp` (30,000 sat, `stock 3`) is
inside inbound and is the demo item, but nobody has paid it. The arithmetic and the rung
selection are covered by the tests; what is unproven is a second settled invoice on one offer.
`node check-buy.ts yardsale-2026-08-lamp --pay` costs 30,000 real sats — ask before running it.

---

## Traps that will cost an hour each

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
| `/docs/runbook.md` | the node: install, funding, demo-day checklist | |
| this file | where we are today | goes stale fastest |
