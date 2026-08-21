# Spike Findings

**Status:** desk spike complete 2026-08-20; **updated at the end of slice 2** with what a live
CLINK round trip actually returns. Four items still need a funded node or a human with a phone;
each is marked `NEEDS HUMAN` with the exact command and the exact output to paste back. Slice 2
closed the node-side halves of questions 2 and 6, corrected §13.4, and added §13.13-14. Question
1 was answered separately on 2026-08-21 — the node has rented inbound now, so the one remaining
slice-2 unknown is a single paid invoice (§1).
**Rule:** every answer needs evidence — a spec file path, a source file and line, or
pasted event JSON. `UNVERIFIED` is an acceptable answer. A confident guess is not.

Where this file disagrees with `/docs/spec.md`, this file wins. Corrections are listed in §12.

## Sources used

| Source | Version pinned |
|---|---|
| CLINK specs — `github.com/shocknet/CLINK` | commit `442b7ae`, branch `main`, fetched 2026-08-20 |
| NIPs — `github.com/nostr-protocol/nips` | fetched 2026-08-20 |
| Blossom BUDs — `github.com/hzrd149/blossom` | fetched 2026-08-20 |
| Lightning.Pub source | the **running local install**, `~/lightning_pub`, `package.json` version `0.0.37` |
| `@shocknet/clink-sdk` | `1.5.5` bundled in Lightning.Pub; `1.7.0` current on npm |
| Live node | local Pub, LND `SERVER_ACTIVE`, 1 private channel, **98,160 sat inbound / 0 outbound** (§1) |

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
- [ ] Test payment received: _(date)_ — still the only thing that proves receive works

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

**The node still has 0 outbound** (`local_balance: 0`). Correct for a seller, and a real
constraint on **slice 7**: refunds need outbound, and outbound only exists after buyers have
paid. A refund cannot be the first payment this node ever makes.

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

**Which fixture items are actually payable, given 98,160 sat inbound:**

| item | price | payable today |
|---|---|---|
| `plants` | 6,000 sat | **yes** |
| `lamp` | 30,000 sat | **yes** |
| `bike` | 180,000 sat | no — over inbound |
| `couch` | 210,000 sat | no — over inbound |

Both unpayable ones will still hand a buyer a BOLT11 and then fail at payment time, which is
the honest shape of the problem and worth showing rather than hiding. Demo `plants` or `lamp`.

**NEEDS HUMAN — the last thing slice 2 needs, and it is now a 60-second job.**

```bash
cd spike && node check-buy.ts yardsale-2026-08-plants --pay
```

It prints a real 6,000-sat invoice and waits. Pay it from the phone wallet that paid the
Olympus fee, then paste everything the script prints after `# waiting`. That single run proves,
in order: the invoice is payable (so §1's checkbox closes), Lightning.Pub really does send the
kind 21001 receipt, the receipt is readable by the payer's ephemeral key and by nothing else,
and the storefront's `showPaid()` path fires. Confirm whether the payload is `{"res":"ok"}` or
`{"res":"ok","preimage":"…"}` — §5 predicts no preimage.

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

**What the seller can actually observe.** Three options, cheapest first:

1. **`GetLiveUserOperations`** — Lightning.Pub pushes a live `UserOperation`
   (`INCOMING_INVOICE`, amount, `operationId`, `internal` flag, `latest_balance`) over
   Nostr to the account's own key on every settlement
   (`paymentSideEffects.ts:34-44`, `101-112`). Nostr-native, no HTTP. **This is the
   watcher's feed.**
2. **`GetUserOfferInvoices`** — poll per offer; returns `invoice`, `offer_id`,
   `paid_at_unix`, `amount`, and `data` (the stored `payer_data`)
   (`offerManager.ts:89-104`). This is how the refund path gets the buyer's pointer.
3. **`callback_url`** — HTTP GET on settlement. Loopback addresses are explicitly
   **allowed** (`safeOutboundFetch.ts:121-131`: `isLoopbackIPv4`/`isLoopbackIPv6` return
   *not blocked*, while private ranges 10/8, 172.16/12, 192.168/16, 100.64/10, link-local
   and cloud-metadata IPs are blocked). So `http://127.0.0.1:<port>/paid?inv={invoice}` on
   the seller's own machine works. Useful, but it is an HTTP listener — prefer (1).

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

**Steps 3 and 4 are done — slice 2, 2026-08-20.** Against a real offer minted with
`payer_data: ["refund_pointer"]`, with the key named as ours rather than `order_id`:

```json
{"code":1,"error":"Missing or invalid payer_data: refund_pointer","payer_data":["refund_pointer"]}
```

and with the key supplied, a BOLT11 (§2). Both reproduce on demand:
`cd spike && node check-buy.ts`, which drives the storefront's own modules. The
Lightning.Pub `payer_data` extension to the error payload is therefore confirmed on the wire,
not just in source, and our page reads it to re-prompt.

**NEEDS HUMAN — only the wallet half now** (needs a funded node; ~5 minutes)

1. Pay one of our fixture offers' `noffer` **from ShockWallet on another device** —
   `node -p "require('./.offers.json')['yardsale-2026-08-plants'].noffer"` prints one.
2. Record: does the wallet prompt for `refund_pointer`, silently fail, or show the error text?

This is now a *secondary* question, and slice 2 is why. Our page is the client sending the
21001, so the refund pointer arrives whatever a third-party wallet does. What the answer
changes is slice 8's fallback copy: if ShockWallet cannot supply the key, then every offer we
mint is unpayable by any wallet but ours, and the item-QR sticker in `/docs/design.md` §4 has
to point at the item page rather than the offer. We have already assumed the worst there.

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

- [x] Deployed with **our own `/spike/deploy-nsite.ts`**, not nsyte — see the tool table below
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

**Blob hosting is the real constraint, and it nearly sank the deploy.** Details in §9, summary
here because it changes what the project can claim:

- `blossom.band` is nostr.build. It stores the sale's **photos** fine and answers
  `415 File type not allowed` for HTML/JS/CSS. It cannot host an nsite.
- Of **fourteen** public Blossom servers probed with a real HTML upload from an unknown pubkey,
  exactly **one** stored it: **`cdn.hzrd149.com`** → `201`, `type=text/html`, and it serves
  `GET /<sha256>` with the right content-type. It takes JPEGs too, so it can be the only server.
- The other twelve: `401 Pubkey not authorized by any storage rule`, `403 Public key not
  authorized`, `400 unsupported content type`, or dead.

⇒ The "no hosting account" claim currently rests on **one person's server choosing to accept
anonymous uploads**. That is a weaker foundation than "no server", and a judge may ask. It is
also a single point of failure with garbage collection: see §14's open question.

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

## 8. Signature prompt count for a 10-item publish — `NEEDS HUMAN`

Cannot be measured without a bunker and a phone. But the spike found the lever that decides
the answer, and it is not in spec §5.

**Floor, if nothing is batched:** 10 listings + 1 manifest + 1 kind `10063` (§7) + N photo
uploads. With one Blossom auth per photo and 2 photos per item that is **32 prompts** —
over the ~15 threshold, so this matters.

**Lever 1 — Blossom auth batching is allowed by the spec.** See §9: one kind `24242` event
can carry **many `x` tags** and authorise every upload in the batch. That collapses N photo
prompts to **1**.

**Lever 2 — NIP-46 `perms`.** A bunker connection can be opened with pre-granted
permissions as a comma-separated `method[:params]` list, where the param for `sign_event`
is the kind number (`nips/46.md:113`), e.g.
`perms=sign_event:30402,sign_event:15128,sign_event:24242,sign_event:10063`. If the signer
honours it, a 10-item publish is **1 approval at connect time**, not 12.

Whether Amber / nsec.app actually honour `perms` for arbitrary kinds is
**UNVERIFIED** — it is a signer-implementation question, not a NIP question.

**NEEDS HUMAN — what to run**

1. Pair the builder (or any NIP-46 client) with your bunker using a `nostrconnect://` URI
   including `perms=sign_event:30402,sign_event:15128,sign_event:10063,sign_event:24242`.
2. Publish 10 listings with 2 photos each.
3. Report: signer name + version, and the **prompt count**. Also say whether the signer
   showed the requested perms at connect time and whether it then stopped prompting.

**Threshold:** if over ~15, redesign the publish flow before building the UI.

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

**Still needed from a human:** a second working Blossom server, so blobs survive one server
garbage-collecting them, and so `PUT /mirror` can be tested. `cdn.satellite.earth` needs an
account; if you have one, or a preferred server, name it.

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
  approval in ShockWallet (`debitManager.ts:147-187`).
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

**Residual, and it is unavoidable today:** the *observation* side still needs a "User"
credential on the seller's account, which implies spend authority over that account's
balance. Two mitigations, both cheap:
- Keep the observe key and the refund key **separate**. The observe key never signs a
  payment in our code.
- Prefer the loopback `callback_url` (§5, option 3) for observation, which needs **no
  credential at all** — the node calls the watcher. That is the narrowest possible answer
  and it is worth a slice-3 experiment.

**No `UNVERIFIED` here except one:** whether the frequency rule can be set to a *daily* cap
via the ShockWallet UI as opposed to the raw RPC — `UNVERIFIED`, check when pairing.

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
| §7.4 | strict mode "requires Lightning.Pub to support gating on custom logic" | No such hook exists (§4). Strict mode = delete the offer on depletion, or front the node with our own service key | ☑ |
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
