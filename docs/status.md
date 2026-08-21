# Status — where the project is, and what to do next

**Read this first in a new session, then `/CLAUDE.md`.** It is the handoff note: current state,
the commands that reproduce it, and what is actually blocked. It is deliberately short and it
goes stale — where it disagrees with `/docs/spike-findings.md`, the findings win.

Last updated: **2026-08-21**, end of slice 2.

---

## One-paragraph summary

Slices 0, 1 and 2 are done. A static page hosted on Nostr reads listings off public relays and
takes Lightning payments by sending CLINK invoice requests to the seller's own node over relays.
**This is proven with real money** — 6,000 sats settled on 2026-08-21 and the page read the
settlement receipt that nobody else can decrypt. There is no server of ours anywhere in it.
Next up is slice 3: the watcher that flips an item to sold.

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

Four items are buyable; the rest deliberately are not:

| item | price | state |
|---|---|---|
| `plants` | 6,000 sat | buyable, **and has actually been paid** |
| `lamp` | 30,000 sat | buyable |
| `bike` | 180,000 sat | has an offer, but priced **above inbound** — invoice issues, payment cannot settle |
| `couch` | 210,000 sat | same |
| `records` | 80 MXN | fiat, cash at the table, no offer by design |
| `boxes` | free | no offer |
| `table`, `mirror` | sold | no offer — a sold item's offer should not exist (spec §7.4a) |

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
node check-buy.ts                      # decline -> invoice -> price-mismatch refusal. Free.
node check-buy.ts <item> --pay         # prints an invoice and waits. COSTS REAL SATS.
node mint-offers.ts [--dry]            # idempotent; reuses offers by label
node seed-listings.ts                  # republishes the 30402s
node deploy-nsite.ts                   # blobs to Blossom, kind 15128 + 10063 to relays

# node health
export PATH="$HOME/lnd:$PATH"
lncli state && lncli listchannels | grep -E 'active|local_balance|remote_balance'
curl -s http://127.0.0.1:1776/api/health
```

`spike/.dev-key` and `spike/.offers.json` are gitignored and **not reproducible from the repo**.
Losing `.dev-key` loses the seller identity, the storefront's npub, and access to the 6,000 sats
sitting in that node account. Back it up before anyone acts on `seed-listings.ts`'s instruction
to delete it at slice 4.

---

## What is genuinely blocked, and on what

Two spike questions remain, **both need a phone, neither blocks slice 3.** Full `NEEDS HUMAN`
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

### Question 8, bunker prompt count — the highest-value unknown left

Pair a NIP-46 bunker (Amber, nsec.app) using a `nostrconnect://` URI carrying
`perms=sign_event:30402,sign_event:15128,sign_event:10063,sign_event:24242`, publish 10 listings
with 2 photos each, and report the **prompt count** plus the signer's name and version.

**If it exceeds ~15, the publish flow needs redesigning before slice 4 builds a UI on top of
it.** Blossom auth batching is dead (findings §9), so NIP-46 `perms` is the only remaining lever
and nobody has verified any signer honours it for arbitrary kinds. There is no probe script for
this yet; writing one is ~40 lines against `nostr-tools/nip46` and does not require the real
Signer abstraction.

---

## Slice 3 — what it is and what is already in place

Per spec §10: the page derives sold/remaining from the listing event alone; a watcher on the
seller's machine observes settlement from the node and republishes the kind 30402 with updated
`stock`/`status`.

Already proven, so slice 3 does not have to discover it:

- **The settlement record exists and is rich.** After a real payment, `user_receiving_invoice`
  carries `paid_at_unix`, `paid_amount`, the **per-item `offer_id`**, the validated
  `payer_data`, and `clink_requester_pub` (findings §6). Per-item attribution needs no
  correlation id we invent.
- **The kind 21000 RPC transport is written**, ~90 lines in `spike/mint-offers.ts` — xchacha20,
  not NIP-04 and not NIP-44 (findings §13.13). `GetLiveUserOperations` and
  `GetUserOfferInvoices` are both `auth_type = "User"` and reachable over it. Lift the code, do
  not re-derive it.
- **No approval is needed** for User-scoped RPCs; `NostrUserAuthGuard` auto-creates the account
  (findings §13.4).

Decide before writing it:

1. **Idempotency key is the settled invoice / payment hash, never the request event id.** Relays
   replay kind 21001 — observed, not theorised (findings §13.1).
2. **Observe via `GetLiveUserOperations` or the loopback `callback_url`?** The callback needs no
   credential at all and is the narrowest possible answer; it is also an HTTP listener on the
   seller's machine. Spec §7.2 ranks them.
3. **Keep the observe key separate from any key that can spend.** "User" scope is not read-only
   — the same credential that reads settlements can call `PayInvoice` (findings §10).
4. `verifyEvent()` caches its verdict on the event under a symbol, and object spread copies it.
   The watcher republishes 30402s by copying events, so it is exposed where the storefront is
   not. `storefront/src/listing.ts` deletes the symbol before every check; do the same
   (findings §13.10).

---

## Traps that will cost an hour each

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
