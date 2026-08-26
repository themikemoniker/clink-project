# Spike Findings

**Status:** desk spike complete 2026-08-20; **updated at the end of slice 2** with what a live
CLINK round trip actually returns. Four items still need a funded node or a human with a phone;
each is marked `NEEDS HUMAN` with the exact command and the exact output to paste back. Slice 2
closed questions 1, 2 and 5 outright and the node-side half of 6, corrected §13.4, and added
§13.13-14. **A real 6,000-sat payment settled on 2026-08-21** and is the evidence behind §1, §5
and §6. **Slice 4 added §13.19-21**, corrected the `perms` string in §8, and turned §13.18 from
a source read into a measured one — offers now mint over CLINK Manage against the live node. Two questions remain, and both need a phone rather than a node: 6's wallet half, and 8.
**Rule:** every answer needs evidence — a spec file path, a source file and line, or
pasted event JSON. `UNVERIFIED` is an acceptable answer. A confident guess is not.

Where this file disagrees with `/docs/spec.md`, this file wins. Corrections are listed in §12.

## Sources used

| Source | Version pinned |
|---|---|
| CLINK specs — `github.com/shocknet/CLINK` | commit `442b7ae`, branch `main`, fetched 2026-08-20 |
| NIPs — `github.com/nostr-protocol/nips` | commit `656cecc`, branch `master`, **re-fetched 2026-08-21** for §31. The repo is not kept on this machine; anything cited from it must be re-fetched, never recalled |
| Blossom BUDs — `github.com/hzrd149/blossom` | fetched 2026-08-20 |
| Lightning.Pub source | the **running local install**, `~/lightning_pub`, `package.json` version `0.0.37` |
| `@shocknet/clink-sdk` | `1.5.5` bundled in Lightning.Pub; `1.7.0` current on npm |
| Live node | local Pub, LND `SERVER_ACTIVE`, 1 private channel, **92,160 sat inbound / 6,000 outbound** after the test payment (§1) |

Field-name detail lives in `/docs/clink-notes.md`. This file is the answers.

## Running the spike scripts

```bash
cd spike && npm install

# slice 0 — raw wire capture
node request-invoice.ts <noffer1...> [amount_sats] ['{"key":"value"}']
node watch-receipts.ts <npub|hex> [wss://relay ...]

# slice 2 — the fixture's offers, and the storefront's own buy path against the live node
node mint-offers.ts [--nprofile <path|nprofile1…>] [--dry]   # writes .offers.json
node seed-listings.ts                                        # republishes 30402s with clink_offer
node check-buy.ts [item-d-tag]                               # exit 0 = the money path works
```

Node 24 runs the `.ts` files directly (type stripping). No build step, no global install.
`check-buy.ts` imports `/storefront/src/*.ts` unmodified — if it and the storefront ever
disagree, `check-buy.ts` is wrong.

---

## 1. Lightning.Pub running with inbound liquidity — **ANSWERED 2026-08-21**

- [x] Installed on: local macOS machine (`~/lightning_pub`, lnpub `0.0.37`)
- [x] Channel confirmed on: **2026-08-21 00:53 UTC**
- [x] Inbound capacity: **98,160 sat** (100,000 capacity − 1,000 local reserve − 840)
- [x] Test payment received: **2026-08-21 01:45 UTC** — 6,000 sat, real external payment
      (`internal: 0`), zero service fee, settled in seconds. §1 is fully closed

**How it was obtained, because "deposit on-chain and let Pub open a channel" is not what
happened and would not have worked.** The node had zero on-chain funds and zero channels, and
Pub's own LSP flow (`lsp.ts:269-284`) pays for a channel out of the **liquidity-provider
balance**, which was 0 — so it could never fire. Deadlock.

The way out is that **inbound is rented, not funded**: you pay a fee, the LSP opens the channel
with *their* sats on *their* side, and your node needs no on-chain balance at all. The fee is a
bolt11, so it can be paid from any other wallet.

Olympus (ZEUS) LSPS1, `https://lsps1.lnolymp.us/api/v1`, measured 2026-08-20:

| | |
|---|---|
| `min_initial_lsp_balance_sat` | **100,000** — the floor; nothing smaller is sold |
| `supports_zero_channel_reserve` | false |
| fee for 100k inbound, 30 / 60 / 90-day lease | 6,496 / 6,825 / **7,157** sat |
| `min_required_channel_confirmations` | 3 (but the channel arrived **active immediately** — a turbo open, so do not plan around the stated 3) |
| lease | 13,000 blocks, funded 2026-08-21, **expires 2026-11-19** |

Order `05fba71ae8f943949147afbe411661ab`, `COMPLETED`, funding outpoint
`3f45f7d1988e11fd9f82b449d9294fcdc42b12b5ef34710123ebb575ba775153:0`.

**This is a lease.** The inbound disappears on 2026-11-19. Put it in the calendar.

**The channel is private (`announce_channel: false`), and that has a sharp edge.** An
unannounced channel is invisible to the network, so an invoice is only payable if it carries a
route hint. `lncli addinvoice --amt 1000` produced **0 route hints** and was unpayable;
`--private` produced 1 hint via Olympus and was payable. Lightning.Pub gets this right — it
calls `AddInvoiceReq(value, expiry, true, …)` (`lnd.ts:412`) and the third argument is
`privateHints` (`addInvoiceReq.ts:3`) — so CLINK invoices from this node do carry the hint.

**Cost floors that do not scale down**, all measured, for anyone tempted by a smaller channel:
Olympus minimum 100,000 sat; LND `minchansize` default 20,000; LND on-chain anchor reserve
~10,000 once any channel exists; Pub's `LSP_CHANNEL_THRESHOLD` 1,000,000 before it buys one
itself. Item prices scale to any size; channels do not.

**Outbound now exists, and a buyer created it.** After the 6,000-sat test payment:
`local_balance 6000 / remote_balance 92160`. That is the slice-7 constraint resolving itself the
way it will in production — refunds need outbound, outbound only exists after buyers have paid,
so a refund cannot be the first payment this node ever makes. It also means the refund cap in
§10 has a real ceiling today: **6,000 sats**, and the demo's oversell refund must fit under
whatever has actually been sold by that point.

**The amount check does not protect you, and slice 2 proved how little.** `getNofferInvoice`
sets `maxSendable` from the channel balance but falls back to `10_000_000` whenever the
liquidity provider is reachable (`offerManager.ts:286-298`), so the **0-channel** node reported
`"max":10000000`. Worse, **a fixed-price offer is not range-checked at all**: `HandleUserOffer`
(`offerManager.ts:246-257`) compares `amount` against `[10, remote]` only when
`price_sats === 0` (spontaneous); when `price_sats > 0` it takes the offer's own price and goes
straight to `AddAppUserInvoice`. Measured on the wire before this channel existed: the
0-channel node returned `lnbc2100u1p4g0fv9…`, a perfectly valid 210,000-sat BOLT11 it had no
capacity whatsoever to settle.

⇒ **"the invoice request succeeded" is not evidence the node can receive, and neither is "we
got a real BOLT11 back".** Only a paid invoice is. Every offer we mint is fixed-price, so this
is the path the demo runs on: a green `check-buy.ts` says our client is correct, not that money
can move.

**Which fixture items are actually payable**, against 92,160 sat of remaining inbound:

| item | price | payable today |
|---|---|---|
| `plants` | 6,000 sat | **yes — proven, paid 2026-08-21** |
| `lamp` | 30,000 sat | yes |
| `bike` | 180,000 sat | no — over inbound |
| `couch` | 210,000 sat | no — over inbound |

Both unpayable ones will still hand a buyer a BOLT11 and then fail at payment time, which is
the honest shape of the problem and worth showing rather than hiding. Demo `plants` or `lamp`.
Every sale eats inbound and creates outbound, so this table drifts as the demo runs.

**Done 2026-08-21** with `cd spike && node check-buy.ts yardsale-2026-08-plants --pay`, which
prints an invoice and waits for a human to pay it. One run closed four things at once: the
invoice is payable, Lightning.Pub really does send the kind 21001 receipt, the receipt is
readable by the payer's ephemeral key and by nothing else, and the payload carries no preimage.
Evidence in §5. Re-run it any time the node's behaviour needs re-proving; it is the only test in
this project that costs money.

---

## 2. Raw noffer request/response captured — `NEEDS HUMAN` (partially done)

**Done: a real request/response round trip against the live local node**, captured with
`/spike/request-invoice.ts` on 2026-08-20 20:53 UTC. The offer id was deliberately
non-existent, so this captures the wire format and the error path, not an invoice.

Request event as published (raw):

```json
{
  "kind": 21001,
  "created_at": 1787259238,
  "tags": [
    ["p", "3f0abe5a9446f8c0d42ff83e316792ca393b1920cbb6ede5072350516015befc"],
    ["clink_version", "1"]
  ],
  "content": "ArZPL5glNO2VWNbffQAnz25owTOHP06XDzQ5pJzExqZrdnVxaAMov8RnperD1nbOPWGUmxVC+0vzXUOMzacqvPY6Lc0f63Hf7uVtaCFHX5AH5KfDDtwHTXKroXNaHNX+CeosMKIPVu8po4b56FHRpJRxA+ES0y6aUsxYkmvKKgztK4s=",
  "pubkey": "4117969f2b8c3bf7f9f4d0c3065275067618159b177b2c0679bf53523a4cb326",
  "id": "416b38fac6c8d0b4a1b1dafaa5e7c910e8e821082a0f763f6b17e29cae220645",
  "sig": "967ab91e0c5a1e711dcc4f24bb6de68d9f66aea87b11b7198e91e21bf66085e94afe79e996aac33e4f5e0c3cac9538623904a79680cd30f1c1b6c02ac7d30ab1"
}
```

Decrypted request payload: `{"offer":"spike-nonexistent-offer","amount_sats":1000}`

Response event (raw):

```json
{
  "content": "AurtvClmXt83smC0tDPentGyUH7iukTgJUrffpzN1EO918vy2X8CWQzZAtSk/wFjshvAH6jjynpn3ygnosfLiyD6k8Gi6PUAb2rMHHbvPraT/f39Y8EcIBOY9bMs5wmGFurKpVYAOFpz1Zrivy2K5h6+xBbHVQemTVnxOE3tShV3VdQ=",
  "created_at": 1787259239,
  "id": "da932fc5a2d70663c4355778e2ea8b664a83f0cf70e1f1f84aada50c590b3ecd",
  "kind": 21001,
  "pubkey": "3f0abe5a9446f8c0d42ff83e316792ca393b1920cbb6ede5072350516015befc",
  "sig": "640b4b6e8014ea67d57e9098d90733a8cec56d568e355ad641466cbe0626efd83bb89f3e69c1ecc2d8d9820e49166ccb166da3007ea0851780a93c2fdbeae664",
  "tags": [
    ["p", "4117969f2b8c3bf7f9f4d0c3065275067618159b177b2c0679bf53523a4cb326"],
    ["e", "416b38fac6c8d0b4a1b1dafaa5e7c910e8e821082a0f763f6b17e29cae220645"]
  ]
}
```

Decrypted response payload: `{"code":1,"error":"Offer recipient not found"}`

Node-side log confirming intake (`~/lightning_pub/logs/components/OfferManager_2026-08-20.log`):

```
📥 [OFFER REQUEST] Received offer request {"fromPub":"6f77343e…","eventId":"4c2553d7…","offer":"spike-nonexistent-offer","amount":1000}
❌ [OFFER REJECTED] Offer request failed {"eventId":"4c2553d7…","code":1,"error":"Offer recipient not found","max":10000000}
```

Facts established:

- Round trip over `wss://relay.lightning.pub` took **~1 second**.
- The response carries `p` + `e` but **no `clink_version` tag**, contradicting
  `clink-offers.md:257` ("Implementations MUST include this tag in both request and
  response events"). Source: `offerManager.ts:315-326`. Our client MUST NOT reject
  responses lacking the tag or it will not work against Lightning.Pub.
- The offers error envelope is `{"code":…,"error":…}` with **no `res` field**, matching
  `clink-offers.md:176`. Debits and Manage use `{"res":"GFY",…}`. Do not write one parser
  for all three.
- The service pubkey `3f0abe5a…` is the **application** pubkey, not per-user. It appears in
  TLV `0` of every noffer this node mints.

### The success path, captured in slice 2 (2026-08-20)

Against a purpose-made fixed-price offer minted by `/spike/mint-offers.ts` on the same node
(`plants`, 6000 sats, `payer_data: ["refund_pointer"]` required). Same wire shape as above:
kind 21001, `p` + `clink_version` on the request, `p` + `e` and **still no `clink_version`** on
the response.

Request payload (decrypted), and note `amount_sats` is deliberately absent — the offer is
fixed-price, so the node prices it (`clink-offers.md:134` makes the field optional there):

```json
{"offer":"230bc0e1eecd95483df1b6b4990a119b3f5ed55ea78cfefff4121e5b9e394d3338dd",
 "payer_data":{"refund_pointer":"spike@example.com"}}
```

Response payload (decrypted):

```json
{"bolt11":"lnbc60u1p4g08chpp543vhej394h4er3fcdaye7lnvnp3g4ej0j6888e8j6ke33zfstznsdp909shyernv9kx2tfjxqervtfs8qkhqmrpde68xcqzzsxqrrsssp5gv0wp265auuqggmtzz4nss97avajn6gux763f84dx5p0mgmarr7s9qxpqysgqp6lrahqe9x5dxffjdm5u9g7kzlqmpsz0ntt9xvfju4aqm9397xspgj0444uhrmqrtkrhj05k9ry3ugrj8fn49z9636dqzc3uuc8wctcqpts0l4"}
```

`lnbc60u` = 60 × 10⁻⁶ BTC = **6000 sats**, matching the offer and the listing. From a node with
**0 channels** — see §1.

And the same offer with the required key omitted, which is the typed decline the whole design
rests on:

```json
{"code":1,"error":"Missing or invalid payer_data: refund_pointer","payer_data":["refund_pointer"]}
```

Round trip ~1–2s each time, over `wss://relay.lightning.pub`.

**NEEDS HUMAN — only the paid half now**, and the channel to pay it over exists as of
2026-08-21. One command, in §1: `node check-buy.ts yardsale-2026-08-plants --pay`. Note the
default item is the *cheapest* offer precisely so it fits inside the rented inbound.

---

## 3. Can Lightning.Pub mint multiple offers per account?

**Answer: yes — unlimited, independently addressable, per item.** `clink_offer` per listing
is viable; `item_ref` is not needed.

**Evidence:**

- `~/lightning_pub/src/services/storage/offerStorage.ts:18-25` — `AddUserOffer` creates a
  row keyed by `app_user_id` with `offer_id: crypto.randomBytes(34).toString('hex')`. No
  cap, no uniqueness constraint per user.
- `~/lightning_pub/src/services/storage/entity/UserOffer.ts:10-43` — one row per offer,
  `offer_id` is `@Column({ unique: true })`, alongside `label`, `price_sats`,
  `callback_url`, `payer_data`, `management_pubkey`, `bearer_token`, `blind`.
- `~/lightning_pub/src/services/main/offerManager.ts:19-37` — `mapToOfferConfig` encodes a
  **distinct `noffer` per row**: `nofferEncode({ pubkey: app.npub, offer: offer.offer_id,
  priceType, relay, price })`. TLV `0` is the shared app pubkey; **TLV `2` is what makes
  each item's offer distinct.**
- Creation paths: RPC `AddUserOffer` (`proto/service/methods.proto`, `auth_type = "User"`)
  and CLINK Manage `create` (`managementManager.ts:231-252`).
- Price semantics (`offerManager.ts:21`, `241-257`): `price_sats > 0` ⇒ `OfferPriceType.Fixed`;
  `price_sats === 0` ⇒ `Spontaneous`, payer must send `amount_sats` between **10** and
  `maxSendable`; `price_sats < 0` ⇒ rejected, error code `5`.

**How an item identifier travels anyway.** Two mechanisms exist, and they are not
equivalent:

1. **TLV `2` of the per-item noffer** — implicit, and the one to use. The node maps
   `offer_id` → row, and stores `offer_id` on the resulting invoice
   (`UserReceivingInvoice.offer_id`, entity line 79). `GetUserOfferInvoices` can then list
   settled invoices **per item**.
2. **`payer_data`** — explicit, and only if we need buyer-supplied values (see §4/§6).

**One default offer per account is special and should not be used publicly.**
`offerStorage.ts:11-17` — `AddDefaultUserOffer` sets `offer_id: appUserId`, i.e. the
default offer's id **is the account's `app_user_id`**. `mapToOfferConfig` flags it with
`default_offer: offer.app_user_id === offer.offer_id`. That same `app_user_id` is the
`pointer` used to address the account in CLINK Debits and Manage
(`debitManager.ts:262`, `managementManager.ts:232`). Publishing the default noffer on a
public storefront therefore hands every reader the account pointer, and an unauthorised
`ndebit`/`nmanage` request against a pointer with no grant pushes an **approval prompt to
the seller's wallet** (`debitManager.ts:312-323`, `managementManager.ts:70-90`). That is a
free approval-fatigue spam channel.

⇒ **Rule for the builder: every published listing gets a purpose-made offer from
`AddUserOffer`/Manage `create`. Never publish the default offer.**

**Consequence:** spec §6.1 keeps `clink_offer` as a per-item tag. **Drop `item_ref`** — it
solved a problem that does not exist.

---

## 4. Can an invoice request be declined on custom logic?

**Answer: not by the node. Lightning.Pub has no pre-invoice hook.** Strict mode (spec §7.4)
is reachable only by making the offer itself stop existing, or by fronting the node with
our own CLINK service. There are exactly four decline paths, all fixed-function.

**Evidence** — every `return { success: false, … }` in the invoice path
(`~/lightning_pub/src/services/main/offerManager.ts`):

| Line | Condition | Code | Payload |
|---|---|---|---|
| `224` / `251` | `amount < 10` or `amount > maxSendable` (spontaneous/variable) | `5` | `range: {min:10, max:<maxSendable>}` |
| `231` | offer id resolves to no user | `1` | `"Offer recipient not found"` |
| `256` | `price_sats < 0` | `5` | — |
| `262-266` | required `payer_data` keys missing or non-string | `1` | `"Missing or invalid payer_data: <keys>"` + a `payer_data` array of the expected keys |
| `270` | `description` longer than 100 chars | `1` | explicit message |
| `306` | offer string has a `:` and the prefix is not `p` | `1` | — |

The only content-aware check is `ValidateExpectedData` (`offerManager.ts:139-155`), and it
validates **presence and `typeof === 'string'` only**. It never inspects values. There is
no plugin, no webhook, no rule engine in front of invoice creation.

**`callback_url` does not help.** It fires *after* settlement, from
`TriggerPaidInvoiceSideEffects` → `triggerPaidCallback`
(`paymentSideEffects.ts:24-29`, `60-99`). It is a URI-template expanded with `amount`,
`invoice`, and the payer_data keys, then GET with an optional bearer token. Post-payment
notification, not a gate.

**What strict mode can actually be built on** — pick one:

- **(a) Delete or reprice the offer when the item sells out.** `nmanage` `delete`
  (`managementManager.ts:317-324`) or RPC `DeleteUserOffer`. A subsequent request then
  falls through `HandleUserOffer` → `HandleDefaultUserOffer` and returns **code `1`,
  `"Offer recipient not found"`** — a clean, spec-shaped decline. Race window = the time
  between the settling payment and the delete landing. This is the lazy option and it needs
  no new infrastructure.
- **(b) Set `price_sats` absurdly high** so honest wallets refuse. Ugly, don't.
- **(c) Run our own CLINK service key** in front of the node (the shop daemon holds the key
  in TLV `0`, evaluates inventory, and only then asks the Pub for an invoice). Full strict
  mode with no race, but it makes the seller's daemon a required always-on component and
  moves the service pubkey off the Pub.

**Consequence for spec §7.4 and §8:** best-effort + auto-refund is the honest default.
Keep `InventoryPolicy` as the seam, implement `checkAvailable` as (a) — an offer that gets
deleted on depletion — and note that "strict" here means "best-effort with a much smaller
window", not "atomic".

---

## 5. What does a settlement receipt look like on the wire?

**This answer invalidates the availability design in spec §7.2 and one line of the pitch.**

- **Event kind:** `21001` — the same kind as the request/response
  (`paymentSideEffects.ts:226`, `clink-offers.md:313`).
- **Tags:** `["p","<payer_pubkey>"]`, `["e","<original request event id>"]`,
  `["clink_version","1"]` (`paymentSideEffects.ts:228-232`). Note this is the *one* place
  Lightning.Pub does emit `clink_version`.
- **References the request** via the `e` tag, correlating to the `clink_requester_event_id`
  stored on the invoice at request time
  (`UserReceivingInvoice.clink_requester_event_id`, entity line 90; set from
  `offerManager.ts:178-183`).
- **Where the preimage appears: it does not.** `paymentSideEffects.ts:222` sends
  `JSON.stringify({ res: 'ok' })` with the comment *"Receipt payload - payer's wallet
  already has the preimage"*. The spec says the payload **MUST** include `preimage` for a
  standard Lightning payment (`clink-offers.md:327-333`). Lightning.Pub never does.

**Confirmed on the wire 2026-08-21** by a real 6,000-sat payment (`check-buy.ts --pay`). The
receipt, 6 seconds after settlement:

```json
{
  "content": "Aveq4G5Ntk5SouQkJtGFUS3HCLwl9TjWzPrRwxquZv1JtDs/9T7T7fPgAsRkUJ5ndvg3dO5YdZeEOvqTCvUl0LbbdKrVFUs6iDIOTdxip5q4CHdgVolttGSZa1371NTXPmEH",
  "created_at": 1787276750,
  "id": "59151c57b020d6cd081f43ee78dc3b1f159655c5e65774402baef7f26a120d6e",
  "kind": 21001,
  "pubkey": "3f0abe5a9446f8c0d42ff83e316792ca393b1920cbb6ede5072350516015befc",
  "sig": "a0f217003579964ece47dd9d2ad2d99523516e4ff1b7b4019218e5c127414026f0d431101cbeaa7a9422db7ddf3ce31f82f6aa24cb6c05e301d061246fc912d1",
  "tags": [
    ["p", "476c297502cf8bb7815d193dc49499f125ca5186409e533d70b5176fa8f787e3"],
    ["e", "bfdb04f7c3adbb3c118a43b10f139c495181f445b47c465cbfa04020721d2589"],
    ["clink_version", "1"]
  ]
}
```

Decrypted payload, in full: `{"res":"ok"}`

Four things that settles:

1. **The receipt is sent.** It is a MAY (`clink-offers.md:309`) and Lightning.Pub does it.
2. **`clink_version` is present here** and absent on the response (§2) — so the tag's presence
   is not a reliable signal of anything, and a client must be lenient on both.
3. **The `p` tag is the ephemeral requester key**, not the wallet that paid the BOLT11. Those are
   different parties and conflating them will produce a broken client. The `e` tag is the
   original request event id, matching `clink_requester_event_id` on the stored invoice.
4. **No preimage, and this was NOT an internal transfer.** This is stronger than the source read
   suggested and it is a real interop bug. `user_receiving_invoice.internal = 0` for this
   payment — a genuine external Lightning settlement, exactly the case where
   `clink-offers.md:327-333` says `preimage` MUST be present. The spec also says the *absence*
   of a preimage "indicates an internal transaction" (`clink-offers.md:333`), so a spec-following
   client reading this receipt would conclude the payment settled internally. It did not.

   ⇒ **Never infer internal-vs-external settlement from a missing preimage.** And this is the
   second cheap upstream PR sitting here, next to the `clink_version`-on-response one in §13.2.

**The receipt is addressed and NIP-44 encrypted to the payer** (`paymentSideEffects.ts:236`,
`encrypt: { toPub: invoice.clink_requester_pub }`). And it is a **MAY**, not a MUST
(`clink-offers.md:309`).

Therefore:

- ❌ The seller cannot read it. The storefront cannot read it. A third party cannot read it.
- ❌ There is **no public settlement receipt on relays** for a CLINK Offers payment. The
  only public receipt in the ecosystem is a NIP-57 kind `9735` zap receipt, and only when
  the request carried a `zap` payload (`paymentSideEffects.ts:183-211`).
- ❌ Spec §7.6 "buyer presents the settlement receipt, seller's device verifies the
  signature offline" — the seller's device cannot decrypt it. Only the buyer's key can.
  Any offline pickup proof has to be something we design (e.g. buyer's device re-signs a
  challenge with the ephemeral payer key that appears in the invoice's
  `clink_requester_pub`), not something CLINK hands us.

**What the seller can actually observe.** Three options — **and the ranking below was wrong;
slice 3 corrected it. See §13.16.** Corrected order:

1. **`GetUserOfferInvoices`** — poll per offer; returns `invoice`, `offer_id`,
   `paid_at_unix`, `amount`, and `data` (the stored `payer_data`)
   (`offerManager.ts:89-104`). **This is the watcher's feed**, and it is the only one of the
   three that answers *which item sold*. It is also the refund path's only route to the
   buyer's pointer. `include_unpaid: false` makes the storage layer filter on
   `paid_at_unix > 0` (`paymentStorage.ts:527-533`), so the response is exactly the settled
   set for one item.
2. **`GetLiveUserOperations`** — Lightning.Pub pushes a live `UserOperation`
   (`INCOMING_INVOICE`, amount, `operationId`, `internal` flag, `latest_balance`) over
   Nostr to the account's own key on every settlement
   (`paymentSideEffects.ts:34-44`, `101-112`). Nostr-native, no HTTP, and lower latency —
   but `UserOperation` carries **no `offer_id`** (`structs.proto:634-646`), so it cannot
   attribute a payment to an item on its own and has to be followed by (1) anyway. It also
   pushes once, so a watcher that was asleep never learns. A nudge, not a feed.
3. **`callback_url`** — HTTP GET on settlement. Loopback addresses are explicitly
   **allowed** (`safeOutboundFetch.ts:121-131`: `isLoopbackIPv4`/`isLoopbackIPv6` return
   *not blocked*, while private ranges 10/8, 172.16/12, 192.168/16, 100.64/10, link-local
   and cloud-metadata IPs are blocked). So `http://127.0.0.1:<port>/paid?inv={invoice}` on
   the seller's own machine works, needs no credential, and is the one path that carries
   `payerData` out of the node without an RPC (`paymentSideEffects.ts:27`). But it is an
   HTTP listener, and it is push-once like (2).

**Consequence for spec §7.2:** the static page **cannot** derive availability from relay
receipts. Availability must come from the seller republishing the kind `30402` with updated
`quantity`/`status` after the watcher sees a settlement. The page reads the listing event
and nothing else. That is simpler than the spec assumed, but it means **availability is only
as fresh as the seller's watcher**, and a page loaded while the watcher is down shows stale
stock. Say that out loud in the demo.

---

## 6. Is `payer_data` populated end-to-end by a real wallet? — `NEEDS HUMAN`

**Node side: fully verified.** Wallet side: unverified, and probably the wrong question.

**What the node does** (`offerManager.ts:139-155`, `258-267`, `273-280`; tests in
`~/lightning_pub/src/tests/nofferPayerData.spec.ts`):

- An offer declares required keys as a string array: `payer_data: ["order_id"]`.
- The 21001 request supplies an object: `payer_data: { order_id: "abc123" }`.
- Missing, non-object, or non-string values ⇒ error `code: 1`, message
  `"Missing or invalid payer_data: order_id"`, plus an extra **`payer_data` array of the
  expected keys** in the error payload (`offerManager.ts:338-350`). That extra field is a
  Lightning.Pub extension — it is not in `clink-offers.md`'s error payload spec. It is
  genuinely useful: a client can read it and re-prompt.
- Validated values are stored on the invoice (`payer_data: { data: validated }`,
  `offerManager.ts:276`) and read back by `GetUserOfferInvoices` as `data`
  (test at `nofferPayerData.spec.ts:312-338`) and expanded into `callback_url`
  (`paymentSideEffects.ts:74-81`).
- `payer_data` requirements survive failed and successful requests
  (`nofferPayerData.spec.ts:341-377`).

**There is no standard refund field.** `/docs/clink-notes.md` §8: CLINK defines
`payer_data` as "Arbitrary JSON object with payer info (e.g., NIP-05, name, pubkey)"
(`clink-offers.md:136`) and enumerates no keys. No `clink_offer`, no `refund`, nothing.
So spec §7.3's "pull an invoice from the buyer's `clink_offer` supplied in `payer_data`"
is **our own convention**, and it only works if the paying client chooses to send it.

**Which makes the wallet question secondary.** A generic wallet scanning our QR has no
reason to invent a `refund_offer` key. The robust design does not depend on wallet
behaviour at all:

> Our storefront is the client sending the 21001. It asks the buyer for a payment pointer
> (Lightning address or `noffer`) **in the page, before requesting the invoice**, and puts
> it in `payer_data`. The offer declares that key as required, so a payment that skips it
> is declined rather than becoming an unrefundable oversell.

That turns the refund path from "hope the wallet cooperates" into a form field. It also
means an out-of-band payer (someone who scans the raw QR with a wallet that doesn't
populate our key) simply cannot pay — which is the correct behaviour for a
non-refundable-oversell risk, and worth stating as a deliberate trade-off.

**Fully closed on the node side — slice 2, 2026-08-20/21.** The last piece landed with the paid
invoice: the validated `payer_data` is **persisted on the settled invoice**, which is what makes
slice 7 possible at all. Straight from `user_receiving_invoice` after the real payment:

```
serial_id  19
paid_at_unix  1787276750
paid_amount   6000
service_fee   0
internal      0
offer_id      230bc0e1eecd95483df1b6b4990a119b3f5ed55ea78cfefff4121e5b9e394d3338dd
payer_data    {"refund_pointer":"check-buy@example.com"}
clink_requester_pub  476c297502cf8bb7…
```

Three things worth naming. The `offer_id` is the *per-item* offer, so `GetUserOfferInvoices`
gives per-item settlement without us inventing a correlation id. The `payer_data` survived
settlement intact, so the refund path has its pointer waiting for it. And `clink_requester_pub`
is on the invoice, which is the key spec §7.6's offline pickup proof would challenge.

**Steps 3 and 4 were done first — slice 2, 2026-08-20.** Against a real offer minted with
`payer_data: ["refund_pointer"]`, with the key named as ours rather than `order_id`:

```json
{"code":1,"error":"Missing or invalid payer_data: refund_pointer","payer_data":["refund_pointer"]}
```

and with the key supplied, a BOLT11 (§2). Both reproduce on demand:
`cd spike && node check-buy.ts`, which drives the storefront's own modules. The
Lightning.Pub `payer_data` extension to the error payload is therefore confirmed on the wire,
not just in source, and our page reads it to re-prompt.

**DEMOTED PERMANENTLY IN SLICE 8, from source, and it can no longer change a design.** The
question stayed open on the reasoning that it decides slice 8's fallback: *if* a third-party
wallet could be prompted for an arbitrary `payer_data` key then there is a middle tier of buyer
who is refundable without our page. Reading `offerManager.ts` before building on that shows the
middle tier does not exist, whatever any wallet does. Two lines, both verified 2026-08-21:

- **`payer_data` on an offer is a REQUIRED-key list, and there is no optional tier.**
  `ValidateExpectedData` (`offerManager.ts:139-142`) returns `{passed:true, validated:{}}` the
  moment `expectedKeys` is empty or absent. A key is required or it is not requested; the node
  has no third state.
- **A key the offer does not declare is DISCARDED, not stored.** The invoice is written with
  `payer_data: validated ? { data: validated } : undefined` (`offerManager.ts:276`), and
  `validated` is built by looping over `expectedKeys` alone (`:147-152`). So a generous wallet
  that volunteered `refund_pointer` against an offer minted `payer_data: []` would have it
  dropped on the floor — the settled invoice carries `{data:{}}` and the refund path finds
  nothing.

⇒ **The two tiers are the only tiers.** An offer either demands the pointer, in which case a
wallet that cannot supply it cannot pay at all; or it does not, in which case the payment is
unrefundable *by construction* and no wallet behaviour can rescue it. Slice 8's option (c) —
"relax the requirement to optional" — was therefore never implementable, and this is why it was
rejected without needing a phone. See spec §7.3.

**What is left of the question is annotation, not decision** (~5 minutes, whenever a phone is
free). It would tell us whether a CLINK wallet scanning a *raw* `noffer` gets a usable prompt,
which would make a raw-noffer sticker work for CLINK-wallet users specifically. It does not
change the sticker: the storefront deep link serves every wallet, and slice 8 chose it for that
reason rather than for lack of an answer here.

1. Pay one of our fixture offers' `noffer` **from ShockWallet on another device** —
   `node -p "require('./.offers.json')['yardsale-2026-08-lamp'].noffer"` prints one. `lamp` is
   30,000 sats, so do not complete it — the decline is the answer and it arrives before money
   moves.
2. Record: does the wallet prompt for `refund_pointer`, silently fail, or show the error text?

Paste evidence:

```json
```

**Consequence:** refunds are viable, but only for buyers who pay through our page. Slice 7
must be written against our own field, and slice 8's fallback path must warn that a
raw-QR payer forfeits the auto-refund.

---

## 7. nsite deploy and gateway resolution — **ANSWERED 2026-08-20**

**`npm i -g nsyte` does not work — nsyte is not on npm.** Corrected 2026-08-20 after the
command in this file's own NEEDS HUMAN block 404'd. What is actually out there:

| Tool | Distribution | Manifest kind it publishes | Verdict |
|---|---|---|---|
| **nsyte** (`sandwichfarm/nsyte`) | JSR (`deno install -A -f -g -n nsyte jsr:@nsyte/cli`) or a pre-built binary from GitHub Releases. **Not npm.** | **15128 / 35128**, and it reads kind `10063` | The right tool. Needs Deno or a 93 MB binary |
| **nsite-cli** (`flox1an/nsite-cli`, npm, v0.1.18) | `npm i -g nsite-cli` | **34128** — the legacy one-event-per-file kind | **Do not use.** `/docs/spec.md` §6.4 rules 34128 out: one signature per file |
| `nsite` on npm | — | — | Unrelated. A 2018 "JS site downloader" |

nsyte release trust signals, checked 2026-08-20: latest is **v0.28.0, published that same day,
4 downloads**. **v0.27.2 (2026-06-21) has 776** and is the one with field usage. GitHub publishes
a per-asset sha256 `digest` via the releases API, so integrity is verifiable:
`nsyte-macos-arm64` v0.27.2 is
`sha256:03d1919a485c214ce3e528a66ec3b93a5ab47d6e743b9a3b1115b0ffa2a7741b`.

Given this project's own thesis about supply-chain risk, note what installing it costs: either a
Deno runtime plus `deno install -A` (which grants the installed script *all* permissions), or a
93 MB unsigned binary that macOS Gatekeeper will quarantine. Neither is disqualifying — just
priced honestly, and prefer v0.27.2 over the same-day release.

**The alternative is that we already have the parts.** `/spike/seed-listings.ts` does Blossom
upload with kind 24242 auth and relay publishing today. An nsite deploy adds only: hash each
file, emit `["path","/abs",  "<sha256>"]` tags, compute the `x` aggregate hash (`5A.md:67-85`),
and publish kind `15128` plus kind `10063`. That is slice 5's job regardless — "deploy from the
app" cannot shell out to a Go/Deno binary from a browser — so writing it makes slice 5 a port
rather than a greenfield. nsyte then has a second, better use: an independent checker to confirm
our manifest is well-formed.

- [x] Deployed with **our own `/spike/deploy-nsite.ts`**, not nsyte — see the tool table below.
      **Slice 5 turned that script inside out**: the hashing, the aggregate, the Blossom auth
      and both event shapes moved to `/builder/src/deploy.ts` (the §13.13 lift pattern) and the
      script is now the ~90 lines a browser cannot have — a filesystem walk and a Signer over a
      key on disk. It drives the shipped module, so it is also slice 5's headless verification
- [x] Resolves at: `https://npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws.nsite.lol/`
      → `200 text/html 3143B`, byte-identical to our `dist/index.html`
- [x] `/404.html` fallback confirmed: **yes** — `/definitely-missing` → `404`, 951 bytes,
      byte-identical to our `dist/404.html`. `5A.md:196` holds in practice
- [x] Manifest kind to use: **15128** (root site, one per pubkey, MUST NOT include a `d`
      tag — NIP-5A `5A.md:17`)
- [x] Aggregate hash cross-checked two ways. Our implementation and the spec's own
      `jq … | sort | sha256sum` pipeline (`5A.md:96`) both give
      `1a15afd616c7fdcb84be2ddc91e7783011d8f9de99836616978c7426bf71af2d`, matching the
      published `x` tag. Note the line format is `<hash> <path>`, **hash first** — reversing it
      produces a wrong-but-plausible digest that nothing would catch
- [x] Gateway used: `nsite.lol`. First request after publish timed out; every request since is
      ~0.3s. Expect one cold miss while the gateway fetches blobs, and do not demo the first hit
- [x] **Redeploy is not immediate, and this is the sharp edge** (measured 2026-08-21, slice 2's
      deploy). Relays and Blossom update in seconds — the kind 15128 carried the new `path`
      hashes and every blob answered `200` from `cdn.hzrd149.com` straight away — but the
      gateway kept serving the *previous* build. It sends
      `cache-control: public, max-age=3600` with an `etag` and a `last-modified` from the old
      version, and a cache-busting query string does not defeat it: the stale copy is on the
      gateway's side, not the client's. New asset filenames therefore **404** while the old
      `index.html` is still being served, which looks exactly like a broken deploy and is not.

      **The stale snapshot is coherent, which is the saving grace.** Measured 70 minutes after
      the slice-2 deploy: `/` served slice 1's `index.html` and *both* of the asset paths it
      references still answered `200`, while both of slice 2's answered `404` — even though the
      current kind 15128 lists only slice 2's and not slice 1's. So the gateway is serving
      wholly from its own cache and ignoring the manifest, rather than mixing the two. A visitor
      sees the previous version working, not a half-broken page. Still over an hour after the
      `max-age` should have lapsed, so `max-age` is not the whole story.

      ⇒ **Verify a deploy against the relay and Blossom, never against the gateway.** The
      manifest is the source of truth. Slice 5 made that a command:
      **`node spike/check-deploy.ts <npub>`** reads the kind 15128 and 10063 off the relays,
      recomputes the aggregate hash from the `path` tags, fetches every blob from every server
      in the 10063 and checks each one hashes to its own tag, then reports the gateway
      separately as the cache it is. Reproduced live on 2026-08-21: sections 1–3 passed while
      the gateway was still serving the previous `/index.html`, and the tool said so in those
      words. ⇒ **Do not redeploy on demo day**, or budget an hour before the URL reflects it.

      **Re-measured 2026-08-26, item 18, and the "budget an hour" advice does not survive it.**
      The live site's kind 15128 was replaced at `2026-08-21T18:11:43Z`; **4d 9h later the
      gateway was still serving the pre-replacement `index.html`** (`00145a56e12e…`, the build
      whose blob mtime is `Thu, 20 Aug 2026 23:49:11 GMT`), while sections 1 and 2 of
      `check-deploy.ts` passed the whole time. That is **106x the advertised `max-age=3600`**.
      So `max-age` is not a deadline and the previous note's "budget an hour before the URL
      reflects it" is optimistic. The mechanism is **UNVERIFIED** — a long-lived internal cache,
      a manifest pinned at fetch time, or a relay set that missed the replacement all fit.

      Four headers, read off the live response rather than assumed:

      | header | what nsite.lol actually sends |
      |---|---|
      | `cache-control` | `public, max-age=3600` |
      | `age` | **not sent at all.** So the gateway does not expose how much of its window is left, and nothing client-side can compute it |
      | `last-modified` | the **Blossom blob's** mtime, not the cache entry's — `cdn.hzrd149.com` returns the identical value for the same hash, so it dates the build and says nothing about the cache |
      | `etag` | the sha256 of the **decompressed** bytes, ie. the manifest's own `path` tag. Identity gives `"<sha>"`, gzip gives `W/"<sha>"` — same digest, weak validator. A quote-strip that does not also strip `W/` reports a false mismatch |

      The ETag being the content hash is the useful half: `curl -sI <url>` answers "is the
      gateway current" with no body. `check-deploy.ts` §4 asserts it every run rather than
      trusting it.

      **No escape hatch exists, and both candidates were probed rather than reasoned about.**
      Against the live stale `/index.html` on 2026-08-26: a query string
      (`?nocache=419f1c8929ec`) returned `00145a56e12e…`, and the request headers
      `cache-control: no-cache` + `pragma: no-cache` returned `00145a56e12e…`. Same stale bytes
      both ways. `check-deploy.ts` §4 now runs both probes whenever it finds a stale path, so the
      claim stays measured instead of ageing into a note.

      **One thing seen while chasing this and not chased further:** the current kind 15128
      answered from `relay.damus.io`, `nos.lol` and `purplepag.es`, and **not** from
      `relay.nostr.band` or `relay.primal.net` (both in `SALE_RELAYS`), nor from `nostr.wine` or
      `relay.snort.social`. `check-deploy.ts` §1 queries the pool as a set and so cannot show
      this. Whether it explains the gateway's behaviour is **UNVERIFIED** — the gateway's relay
      set is not ours to see. Reporting per-relay coverage in §1 is a candidate item, not
      built here.

**Blob hosting was the real constraint, and slice 5 removed it.** Details in §9; summary here
because it changes what the project can claim.

Slice 1 probed fourteen public servers with a real HTML upload from an unknown pubkey and found
exactly **one** that stored it — `cdn.hzrd149.com`. That made the "no hosting account" claim rest
on one person's server choosing to accept anonymous uploads, which is a weaker foundation than
"no server" and a fair thing for a judge to ask about.

**Slice 5 found the cause was ours: the BUD-11 auth header encoding.** Sending standard base64
instead of the spec's base64url turns three more servers from `400` into `200`. Blobs now live
on **four** servers — `cdn.hzrd149.com`, `blossom.primal.net`, `files.sovbit.host`,
`nostr.download` — each verified to serve every blob of both deployed sites, hashing to its own
`path` tag. `blossom.band` still takes the photos and still refuses HTML, and it drops itself out
of the site's server list by failing rather than by being remembered. Full table in §9.

⇒ The claim is now "four independent servers, none of which knows who we are", which is a
materially stronger version of the same sentence.

**What the spike did verify from NIP-5A** (`nips/5A.md`), including two things spec §6.4
gets wrong or omits — see §12:

- Kinds: `15128` root site (no `d` tag), `35128` named site (`d` tag, `^[a-z0-9-]{1,13}$`,
  must not end in `-`), `5128` **manifest snapshot** (a regular event capturing a version),
  `34128` legacy/deprecated (`nips/README.md:289`).
- `path` tags are `["path","/absolute/path","<sha256>"]` (`5A.md:45-49`).
- **`x` aggregate hash** (`5A.md:51`, `67-85`): `["x","<sha256-hex>","aggregate"]`, computed
  as sha256 of sorted `"<hash> <path>\n"` lines. Recommended; makes a site version
  indexable. Spec §6.4 does not mention it.
- **`/404.html` fallback is confirmed required**: "If a host server is unable to find a site
  manifest event or a matching `path` tag for the requested path, it MUST use `/404.html` as
  a fallback path" (`5A.md:196`).
- **Blob discovery is the part spec §6.4 missed** (`5A.md:186-190`): host servers prefer
  `server` tags on the manifest, then **MUST** try the author's **BUD-03 kind `10063`**
  user-server list, and if there is neither a `10063` event nor `server` tags they **MUST
  return 404**. ⇒ the deploy flow must publish a kind `10063` (or emit `server` tags, or
  both). One extra signature; do it once, not per deploy.
- Index fallback: a path not ending in a filename falls back to `index.html` (`5A.md:180`).
- Canonical URL is a **single DNS label**: `<npub>.nsite-host.com` for root sites;
  `<pubkeyB36><dTag>` (50 chars + 1–13) for named sites (`5A.md:134-168`).

**NEEDS HUMAN — what to run**, if you'd rather do it yourself:

```bash
# nsyte is NOT on npm. Either:
#   deno install -A -f -g -n nsyte jsr:@nsyte/cli
# or grab the v0.27.2 binary and verify it:
#   shasum -a 256 nsyte-macos-arm64   # expect 03d1919a485c214ce3e528a66ec3b93a5ab47d6e743b9a3b1115b0ffa2a7741b
# deploy a dir containing index.html and 404.html, then:
curl -sI https://<npub>.<gateway>/                 # expect 200
curl -sI https://<npub>.<gateway>/definitely-missing # expect the 404.html body
nak req -k 15128 -a <pubkey> wss://relay.damus.io | jq '.tags'
nak req -k 10063 -a <pubkey> wss://relay.damus.io | jq '.tags'   # must exist, or gateways 404
```

Paste the two `nak` outputs and the curl status lines.

---

## 8. Signature prompt count for a 10-item publish — **ANSWERED 2026-08-21 from source**

**Both Amber and nsec.app honour `perms` for arbitrary kinds, and Amber's default sign policy
is the one that does. A 10-item publish costs 1 approval, or 5 if `perms` is ignored entirely.
Under the ~15 threshold on every path, so the publish flow does not need redesigning.**

Read from the signers' source rather than measured on a phone — see NEEDS HUMAN below, which is
now a confirmation rather than a discovery.

**The NIP is no help, and that was the right read.** NIP-46 defines `perms` as "a comma-separated
list of permissions the _client_ is requesting be approved by the _remote-signer_", format
`method[:params]`, "optional parameter for `sign_event` is the kind number" (`nips/46.md`). No
MUST, no SHOULD. It is a request, so the answer lives entirely in the two implementations.

**Amber** (`greenart7c3/Amber`, `master`, read 2026-08-21):

- Parses `perms` out of the `nostrconnect://` query into `Permission(type, kind)` —
  `service/NostrConnectUtils.kt:71-92`. Each defaults to `checked = true`
  (`models/Permission.kt:24`).
- `configureSignPolicy` (`service/AmberUtils.kt:196-247`) branches on the account's sign policy:
  - **0, "Approve basic actions"** — *discards the request* and installs `basicPermissions`
  - **1, "Manually approve each permission"** — writes every requested perm with
    `RememberType.ALWAYS` and `acceptUntil = Long.MAX_VALUE / 1000`, i.e. granted forever
  - **2, "I fully trust this application"** — signs everything, no per-kind rows at all
- At request time `isRemembered` (`service/IntentUtils.kt:1105-1119`) returns `true` when
  `acceptUntil > now && acceptable`, and the bunker screen auto-approves on a kind-matched row
  (`ui/components/BunkerSingleEventHomeScreen.kt:764-785`). No prompt is drawn.
- **The default account sign policy is 1** — `LocalPreferences.kt:789`,
  `getInt(PrefKeys.SIGN_POLICY.key, 1)`. The default is the mode that honours `perms`.

**nsec.app** (`nostrband/noauth`, `main`, last pushed 2025-05-26):

- Reads `perms` from the `nostrconnect://` query (`client/src/hooks/useHandleNostrConnect.ts:25-34`)
  and from the `connect` method's third param.
- The connect modal defaults to `ACTION_TYPE.REQUESTED` whenever the app asked for perms
  (`client/src/components/Modal/ModalConfirmConnect/ModalConfirmConnect.tsx:95-101`) and saves
  them with `remember: true`.
- `getDecision` (`backend/src/backend.ts:551-578`) exact-matches `sign_event:<kind>` and returns
  `ALLOW` — the request never reaches a prompt.

**Neither signer's "basic" bundle contains a single kind this project uses.** Amber's
`basicPermissions` (`models/BasicPermissions.kt:3-30`) is kinds 0, 1, 3, 4, 5, 6, 7, 9734, 9735,
10000, 10002, 10003, 10013, 22242, 27235, 30023, 30078, 31234; nsec.app's `packageToPerms(BASIC)`
(`common/src/helpers.ts:38-60`) is a shorter version of the same list. `30402`, `30405`, `15128`,
`10063` and `24242` are in neither. `30078` — slice 6's NIP-78 private shop state — is in Amber's,
which is luck rather than design.

**The count, for 10 items with 2 photos each:**

| Path | Prompts |
|---|---|
| `perms` requested and granted at connect | **1** — the connect screen itself |
| No `perms`, seller taps "remember always" on each new kind | **5** — one per distinct kind |
| No `perms`, seller never remembers | **33** — 10 + 1 + 1 + 1 + 20 |

**Slice 4 adds a term to the event count, though not to the prompt count.** An item is not one
signature, it is **1 + units**: the listing plus one pre-signed kind 30402 per reachable stock
state, so the watcher can publish availability holding no key (§7.2, `/spike/ladder.ts`). Ten
items averaging two units each is 30 kind-30402 signatures rather than 10 — all the same kind,
so a remembered `sign_event:30402` grant still covers them for **one** approval. It changes the
UI, not the budget: `/builder` shows the real count before the seller starts, because a seller
who was told "one approval" and then sees thirty is a seller who abandons a publish halfway and
leaves a listing with no ladder behind it.

The middle row is the one this section previously missed, and it is the one that actually
retires the question. Both signers key a remembered grant on `(app, type, kind)`, so the twenty
Blossom auths are all kind `24242` and cost **one** approval between them — with or without
`perms`. There is no path to 33 that does not require the seller to decline to remember
anything, thirty-three times.

**The perms string the builder should send** — corrected in slice 4, which added `21003`:

```
perms=get_public_key,nip44_encrypt,nip44_decrypt,sign_event:30402,sign_event:30405,sign_event:21003,sign_event:15128,sign_event:10063,sign_event:24242,sign_event:30078
```

`sign_event:21003` was missing from every earlier copy of this string, here and in spec §5,
because before slice 4 nothing signed a CLINK event **as the seller** — the storefront's kind
21001 requests are signed by a fresh ephemeral key per purchase, which no bunker ever sees. The
builder mints each item's offer over CLINK Manage, which is a signed kind 21003, so omitting it
costs one prompt at the first publish. Live in `/builder/src/signer.ts` as `PERMS`.

Two things that bite:

- **There is no "all kinds".** `NostrConnectUtils.kt:128` drops any `sign_event` perm carrying no
  kind. Every kind must be enumerated at connect time; a kind added later costs one prompt, then
  is remembered.
- **`30405` is easy to forget.** The sale collection is a separate kind from the listings, and
  spec §5's original example string omitted it.

One item is on our side rather than the signer's: a NIP-46 grant is keyed to the **client's**
pubkey. A builder that mints a fresh client key on every page load makes the seller re-approve
the connection every session. Persist it in `localStorage` — slice 4.

**Lever 1 is dead, and this section was stale about it.** The earlier text claimed Blossom auth
batching collapses N photo prompts to 1. §9 and §13.11 measured otherwise: batching is permitted
by BUD-11 but blossom.band misattributes every blob after the first, so we budget one auth per
photo. It does not change the answer — the twenty auths are one kind and therefore one grant —
but the old floor of "32 prompts, and the only remaining lever is `perms`" was wrong twice over.

**NEEDS HUMAN — confirmation, not discovery**

The residual risk is a UI one: Amber's policy 0 silently discards the requested perms and gives
you the no-`perms` path with no error. Worth one run to confirm the connect screen behaves as the
source says.

1. Pair any NIP-46 client with your bunker using a `nostrconnect://` URI carrying the perms
   string above.
2. Report: signer name + version, whether the connect screen pre-selected "Manually approve each
   permission", whether all requested perms were listed and pre-checked, and the prompt count
   for a 10-item publish.

**Threshold:** was "if over ~15, redesign the publish flow before building the UI." Not reached
on any path, so slice 4 builds as planned.

**Scope narrowed 2026-08-21 (slice 3): this no longer gates slice 3, only slice 4.** It was
briefly the worse question, because a watcher that signed each stock update through a bunker
would push an approval prompt to the seller's phone on every sale, during their own yard sale.
That watcher does not exist: slice 3's watcher holds no signing key at all and publishes kind
30402 events the seller pre-signed at seed time (`/spike/ladder.ts`). Signing happens at the
desk, before the sale. `perms` would in fact have covered the bunker-signing watcher — see the
answer above — but a standing `sign_event:30402` grant sitting next to an always-on process is a
worse posture than a watcher that holds no key at all, so the ladder is still the right shape.

---

## 9. Blossom auth requirements

**CORRECTED 2026-08-20 (slice 1), and this reverses the useful half of the original answer.**

Original answer: "one auth event per upload is the default, but the spec explicitly permits
batching several blobs into one signed event." The first clause is right. The second is right
about the *spec* and wrong about the *server*, and acting on it silently corrupts uploads.

**Answer: one signed kind 24242 auth per blob. Do not batch.**

**What BUD-11 says** (`blossom/buds/11.md`) — unchanged, still correct:

- Kind `24242`. MUST have human-readable `content`, a NIP-40 `expiration` tag with a future
  unix timestamp, and a `t` tag whose verb is one of `get`, `upload`, `list`, `delete`,
  `media` (`11.md:11-19`).
- Optional scoping tags (`11.md:23-27`): `server` (bare lowercase domain, absent means valid
  on *all* servers) and `x` (lowercase hex blob hashes).
- The example is annotated *"Authorization token MAY have multiple `x` tags"* (`11.md:40`),
  and validation rule 6 is *"the server MUST verify that **at least one** `x` tag matches the
  blob hash implied by the endpoint"* (`11.md:67`).
- Endpoint table (`11.md:73-83`): `PUT /upload` needs `t: upload` and a matching `x`;
  `PUT /mirror` also `t: upload`; `DELETE /<sha256>` needs `t: delete` and a matching `x`;
  `GET /list/<pubkey>` needs `t: list`.
- Transport: `Authorization: Nostr <base64url-no-padding of the event JSON>` (`11.md:50`).

**What blossom.band actually does** — measured, `/spike/probe-blossom.ts`, 2026-08-20.
Two blobs, `couch-1200.jpg` (`48fa6e07…`, 132723 bytes) and `bike-1200.jpg` (`4ab44e75…`,
86103 bytes):

```
A. ONE auth carrying BOTH x tags
   PUT /upload  couch  -> 200  {"url":".../48fa6e07….jpg","size":132723,"sha256":"48fa6e07…"}
   PUT /upload  bike   -> 200  {"url":".../48fa6e07….jpg","size":132723,"sha256":"48fa6e07…"}
                               ^^ bike's body, couch's descriptor

B. one auth per blob, each carrying only its own x
   PUT /upload  couch  -> 200  {"url":".../48fa6e07….jpg","size":132723,"sha256":"48fa6e07…"}
   PUT /upload  bike   -> 201  {"url":".../4ab44e75….jpg","size":86103, "sha256":"4ab44e75…"}
```

The server reads the **first `x` tag as the blob's identity** instead of hashing the request
body and checking it against the set. Under a batched token every upload after the first is
discarded and every listing ends up pointing at the same photo. **It returns 200.** A failure
that looks like success is worse than a rejection, and this one was found only because the
seeded storefront rendered eight items with one image.

Note the status codes are the tell: `201` = stored, `200` = "already have that hash". Under
the batched token both were 200 because the server believed both were couch.

**Update 2026-08-21: `cdn.satellite.earth` came out of the seeder's default.** It had been the
second entry in `seed-listings.ts`'s `--blossom` list since slice 1 and never once accepted a
blob — 401 for HTML, and on *images* it does not answer at all, so each of 21 uploads burned the
full 20s `AbortSignal.timeout`. That was ~7 of every seed run's 8 minutes, spent on a server that
has never stored a byte for us. The default is now `https://blossom.band` alone. This is not a
decision to stop mirroring; it is deleting a server that was never a mirror. **Blobs are now on
exactly one server**, which §9 already calls one garbage collection away from a broken
storefront, so finding a second one that accepts anonymous uploads is unchanged as the
highest-value infrastructure task.

Other servers, same date: `cdn.satellite.earth` returns `401 {"message":"Permission denied:
blossom.upload required"}` — it needs an account, so it is not a drop-in mirror.
`nostr.download` returned 502 then 400 and could not be tested. So this is **one measured
server**, not a proven universal; but it is the one that works, and the failure mode is data
loss, so the safe default is per-blob auth everywhere.

**Consequences:**

- `/docs/spec.md` §5 "Lever 1 — Blossom auth batching" is **dead**. N photos cost N signatures.
  The signature budget now rests entirely on NIP-46 `perms` (lever 2), which is still
  `UNVERIFIED` — that makes spike question 8 more important, not less.
- Mirroring may still be cheap: BUD-04 `PUT /mirror` copies from a URL (`buds/04.md:9-11`) and
  an auth with no `server` tag is valid on every server (`11.md:25`), so one per-blob token can
  still cover that blob across N servers. **Untested** — no second working server yet.
- Any client MUST compare the returned `sha256` against the hash it computed locally and treat
  a mismatch as a failed upload. `/spike/seed-listings.ts` does this now.
- Security note BUD-11 raises and we still honour (`11.md:85-91`): an unscoped token can be
  replayed against any server until it expires, worst for `delete`. Short `expiration`s on
  uploads; any delete token gets both a `server` and an `x` tag.

**ANSWERED IN SLICE 5, and the answer was our own header.** The "second working Blossom server"
this section asked a human for did not need to be found. It needed the auth token encoded
differently.

11.md:50 says the token "MUST be encoded as Base64 URL-safe without padding (Base64url, as used
by JWTs)". We complied. Measured 2026-08-21 with a real anonymous upload of an HTML file and
again with a real JPEG, from a freshly generated pubkey:

| server | base64url (what the spec says) | standard base64 | `GET /<sha256>` |
|---|---|---|---|
| `cdn.hzrd149.com` | **201** html, **201** jpeg | 201, 201 | `text/html`, `image/jpeg` |
| `blossom.primal.net` | 400 `invalid base64 for auth event` | **200**, **200** | `text/html` (via one 302) |
| `files.sovbit.host` | 400 `Invalid base64 in Authorization header` | **200**, **200** | `text/html` |
| `nostr.download` | 400 (empty body) | **201**, **201** | `text/html` |
| `blossom.band` | 200 jpeg only | 200 jpeg only | `image/jpeg` |

Standard base64 is accepted by **all five**. Base64url by exactly one. Three of the four servers
that will store an nsite's HTML for an unknown pubkey were rejecting us over a character class,
and `blossom.band` — the only server we had — never showed it, because it accepts both.

⇒ `/builder/src/blossom.ts` sends **standard base64**. It is a deliberate divergence from a MUST,
in the direction four independent implementations accept. If a server ever appears that takes
base64url and *not* standard base64, this becomes a per-server preference; none of the five is
that server today.

⇒ **Blobs now live on four servers, verified.** `node spike/check-deploy.ts <npub>` fetches every
blob from every server in the kind 10063 and checks it hashes to its own `path` tag; both sites
deployed in slice 5 report `4 complete mirror(s)`. The "one garbage collection from a broken
storefront" risk this section has carried since slice 1 is closed, and `imeta fallback`
(§13.21) finally carries something.

Two smaller things measured with it:

- **One signature covers a blob across every server.** 11.md:25 makes a token with no `server`
  tag valid everywhere, so mirroring to four servers costs no extra approvals — N blobs on M
  servers is N signatures. Slice 4's `photos.ts` signed per (blob, server) and now does not.
- **`blossom.primal.net` answers the first `GET /<sha256>` with a 302** to its own storage and
  200s thereafter. A gateway following redirects is unaffected; a client that does not follow
  them would see an empty body. `redirect: 'follow'` is the default in `fetch`.
- `cdn.satellite.earth` (401, needs an account), `blossom.f7z.io`, `blossom.nostr.hu`,
  `media.utxo.nl` (all 401), `nostrmedia.com` (403, paid), `24242.io` (400, no text types) and
  `cdn.nostrcheck.me` (timeout) still refuse anonymous uploads on either encoding.

---

## 10. Credential scoping — what may the watcher hold?

**Answer: there are three levels, not two. The watcher should hold the middle one, and the
refund cap should be enforced by the node, not by our code.**

**The levels** (`~/lightning_pub/proto/service/methods.proto` `auth_type` options;
enforcement in `~/lightning_pub/src/nostrMiddleware.ts:13-39`):

| Level | Credential | Guard | Scope |
|---|---|---|---|
| **Admin** | `admin.connect` = `nprofile:token` | `NostrAdminAuthGuard` (`nostrMiddleware.ts:19-25`) — pubkey must equal the enrolled admin npub | 21 node-wide RPCs: `GetSeed`, `OpenChannel`, `CloseChannel`, `BanUser`, `AddApp`, `BumpTx`, `LndGetInfo`, … |
| **User** | any Nostr keypair that has an account on the app | `NostrUserAuthGuard` (`nostrMiddleware.ts:13-18`) — **auto-creates an account for any pubkey**, gated by `application.allow_user_creation` (`applicationStorage.ts:85-97`) | 40 account-scoped RPCs: `GetLiveUserOperations`, `GetUserOfferInvoices`, `AddUserOffer`, `AuthorizeManage`, **and `PayInvoice`/`PayAddress`** |
| **Guest** | — | `NostrGuestWithPubAuthGuard` (`nostrMiddleware.ts:34-39`) | 8–10 unauthenticated RPCs |

**`admin.connect` is never needed for anything the watcher does.** Confirmed — none of the
watcher's operations (observe settlements, list per-offer invoices, pay a refund, delete a
sold-out offer) carry `auth_type = "Admin"`.

**But "User" is not read-only.** The same credential that reads `GetLiveUserOperations` can
call `PayInvoice`. There is no observer scope in Lightning.Pub. So a watcher holding the
seller's account key can drain the seller's Pub balance — not the node's channels, but all
of that account's sats.

**The narrowest credential that permits refunds is a CLINK Debit grant with a frequency
rule, held by a separate watcher key.** This is the important find:

- The seller authorises the watcher's pubkey once, via `AuthorizeManage`/`EditDebit`-style
  approval in ShockWallet (`debitManager.ts:147-187`). **Corrected in slice 7 — this line named
  the wrong RPC.** `AuthorizeDebit` is commented out and `EditDebit` throws `Debit does not
  exist` when there is no grant to edit; the only way to *create* one is for the account owner to
  answer a pending `LiveDebitRequest` with `RespondToDebit`. Full read and the working sequence in
  §13.27; `/spike/authorize-refunds.ts` is that sequence.
- The grant may carry a **frequency rule** — `[number, unit, max]`
  (`debitManager.ts:406-431`). On every debit the node sums that key's debit payments over
  the interval and rejects with GFY `5` plus the `max` if the cap would be exceeded.
- The check runs **inside the payment transaction** (`assertDebitFrequency`,
  `debitManager.ts:376-401`), not as an advisory pre-check, so it holds under concurrency.
- **Kill switch already exists**: `BanDebit` / `ResetDebit`
  (`debitManager.ts:108-113`) → subsequent requests get GFY `1`. One tap in the wallet.

⇒ Spec §12's requirement — "The watcher's refund path must have a hard cap and a kill
switch" — is satisfiable **by the node**, which is far better than by our own code. Build
the refund path as a kind `21002` debit from the watcher key against the seller's `ndebit`
pointer, capped by a frequency rule (e.g. 50 000 sats/day). A bug in our watcher then costs
at most one day's cap, and the seller can revoke without touching the node.

**The signing side needs no credential at all — answered in slice 3.** This section was
written about spend authority and missed the other half: republishing a kind `30402` means
signing *as the seller*, and no delegated key can do it, because a listing's authority is its
signature (§11: identity comes from the listing signature, never from the payment pointer).
The resolution is that the watcher does not sign. A yard-sale item has a finite set of future
states — stock 3 can only become 2, 1, 0 — so the seller signs all of them at publish time and
the watcher holds a bundle of already-signed events. See `/spike/ladder.ts` and spec §7.2.

**Residual, and it is unavoidable today:** the *observation* side still needs a "User"
credential on the seller's account, which implies spend authority over that account's
balance. Two mitigations, both cheap:
- Keep the observe key and the refund key **separate**. The observe key never signs a
  payment in our code.
- Prefer the loopback `callback_url` (§5, option 3) for observation, which needs **no
  credential at all** — the node calls the watcher. That is the narrowest possible answer
  and it is worth a slice-3 experiment.

**No `UNVERIFIED` here except one:** whether the frequency rule can be set to a *daily* cap
via the ShockWallet UI as opposed to the raw RPC — `UNVERIFIED`, check when pairing. (A daily cap
over the **raw RPC** is now verified and live: `IntervalType.DAY` with `number_of_intervals: 1`,
set by `/spike/authorize-refunds.ts` and read back by `GetDebitAuthorizations`. The ShockWallet UI
half is still unverified and nothing depends on it.)

**Slice 7 built all of this and measured it.** Everything above was a source read; §13.27, §13.28
and §13.29 are the wire. The three things that changed: the grant path is `RespondToDebit` and not
`EditDebit`; the `k1` cannot carry idempotency because the node's k1 set is in memory with a
5-minute TTL; and the cap and `BanDebit` were both seen firing, with the cap naming itself in the
GFY `range`. The credential split this section argues for is shipped —
`spike/.dev-key` observes, `spike/.refund-key` pays, and `watch-sales.ts` refuses to start with
`--refunds` if they are the same key.

---

## 11. Can a guest account hold its own independently-addressable CLINK offer?

**Answer: yes. One community Pub can host a market of sellers. This unblocks the "builder
others can use" scope.**

**Evidence:**

- Any Nostr pubkey that speaks to the app's guest pairing string gets an account created on
  first authenticated call — `GetOrCreateNostrAppUser` (`applicationStorage.ts:85-97`),
  gated only by `application.allow_user_creation`. Confirmed by the README: "Connecting
  with wallet will create an account on the node, it will not show or have access to the
  full LND balance" (`~/lightning_pub/README.md:250`), guest string at
  `$HOME/lightning_pub/app.nprofile` (`README.md:245`).
- Each account gets its own default offer on first read (`offerManager.ts:126-132` →
  `AddDefaultUserOffer`), and may create unlimited further offers (§3).
- Each offer encodes to its own `noffer` (`offerManager.ts:19-37`).

**The shape of the multi-tenancy, stated precisely:** every seller on a shared Pub publishes
a `noffer` whose **TLV `0` is the same node pubkey**. Sellers are distinguished only by
**TLV `2`**. Consequences we must design around:

1. **Storefront trust.** A buyer cannot tell from the `noffer` which seller they are paying
   — only which node. The binding "this listing belongs to this seller" comes from the
   signature on the kind `30402`, not from the payment pointer. The storefront must verify
   the listing's signature and show the seller's npub; the noffer proves nothing about
   identity.
2. **Correlation.** All sellers on one Pub share a service pubkey and relay, so the node
   operator sees every request. That is the same trust as any shared node; name it.
3. **Liveness is shared.** One Pub down = every seller on it down. `/docs/runbook.md` §4
   already says this for one seller; on a community Pub it is N sellers.
4. **Do not publish the default offer** — §3. On a shared Pub the default offer's id *is*
   the tenant's `app_user_id`, so publishing it exposes one tenant's account pointer to
   every visitor of the market.

**What is *not* available yet: CLINK Enroll.** The portable, spec'd way to provision an
account and receive `noffer`/`ndebit`/`nmanage` is kind `21004` (`clink-enroll.md`).
Lightning.Pub v0.0.37 **does not implement it**: `actionKinds = [21000, 21001, 21002,
21003]` (`~/lightning_pub/src/services/nostr/nostrPool.ts:51`), the relay subscription is
built from that list (`nostrPool.ts:308-316`), and `nostrMiddleware.ts:52-82` routes only
21001/21002/21003. `grep -rn 21004 src/ proto/` returns nothing. Client support exists —
`@shocknet/clink-sdk@1.7.0` ships `nenroll.js`, `nbeacon.js`, `nip13.js` and
`CLINK_ENROLL_KIND = 21004` — so this is a server gap that will likely close.

⇒ **Until 21004 lands, onboarding a seller onto a shared Pub is the ShockWallet pairing
flow, not something our builder can do over CLINK alone.** Design the builder so the
account-provisioning step is a single swappable function: paste-a-pairing-string today,
`SendNenrollRequest` tomorrow.

---

## 12. Corrections to `/docs/spec.md`

**All 13 applied to `spec.md` on 2026-08-20.** Consequential edits went further than the
table: build-plan slices 2, 3, 7, 8, the `InventoryPolicy` interface in §8, the §11 checklist,
the §12 security list, and the §14 open questions all restated claims these corrections
invalidate.

| Spec section | Was | Actually | Fixed? |
|---|---|---|---|
| §1 caveats, §7.2, §7.6 | "publicly-readable signed receipts"; receipts appear on relays; watcher and buyer's-pickup both read them | The CLINK receipt is kind `21001`, **NIP-44 encrypted to the payer**, addressed to the payer, and only a **MAY**. It carries no `preimage` in Lightning.Pub. Nobody but the buyer can read it. See §5 | ☑ |
| §7.2 | page derives availability from "listing event + settlement receipts" | Receipts are unreadable by the page. Availability = the listing event only; the watcher republishes the `30402`. See §5 | ☑ |
| §7.6 | seller verifies the receipt offline at pickup | Seller cannot decrypt it. Offline pickup proof must be designed, not inherited. See §5 | ☑ |
| §6.1 | `item_ref` fallback tag if per-item offers are unsupported | Per-item offers **are** supported (§3). Delete `item_ref` from the data model | ☑ |
| §7.4 | strict mode "requires Lightning.Pub to support gating on custom logic" | No such hook exists (§4). ~~Strict mode = delete the offer on depletion~~ — **superseded twice**: §13.17 disqualified deletion (it destroys the buyer's refund pointer) and slice 6 landed the replacement (a sold item drops its `clink_offer` tag and the offer is left alone on the node). Front the node with our own service key remains the only true strict mode | ☑ |
| §7.3 | refunds pull an invoice from "the buyer's `clink_offer` supplied in `payer_data`" | `payer_data` has **no standard keys** and no refund field (`clink-offers.md:136`). This is our own convention and only works when our page is the paying client (§6) | ☑ |
| §11 q10 | worst case is "admin only" for the refund path | Far better than feared: a CLINK Debit grant with a node-enforced frequency cap plus `BanDebit` kill switch (§10). `admin.connect` is never needed | ☑ |
| §6.4 | manifest carries `path`, optional `server`, `title`/`description` | Also `x` aggregate hash (recommended), and kind `5128` snapshots exist. **And blob discovery needs a BUD-03 kind `10063` user-server list or `server` tags, else gateways MUST 404** (`5A.md:186-190`) | ☑ |
| §5 | "Blossom uploads require a signed auth event per blob — batch or reuse where the spec allows. `SPIKE`" | Resolved: BUD-11 permits **multiple `x` tags in one kind `24242` event**, and an auth with no `server` tag works on every server, so one signature covers upload + mirroring (§9) | ☑ |
| §6.2 | private shop state on NIP-78 kind `30078` | Still fine, but kind `30078` `d` values prefixed `clink-` are **reserved** by CLINK Beacon (`clink-beacon.md:195`). Pick a `d` that is not `clink-*`. Note the running Pub publishes its beacon under the legacy `d = "Lightning.Pub"` (`nostrPool.ts:53`) | ☑ |
| §6.1 `price` | `["price","<number>","<currency>"]` | NIP-99 allows an optional 4th element `<frequency>` (`99.md:38-42`). Harmless, but our parser must tolerate it | ☑ |
| §6.5 | "Publish the `noffer` in kind 0 metadata and directly in the listing event" | Correct and confirmed — the kind 0 field name is exactly `clink_offer` (`clink-offers.md:58-67`), same name in NIP-05 (`clink-offers.md:72-83`). Add: **use a purpose-made offer, never the account's default offer** (§3) | ☑ |
| §9 stack | "`nostr-tools` … pick one, don't mix" | `@shocknet/clink-sdk` **pins `nostr-tools` to an exact version** (`1.7.0` → `2.15.1`) and npm nests it. A storefront bundling both ships two copies of nostr-tools. Measure before adopting the SDK in the storefront — see §13 | ☑ |

---

## 13. New unknowns discovered

1. **Relays replay "ephemeral" CLINK events.** `wss://relay.lightning.pub` delivered
   kind `21001` events that were 2 and 4 minutes old to a fresh subscriber **before
   EOSE** (`/spike/watch-receipts.ts`, 2026-08-20). A repeat run ~10 minutes later
   returned none of them, so the window looks like single-digit minutes — but it is the
   relay's choice, not a guarantee, and other relays may differ. Kind 21001 is in NIP-01's ephemeral range.
   Lightning.Pub's own protection is an **in-memory** event-id deduper with a 20-minute TTL
   plus a subscription `since` clamped to ≤10 minutes
   (`~/lightning_pub/src/services/nostr/nostrRelayConnection.ts:17-69`,
   `nostrPool.ts:96`) — so it survives replays while running, but **loses the set on
   restart**. Combined with the fact that CLINK Offers defines no request-freshness rule at
   all (`/docs/clink-notes.md` §7), our idempotency key must be the settled invoice /
   payment hash, never the request event id.
2. **Offers responses omit the mandatory `clink_version` tag** (§2). Our client must be
   lenient on receive and strict on send. Worth an upstream PR — like the `LND_LOG_DIR`
   fix in `/docs/runbook.md`, it is a cheap ecosystem contribution judges notice.
3. **CLINK Manage `create` payload disagrees with its own spec.** `clink-manage.md:34-47`
   shows `{"resource":"offer","action":"create","offer":{"label":…,"price_sats":…}}`, but
   both `@shocknet/clink-sdk` (`NmanageCreateOffer.offer.fields`) and Lightning.Pub
   (`managementManager.ts:240`, reading `nmanageReq.offer.fields`) require a **`fields`
   wrapper**. Follow the implementation, not the doc, and note it upstream.
4. **Lightning.Pub does not implement CLINK Enroll's "Owner policy."**
   `clink-enroll.md:168-175` says a request signed by the account-owning key MUST be
   allowed without a prior grant. `validateGrantAccess` (`managementManager.ts:254-273`)
   requires a `ManagementGrant` row for **every** requestor, owner included.

   **Scoped correctly in slice 2: this gates CLINK Manage only, and there is a path around
   it.** Offer CRUD also exists as native RPCs — `AddUserOffer`, `GetUserOffer`,
   `UpdateUserOffer`, `DeleteUserOffer`, all `auth_type = "User"`
   (`proto/service/methods.proto:625-664`) — reached over **kind 21000**, which
   `NostrUserAuthGuard` serves by *auto-creating an account for any pubkey that asks*
   (`nostrMiddleware.ts:13-18`), gated only by `application.allow_user_creation`. Verified:
   the throwaway dev key spoke to the guest `app.nprofile`, was given an account, and minted
   four offers with **no approval, no wallet, and no human**. `/spike/mint-offers.ts`.

   So the `AuthorizeManage` prompt is a cost of choosing CLINK Manage, not a cost of minting
   offers. It is still worth paying in the builder — Manage is the portable, spec'd path and
   the one a "Best Use of CLINK" judge cares about — but budget it as one prompt for a
   deliberate choice, not as an unavoidable tax. See spec §14.
5. **`blind` offers exist, are undocumented in CLINK, and on this node would be unpayable.**
   `UserOffer.blind` (entity line 42, migration `1760000000000-add_blind_to_user_offer.ts`),
   passed into invoice creation (`offerManager.ts:275`). Still in no CLINK spec. But
   `addInvoiceReq.ts:6` reads `private: blind ? false : privateHints` — **`blind` switches
   private route hints off.** Our only channel is unannounced (§1), so an invoice without
   hints cannot be routed to at all: verified empirically, no hints → unpayable, hints →
   payable. **Do not enable `blind`** unless the node has a public announced channel. The
   original "may affect receive reliability" guess was right and now has a mechanism.
6. **A `p:` offer-id prefix routes to a separate "product" system.**
   `offerManager.ts:299-307`: an `offer` string containing `:` with first segment `p` calls
   `productManager.NewProductInvoice(...)`, bypassing user offers, `payer_data` validation
   and amount checks entirely. Not in any CLINK spec. Worth 20 minutes of reading
   (`src/services/main/productManager.ts`) before we build per-item offers — it may be a
   better fit, or a footgun. `UNVERIFIED`.
7. **Minimum payable amount is 10 sats**, hardcoded (`offerManager.ts:224`, `251`), and
   `maxSendable` falls back to 10 000 000 sats when a liquidity provider is ready
   (`offerManager.ts:286-298`). Both belong in the storefront's price validation so buyers
   see a useful message instead of a bare `code 5`.
8. **NIP-99 points at an e-commerce extension we have not read**: the GammaMarkets
   market-spec (`99.md:11`). Before inventing a `quantity` tag or a `t`-tag shop grouping
   (spec §6.3, §14), check whether it already standardises both. `UNVERIFIED`.
9. **`nostr-tools` v2.24.3 changed `pool.subscribeMany(relays, filter, params)` to take a
   single filter object, not an array.** Passing an array makes strfry reply
   `bad req: provided filter is not an object` and the subscription silently never fires —
   cost 20 minutes during this spike. `@shocknet/clink-sdk` still passes an array
   (`build/sender.js`) and is only safe because it pins `nostr-tools@2.15.1` and npm nests
   it. Pin deliberately in the storefront.

10. **`nostr-tools` `verifyEvent()` returns a cached verdict and does not recheck.** It stores
    its answer on the event object under an exported symbol and short-circuits on it
    (`nostr-tools/lib/esm/index.js:211-212`); `finalizeEvent` sets it to `true` (line 207).
    Object spread copies own symbol properties, so `verifyEvent({...signedEvent, content:
    'anything'})` returns **true**. Found by a slice-1 test that expected a forged event to be
    rejected and got the opposite. Events off a relay arrive through `JSON.parse` and never
    carry the symbol, so a read path like the storefront's is not exposed — but anything that
    builds an event by spreading another one and then re-verifies is, and slice 3's watcher
    republishes `30402`s by doing exactly that kind of copy. `storefront/src/listing.ts`
    deletes the symbol before every check. Do the same anywhere else we verify.

11. **A public Blossom server accepted a batched BUD-11 auth and silently misattributed every
    blob after the first** — see the corrected §9. The generalisable lesson is not about
    Blossom: a 200 is not evidence the server did what we asked. Compare the returned
    content-address against the one we computed. This is the same shape of mistake as §1's
    "a successful invoice request is not proof the node can receive."

12. **No standard tag carries a sale's date or opening hours.** Not in NIP-99, not in the
    GammaMarkets market-spec, not in kind 30405. `/docs/design.md` §1 makes them part of the
    masthead, and slice 1 renders them out of the collection's freeform `summary`. Decide
    before slice 6 whether that stays freeform or earns a tag.

13. **The kind 21000 RPC envelope is neither NIP-04 nor NIP-44.** Documented because slice 3's
    watcher needs it for `GetLiveUserOperations` and slice 6's admin panel for everything else.
    It is xchacha20 keyed on `sha256` of the ECDH x-coordinate, payload
    `base64(0x01 ‖ nonce[24] ‖ ciphertext)` — `~/lightning_pub/src/services/nostr/nip44v1.ts`,
    used at `nostrPool.ts:111,177`. The request body is
    `{rpcName, authIdentifier, requestId, body}` and `nostrMiddleware.ts:92` drops it unless
    `authIdentifier` equals the event pubkey. Responses come back on kind 21000 `p`-tagged to
    the caller, correlated by `requestId`, and are **split into shards** above
    `maxEventContentLength` (`nostrPool.ts:44-58`) — our offer payloads are far below it, but a
    settlement feed may not be. ~90 lines in `/spike/mint-offers.ts`; lift them when the
    watcher needs them, do not re-derive them.

14. **`@shocknet/clink-sdk` in a browser bundle costs a second `nostr-tools`.** Measured in
    slice 2, and it settles spec §9: hand-rolled 83.2 KB raw / 30.9 KB gzip, SDK 169.0 / 59.0.
    Importing *anything* from the package root drags in `sender.js` and therefore its nested
    exact-pinned `nostr-tools@2.15.1`. A deep import of only `build/nip19Extension.js` avoids
    that (85.6 / 30.9) but reaches past the package entry point and still costs more than ours.
    Its `decodeBech32` also *requires* TLV `3`, which `clink-offers.md:29` makes optional, and
    ignores TLV `5` entirely. Fine for the builder; wrong for the storefront.

15. **An npub URL is not human-transcribable, which the printed flyer exposes.** The tear-off
    tabs in `/docs/design.md` §3 carry `npub1lvvw…q0lalws.nsite.lol` — 63 characters that wrap
    to four unreadable lines on a 22mm tab. The QR works; the text under it is decoration. A
    torn-off tab whose QR will not scan is a dead end. Options are a NIP-05 name, a short
    custom domain, or accepting QR-only — but a custom domain is the infrastructure this
    project claims to remove, so this is a tension to name on stage rather than paper over.
    Decide by slice 9.

16. **`GetLiveUserOperations` cannot attribute a payment to an item, so spec §7.2's ranking was
    backwards.** `UserOperation` (`~/lightning_pub/proto/service/structs.proto:634-646`) carries
    `paidAtUnix`, `type`, `inbound`, `amount`, `identifier`, `operationId`, `service_fee`,
    `network_fee`, `confirmed`, `tx_hash`, `internal` — and **no `offer_id`**. For a settled
    invoice `identifier` is the bolt11 (`paymentSideEffects.ts:36`), which is a fine idempotency
    key and tells you nothing about which item sold. Anything wanting per-item availability has
    to call `GetUserOfferInvoices` regardless, so the live feed is at best a latency nudge in
    front of the call that does the real work. It is also push-once: `sendOperationToNostr`
    fires at settlement (`paymentSideEffects.ts:101-112`) and a watcher that was asleep never
    learns, whereas `GetUserOfferInvoices` returns the whole settled set on every call and is
    therefore restart-safe with no persisted state of our own. Slice 3's watcher polls.

    Two smaller details worth having: the live push arrives on the kind 21000 RPC channel with
    the **fixed** `requestId: "GetLiveUserOperations"` (`paymentSideEffects.ts:107`), so an RPC
    client that routes on `requestId` simply drops it — which is what `/spike/pub-rpc.ts` does.
    And `GetUserOfferInvoices` takes `{ offer_id, include_unpaid }` (`structs.proto:893-896`);
    with `include_unpaid: false` the storage query filters on `paid_at_unix > 0`
    (`paymentStorage.ts:527-533`), so the response is exactly the settled set for one item.

17. **Deleting a depleted offer destroys the buyer's refund pointer. Spec §7.4(a) is more
    expensive than it looks.** §7.4(a) makes "the watcher deletes the item's offer on depletion"
    v1's strict mode. `DeleteUserOffer` drops only the `UserOffer` row
    (`offerStorage.ts:27-29`); the settled `UserReceivingInvoice` rows survive with their
    `offer_id` and their stored `payer_data`. The damage is to who can still read them:

    - `GetUserOfferInvoices` looks the offer up first and throws `"Offer not found"` when it is
      gone (`offerManager.ts:89-93`). The watcher goes blind on that item at exactly the moment
      the late settlement it cares about would arrive.
    - That RPC is the **only** way the stored `payer_data` leaves the node. `grep`ing every
      reader leaves one other: the offer's own settlement `callback_url`
      (`paymentSideEffects.ts:27`), which our offers set to `''`.

    So deleting the offer permanently destroys the refund pointer for every invoice under it.
    An oversell *is* a payment that settles after depletion, and slice 7 exists to refund it —
    shipping a sellout that throws the pointer away would break the slice that sends the money
    back. **Slice 3's watcher does not delete offers.** Strict mode needs a mechanism that does
    not take the invoice history with it; the untested candidate is `UpdateUserOffer` to a
    price outside the payable range, which leaves the row (and the history) in place. Or set a
    loopback `callback_url` at mint time so the pointer is delivered at settlement and never
    has to be read back. Decide before slice 7.

18. **A NIP-46 bunker cannot drive Lightning.Pub's kind 21000 RPC, which forces spec §14's
    "Manage or native?" question.** `nostrPool.ts:110-113` branches on kind:
    `if (e.kind === 21000) content = decryptV1(..., getConversationKeyV1(app.privateKey, e.pubkey))`
    — the custom `nip44v1` envelope of §13.13, keyed on `sha256` of the raw ECDH x-coordinate —
    `else` standard NIP-44 v2. NIP-46 exposes `sign_event`, `nip04_*`, `nip44_*`, `get_public_key`
    and `ping`; it never exposes raw ECDH or a private key, so a browser holding only a bunker
    connection **cannot construct a kind 21000 request at all**. `/spike/mint-offers.ts` and
    `/spike/pub-rpc.ts` only work because the spike holds a raw key in `/spike/.dev-key`.

    CLINK's own kinds are unaffected: `21001`–`21004` all carry NIP-44 encrypted content
    (`/docs/clink-notes.md` §1, quoting `clink-offers.md:103-108`, `clink-debits.md:105-110`,
    `clink-manage.md:20-25`, `clink-enroll.md:44-53`), which is exactly what a bunker does expose.

    ⇒ **Slice 4 must mint offers over CLINK Manage (kind 21003), not the native RPC.** It is not
    a preference between a portable path and a convenient one, as spec §14 framed it — the
    convenient one is unreachable the moment the seller's key lives in a signer instead of a file,
    and rule 2 says it always will. Expect the `fields` wrapper disagreement (§13.3). The
    alternative — a browser-generated key with its own account on the seller's node — is worse
    than it looks: the offers, and therefore the money, would belong to *that* account rather
    than the seller's.

    **Slice 4 built it and this is now measured rather than read** (2026-08-21). The exact send
    side, which the entry above did not cover, is the mirror of the receive branch:
    `handleSendDataContent -> encryptV1` for kind 21000, `handleSendDataEvent -> encryptV2` for
    everything else (`nostrPool.ts:176-190`). `/spike/check-manage.ts` drives
    `/builder/src/manage.ts` — the shipped module, through a `Signer` — against the live node
    and gets a real offer back: correct `price_sats` in TLV 4, `refund_pointer` recorded
    required, not the account default offer, and a listing the storefront's own parser would
    draw a Buy button on. Two corrections to this entry fall out of that build, in §13.19 and
    §13.20: the `AuthorizeManage` prompt it tells you to budget for is **zero**, and Manage and
    the native RPC do not see the same set of offers.

19. **`AuthorizeManage` is `auth_type = "User"`, so the grant costs zero human prompts on this
    node.** `methods.proto:678-683`, `option (nostr) = true`. The account's own key issues its
    own grant; nothing is pushed to a wallet and nobody approves anything. Spec §14 and §11 q11
    both assumed one `AuthorizeManage` prompt — that is the *other* path, `handleAuthRequired`
    (`managementManager.ts:71-89`), which fires only when an **ungranted** requestor sends a
    21003 and pushes a `GetLiveManageRequests` message to `appUser.nostr_public_key` for
    ShockWallet to display. Granting yourself first skips it entirely.

    Two details that cost time:

    - **`authorize_npub` is a misnomer.** It is stored as `app_pubkey`
      (`managementStorage.ts:15`) and matched against `event.pub`
      (`managementManager.ts:254`), i.e. a **64-char hex** pubkey. An `npub1…` creates a grant
      that can never match.
    - **`addGrant` is `CreateAndSave`, not an upsert** (`managementStorage.ts:15`), so running
      the bootstrap twice leaves two rows. `getGrant` is a `FindOne` so it still works, but
      check `GetManageAuthorizations` first. `ResetManage` removes one.

20. **The two offer transports partition the offer set, asymmetrically.** `createOffer` over
    Manage stamps `management_pubkey: requestorPub` (`managementManager.ts:249`);
    `validateOfferAccess` refuses `get`/`update`/`delete` unless it matches (`:280`) and `list`
    queries `getManagedUserOffers(app_user_id, management_pubkey)` (`offerStorage.ts:43-45`).
    Native `AddUserOffer` never sets the column and it defaults to `''` (migration
    `1752425992291-invoice_callback_urls.ts`).

    So:

    | | sees native offers | sees Manage offers |
    |---|---|---|
    | native `GetUserOffers` (kind 21000) | yes | **yes** |
    | CLINK Manage `list` (kind 21003) | **no** | only its own requestor's |

    **Measured 2026-08-21**: after `check-manage.ts` minted one offer over Manage,
    `mint-offers.ts --dry` reported "7 offer(s) on the account, 6 purpose-made" — up one from
    the fixture's five plus the default. The native RPC sees everything.

    Consequence for the fixture: the five offers `/spike/mint-offers.ts` minted are **not**
    editable over Manage. Nothing breaks — they are already minted, already tagged onto the
    listings, and already paid against — but an edit flow that goes through Manage cannot touch
    them. They get re-minted through Manage if and when they are ever edited.

21. **NIP-92 `imeta` is the image-placeholder tag slice 1 deferred, and NIP-94 is where its
    field names actually live.** `nips/92.md`: `imeta` is variadic space-delimited key/value
    pairs, MUST carry `url` plus at least one other field, and "MAY include any field specified
    by NIP 94". `nips/94.md` is the list: `url`, `m`, `x`, `ox`, `size`, `dim`, `magnet`, `i`,
    **`blurhash`**, `thumb`, `image`, `summary`, `alt`, `fallback`, `service`. Neither NIP-99
    nor the GammaMarkets market-spec carries any of them, which confirms slice 1's read.

    Slice 4 writes `imeta` with `url`, `m`, `x`, `dim`, `alt` and one `fallback` per extra
    Blossom server — and **deliberately not `blurhash`**, which would need an encoder in the
    builder and a decoder inside the storefront's gzip budget (spec §9) to replace a flat tone
    that already works. The field name is now pinned with a citation, so shipping one later is
    an hour rather than a research task.

    One caveat to carry: 92.md says each `imeta` SHOULD match a URL in the event's **content**,
    and ours match `image` tags instead. A generic NIP-92 client will not look for them. The
    fields are for our own storefront to read; the alternative was inventing a tag, which
    spec §14 exists to prevent.

22. **A kind 15128 root site is ONE PER PUBKEY, so the builder cannot be deployed under the
    seller's key.** `5A.md:16`: "Uses kind `15128` and MUST NOT include a `d` tag. This is a
    single replaceable event per pubkey and serves as the root site for the pubkey." NIP-01
    keeps the newest replaceable event per (kind, pubkey), so deploying a second site under the
    same key silently *replaces* the first — no error, no warning, and the old site's blobs are
    still on Blossom but unreachable because nothing maps a path to them.

    This bites the moment /CLAUDE.md rule 5 is honoured: the builder is an nsite too, and it is
    not the seller's site. Slice 5 gives it its own identity (`spike/.builder-key`) and the
    storefront keeps the seller's. Named sites (kind `35128`, a `d` tag matching
    `^[a-z0-9-]{1,13}$`, `5A.md:20-28`) are the mechanism for putting two sites under one
    pubkey if that is ever wanted; spec §6.4 rules them out for v1 and nothing needs them yet.

23. **The BUD-11 `Authorization` header must be standard base64, not the base64url the spec
    requires.** See §9 — three of the four Blossom servers that will store an nsite's HTML
    reject base64url outright, and this was the entire reason "find a second Blossom server" sat
    open as the highest-value infrastructure task from slice 1 to slice 5. The generalisable
    lesson is the inverse of §13.11's: there, a server returned 200 for something it had not
    done; here, servers returned 400 for something we had done correctly. Neither a success nor
    a failure code is evidence on its own — the only evidence is the content address coming
    back, or the blob coming back out.

24. **The gateway serves a 404 status with the `/404.html` body**, which is obvious in hindsight
    and turns a naive `res.ok` check into a false failure. 5A.md:196 makes `/404.html` the
    fallback for any unmatched path; the host serves it as the response to a request that did
    not match, so the status is 404. `check-deploy.ts` hashes that body anyway and compares it
    against the `/404.html` path tag. Cost ten minutes on the day.

25. **CLINK has no settlement path, so a browser holding no key cannot see the seller's sales.
    This deletes a bullet from slice 6 rather than deferring one.** Read from source on
    2026-08-21 and measured the same day.

    Three facts, each citable, and together they close the question:

    - **CLINK Manage's only resource is `"offer"`** (`clink-manage.md:29`), with actions
      `create`, `update`, `get`, `list`, `delete` (`clink-manage.md:33-92`). The running node
      agrees exactly: `managementManager.ts:115-134` switches on those five and answers
      `{"res":"GFY","code":1,"error":"Request Denied: Unknown action: …"}` to anything else.
      There is no invoice resource, no settlement resource, no payment-history resource — not in
      Manage, and not in Offers, Debits, Enroll or Beacon either (`/docs/clink-notes.md` §1-§6).
    - **Settled sales live behind `GetUserOfferInvoices`**, which returns `OfferInvoice { invoice,
      offer_id, paid_at_unix, amount, data }` (`structs.proto:902-908`) — `data` being the stored
      `payer_data`, i.e. the buyer's refund pointer.
    - **That call is reachable only over kind 21000.** `nostrMiddleware.ts:52-80` dispatches
      21001 to `handleClinkOffer`, 21002 to `handleNip68Debit` and 21003 to
      `managementManager.handleRequest`, each with an early `return`; only an event that is none
      of those falls through to `nostrTransport`, which is the RPC dispatcher every server method
      including this one hangs off. And kind 21000 is decrypted with `decryptV1` /
      `getConversationKeyV1` — the raw ECDH x-coordinate envelope of §13.18 — which NIP-46 does
      not expose.

    ⇒ **A browser behind a Signer cannot read the seller's sales, and no amount of building
    changes it.** The workaround is disqualified before it is written: giving the page a raw node
    key breaks `/CLAUDE.md` rules 2 and 3 at once, and it is not even a read-only credential —
    Lightning.Pub has no observer scope, so the same key that lists operations can call
    `PayInvoice` (§10).

    **What slice 6 shipped instead, and it is two answers rather than a compromise:**

    - The panel derives **units sold from the relays**, with no credential at all: the watcher
      already republishes each item's stock as money arrives, so `units − stock` is how many have
      gone (`builder/src/admin.ts` `soldCount`). It is strictly less than the node knows — no
      amounts, no timestamps, no payer data — and it is the number a seller wants mid-sale.
      Unknown for an item this browser never published, because nothing on a relay records what
      the stock started at.
    - **`/spike/sales-report.ts`** gives the full version where the key already is: amount,
      timestamp and refund-pointer presence per settled invoice, per offer. It prints presence
      and never the pointer itself — a `refund_pointer` is an ndebit addressed to the buyer's
      wallet, and `/CLAUDE.md` says not to log payloads carrying one.

    This constrains slice 7's UI too: an automatic refund cannot be *reviewed* in the browser
    before it is sent, because the browser cannot see the invoice it would be refunding. Slice 7
    is a process next to the node or it is nothing.

26. **A relay answers OK to a replaceable event it does not store, so a stale ladder fails
    silently and cheerfully.** Slice 6's edit flow made this reachable and it is the sharpest
    edge in the slice.

    Rungs carry `created_at` later than the listing they were cut from — that is what makes
    availability monotone (§7.2, `spike/ladder.ts`). An **edit** publishes a listing later than
    every rung of the *old* ladder, inverting it. NIP-01 then keeps the newer edit and drops the
    rung. The failure is not that the publish errors: a relay that already holds a newer
    replaceable event still returns `["OK", <id>, true, ""]` and simply stores nothing. So
    `watch-sales.ts` counts a success, logs `3/4 relays`, and the item stays advertised as
    available for the rest of the sale. **An oversell with a clean log beside it.**

    Note this is the *opposite* of the failure the slice-6 brief predicted. The brief expected a
    stale rung to republish old text over new; that needs the edit to land within `units` seconds
    of the original publish, which is a 1–3 second window for a yard-sale item. The reachable
    failure is the silent no-op, and it lasts until somebody notices.

    Fixed in `spike/ladder.ts` `isStale`, checked once at watcher startup against the live
    listings, tested in `ladder.test.ts`, and reported by `spike/check-admin.ts` section 4. Equal
    timestamps are not stale — a sold-out item's live listing *is* its own last rung — and an
    item with no live listing is not judged at all, because "the relay is down" and "your ladder
    is stale" have opposite remedies.

27. **`AuthorizeDebit` is commented out AND `EditDebit` cannot create a grant, so the only way to
    authorise a debit is to answer a request the node is already holding.** Read from source and
    then driven end to end on 2026-08-21, against the running Lightning.Pub 0.0.37.

    The slice-7 brief said "`AuthorizeDebit` is commented out. `EditDebit` is the grant path."
    The first sentence is right; the second is not, and building on it fails with
    `Debit does not exist`.

    - `AuthorizeDebit` — the whole rpc sits inside a `/* … */` block
      (`proto/service/methods.proto:690-694`). Unreachable.
    - `EditDebit` is live and is `auth_type = "User"`, `nostr = true`
      (`methods.proto:696-701`), taking `DebitAuthorizationRequest { authorize_npub, repeated
      DebitRule rules, optional request_id }` (`structs.proto:755-759`) exactly as the brief
      describes. But its first statement is
      `const access = await GetDebitAccess(...); if (!access) throw new Error("Debit does not
      exist")`, and its only other statement is `UpdateDebitAccessRules`
      (`debitManager.ts:99-105`). **It edits the rules on a grant that already exists.**
    - `AddDebitAccess` is the only function that inserts a `DebitAccess` row, and it has exactly
      two callers in the whole node: `debitStorage.ts:45`, which creates a row with
      `authorize: false` on the way to a ban, and `debitManager.ts:153` inside
      `handleAuthorization`.
    - `handleAuthorization` is reached only from `RespondToDebit`
      (`methods.proto:714-719`, `auth_type = "User"`, `nostr = true`), which answers a **pending**
      request. A request only becomes pending when a debit arrives from a pubkey with no grant:
      `doNdebit` returns `{status:'authRequired'}` and `handleAuthRequired` pushes a
      `LiveDebitRequest` to the account's own key (`debitManager.ts:216-221`).

    ⇒ **Granting is a three-step dance and there is no shorter route**, which is what
    `/spike/authorize-refunds.ts` is:

    1. the key being granted sends a kind 21002 **budget** request (`{pointer, amount_sats,
       frequency}`, no `bolt11`). `doNdebit` branches on `frequency` before it looks at any
       invoice (`debitManager.ts:277-301`), so **nothing is paid**.
    2. the node pushes a `LiveDebitRequest` to the account owner's key over **kind 21000**, with
       the fixed `requestId: "GetLiveDebitRequests"` — the same channel and the same fixed-id
       shape as `GetLiveUserOperations` (§13.16). It is `encryptV1`, tagged `['p', owner]`
       (`nostrPool.ts:175-183`). `/spike/pub-rpc.ts` gained an `onPush` hook to catch it.
    3. the owner answers `RespondToDebit` with `AUTHORIZE` **and its own rules**. The node stores
       `debit.rules` off the response verbatim (`debitManager.ts:153-157`), so the requestor
       proposes and the owner disposes.

    Two shapes that cost a round trip each and are not obvious from the proto text:

    - **`DebitRule` nests its oneof under a `rule` key.** The message's only field is the oneof,
      so the generated shape is `{ rule: { type: 'frequency_rule', frequency_rule: {…} } }`, not
      `{ type, frequency_rule }` (`proto/autogenerated/ts/types.ts:1700-1702`, validator at
      `:1708-1717`; the node's reader agrees at `debitTypes.ts:40-41`). Sending it flat returns
      `invalid request body` with no field named. It comes back in the same nested shape from
      `GetDebitAuthorizations` (`debitTypes.ts:58-83`).
    - **`authorize_npub` is HEX, exactly as on the Manage side** (§13.19). The row stores `npub`
      and matches it against `event.pub` (`debitStorage.ts:27-29`, fed from `debitManager.ts:250`).
      Verified for Debits rather than inherited: `check-refund.ts` asserts the grant the node
      reports back is 64 hex characters.

    Confirmed working: `node spike/authorize-refunds.ts` produced `debit_id 1 AUTHORIZED` with
    both a frequency rule and an expiration rule on the first run after the shape was corrected.

28. **CLINK's `k1` cannot carry refund idempotency, because Lightning.Pub's k1 set is in memory
    with a 5-minute TTL — and it is consumed by requests the node then refuses.** The slice-7
    brief marked this `UNVERIFIED` and asked for it to be read from source rather than inferred.
    It was, and the candidate collapses. Two separate divergences, both measured on the wire by
    `spike/check-refund.ts` on 2026-08-21.

    **(a) It does not survive a restart, and the window is 5 minutes, not 20.** `K1Debouncer` is
    a plain array on a class instance, `K1_MAX_AGE = 1000 * 60 * 5`, swept once a minute
    (`debitManager.ts:19-37`). The source comment in `doNdebit` says it outright: *"k1 will
    persist in memory for up to 5 minutes before getting cleared"* (`debitManager.ts:256-257`).
    Note this is a **different** deduper from the event-id one in §13.1, which is 20 minutes —
    they are easy to conflate and neither is persisted.

    ⇒ The proposed design — derive `k1` from the settled invoice so a double refund is refused by
    the node — is a real second layer against a crash loop and is **not** an answer to
    "the watcher restarted an hour later". `/spike/refund.ts` keeps the derived `k1` and adds a
    journal keyed on the settled invoice, written before the payment, for the durable half.

    **(b) A `k1` is consumed before any validation, contradicting the spec.**
    `clink-debits.md:167-171` (quoted at `/docs/clink-notes.md` §3.3) says a `k1` is consumed when
    the service *accepts* a request for approval or payout, and that structural and payload
    validation failures **MUST NOT** consume it — "the requestor MAY retry the same `k1`".
    `doNdebit` calls `DedupeK1` immediately after the pointer check, before it decodes the
    invoice, looks up the grant, or checks any rule (`debitManager.ts:258-262`). Measured:

    ```
    first:  {"ok":false,"code":1,"error":"Request Denied Warning"}
    second: {"ok":false,"code":1,"error":"K1 already processed"}
    ```

    The first request was refused outright (the grant was banned) and still burned the `k1`.

    ⇒ **Practical consequence, and it shaped the watcher.** Our `k1` is derived from the settled
    invoice and is therefore identical on a retry, so a refund that fails cannot be retried for up
    to 5 minutes — the retry answers "K1 already processed" and attempts nothing.
    `watch-sales.ts` waits `RETRY_AFTER_S = 6 minutes` before retrying a `failed` row for exactly
    this reason.

    **(c) A duplicate `k1` answers GFY code `1`, not `6`.** `clink-debits.md:279` gives code `6`
    ("K1 already processed") as the example. Lightning.Pub returns that *message* with
    `code: 1` (`k1AlreadyProcessedReason` at `debitTypes.ts:98`, returned at
    `debitManager.ts:261`). **Match on the message, not the code.** Third cheap upstream PR,
    next to the `clink_version`-on-response one (§13.2) and the missing-preimage one (§5).

29. **The debit frequency cap is real, is enforced inside the payment transaction, and names
    itself in the refusal.** Not a source read — driven at the running node by
    `spike/check-refund.ts` on 2026-08-21, and it is the evidence `/CLAUDE.md`'s "the refund path
    needs a hard cap and a kill switch" asks for.

    With the grant's cap moved to 1 sat and a 10-sat debit sent from the refund key:

    ```
    {"ok":false,"code":5,"error":"Invalid Amount","range":{"min":1,"max":1}}
    ```

    Three things worth having:

    - **The GFY names the cap.** `ndebitFailure(5, { max })` fills in `range: { min: 1, max: cap }`
      (`debitTypes.ts:104-114`), so a client can report the number it hit rather than a message.
      This matches `/docs/clink-notes.md` §3.5, where code `5` carries `range` — the Debits
      envelope, `{"res":"GFY",…}`, and **not** the Offers one.
    - **The check is in-transaction.** `assertDebitFrequency` is passed into
      `PayAppUserInvoice` and runs inside the payment transaction against a `txId`
      (`debitManager.ts:376-401`), summing this key's prior debit payments over the interval
      (`checkFrequencyCap`, `:404-425`). It is not an advisory pre-check, so it holds under
      concurrency, and a refusal is a rollback rather than a payment that was talked out of
      happening — the probe invoice was still unsettled afterwards.
    - **`BanDebit` stops a payment already within the cap.** The same in-transaction function
      throws `DebitUnauthorizedError` on a ban row whether or not the grant was ever authorised
      (`debitManager.ts:381-390`), measured as `{"ok":false,"code":1,"error":"Request Denied
      Warning"}` on a debit that the restored 8,000-sat cap would otherwise have allowed.

    **A cap set to the balance cannot fire.** The live grant is 8,000 sats/day and the node's
    outbound is 8,000 sats, so the balance runs out before the rule does. That is still a real
    bound on a bug — one day's worth of what the node can send — but it is not the property a cap
    is bought for, and it is why `check-refund.ts` proves the mechanism by moving the cap down to
    1 sat rather than by spending the balance. Say the distinction out loud rather than claiming
    a cap that has never been crossed.

    **An expiry rule deletes the grant rather than suspending it.** `validateAccessRules` calls
    `RemoveDebitAccess` and returns GFY `3` the first time a debit arrives after
    `expires_at_unix` (`debitManager.ts:443-449`). It fails closed, which is right, but re-arming
    is the whole three-step dance of §13.27 again — do not let it lapse mid-demo.

30. **BOLT12 does not exist anywhere in this stack, so spec §10's slice-8 line was unbuildable as
    written.** Verified 2026-08-21, before anything was built on it, because "the seller's node
    could expose one someday" is a sentence in the non-goals rather than a feature.

    ```
    $ grep -rni bolt12 ~/lightning_pub/src ~/lightning_pub/proto
    (no output, exit 0)
    $ grep -rni 'lno1' ~/lightning_pub/src
    (no output)
    $ lncli version | head -3
    { "lncli": { "commit": "v0.21.2-beta",
    $ lncli help | grep -ci offer
    0
    ```

    Three separate absences, and the third was a surprise:

    - **Lightning.Pub has no BOLT12 anything.** Not a string, not a proto field, not an RPC. Its
      only invoice-creation paths produce BOLT11 (`AddInvoice`, and `AddAppUserInvoice` behind
      the CLINK Offers flow), and every decode path is `DecodeInvoice`, which is `decodepayreq`,
      which is BOLT11.
    - **`lncli` on this build exposes no offer command either.** LND v0.21.2-beta carries
      experimental BOLT12 support behind a build tag, and this binary was not built with it —
      `lncli help` matches the word "offer" zero times. The slice brief's gotcha list said
      "`lncli` has it; Lightning.Pub does not"; on this machine neither does, and the correction
      matters because it removes the last "we could shell out to it" escape hatch.
    - **CLINK's "Offer" is not BOLT12's "offer"**, despite the shared word, and conflating them
      is the trap this finding exists to close. A CLINK `noffer` is a bech32 TLV pointer to a
      *nostr* service that will issue a BOLT11 on request (`/docs/clink-notes.md` §2.1); a BOLT12
      `lno1` is a self-contained onion-routed offer with no nostr in it at all. They solve the
      same problem by different means and share no code, no encoding and no wire format.

    ⇒ **Spec §10's "BOLT11/BOLT12" was corrected rather than attempted.** BOLT11 is what this
    project already produces on every buy, so the fallback slice was never about a payment format
    — see §7.3 and §10 for what it turned out to be about.

31. **A geohash map of nearby sales cannot be built without a third-party hostname on every page
    load, so spec §10's slice-9 line was cut rather than attempted — and what replaced it is one
    `geo:` link.** Verified 2026-08-21, before anything was built on it, which is the same
    discipline §30 applied to BOLT12 one slice earlier and for the same reason: §10's one-line
    slice descriptions are a plan written before the answers were known.

    Three obstacles, each disqualifying on its own.

    **(a) A map needs a basemap, and a basemap is somebody's server.** OSM tiles, Mapbox, Carto,
    Protomaps — every one of them is HTTP to a host we do not control, fetched by every visitor.
    That is not literally /CLAUDE.md rule 1, which forbids a server *of ours*; it is worse in the
    place this project is judged. Measured on the tree as it stands:

    ```
    $ grep -rn 'subscribeMany\|querySync\|fetch(' storefront/src/*.ts | grep -v test
    storefront/src/buy.ts:236     pool.subscribeMany(... authors: [offer.pubkey] ...)
    storefront/src/nostr.ts:37    pool.subscribeMany(... authors: [pubkey] ...)
    ```

    Two relay subscriptions and **no HTTP fetch at all** — the photos are `<img>` elements the
    browser resolves. The only third-party server anywhere in the project is the LNURL host in
    `spike/refund.ts`, which the *seller's machine* contacts and the buyer's page never does. Spec
    §7.3 already has the line for this: *a Lightning address is a hostname, and a hostname is a
    server.* A map puts a hostname on the storefront, permanently, for everyone.

    **(b) "Nearby" means reading events from strangers, and this page has never done that.**
    Every filter above is `authors: [<one known pubkey>]`, and `listing.ts` `trusted()` re-checks
    `ev.pubkey === pubkey` before verifying the signature. Discovery means rendering kind 30405s
    from arbitrary authors, which does not extend the trust boundary — it moves it. /CLAUDE.md's
    "treat every inbound event as hostile" is a much harder promise to keep when the author is
    not known in advance and the payload is a location a stranger chose.

    **(c) The query is not expressible with what we publish, and the convention that would make
    it expressible is in a geocaching NIP.** This is the part that was `UNVERIFIED` in the slice
    brief and is now cited. Re-fetched from `nostr-protocol/nips@656cecc`:

    - **Tag filters match exact values.** `01.md:33` — "In the case of tag attributes such as
      `#e`, for which an event may have multiple values, the event and filter condition values
      must have at least one item in common." There is no prefix match, so `#g: ["9ewm"]` does
      not find `9ewmxg9`.
    - **NIP-99 says nothing about precision.** `99.md:53` lists `"g"` under *"Other common tags
      that might be useful"* — one line, no proximity semantics. NIP-52, which is where `g` is
      actually introduced (`52.md:24`), says only "geohash to associate calendar event with a
      searchable physical location".
    - **The multi-precision convention IS specified — in NIP-CC, Geocaching.** `CC.md:53`:
      "`g` (required) - geohash of cache location. **To allow for a proximity search, include
      multiple geohash tags at different precision levels (3-9 characters)**", and `CC.md:246`
      repeats it for collections at 3-6. NIP-CC is `draft` `optional`, kind 37516, and is about
      hiding tupperware in woods.

    ⇒ So proximity search is a real convention with a real citation, and adopting it would mean a
    classifieds event borrowing a geocaching NIP's tag discipline. **We emit exactly one `g` tag**
    — `spike/seed-listings.ts:220`, `:280` and `builder/src/listing.ts` — so nothing we publish is
    findable by proximity today regardless.

    **(d) And the byte budget has 0.4 KB of headroom.** Spec §9 raised the storefront to 32 KB
    gzip in slice 8 and measured 31.61. A slippy-map library is one to two orders of magnitude
    over that on its own, before tiles.

    ⇒ **Cut, and §10's line is rewritten rather than deferred.** What shipped instead is
    `storefront/src/render.ts` `geoUri`: the sale's own `g`, decoded in the page, rendered as an
    RFC 5870 `geo:` link around the neighbourhood on the masthead. The operating system resolves
    it, so the buyer's own map app opens on the driveway, **no tile is fetched from anybody**, and
    the page never learns that it happened. It needs no basemap, no library, no cross-author query
    and no second `g` tag. It is not "a map of nearby sales" — it is "where this sale is", which
    is a different and much better-scoped feature that §6.1's tag already supported.

    **It also immediately found a bug that eight slices of not-reading the tag had hidden.** The
    fixture's `g` was `9ewmr4z` from slice 1. Decoded: **20.6261, -103.3930 — Guadalajara, but
    5.94 km from Colonia Americana**, which is what the `location` tag beside it says. It was
    published on four public relays and read by nothing, so nothing ever disagreed with it.
    Corrected to `9ewmxg9` (20.6742, -103.3683, ±76 m) in `spike/fixture.ts`, with the assertion
    in `storefront/src/render.test.ts`. **A tag nothing reads is a tag nothing checks** — which is
    the same lesson as findings §13.11 ("a 200 is not evidence") pointed at our own output rather
    than at a server's.

