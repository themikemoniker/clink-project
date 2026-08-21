# CLINK notes

Read from the spec repo at `https://github.com/shocknet/CLINK`, commit `442b7ae` (branch
`main`), fetched 2026-08-20. Every field name, kind, and code below is quoted from those
files. Citations are `file:line`. Where the running Lightning.Pub disagrees with the spec,
that is noted inline and recorded in `/docs/spike-findings.md`.

**Nothing here is from memory.** If a detail is not in a spec file it is marked `UNVERIFIED`.

---

## 1. The five specs and their kinds

`README.md:52-58` — event kind registry:

| kind | description | spec |
|---|---|---|
| `21001` | Offer Request/Response | `specs/clink-offers.md` |
| `21002` | Debit Request/Response | `specs/clink-debits.md` |
| `21003` | Management Delegation | `specs/clink-manage.md` |
| `21004` | Enroll (Account Request) | `specs/clink-enroll.md` |
| `30078` | Service beacon (NIP-78) | `specs/clink-beacon.md` |

21001–21004 are all described as **ephemeral** kinds (`clink-offers.md:101`,
`clink-debits.md:103`). They fall in NIP-01's ephemeral range (20000–29999). See
[§7 Expiry and replay](#7-expiry-and-replay) — relays do not reliably honour that.

Common event shape for all four interactive kinds (`clink-offers.md:103-108`,
`clink-debits.md:105-110`, `clink-manage.md:20-25`, `clink-enroll.md:44-53`):

- `content` — NIP-44 encrypted JSON payload
- `tags`:
  - `["p", "<recipient_pubkey_hex>"]`
  - `["e", "<request_event_id>"]` — **responses only**
  - `["clink_version", "1"]` — **mandatory on request and response**

> `clink-offers.md:257`: "Implementations MUST include this tag in both request and
> response events and SHOULD reject events lacking this tag or having an unsupported
> version number."
>
> Lightning.Pub v0.0.37 **omits `clink_version` on 21001 and 21003 responses**. Verified
> against a live response event. See spike findings §2 and §13.2.

---

## 2. Offers flow (kind 21001)

### 2.1 The `noffer` pointer

Bech32 per NIP-19, HRP `noffer`, so the literal string is `noffer1<data>` with no colon or
URI wrapper (`clink-offers.md:17`). TLV items (`clink-offers.md:19-27`):

| TLV | Contents |
|---|---|
| `0` | 32 raw bytes of the **receiving service's** public key |
| `1` | recommended relay URL where the service listens |
| `2` | **opaque offer identifier string**, defined by the receiving service |
| `3` | (optional) one-byte pricing type flag: `0` Fixed, `1` Variable, `2` Spontaneous |
| `4` | (optional) price in **satoshis** (integer) |
| `5` | (optional) currency code, e.g. `"USD"`. If present, type MUST be `1` and TLV `4` MUST be omitted |

Defaults: no TLV `3` and no TLV `4` ⇒ treat as type `2` Spontaneous
(`clink-offers.md:29`). Amounts everywhere are **whole satoshis**
(`clink-offers.md:31`).

QR payload MUST be the plain `noffer1…` string; implementations MUST NOT prepend
`noffer:`, use BIP-21, LNURL, or HTTP URLs (`clink-offers.md:46-48`). An offer QR is not a
BOLT11 invoice (`clink-offers.md:50`).

### 2.2 Advertising an offer

- **kind 0 metadata**: field name `clink_offer` inside the JSON `content`
  (`clink-offers.md:58-67`).
- **NIP-05 response**: top-level object `clink_offer` mapping name → `noffer1…`
  (`clink-offers.md:72-83`).

### 2.3 Request payload (decrypted `content`)

`clink-offers.md:130-141`. Exact field names:

| Field | Type | Requirement |
|---|---|---|
| `offer` | string | the offer id from `noffer` TLV `2` |
| `amount_sats` | integer | "Required for spontaneous/variable, optional otherwise" |
| `payer_data` | object | optional, "Arbitrary JSON object with payer info (e.g., NIP-05, name, pubkey)" |
| `zap` | string | optional, **stringified JSON** of a kind `9734` zap request event |
| `expires_in_seconds` | integer | optional, "Requested invoice expiry time" |
| `description` | string | optional, "A description to be included in the invoice, **max 100 chars**" |

### 2.4 Response payloads (decrypted `content`)

- **Success**: `{"bolt11":"<BOLT11_invoice_string>"}` (`clink-offers.md:159`).
- **Error**: `{"error":"<message>","code":<int>,"range":{"min":<sats>,"max":<sats>}}`
  (`clink-offers.md:176`). Note the offers error envelope has **no `res` field** — unlike
  Debits/Manage, which use `{"res":"GFY",…}`.

### 2.5 Offers error codes

`clink-offers.md:188-192` and the per-code payloads at `clink-offers.md:206-249`:

| code | meaning | extra fields |
|---|---|---|
| `1` | **Invalid Offer** — offer ID invalid or no longer available | — |
| `2` | **Temporary Failure** — receiver temporarily unable to process | — |
| `3` | **Expired or Moved Offer** — expired, replaced, or permanently moved | `latest`: a new `noffer1…` string, when forwarding |
| `4` | **Unsupported Feature** — receiver doesn't support a requested feature | — |
| `5` | **Invalid Amount** — amount too big or too small | `range`: `{"min":<sats>,"max":<sats>}` |

Code `3` handling (`clink-offers.md:217-219`): if `latest` is present the client SHOULD
store the new offer and retry automatically; if absent the client MUST treat the offer as
permanently expired.

### 2.6 Payment receipt

`clink-offers.md:307-343`. **This is the single most consequential thing in the spec for
this project.**

- Kind `21001`, sender = receiving service, **recipient = the payer**.
- Tags: `["p","<payer_pubkey>"]`, `["e","<request_event_id>"]`, `["clink_version","1"]`.
- Content: NIP-44 encrypted, so readable **only by the payer**.
- Payload, standard Lightning payment: `{"res":"ok","preimage":"<64-char_hex_lightning_preimage>"}`
- Payload, internal settlement: `{"res":"ok"}` — "The absence of a `preimage` indicates an
  internal transaction."
- It is **MAY**, not MUST (`clink-offers.md:309`: "the receiving service **MAY** send a
  final kind: 21001 event to the payer").

There is **no public, seller-readable settlement receipt in CLINK Offers.** The only
public receipt in the flow is the NIP-57 kind `9735` zap receipt, and only when the
request carried a `zap` payload (`clink-offers.md:95`).

### 2.7 Zap integration

`clink-offers.md:88-97`. The kind `9734` event goes in the request's `zap` field as
stringified JSON; the service publishes the kind `9735` receipt after payment. Services
supporting zaps SHOULD use an offer id starting with `zap` (e.g. `zap_default`) so clients
know it is safe to send a `zap` payload.

### 2.8 Flow

`clink-offers.md:259-280`: decode `noffer` → send 21001 request to TLV `0` on TLV `1` →
service validates `offer` and `amount_sats`, generates BOLT11 → 21001 response with
`bolt11` or `error`/`code` → payer pays → optional receipt.

---

## 3. Debits flow (kind 21002)

### 3.1 The `ndebit` pointer

Bech32 HRP `ndebit` (`clink-debits.md:17`). TLVs (`clink-debits.md:19-22`):

| TLV | Contents |
|---|---|
| `0` | 32 raw bytes of the **node service** public key |
| `1` | relay URL |
| `2` | (optional) opaque pointer identifier — "a specific budget, account, or application" |
| `3` | (optional) **session identifier (`k1`)**, exactly 32 bytes, CSPRNG-generated |

Static pointer = TLVs `0`–`2` only, publishable. Session ndebit = plus TLV `3`, minted per
interaction, "MUST NOT be published as a user's primary `clink_debit`"
(`clink-debits.md:30-31`). Advertised in kind 0 / NIP-05 under the field name
`clink_debit` (`clink-debits.md:74-98`).

### 3.2 Request payloads (decrypted `content`)

Two shapes (`clink-debits.md:132-156`):

**Direct payment request** — `pointer` (optional), `amount_sats` (optional),
`bolt11`, `description` (optional), `k1` (optional, 64-char lowercase hex).

**Budget request** — `pointer` (optional), `amount_sats`, `frequency` as
`{"number":<int>,"unit":"day"|"week"|"month"}`, `description` (optional).

Notes (`clink-debits.md:158-161`): omitting `frequency` on a budget request implies a
one-time budget; a request with no `bolt11`, no `amount_sats` and no `frequency` is
implicitly a request for **unrestricted access** to the `pointer`.

### 3.3 `k1` session rules

`clink-debits.md:163-172`:

- Present in TLV `3` ⇒ the wallet MUST set `k1` to the lowercase hex of those 32 bytes.
- Absent ⇒ the wallet MUST NOT invent one.
- The node service SHOULD treat each `k1` as single-use within the scope of the `pointer`.
- A `k1` is **consumed** when the service accepts a valid request for approval or payout.
  Structural failures (undecryptable, malformed) and payload validation failures (bad
  amount, undecodable BOLT11) MUST NOT consume it — the requestor MAY retry the same `k1`.
- Duplicate `k1` while a session is pending SHOULD get a GFY, e.g. code `6`
  (`"K1 already processed"`, `clink-debits.md:279`).

**What Lightning.Pub 0.0.37 actually does — measured on the wire 2026-08-21, slice 7. Three
divergences, and together they disqualify `k1` as an idempotency key for anything durable.**
Evidence and citations in `/docs/spike-findings.md` §13.28; reproduce with
`node spike/check-refund.ts`.

| the spec says | the node does |
|---|---|
| single-use "within the scope of the pointer", no lifetime given | in-memory array, **5-minute TTL**, swept once a minute, **lost on restart** (`debitManager.ts:19-37`; the `doNdebit` comment says so outright at `:256-257`) |
| validation failures MUST NOT consume it | `DedupeK1` runs **before** the invoice is decoded and before any rule is checked (`debitManager.ts:258-262`), so a request the node then refuses still burns the `k1` |
| duplicate SHOULD get e.g. code `6` | the message `"K1 already processed"` with **`code: 1`** (`debitTypes.ts:98`, `debitManager.ts:261`). **Match on the message, not the code.** |

⇒ A `k1` derived from a settlement identifier is a useful *second* layer against a crash loop and
is not a substitute for our own record. It also means a failed debit cannot be retried for ~5
minutes, because the derived `k1` is the same one — `spike/watch-sales.ts` waits 6.

### 3.4 Response payloads

`clink-debits.md:178-217`:

- ACK, standard Lightning payment: `{"res":"ok","preimage":"<lightning_preimage>"}`
- ACK, internal settlement: `{"res":"ok"}`
- ACK, budget approval: `{"res":"ok"}`
- Failure: `{"res":"GFY","code":<int>,"error":"<message>", …}`

Responses are always addressed to the pubkey that **signed the request**
(`clink-debits.md:176`, `223`).

### 3.5 GFY codes (Debits)

`clink-debits.md:225-278`:

| code | meaning | extra fields |
|---|---|---|
| `1` | Request Denied (user or rule denied it) | — |
| `2` | Temporary Failure (node service issue, e.g. node offline) | — |
| `3` | Expired Request (timestamp too old, e.g. >30s delta) | `delta`: `{"max_delta_ms":30000,"actual_delta_ms":<n>}` |
| `4` | Rate Limited | `retry_after`: `<unix_timestamp>` (optional) |
| `5` | Invalid Amount (outside range or budget) | `range`: `{"min":<sats>,"max":<sats>}` (optional) |
| `6` | Invalid Request (malformed payload, missing fields) | — |

**Confirmed on the wire 2026-08-21 (slice 7), for the two this project depends on.** A debit that
exceeds the grant's frequency cap comes back as code `5` **carrying `range`**, where `max` is the
cap the node enforced — so a client can report the number rather than the message:

```json
{"res":"GFY","code":5,"error":"Invalid Amount","range":{"min":1,"max":1}}
```

`min` is hardcoded to 1 rather than being a real floor (`ndebitFailure`, `debitTypes.ts:104-114`).
A banned grant comes back as code `1`, `"Request Denied Warning"`. Both are produced inside the
payment transaction, so both are refusals rather than reversals — `/docs/spike-findings.md` §13.29.

---

## 4. Manage flow (kind 21003)

`nmanage1…` TLVs (`clink-manage.md:13-16`): `0` wallet server pubkey, `1` relay, `2`
optional pointer ID (multi-account).

### 4.1 The offer resource

The only resource defined so far is `"offer"` (`clink-manage.md:29`). Actions: `create`,
`update`, `get`, `list`, `delete` (`clink-manage.md:33-92`).

Offer object fields (`clink-manage.md:94`): server-generated `id`, `label` (human-readable
display name, "the standardized, optional field for this purpose"), `price_sats`,
`callback_url`, and `payer_data` — **an array listing required payer-supplied data field
names**, e.g. `["email","shipping_address"]`.

Success responses (`clink-manage.md:97-122`):

- create / update / get: `{"res":"ok","resource":"offer","details":{ …offer object… }}`
  where the object includes `"noffer": "<bech32 offer pointer>"`
- list: `details` is an array of offer objects
- delete: `{"res":"ok","resource":"offer"}`
- error: `{"res":"GFY","code":<int>,"error":"<message>"}`

### 4.2 GFY codes (Manage)

`clink-manage.md:133-186` — same 1–6 numbering as Debits, except code `5` is
**Invalid Field/Value** (extra fields `field` and `range`) rather than Invalid Amount.

### 4.3 Ownership, idempotency, expiry

- The server MUST track which app created each offer and MUST reject modify/delete from
  other apps unless the user permits it (`clink-manage.md:189`).
- Offer IDs MUST be unique per wallet server (`clink-manage.md:190`).
- `update` MUST NOT add new fields to an offer (`clink-manage.md:193`).
- On `create` the client **MUST NOT** supply an `id` (`clink-manage.md:223`).
- `create` is **not** idempotent — N identical requests create N offers
  (`clink-manage.md:226`). `update`, `delete`, `get`, `list` are idempotent;
  `delete` of a missing id SHOULD return `res: "ok"`; `update`/`get` of a missing id MUST
  return GFY `6`.
- Replay: "wallet servers MUST enforce a maximum time delta between the server's clock and
  the event's `created_at`", recommending GFY `3` outside ~30 seconds
  (`clink-manage.md:232`).

---

## 5. Enroll (kind 21004)

`clink-enroll.md`. Binds a Nostr key to an account on a node service and returns that
account's default pointers.

- Request payload is the **empty object** `{}` (`clink-enroll.md:108-112`). The service
  MUST associate the account with the request event's pubkey (`clink-enroll.md:114`).
- Success response (`clink-enroll.md:118-132`):
  `{"res":"ok","noffer":"noffer1…","ndebit":"ndebit1…","nmanage":"nmanage1…"}`
- Idempotent: repeating Enroll with the same key MUST return equivalent pointers
  (`clink-enroll.md:140`).
- Error codes (`clink-enroll.md:157-166`): `1` Denied, `2` Temporary Failure, `3` Expired
  Request (`delta`), `4` Rate limited (`retry_after`), `5` **Insufficient NIP-13 proof of
  work** (`required_difficulty` MUST be present), `6` Invalid Request.
- PoW is optional per deployment (`clink-enroll.md:69`). When required: NIP-13 `["nonce",
  "<counter>","<target_difficulty>"]` tag, event id must have ≥ `target_difficulty`
  leading zero bits, and the committed target must be ≥ the service's requirement
  (`clink-enroll.md:73-76`). Recommended difficulty **18 bits** (`clink-enroll.md:82`).
  Portable discovery = probe with no `nonce`, read `required_difficulty` off the code `5`
  response, mine once, retry once (`clink-enroll.md:94-96`).

**Owner policy** (`clink-enroll.md:168-175`) — normative for reference servers: when the
signer of a 21002 or 21003 request is the key that owns the account behind the pointer,
"The service MUST allow the operation without a prior third-party debit/manage
authorization grant." Lightning.Pub v0.0.37 does not implement this; see spike finding §13.4.

---

## 6. Beacon (kind 30078)

`clink-beacon.md`. NIP-78 addressable event, author = **service** pubkey.

- Required tags: `["d","clink-node"]`, `["clink_version","1"]`. Optional
  `["operator","<operator_pubkey_hex>"]` (`clink-beacon.md:32`).
- Content JSON, all fields optional (`clink-beacon.md:73-102`): `name`, `avatarUrl`,
  `website`, `description`, `relays[]`, `fees.serviceFeeFloor`, `fees.serviceFeeBps`,
  `enroll_difficulty`, `supported_kinds[]`.
- Republish at least every **60s**; treat as stale after **180s** with no fresh
  `created_at`; treat `created_at` more than **30s in the future** as invalid
  (`clink-beacon.md:59-65`).
- Operator attestation is bidirectional: service beacon carries an `operator` tag, and the
  operator publishes kind `30078` `["d","clink-node-operator"]` with a `["service",…]` tag
  per attested service; revocation is a separate `["d","clink-node-operator-revoke"]`
  document and **revocation wins** (`clink-beacon.md:120-158`).
- Reserved `d` namespace on kind 30078: `clink-node`, `clink-node-operator`,
  `clink-node-operator-revoke`, and "…" (`clink-beacon.md:195`). **Do not name our own
  NIP-78 shop-state `d` tag with a `clink-` prefix.**
- Backward compatibility: "some deployments historically used `d=Lightning.Pub`"
  (`clink-beacon.md:195`). The running Lightning.Pub still does (`nostrPool.ts:53`) — see
spike findings §12.

---

## 7. Expiry and replay

Collected because this is the money path.

**Invoice expiry.** The payer requests it with `expires_in_seconds` in the 21001 request
payload (`clink-offers.md:138`). The spec defines no cap and no default; the invoice's own
BOLT11 expiry is what actually binds.

**Offer expiry.** Signalled after the fact, via error code `3` with an optional `latest`
forwarding pointer (`clink-offers.md:212-235`). There is no expiry field inside the
`noffer` itself.

**Request freshness.** Only Debits and Manage state a rule, and only as a recommendation:
GFY code `3` for a `created_at` outside a ~30 second delta (`clink-debits.md:229`,
`clink-manage.md:232`). **CLINK Offers states no freshness rule at all** — there is no
`code 3`-for-stale-request in the Offers spec, only `code 3` for a stale *offer*.

**Replay.** The only single-use construct in CLINK is the Debits `k1`
(`clink-debits.md:167-171`, `378`). Offers has nothing equivalent: a replayed 21001
request is indistinguishable from a fresh one, and the spec's own guidance for Manage
("wallet servers MUST enforce a maximum time delta … to prevent replay attacks",
`clink-manage.md:232`) has no Offers counterpart.

⇒ **Our idempotency key on the money path cannot be the request event id.** It has to be
the settled invoice / payment hash. Empirically, `wss://relay.lightning.pub` stored and
replayed minutes-old kind 21001 events to a new subscriber despite the ephemeral range —
see spike finding §13.

---

## 8. What `payer_data` carries

The name means two different things depending on which side of the flow you are on. Both
are in the specs; conflating them will produce a broken client.

**In a kind 21001 request** (`clink-offers.md:136`) — `payer_data` is an **object**, sent
by the payer:

> `"payer_data": { ... }, // Optional: Arbitrary JSON object with payer info (e.g., NIP-05, name, pubkey)`

The keys are not enumerated anywhere in the CLINK specs. There is **no standard field for
a refund pointer**, no `clink_offer` key, no `refund` key. If we want the buyer's payment
pointer for the auto-refund path, we are defining a private convention.

**In a kind 21003 offer object** (`clink-manage.md:94`, `108`) — `payer_data` is an
**array of strings** naming the fields the offer *requires* the payer to supply:

> `"payer_data": ["email", "shipping_address"]`

So the seller declares required key names on the offer; the payer supplies an object with
those keys; the service enforces presence. Lightning.Pub implements exactly this and
returns error `code: 1` plus a `payer_data` array of the missing keys — a field not in the
Offers spec's error payload. See spike findings §4 and §6.

---

## 9. Reference implementations named by the specs

`clink-offers.md:345-350` and equivalents: server **Lightning.Pub**, wallet
**ShockWallet**, SDK **`@shocknet/clink-sdk`**, demo **clinkme.dev**.

SDK constants (`@shocknet/clink-sdk@1.7.0`, `build/constants.js`) match the specs:
`CLINK_VERSION "1"`, kinds `21001`–`21004`, `CLINK_BEACON_KIND 30078`,
`CLINK_BEACON_D_TAG "clink-node"`, `BEACON_STALE_AFTER_SECONDS 180`,
`BEACON_FUTURE_SKEW_SECONDS 30`, `MAX_ENROLL_POW_BITS 24`.
