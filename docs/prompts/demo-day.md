# Session brief: demo day

**This is not a build slice.** Nothing here adds a feature. The job is to get the machine, the
two published sales and the person ready for a four-minute talk that ends in a real Lightning
payment, and to find out — before a room does — which of the things we say on stage are actually
true today.

Read these in full before touching anything:

1. **`/docs/status.md`** — the handoff note. It is current as of 2026-08-21 evening and it lists
   both sellers, both nsites and the node's liquidity.
2. **`/docs/known-defects.md`**, specifically **"Added by the review panel"** — four open rows,
   and **two of them are in the money path you are about to run live**. Do not skip this.
3. `/docs/spec.md` **§13** — the demo run-sheet. Steps 5 and 7 were both corrected on 2026-08-21;
   read what they say now rather than what you remember.
4. `/docs/spec.md` **§3.1** — model 1 vs model 2 custody. There are two sellers on one node now,
   and the sentence you say about custody has to be the narrow one.
5. `/docs/spike-findings.md` **§7** (the gateway is a cache), **§11** (one Pub, many sellers).
6. `/CLAUDE.md` — money-path rules. The refund cap and kill switch are stage props; they are also
   real.

The talk, as scoped: **problem (45s) · the architecture and the CLINK kinds (90s) · a live
payment (75s) · close (30s)**, with a PDF carrying the builder walkthrough and the printed flyer
so no stage time is spent authoring.

---

# Phase 0 — the blockers, in the order they block

## 0.1 The node was not synced, and nothing settles until it is

Last checked 2026-08-21 18:0x: `/api/health` returned `{"status":"ERROR","reason":"not synced"}`
and `lncli getinfo` had `synced_to_chain: false`, `wallet_synced: false`. Invoices still issued
in that state — that was measured, an 800-sat BOLT11 came back fine — but **a settlement was
never tested against an unsynced node** and nobody should find out on stage.

```bash
curl -s http://127.0.0.1:1776/api/health          # must be {"status":"OK"}
export PATH="$HOME/lnd:$PATH"
lncli getinfo | grep -E 'synced_to_chain|wallet_synced|block_height'
lncli listchannels | grep -E 'active|local_balance|remote_balance'
```

Do not proceed to 0.2 until health reads OK. If it will not sync, the talk still works — you
demo the *invoice request* (which provably works unsynced) and say plainly that settlement is
waiting on chain sync. That is a worse demo and an honest one.

## 0.2 Rehearse the exact payment you intend to do on stage

**The Mérida sub-account has never received money.** It has issued invoices — `check-buy.ts`
proved the full CLINK round trip, typed decline on a missing `refund_pointer`, price-mismatch
refusal, real BOLT11 — but no sats have ever landed in it. That is the single largest unproven
thing in the demo.

```bash
cd spike
node check-buy.ts artesanias-jabon --offers .merida-key.offers.json     # free, no --pay
node check-buy.ts artesanias-jabon --offers .merida-key.offers.json \
     --pay --pointer <a real Lightning address or noffer>               # COSTS 800 sats
```

**Pay it from an external wallet, not from this node.** Paying a Mérida invoice from the
`.dev-key` account on the same Pub is `PayInternalInvoice` — a database move, no Lightning
involved (spec §3.1). It would look identical on screen and it would make the sentence you are
saying false.

Then confirm the money arrived and the stock moved:

```bash
node watch-sales.ts --key .merida-key --once     # republishes jabon at stock 11
node check-deploy.ts npub1j7jwqfnwnkp3rk5lv9s7qlnfra609eepy42vmk80z5fq5nncxffq2q900q --skip-gateway
```

## 0.3 Decide the live item, and know why the obvious one is gone

`mugs` was the cheap demo item and it is **sold out — 3/3, the last unit settled
2026-08-21T17:05Z**. The yard sale's cheapest remaining item is `lamp` at 30,000 sats. So the
live sale is the Mérida `jabon` at 800 sats, which is also the better story: a second seller,
their own sub-account, minted over CLINK Manage from a browser holding no key.

---

# Phase 1 — the refund beat, which is unproven and just got cheaper

Two rows in `/docs/known-defects.md` have been open since slice 7 and both are one run from
closed: **`payDebit`'s success path has never returned `ok`** (every debit so far was one the
node refused, which proves a cap and proves nothing about a payment), and **`resolvePointer`'s
LNURL branch has never resolved a real address** (every settled invoice on the node carries an
`@example.com` placeholder).

**`mugs` selling out set this up rather than breaking it.** A depleted item's offer is
deliberately left on the node (spec §7.4, findings §13.17), and `check-buy.ts` reads the noffer
from `.offers.json` rather than from the listing — so the mugs offer is **still payable at stock
0**. Any further payment of it is, by construction, the §7.3 oversell. One 1,000-sat payment now
does what slice 7 needed two for.

```bash
cd spike
node authorize-refunds.ts --show                 # the grant must exist and not be expired
node check-buy.ts yardsale-2026-08-mugs --pay --pointer <a REAL Lightning address>
node watch-sales.ts --refunds --once             # note --once, and read the next paragraph
```

**Use `--once`, not the polling watcher, for this.** Review-panel row 1: `setInterval(tick,
5_000)` has **no in-flight guard**, and a refunding tick routinely outlasts 5s by design because
`resolvePointer` is two sequential network calls. Overlapping ticks can pay the same buyer twice
and corrupt the journal on the way. `--once` runs a single tick and exits before the interval is
ever installed (`watch-sales.ts:512-518`), which sidesteps the race entirely. **Do not leave
`--refunds` polling during the talk.**

The money comes back to the address you supplied, so this rehearsal costs a fee, not 1,000 sats.

**If you demo the kill switch**, review-panel row 4: `authorize-refunds.ts` mints a refund key at
module top level *before* `--revoke` is handled, so running the kill switch on a machine where
`spike/.refund-key` is missing bans a pubkey that was never granted anything and **exits 0 saying
it worked**. On this machine the file exists, so it behaves. Know that the guarantee is "the file
is there", not "the code checks".

---

# Phase 2 — the stage setup

## 2.1 Serve the storefront locally, and say why

spec §13 step 7, corrected 2026-08-21. The gateway is a cache we do not control: measured this
afternoon, all three nsite URLs were serving builds older than the deploy, one of them older than
that morning's. `cache-control: max-age=3600`, a cache-busting query string does not defeat it
(findings §7), and it has stayed stale past 70 minutes.

```bash
cd storefront && npm run preview          # http://localhost:4173
open "http://localhost:4173/?seller=npub1j7jwqfnwnkp3rk5lv9s7qlnfra609eepy42vmk80z5fq5nncxffq2q900q"
```

Beside it, the prop that turns the weakness into the point:

```bash
node spike/check-deploy.ts <npub> --skip-gateway
```

The page renders from local bytes while the command proves those exact hashes are live on four
independent Blossom servers. Say it in one sentence: *the gateway is a cache, and a cache is not
the architecture.*

## 2.2 Kill every stray server first

Stale `vite preview` processes from previous sessions were found serving old builds on 4173,
4174 and 4175. Check before you start:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':41[0-9][0-9]'
```

## 2.3 Warm the gateway anyway, in case you want the real URL on screen

Cold-start is separate from the cache: a freshly deployed site answered 200 once, then timed out
for 25s three times running, then came back. Chromium got `ERR_ABORTED` and a blank page on the
first load. Open all three URLs from the demo laptop well before you go up.

## 2.4 What "no server" survives

spec §13 step 5 was corrected: **`lnd` listens on `*:9735` and Lightning.Pub on `*:1776`.** The
claim is not "no inbound ports open"; it is **no inbound port serves the storefront**. If you
show `lsof -nP -iTCP -sTCP:LISTEN` on stage, the corrected sentence survives it and the old one
does not.

---

# Phase 3 — what to say, and what to say before you are asked

**The four CLINK kinds, one line each.** Kind **21001** Offers — a page with no server asks the
seller's node for an invoice, over public relays. Kind **21003** Manage — how the seller minted
each item's offer from a browser holding no key. Kind **21002** Debit — the refund path, capped
by the node itself, with `BanDebit` as a kill switch. The **`noffer` TLVs** — and there are now
two sellers on one Pub sharing TLV 0 and differing only in TLV 2, which is exactly why a
listing's authority is its **signature** and never its payment pointer.

**Kind 21000 is not CLINK** and it is worth saying so. It is Lightning.Pub's native RPC, keyed on
a raw ECDH secret that NIP-46 does not expose, so a bunker-held key cannot speak it at all
(findings §13.18). That is *why* Manage is in the flow rather than a nicety.

**Say these before a judge does:**

- **No BOLT12, no plain-QR payment path.** The fallback for a neighbour with an ordinary wallet
  is *the page*, not a second payment format (§10, findings §30). One extra tap, in exchange for
  every payment being refundable.
- **Custody.** Both keys on this node are ours, so it is still model 1 — our own sats, our own
  node. The Mérida seller demonstrates that a second seller *can* live there; the moment someone
  else's balance sits in that table it is model 2 and we are their custodian. spec §3.1 has the
  narrow sentence. Do not blur "no custodian exists" into "no custodian by default".
- **The seller cannot see their own sales in the browser.** Manage's only resource is the offer;
  there is no invoice or settlement resource in CLINK, and the node's own
  `GetUserOfferInvoices` rides kind 21000 (findings §13.25). That is what holding no key costs,
  and the honest answer is two answers: the panel derives units-sold from the relays, and
  `node spike/sales-report.ts` gives the money where the key already is.

---

# Do not do these on demo day

- **Do not re-seed.** `seed-listings.ts` re-cuts the ladder and republishes every listing.
- **Do not redeploy**, or budget an hour before the URL reflects it (findings §7).
- **Do not edit an item while a watcher is polling.** The stale-ladder check runs once at
  startup; edit during a session and it keeps publishing superseded rungs.
- **Do not leave `watch-sales.ts --refunds` polling.** Phase 1 explains why.
- **Do not `authorize-refunds.ts --revoke` on a machine without `.refund-key`.**

---

# Still open, and worth a line if asked

- **Mérida has no refund grant.** An oversell there is logged and not paid. `authorize-refunds.ts`
  is per-account; the existing grant is `.dev-key`'s.
- **Mérida's key is not in a bunker**, so the builder cannot sign as that seller. Live authoring
  in the builder has to be the yard-sale identity, or run
  `node export-key-qr.ts --key .merida-key --yes` first and import it.
- **`blossom.band` refuses the site's JS and HTML** on content-type sniffing and drops itself out
  of the kind 10063 list. Four mirrors, not five, and that is the system working.
- **`blossom.primal.net` answers with a 302** to `r2a.primal.net/…/<hash>.txt`. `fetch` follows
  it; a bare `curl` without `-L` returns zero bytes and looks like a dead mirror.
- **Item photos are picsum placeholders.** A pine forest for a hammock. If a slide shows the
  Mérida storefront up close, that is the thing someone will notice.
