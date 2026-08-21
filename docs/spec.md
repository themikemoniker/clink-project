# Lamppost — Architecture & Build Spec

**Working name:** **Lamppost**, settled in slice 2. Named for the flyer taped to one: paper that
stays current because the QR on it points at a live page. It appears in exactly two places —
the masthead when a sale has no title of its own, and a colophon on the printed flyer.
**Target:** hackathon submission, "Best Use of CLINK"

**Current state and next actions live in `/docs/status.md`** — read that first in a new session.

**Status:** slice 3 shipped (2026-08-21). Availability is live: a watcher on the seller's
machine observes settlement on their own node and republishes the kind 30402, and it does so
**holding no signing key**. That was the slice's real design work and it is not in §10's
one-line description — see §7.2's "Who signs the republish" and `/spike/ladder.ts`. Slice 3
corrected two things measured while building: `GetLiveUserOperations` cannot attribute a
payment to an item (§7.2), and §7.4(a)'s "delete the offer on depletion" would destroy the
buyer's refund pointer (§7.4). It also took spike question 8 off this slice entirely — q8 itself
was answered from source the same day, in parallel (findings §8).

**Status:** slice 2 shipped (2026-08-20), **and money has moved (2026-08-21)**. A static page
mints an ephemeral key, sends a NIP-44-encrypted kind 21001 to the seller's own node over that
node's relay, gets a real BOLT11 back, and reads the settlement receipt that nobody else can
decrypt. Proven with a real 6,000-sat Lightning payment: `/docs/spike-findings.md` §1, §5, §6.
The core claim in §1 is no longer a claim. Slice 2 settled four things this document had left open: the
`payer_data` key name (`refund_pointer`), fiat→sats (there is no conversion — see §6.1), the
clink-sdk question (measured, hand-rolled wins by 29 KB gzip — §9), and the JS budget (it means
**gzip** — §9).

**Status:** slice 1 shipped (2026-08-20) — read-only storefront in `/storefront`, everything but
the nsite deploy. Slice 1 corrected three things in this document: `quantity` is deleted in favour
of GammaMarkets `stock` (§6.1), sale grouping is kind `30405` not a `t` tag (§6.3), and the Blossom
signature-batching lever in §5 is dead (measured, `/docs/spike-findings.md` §9).

**Status:** post-spike (2026-08-20). All 13 corrections from `/docs/spike-findings.md` §12 are
applied below; the `SPIKE` markers are gone because the questions behind them are answered.
Five items still need a funded node or a phone — spike questions 1, 2, 6, 7, 8 — and each has a
`NEEDS HUMAN` block in the findings with the exact command to run. **Evidence lives in
`/docs/spike-findings.md`, protocol field names in `/docs/clink-notes.md`; both still win over
this document where they disagree.** The largest change: CLINK settlement receipts are
encrypted to the *payer* and are not readable by the seller, which rewrote §7.2, §7.6, §8, and
one line of the pitch in §1.

---

## 1. What this is

A web app that lets anyone publish a sale page for physical goods — yard sale, garage sale, market stall, moving sale — and take Lightning payments on it, with:

- no hosting account
- no domain or TLS certificate
- no payment processor, merchant account, or KYC
- no server operated by us that holds keys, funds, or user data

The seller's site is hosted on Nostr (NIP-5A manifest + Blossom blobs). The listings are Nostr events (NIP-99). Payments are negotiated over Nostr via CLINK and settle to the seller's own Lightning node. The seller's identity, their storefront, their listings, and their money are all one pubkey.

### The claim to defend on stage

> An LNURL storefront cannot exist on a static host, because LNURL needs an HTTPS endpoint to mint invoices. CLINK requests travel over relays to the seller's own node, so a purely static, serverless site can take money.

### The honest caveats (say these before a judge does)

- The seller's Lightning node must be **online**. It does not need inbound reachability, a public IP, DNS, TLS, or an open port — but it is a process running somewhere.
- BOLT12 also achieves "static reusable payment code with no web server." CLINK's differentiators here are **identity/discovery (NIP-05 and kind 0), a typed decline the buyer's client can act on, buyer-supplied `payer_data` on the request, and per-item offers a marketplace app can mint over kind 21003** — not the absence of a server by itself.
- **Receipts are private, not public.** The CLINK payment receipt is NIP-44 encrypted to the payer and addressed only to them (`clink-offers.md:307-343`), and it is a MAY, not a MUST. Do not claim publicly-readable signed receipts. See `/docs/spike-findings.md` §5.
- **"No hosting account" rests on somebody accepting anonymous uploads.** Slice 1 probed
  fourteen public Blossom servers with a real HTML upload; exactly one — `cdn.hzrd149.com` —
  stored it. Most require an allowlist, and `blossom.band` is media-only. We do not operate a
  server and we do not have an account, which is true and is the point; but the honest phrasing
  is "no account, no domain, no TLS, no processor" rather than "no infrastructure exists."
  See `/docs/spike-findings.md` §7.
- There is no escrow and no chargebacks. Default to in-person pickup.

---

## 2. Non-goals (v1)

- Shipping, tracking, or shipping-based escrow
- Dispute resolution
- Multi-currency checkout beyond fiat display + sats settlement
- Our own relay or Blossom server
- Native mobile apps
- Any server-side account system

---

## 3. Hard architectural rules

These are not preferences. Violating them destroys the pitch.

1. **We never hold a private key.** No nsec on our infrastructure, ever. All signing goes through NIP-07 or NIP-46.
2. **We never hold node credentials.** The seller's Lightning.Pub pairing lives in their browser, never transmitted to us.
3. **`admin.connect` never enters this system.** It is `nprofile:token` with full admin authority over the node. The builder, the storefront, and the watcher must all use the narrowest credential that works — never the admin string. See §11 spike question 10.
4. **We have no backend, no database, no accounts.** All persistent state is signed Nostr events on public relays plus Blossom blobs.
5. **The builder itself deploys as an nsite.** If our own app needs a server, the thesis is false.
6. **Any always-on process (the watcher/shop daemon) is run by the seller, not by us.**

---

## 4. Parties and components

| Component | Runs where | Holds keys? | Purpose |
|---|---|---|---|
| Builder app | Seller's browser (served from an nsite) | No | Author listings, upload photos, deploy site, admin panel |
| Signer | NIP-07 extension or NIP-46 bunker | Yes (seller's) | Signs all events |
| Relays | Public | No | Listings, site manifest, CLINK messages, receipts |
| Blossom servers | Public | No | Photos and site files, addressed by sha256 |
| Seller's node | Seller's VPS / laptop / Pi | Yes (seller's) | Lightning.Pub (or other CLINK node service) |
| Shop watcher | Seller's machine, next to the node | **No — none.** Publishes kind 30402 events the seller pre-signed (§7.2) | Observes settlement, republishes inventory state, issues refunds |
| Storefront | Static files on Blossom, resolved via NIP-5A | No | The buyer-facing sale page |

---

## 5. Identity and signing

### Supported signer paths

1. **NIP-07** browser extension (Alby, nos2x) — technical users.
2. **NIP-46 remote signing** (Amber on Android, nsec.app in browser) — default recommendation for everyone else.
3. **New user flow** — generate a keypair in the browser, then immediately hand it off to a bunker. If a raw key must be retained client-side, it is encrypted at rest with a user passphrase and the app is loud and explicit about backup.

### Implementation requirement

Define one `Signer` interface and implement all paths behind it. No component outside the signer module ever sees key material.

```ts
interface Signer {
  getPublicKey(): Promise<string>;
  signEvent(unsigned: UnsignedEvent): Promise<Event>;
  nip44Encrypt?(pubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt?(pubkey: string, ciphertext: string): Promise<string>;
}
```

### Signature-count budget (UX-critical)

Every signature is a prompt on the seller's phone when using a bunker. Publishing a 12-item sale must not mean 40 approvals. Design for:

- One signature per listing event
- One signature for the whole site manifest (see §6.4 — this is why we use kind 15128/35128, not legacy 34128)
- ~~**One signature for the whole photo batch.**~~ **Dead — measured false in slice 1.** BUD-11 does permit multiple `x` tags in one kind `24242` event (`buds/11.md:40,67`), but blossom.band reads the *first* `x` as the blob's identity rather than hashing the body: under a batched token, uploading blob B returns blob A's descriptor with a **200**, and B is discarded. Every listing then points at the same photo. Budget **one signature per photo**. Evidence and the exact transcript are in `/docs/spike-findings.md` §9. Keep `expiration` short, scope any `delete` token with both `server` and `x`, and always compare the server's returned `sha256` against the one we computed.
- One signature for the kind `10063` Blossom server list — once per seller, not per deploy (see §6.4).
- **NIP-46 `perms` was the lever, and it works.** **Answered 2026-08-21** from both signers' source (`/docs/spike-findings.md` §8). Amber and nsec.app each honour `perms` for arbitrary kinds, and Amber's *default* sign policy is the one that persists them. Send `perms=get_public_key,nip44_encrypt,nip44_decrypt,sign_event:30402,sign_event:30405,sign_event:15128,sign_event:10063,sign_event:24242,sign_event:30078` — note `30405`, which the earlier draft of this line omitted, and note that neither signer accepts a bare `sign_event` with no kind.

**Slice 3 adds one term, and removes a worse one.** The availability ladder (§7.2) pre-signs
every future stock state of every buyable item, so a 10-item sale with a few multi-unit items
costs a handful of extra signatures — but all of them at publish time, in the same sitting as
the listings, where `perms` either helps or does not. What it removes is the alternative: a
watcher that signed each stock update through a bunker would prompt the seller's phone **once
per sale, during the sale**, and would make the seller's phone a required participant in every
sale. Spike question 8 turned out to be answerable — `perms` is honoured — but the ladder never
had to wait for it.

**The measured floor, now that spike question 8 is answered.** A 10-item publish with 2 photos
an item costs **1 prompt** if `perms` is granted at connect, and **5** if it is ignored entirely —
because both signers key a remembered grant on `(app, type, kind)`, so twenty kind-`24242` Blossom
auths are one approval between them, not twenty. The old "33 prompts, redesign first" figure
assumed a seller who declines to remember anything thirty-three times. Nothing is over the ~15
threshold on any path, so **slice 4 builds the publish flow as planned.** Full citations, the exact
Amber and nsec.app code paths, and the one residual UI risk are in `/docs/spike-findings.md` §8.

---

## 6. Data model

### 6.1 Listing — NIP-99 kind 30402

Addressable: replacing an event with the same `(kind, pubkey, d)` updates the listing in place. This is how restocking and price changes work — no backend, no migration.

Standard tags used:

| Tag | Use |
|---|---|
| `d` | stable item slug, e.g. `yardsale-2026-couch` |
| `title` | item name |
| `summary` | one-line description |
| `published_at` | unix seconds, first publish |
| `location` | human-readable, e.g. "Colonia Americana, Guadalajara" |
| `g` | geohash — powers the "sales near me" map |
| `price` | `["price", "<number>", "<currency>"]`, e.g. `["price", "800", "MXN"]`. NIP-99 also allows an optional 4th element `<frequency>` (`99.md:38-42`) — we never write it, but the parser must tolerate it |
| `status` | `active` or `sold` |
| `image` | NIP-58 shaped: URL + optional `WxH` |
| `t` | hashtags |

Custom tags (namespace them clearly, document them in the README):

| Tag | Use |
|---|---|
| `clink_offer` | per-item `noffer`. **Live as of slice 2** — minted by `/spike/mint-offers.ts`, carried on the seeded 30402s, decoded and paid by `/storefront/src/offer.ts`. The tag name is not in any spec; we reuse CLINK's own kind-0/NIP-05 field name (`clink-offers.md:58-83`) rather than invent a second one. Lightning.Pub mints unlimited offers per account, each with its own `offer_id` in TLV `2` (`/docs/spike-findings.md` §3). |

**Prices on a buyable item are authored in satoshis. There is no fiat conversion, ever.**
Settled in slice 2, and it is a consequence of rule 1 rather than a preference: converting MXN to
sats needs a price oracle, an oracle is an HTTP call to somebody else's server, and this project
does not make one. So the seller writes the sats number, the listing displays that number, and
the offer is minted at that number — one number, no drift, no third party.

An item priced in anything else is simply not buyable on the page: no offer is minted for it and
no Buy button is drawn. That is honest for a yard sale, where most things are cash at the table
anyway, and it keeps fiat listings in the fixture so the no-offer render path stays exercised.

The agreement is enforced rather than assumed, in three places, because the seller authors both
the tag and the offer and only the invoice actually takes money:

1. `/spike/mint-offers.ts` refuses to write an offer whose `price_sats` differs from the fixture,
   and `/spike/seed-listings.ts` refuses to publish a listing that disagrees with the minted offer.
2. `storefront/src/listing.ts` drops the offer entirely unless the noffer's TLV `4` price equals
   the listed sats price — a listing that advertises one price and points at another is not
   buyable at all.
3. `storefront/src/buy.ts` parses the amount out of the returned BOLT11's human-readable part and
   refuses to display an invoice for a different number, or one with no amount at all. An
   amountless invoice is the dangerous case: every wallet lets the payer type any figure into it.

`quantity` is **deleted**. Slice 1 read the GammaMarkets market-spec that NIP-99 links as its
e-commerce extension (`99.md:11`) and it already standardises remaining count as
`["stock","<integer>"]` — "Available quantity as integer" (`GammaMarkets/market-spec spec.md:124,165`).
Both `stock` and `quantity` appear on live relays; `stock` is the one with a spec behind it.
We write `stock`, and keep NIP-99's `["status","active"|"sold"]` beside it because a generic
NIP-99 client reads `status` and knows nothing about GammaMarkets. Neither subsumes the other,
so the storefront treats **either** saying sold as sold.

Two more tags worth writing, both free interop:

| Tag | Use |
|---|---|
| `stock` | remaining count (Gamma `spec.md:124`) |
| `type` | `["type","simple","physical"]` (Gamma `spec.md:119-121`). The default is *digital*; a yard sale is emphatically not |
| `thumb` | NIP-58 `58.md:34`, MAY repeat at different dimensions. This is the standard multi-width srcset source — no custom tag needed for the image pipeline |

One ambiguity the two specs leave open, resolved in code: NIP-58 pairs one `image` with its
`thumb`s, GammaMarkets allows several `image` tags for several distinct photos
(`spec.md:135`, which also adds an optional 4th sort-order element), and nothing says which
image a `thumb` belongs to. With one image the pairing is unambiguous; with several we attach
thumbs to the first only, because that is the sole reading that cannot show the wrong photo.

`item_ref` is **deleted** — it existed only as a fallback for the case where per-item offers
were unsupported, and that case does not exist.

**Never publish the account's default offer.** Its `offer_id` *is* the account's
`app_user_id`, which is the pointer that addresses the account in CLINK Debits and Manage.
Publishing it hands every visitor a channel to spam the seller's wallet with authorization
prompts. Every listing gets a purpose-made offer. See `/docs/spike-findings.md` §3.

Drafts and unlisted items use **kind 30403**, same structure.

### 6.2 Private shop state — NIP-78 (kind 30078)

Cost basis, internal notes, restock reminders, buyer contact log. NIP-44 encrypted to self. Never in public listing tags.

**Pick a `d` tag that is not `clink-*`.** CLINK Beacon reserves the `clink-` prefix on kind
`30078` (`clink-node`, `clink-node-operator`, `clink-node-operator-revoke`, and future
names — `clink-beacon.md:195`). Note also that the running Lightning.Pub still publishes its
beacon under the legacy `d = "Lightning.Pub"` (`nostrPool.ts:53`), so that name is spoken
for too.

### 6.3 Sale/shop grouping — kind 30405

**Resolved in slice 1. Use the GammaMarkets Product Collection, kind `30405`** — an addressable
NIP-51-shaped list (`GammaMarkets/market-spec spec.md:213-262`). Required `d`, `title`, and one
`["a","30402:<pubkey>:<d-tag>"]` per member; optional `image`, `summary`, `location`, `g`.

This is strictly better than the `t`-tag grouping the pre-slice draft proposed, and it was
already specified, so §14's "do not invent custom tags before checking" paid for itself:

- The sale becomes **one signed event**, which matters against the §5 signature budget.
- It carries the masthead — name, neighbourhood, geohash — instead of us inventing config.
- It fixes display order. The storefront renders collection order first, strays after.
- It is an addressable event, so editing the sale is a replacement, like a listing.

The storefront still verifies each listing's own signature; the collection is an ordering and
presentation hint from the same pubkey, never a source of authority (see §6.6 — on a shared
Pub, identity comes from the listing signature, not the payment pointer).

Note the collection has no field for a sale's **date or opening hours** — no NIP does. Slice 1
renders them from the freeform `summary`. See `/docs/spike-findings.md` §13.12.

### 6.4 Site hosting — NIP-5A

- **kind 15128** — root site manifest for the pubkey (one site per seller). Use this for v1.
- **kind 35128** — named site manifest, if a seller wants multiple sales.
- **kind 34128** — legacy, one event per file. **Do not use.** One signature per file is a UX disaster with a bunker.

Manifest carries `path` tags mapping absolute paths to sha256 hashes (`["path", "/abs/path", "<sha256>"]`, `5A.md:45-49`), optional `server` hints for Blossom, and `title`/`description`. Provide `/404.html` — NIP-5A requires host servers to fall back to it (`5A.md:196`), and client-side routing depends on it.

Two things the pre-spike draft missed:

- **`x` aggregate hash** (`5A.md:51`, `67-85`) — `["x", "<sha256-hex>", "aggregate"]`, the sha256 of the sorted `"<hash> <path>\n"` lines. Recommended, and cheap: it makes a site version indexable and lets us tell two deploys apart. Emit it.
- **Blob discovery will 404 without a server list.** A host server prefers `server` tags on the manifest, then **MUST** try the author's BUD-03 kind `10063` user-server list, and if there is neither it **MUST return 404** (`5A.md:186-190`). So the deploy flow publishes a kind `10063` (or emits `server` tags, or both). One extra signature, once per seller.

Kind `5128` manifest snapshots also exist (`5A.md:59-65`) — a regular event pinning one version. Not needed for v1; useful later for "show me the sale as it was."

Blobs go to **multiple** Blossom servers. They garbage-collect. Mirror — but note slice 1
measured both halves of that advice to be harder than written: mirroring does **not** come free
of signatures (§5, the batching lever is dead), and there is currently only **one** public server
that will accept an nsite's HTML at all (`cdn.hzrd149.com`; `/docs/spike-findings.md` §7). Until
a second one exists, "mirror your blobs" is advice we cannot follow for the site itself, only for
the photos. Finding a second server is the highest-value infrastructure task after node funding.

**Deploy is implemented** in `/spike/deploy-nsite.ts`. It refuses to publish a manifest unless at
least one server holds a complete copy — a manifest whose blobs are missing is a site that 404s,
and failing loudly at deploy beats discovering it from a buyer in a driveway.

### 6.5 CLINK

**Offer discovery.** The original assumption was that sellers publish `clink_offer` in their own NIP-05 record. A local Lightning.Pub install shows this is not free: ShockWallet auto-enrols the Pub's offer and issues a `@shockwallet.app` address, while a custom domain requires a Bridgelet or an SSL reverse proxy — i.e. exactly the infrastructure this project claims to eliminate.

Therefore, in order of preference:

1. **Publish the `noffer` in the seller's kind 0 metadata and directly in the listing event.** No domain, no NIP-05, no reverse proxy. The storefront reads it from the event it already fetched. This should be the default.
2. Accept a `@shockwallet.app` address for wallets that expect a Lightning address. Name this as a hosted dependency when pitching.
3. Custom domain via Bridgelet — out of scope for v1.

**Confirmed.** The kind 0 metadata field name is exactly `clink_offer` (`clink-offers.md:58-67`), and NIP-05 uses the same name (`clink-offers.md:72-83`). Option 1 stands as the default. Add one rule: the `noffer` we publish is always a **purpose-made offer**, never the account's default offer (§6.1).

**Wire details.** Read them from `/docs/clink-notes.md`, which quotes every kind, field name, and error code from the CLINK spec files with citations, and from `/docs/spike-findings.md` for where the running Lightning.Pub diverges. Do not write them from memory or from this document.

### 6.6 Guest accounts (multi-tenancy)

Lightning.Pub supports guest accounts natively: `app.nprofile` is a non-admin pairing string, and anyone who pastes it into ShockWallet gets an account on that node. This is the "Uncle Jim" pattern — friends and family get Lightning without running anything.

This matters for scope. If a guest account can hold its own independently-addressable CLINK offer, then one community Pub can host an entire market of sellers, and "builder others can use" no longer requires every seller to run a node. If it can't, each seller needs their own node and the addressable market is much smaller. See §11 spike question 11 — this is now on the critical path.

---

## 7. Flows

### 7.1 Publish

```
Seller in builder app
  → uploads photos            → Blossom (ONE signed 24242 auth for the whole batch)
  → authors items             → kind 30402 events, signed, published to relays
  → app generates static site → files hashed, uploaded to Blossom
  → app publishes manifest    → kind 15128, signed
Buyer opens npub1xxx.<gateway> (or nsite:// in Titan)
  → gateway resolves manifest → fetches blobs by hash → renders
```

### 7.2 Purchase (best-effort mode — default)

```
Buyer taps "Buy" on the static page
  → page collects the buyer's refund pointer, mints an ephemeral key
  → page sends a kind 21001 invoice request to the item's noffer, over relays
  → seller's node returns a kind 21001 response with {"bolt11": "..."}
  → buyer pays
  → node sends a kind 21001 receipt — ENCRYPTED TO THE BUYER, not to us
  → shop watcher (on seller's machine) sees the settlement via the node's own
    live-operations feed, decrements quantity, republishes the 30402 with
    updated quantity / status=sold
  → any page loaded later queries relays and renders current availability
```

**The page never polls a backend.** Availability is derived client-side at load time from **the listing event alone**.

The pre-spike draft had the page reading settlement receipts off relays. It cannot: the CLINK receipt is kind `21001`, NIP-44 encrypted to the payer and addressed to the payer, carries no `preimage` in Lightning.Pub, and is a MAY rather than a MUST (`/docs/spike-findings.md` §5). Nobody but that one buyer can read it.

So the seller's node is the only party that observes settlement, and the watcher gets it from the node, not from a relay. **Settled in slice 3, and the pre-slice ranking here was backwards:**

1. **`GetUserOfferInvoices`** — poll per offer with `{ offer_id, include_unpaid: false }`; returns `invoice`, `offer_id`, `paid_at_unix`, `amount`, and the stored `payer_data`. **This is the watcher's feed.** It is the only call that answers *which item sold*, and it is where the refund path reads the buyer's pointer. **Confirmed populated by a real settlement** on 2026-08-21: the row carried the per-item `offer_id`, `paid_amount: 6000`, and `payer_data: {"refund_pointer":"…"}` intact (`/docs/spike-findings.md` §6).
2. **`GetLiveUserOperations`** — the node pushes an `INCOMING_INVOICE` operation over Nostr to the account's own key on every settlement. Nostr-native, no HTTP listener, lower latency — but `UserOperation` carries **no `offer_id`** (`structs.proto:634-646`), so it cannot attribute a payment to an item and has to be followed by (1) anyway. It is also push-once, so a watcher that was down never learns. A latency nudge, not a feed (`/docs/spike-findings.md` §13.16).
3. **`callback_url`** on the offer — the node GETs a URI template on settlement, and loopback addresses are explicitly allowed while private ranges are blocked. Needs no credential at all, and it is the one path that delivers `payer_data` without an RPC — but it is an HTTP listener on the seller's machine, and push-once like (2).

### Who signs the republish

**This is the part §10's one-line description hides, and it is the slice's real design work.** Republishing a kind 30402 means signing *as the seller*, and rule 1 in §3 says the watcher must not hold the seller's key. Nothing in CLINK helps: a listing's authority is its signature, so a substitute key cannot publish stock updates without breaking the trust the storefront depends on (`/docs/spike-findings.md` §11 — identity comes from the listing signature, never from the payment pointer). NIP-26 delegation is deprecated and no marketplace client reads it.

**The answer is that the watcher does not sign.** A yard-sale item has a finite, knowable set of future states: an item with stock 3 can only ever be 2, 1, or 0. So the seller signs all of them at publish time, in the same sitting that signs the listing, and the watcher holds a bundle of already-signed events — an **availability ladder** — and publishes the right rung when it sees money arrive. Implemented in `/spike/ladder.ts`, cut by `/spike/seed-listings.ts`, consumed by `/spike/watch-sales.ts`.

What it buys:

- The watcher's key material is **none**. Not "the narrowest credential that works" — none at all. It still holds a node credential to *read* settlements, and that one is not read-only (§12).
- A compromised watcher can publish only states the seller authorised. It cannot invent a price, retitle an item, or resurrect a sold one: each rung's `created_at` strictly increases as stock falls, so NIP-01's newest-per-address rule makes an out-of-order or replayed publish a no-op at the relay. Availability cannot run backwards by construction rather than by the watcher behaving.
- **Signing happens at the desk, before the sale.** The alternative — a watcher signing each update through a NIP-46 bunker — would push an approval prompt to the seller's phone once per sale, during their own yard sale. `perms` would in fact cover it (§11 q8 is answered: both signers honour `sign_event:30402`), but a pre-granted signing permission living next to an always-on process is a worse posture than a watcher that holds no key at all. The ladder makes the question moot here rather than merely survivable.

**The ceiling, stated plainly:** the ladder is cut from one version of the listing, so editing a price or a title mid-sale invalidates it — a stale rung would republish the old text over the new. Re-seed after any edit and the ladder is re-cut with it. If inventory ever becomes unbounded, or mid-sale edits become routine, this becomes a NIP-46-signing watcher — buildable now that q8 is answered, and still a worse
posture, because a standing `sign_event:30402` grant next to an always-on process is exactly
what holding no key avoids.

**Idempotency, and where the state lives.** The key is the settled invoice, never the request event id (§8). Slice 3 does not persist a seen-set at all: remaining stock is derived from the *count of distinct settled invoices the node reports for that item's offer*, so the node holds the state, a restart recomputes it, and a replayed kind 21001 request that never became a payment cannot move it.

**The honest consequence:** availability is only as fresh as the seller's watcher. A page loaded while the watcher is down shows stale stock. Say that out loud in the demo rather than letting a judge find it.

### 7.3 Sold-out race

Two buyers hit the last couch simultaneously. In best-effort mode both may pay.

Resolution: the watcher detects the second settlement for a depleted item and **automatically refunds** it, using a payment pointer the buyer supplied in `payer_data` on the original request.

**`payer_data` has no standard keys.** CLINK defines it only as "Arbitrary JSON object with payer info" (`clink-offers.md:136`) and enumerates nothing — there is no `clink_offer` field, no refund field, no convention to inherit. The key name is ours to define, which means it only arrives if *our page* is the client sending the request.

That is fine, and it is better than depending on wallet behaviour:

- The item's offer declares the key as required (`payer_data: ["refund_pointer"]` on the offer object). **Confirmed on the wire in slice 2**, against the live node: a request without it comes back
  `{"code":1,"error":"Missing or invalid payer_data: refund_pointer","payer_data":["refund_pointer"]}`,
  and the same request with it comes back with a BOLT11. The key name `refund_pointer` is now
  minted into every offer and is expensive to change — see `/spike/mint-offers.ts`.
- Our page asks the buyer for a Lightning address or `noffer` **before** requesting the invoice, and puts it in `payer_data`. A form field, not a protocol hope.
- A payment that would be unrefundable is therefore declined rather than accepted. That is the correct default for oversell risk.
- Someone who scans the raw QR with a generic wallet cannot pay at all. Deliberate trade-off; slice 8's fallback copy must say so.

The refund itself is a kind `21002` debit from the watcher's key against the seller's `ndebit` pointer, capped by a node-enforced frequency rule — see §11 q10 and §12.

This is a feature, not an apology. Demo it. Sending money back to someone who never gave you an invoice is the single most persuasive thing in this project.

### 7.4 Strict mode (build behind the same interface)

The intent stands: return an error instead of an invoice for a depleted item, so no payment occurs and no refund is needed.

**Lightning.Pub has no pre-invoice hook.** There is no plugin, webhook, or rule engine in front of invoice creation; the only decline paths are fixed-function (amount out of range, unknown offer, negative price, missing required `payer_data`, over-long description), and the offer's `callback_url` fires *after* settlement, not before (`/docs/spike-findings.md` §4). So strict mode is not a config flag on the node.

Two reachable implementations:

- **(a) Delete the offer on depletion — was the default, and slice 3 did NOT ship it.** The idea: when the watcher sees the last unit sell, it deletes the item's offer (CLINK Manage `delete`, or the `DeleteUserOffer` RPC), so the next request returns `code: 1` — a clean, spec-shaped decline that a buyer's client can display. It is one RPC from code that already exists.

  **Measured while building slice 3, and it is disqualifying as written** (`/docs/spike-findings.md` §13.17). `DeleteUserOffer` drops only the `UserOffer` row (`offerStorage.ts:27-29`); the settled invoices survive. But `GetUserOfferInvoices` looks the offer up first and throws `"Offer not found"` when it is gone (`offerManager.ts:89-93`), and that RPC is the **only** way the stored `payer_data` leaves the node — the sole other reader is the offer's own settlement `callback_url` (`paymentSideEffects.ts:27`), which our offers leave empty. So deleting a depleted offer permanently destroys the buyer's refund pointer for every invoice under it, and blinds the watcher to the item. An oversell *is* a payment that settles after depletion, so this would break slice 7 in exactly the case slice 7 exists for.

  Two candidates that keep the invoice history, neither tested: `UpdateUserOffer` the price outside the payable range instead of deleting the row, or set a loopback `callback_url` at mint time so the pointer is delivered at settlement and never has to be read back. **Decide before slice 7.**
- **(b) Hold the CLINK service key ourselves.** The shop daemon becomes the pubkey in the `noffer`'s TLV `0`, evaluates inventory, and only then asks the Pub for an invoice. True strict mode with no race — at the cost of making the daemon a required always-on component and moving the service identity off the Pub.

v1 was going to ship (a) and now ships neither. The oversell window in slice 3 is what the storefront closes on its own — a sold item draws no Buy button — plus the watcher shouting `OVERSOLD` at the seller when a second settlement lands. "Strict" was always going to mean "best-effort with a much smaller window," not "atomic"; today it means best-effort. Do not oversell it on stage.

### 7.5 Restock / edit

Seller changes quantity or price in the admin panel → app republishes the 30402 with the same `d` tag → relays replace it → every storefront reflects it on next load. One signature.

### 7.6 Pickup

The pre-spike draft had the seller verifying the buyer's settlement receipt offline. **The seller cannot decrypt it** — it is NIP-44 encrypted to the payer (`/docs/spike-findings.md` §5). Offline pickup proof has to be designed, not inherited from CLINK.

The cheap version, and the one to build: the invoice the node stores carries the buyer's ephemeral request pubkey (`clink_requester_pub`). The buyer's page keeps that ephemeral key. At the driveway the seller's device shows a QR challenge, the buyer's page signs it with that key, and the seller checks the signature against the pubkey on the settled invoice — which the watcher already synced. No signal needed on either side once both have loaded.

Decide this before slice 6; until then, pickup is "seller looks up the sale in the admin panel," which is fine for a demo and needs signal.

---

## 8. Inventory interface

**Slice 3 built the watcher and did not build this interface. That is deliberate, and this
section is now a record of why rather than a plan.** The sketch below has one implementation
and always would have: strict mode turned out not to be a config flag on the node (§7.4), and
§7.4(a) — the one alternative that needed no new infrastructure — is disqualified by
`/docs/spike-findings.md` §13.17. An interface with one implementation, written for a second
that cannot be built yet, is scaffolding; `/CLAUDE.md` says not to.

What slice 3 shipped instead is 40 lines in `/spike/watch-sales.ts`: poll settled invoices per
offer, derive remaining stock, publish the matching pre-signed listing. `reserve` and
`releaseExpired` have no counterpart at all — nothing reserves, because the invoice's own
expiry *is* the hold. Reintroduce an interface when a second policy actually exists.

The original sketch, kept because the naming lesson under it is still live:

```ts
interface InventoryPolicy {
  // called before an invoice is issued (strict) or after settlement (best-effort)
  checkAvailable(itemId: string): Promise<boolean>;
  reserve(itemId: string, ttlSeconds: number): Promise<ReservationResult>;
  commit(itemId: string, settlement: Settlement): Promise<void>;
  releaseExpired(): Promise<void>;
}
```

`Settlement` is what the *seller's node* reports — a settled invoice with its `offer_id`,
`paid_at_unix`, amount, and stored `payer_data` — not a CLINK receipt event. There is no
seller-readable receipt (§7.2). Naming it `SettlementReceipt` invited exactly the mistake
the pre-spike draft made.

**Idempotency key is the settled invoice / payment hash, never the request event id.**
CLINK Offers defines no request-freshness rule, has no single-use construct (Debits' `k1`
has no Offers equivalent), and `wss://relay.lightning.pub` was observed replaying
minutes-old kind `21001` events to a fresh subscriber before EOSE
(`/docs/spike-findings.md` §13.1). A replayed request is indistinguishable from a fresh one.

**Slice 3 goes one better and stores no key at all.** `GetUserOfferInvoices` returns the whole
settled set for an item on every call, so remaining stock is `units − |distinct settled
invoices|`, recomputed from the node each poll. There is no seen-set to persist, nothing to
lose on restart, and a replayed request that never became a payment cannot move the count.

Reservation TTL should track invoice expiry — the invoice lifetime *is* the hold. The payer
asks for it with `expires_in_seconds` on the request; the BOLT11 expiry is what actually
binds.

In strict mode (§7.4a) `checkAvailable` would not be a query the node performs — it would be
our watcher's decision, expressed by whether the item's offer still exists. See §7.4 for why
expressing it that way costs the refund pointer.

---

## 9. Suggested stack

See `/docs/design.md` for the full design direction. The two surfaces have opposite constraints and do not share a design system.

**Builder + admin** — loaded once by a motivated user:
- Vite + React + TypeScript
- Tailwind + shadcn/ui (forms, dialogs, tables, toasts, upload progress)

**Generated storefront** — loaded cold from a gateway, on mobile data, in a driveway:
- Hand-written CSS, no component library. Newspaper classifieds aesthetic.
- **No framework at all.** Slice 1 shipped Vite + TypeScript + hand-written DOM calls. Preact was
  not needed and was not added; revisit only if slice 2/3 state gets genuinely hairy.
- Budget: ~30KB JS, ~10KB CSS. Justify every dependency.
- No three.js / R3F. No animation libraries.

**The budget means gzip.** Settled 2026-08-20 (slice 2). It is a number about what a phone on
mobile data in a driveway has to pull down, so transfer size is the thing it was always about.
The raw figure is now ~2.7x the number and always would have been: `verifyEvent` alone is most of
it, and dropping it to hit a byte target would trade `/CLAUDE.md`'s "verify every inbound event"
for a statistic.

**Measured at the end of slice 2** (`npm run size` in `/storefront`):

| Asset | Raw | gzip | vs slice 1 |
|---|---|---|---|
| JS, cold load | 83.2 KB | **30.9 KB** | +11.3 KB gzip |
| JS, QR chunk (loaded only on Buy) | 10.3 KB | 3.9 KB | new |
| CSS | 5.8 KB | 2.1 KB | +0.6 KB gzip |
| HTML (incl. the inlined storefront QR) | 3.1 KB | 1.1 KB | — |

Where the slice-2 increase went, measured by stubbing each import and rebuilding:

| Piece | Raw | gzip | Optional? |
|---|---|---|---|
| `nostr-tools/nip44` | 17.4 KB | 6.0 KB | No. CLINK content is NIP-44 encrypted; without it there is no payment |
| signing (`finalizeEvent`, `generateSecretKey`) | ~9 KB | ~3.5 KB | No. Slice 1 only verified events; slice 2 signs them |
| `@scure/base` bech32 | 2.0 KB | 0.6 KB | No — a noffer is bech32. See below |
| our own offer/buy/render code | ~5 KB | ~1.5 KB | — |

So a page that takes money costs ~11 KB gzip more than a page that only reads, and 6 of those
are one NIP. That is the honest number to say on stage. The QR encoder is **not** in the cold
load: it is a dynamic `import('uqr')` behind the Buy button, so a visitor who only browses never
downloads it.

**The two dependencies slice 2 added, and why each is not "just one more":**

- **`@scure/base@2.0.0`, pinned exact.** Needed for bech32, which is what a `noffer` is. It was
  already physically in `node_modules` — `nostr-tools`' own `nip19` imports it and pins the same
  exact version — so this pins what was already there rather than adding a package. The
  alternative was ~50 hand-rolled lines including a checksum, and a wrong checksum on the money
  path accepts a corrupted pointer as a valid pubkey.
- **`uqr@0.1.3`, pinned exact, dynamically imported.** The invoice QR. design.md §4's *storefront*
  QR is a build-time constant and still costs the page nothing; this is the other kind — a BOLT11
  that does not exist until the node answers, so it needs a real encoder in the browser. Measured
  against the `qrcode` devDependency we already had: `qrcode` costs 25.6 KB raw / 10.0 KB gzip in
  the bundle, `uqr` costs 10.4 / 3.9. Uppercasing the invoice first (bech32 is case-insensitive)
  puts it in QR alphanumeric mode and drops this invoice from 63 modules to 55. Nearly all of the JS is secp256k1 for `verifyEvent`, which is not optional —
`/CLAUDE.md` requires verifying every inbound event, and dropping it to hit a byte target would
trade the security rule for a number. Only one runtime dependency ships: `nostr-tools`, pinned to
an exact `2.24.3`. `qrcode` is a devDependency — the storefront QR is encoded at build time and
inlined as an SVG `<symbol>`, so it costs the page zero JS.

**Shared:**
- TypeScript throughout
- `nostr-tools` (or NDK if a higher-level cache is wanted — pick one, don't mix). **Pin it deliberately.** v2.24.3 changed `pool.subscribeMany(relays, filter, params)` to take a single filter object rather than an array; passing an array makes strfry reply `bad req: provided filter is not an object` and the subscription silently never fires.
- `@shocknet/clink-sdk` — **measured in slice 2, and the answer is no for the storefront.**

  | Approach | Raw | gzip |
  |---|---|---|
  | Hand-rolled TLV decode + our own 21001 client | **83.2 KB** | **30.9 KB** |
  | `import { decodeBech32, SendNofferRequest } from '@shocknet/clink-sdk'` | 169.0 KB | 59.0 KB |
  | Deep-import only its TLV codec, `…/build/nip19Extension.js` | 85.6 KB | 30.9 KB |

  The middle row is the second `nostr-tools` (it pins an exact `2.15.1` and npm nests it), and
  importing *anything* from the package root drags it in, because the root re-exports `sender.js`.
  The deep-import row avoids that but reaches past the package's own entry point into `build/`,
  costs 4.3 KB raw more than ours anyway, requires TLV `3` where its own spec makes it optional
  (`clink-offers.md:29`), and has no TLV `5` handling at all. Hand-rolled it is —
  `storefront/src/offer.ts`, 126 lines, 14 assertions.

  This says nothing about the builder, which is React and can afford the SDK. Note also that the
  SDK still passes an array to `subscribeMany` (`build/sender.js`) and is only safe because of
  the nested pin — see §13.9 in the findings.
- A Blossom client library for uploads/mirroring
- `nsyte` or `nsite-cli` for deploy during development; in-app deploy for the product
- Watcher: small Node process, no framework

---

## 10. Build plan — vertical slices

Each slice ends in something demoable. If you stall at slice 4, slices 1–3 are still a demo.

**Slice 0 — Spike.** See §11. No product code.

**Slice 1 — Read-only storefront. DONE 2026-08-20, except the deploy.** Lives in `/storefront`:
Vite + TypeScript, no framework, hand-written CSS. Reads kind `30402` + `30405` for one hardcoded
pubkey off four public relays, renders the classifieds template with Blossom-hosted photos, and
prints as a flyer with a tear-off QR strip.

What it actually covers, and what it deliberately does not:

- **`src/listing.ts` is the trust boundary** and the only file with a test. Signature verified,
  sizes bounded, https-only URLs, control and bidi characters stripped, NIP-01 newest-per-address
  so a replayed stale event cannot resurrect a sold item. 14 assertions in `src/listing.test.ts`,
  run with `node --test` — no framework.
- **Image pipeline: the render half only.** srcset from NIP-58 `thumb` tags, aspect-ratio boxes
  from the event's own dimensions, lazy below the fold. The *generator* half — canvas resize to
  N widths, 1-bit dithered thumbs, blurhash — cannot exist until something uploads, so it lands
  in slice 4. Print approximates dithering with `grayscale + contrast` until then.
- **Placeholders are a flat tone, not a blurhash.** No tag in NIP-99 or GammaMarkets carries one;
  NIP-92 `imeta` is where it would live. Pick the tag in slice 4, render it here.
- **No masthead webfont.** design.md §1 wants a display serif subsetted to the characters that
  sale uses — which cannot be built until the sale's text is known, i.e. at deploy. System
  high-contrast serifs until slice 5; zero font bytes shipped.
- **No Buy button.** Slice 2 owns it. Deliberately absent rather than stubbed: design.md §1 says
  this control must read as obviously live, and a dead one is worse than none.
- **`.content` renders as text, not markdown.** 99.md:21 says markdown; a parser is both bytes we
  do not have and an injection surface aimed at hostile input. Revisit only with a renderer that
  emits DOM nodes rather than an HTML string.
- **No fiat → sats conversion.** It needs a price oracle, i.e. somebody else's server, against
  rule 1. Prices display as authored. Slice 2 has to solve this anyway to mint an offer.

**Deployed, and spike q7 is closed with it.** `nsyte` turned out not to be on npm at all
(`/docs/spike-findings.md` §7), and the npm package that *is* there, `nsite-cli`, publishes the
legacy kind `34128` this spec rules out in §6.4. So the deploy is ours:
`/spike/deploy-nsite.ts`, ~150 lines reusing the seeder's Blossom upload and relay publish. That
is slice 5's job brought forward rather than extra work — "deploy from the app" cannot shell out
to a binary from a browser, so this code had to exist either way.

*Demo today, on a real URL with no server of ours:*
**`https://npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws.nsite.lol/`** —
eight listings pulled from public relays, two sold, one free, one multi-unit, one with no photo,
photos from Blossom, and a printable flyer with a tear-off QR strip. `/definitely-missing`
serves our own `/404.html`.

Test data comes from `/spike/seed-listings.ts`, a throwaway identity that publishes the fixture
sale. **Delete that script and `spike/.dev-key` when slice 4 lands a real Signer.**

**Slice 2 — Buy button. DONE 2026-08-20.** A static page takes money. Adds
`storefront/src/offer.ts` (noffer TLV + BOLT11 amount, 126 lines, the second trust boundary),
`storefront/src/buy.ts` (the kind 21001 client), and the buy panel in `render.ts`.

*Demo, and it runs today against the live node:* `cd spike && node check-buy.ts` — the storefront's
own modules, unmodified, against the running Lightning.Pub. It shows the typed decline for a
missing `refund_pointer`, then a real BOLT11 for exactly the listed price, then the page refusing
an invoice whose amount does not match. No backend on either side of it.

What it actually covers:

- **Ephemeral key per purchase**, NIP-44-encrypted payload, `["clink_version","1"]` on send.
  A fresh key is not ceremony: it is what stops the node and the relay linking one buyer's
  purchases to each other, and it is the key the receipt is encrypted to.
- **Lenient on receive.** No `clink_version` required on the response — Lightning.Pub omits it
  (`/docs/spike-findings.md` §2) and rejecting would mean working against no server that exists.
  TLV `3` is optional on read too, per `clink-offers.md:29`, though the reference SDK requires it.
- **All five Offers error codes**, each turned into something a person in a driveway can act on,
  including `code: 1` with Lightning.Pub's non-standard `payer_data` array (re-prompt with the
  named keys) and the `code: 3` → `latest` automatic retry that `clink-offers.md:217-219` asks for.
- **`payer_data: ["refund_pointer"]` required on every offer**, decided here because offers are
  minted here (§7.3). The page collects it in a form field before requesting the invoice, and
  validates an noffer with the real decoder rather than a shape regex.
- **The invoice amount is checked against the price on the page** before the buyer sees it (§6.1).
- **Confirmation with no backend and no polling.** The page keeps its ephemeral key and the
  subscription open, so it — and only it — can read the settlement receipt.

What it deliberately does not do:

- **Payment proven 2026-08-21.** 6,000 sats moved over Lightning into the seller's node and the
  page's confirmation path fired, with no backend on either side. Two remaining honesty notes:
  `bike` (180k) and `couch` (210k) are priced above the node's inbound and will hand a buyer an
  invoice that cannot settle — a fixed-price offer is not range-checked
  (`/docs/spike-findings.md` §1) — and the browser rendering of `showPaid()` has been exercised
  only through `check-buy.ts`, which drives the same `buy.ts` code path but not the DOM.
- **No re-use of an outstanding invoice.** Leaving an item and coming back mints a second one.
  Two unpaid invoices cost nothing and expire in 15 minutes, and the oversell that matters is two
  *different* buyers, which is slice 3's watcher.
- **No CLINK Manage.** Offers are minted over Lightning.Pub's native kind 21000 RPC, not kind
  21003 — see the note under §11 q11 and `/docs/spike-findings.md` §13.4. The builder should
  speak Manage; the throwaway seeder had no reason to.

**First task, and it was not in this slice's one-line description:** the slice-1 listings carried
no `clink_offer` tag at all, so nothing was buyable. `/spike/mint-offers.ts` now mints one
purpose-made offer per buyable item on the local node and `/spike/seed-listings.ts` republishes
the 30402s carrying them. The fixture is deliberately mixed: four items buyable, two sold, one
priced in pesos (cash at the table), one free.

**Slice 3 — Availability. DONE 2026-08-21.** The page derives sold/remaining from the listing
event alone — that half shipped with slice 1 and needed no change. The new work is
`/spike/watch-sales.ts`, a ~40-line Node process on the seller's machine that polls
`GetUserOfferInvoices` per offer over the kind 21000 transport, derives remaining stock from
the count of settled invoices, and publishes the matching pre-signed kind 30402.

**The first hour went to a blocker that is not in the line above**, the same shape as slice 2's
missing `clink_offer` tag: republishing a listing means signing as the seller, and the watcher
must not hold the seller's key. §7.2's "Who signs the republish" is the answer — a pre-signed
**availability ladder**, one signed event per reachable stock state, cut at seed time. The
watcher holds no signing key. That also took spike question 8 (§11) off this slice: a
bunker-signing watcher would have prompted the seller's phone once per sale. q8 closed from
source the same day, in parallel — `perms` is honoured — which makes that watcher buildable but
not preferable (§7.2).

What it covers, and what it deliberately does not:

- **`/spike/ladder.ts`** — `atStock`, `unitsOf`, `targetStock`, 3 exported functions and a long
  comment. Tested in `/spike/ladder.test.ts`, 8 tests / 20 assertions, `node --test`, same style
  as the storefront's.
- **`/spike/pub-rpc.ts`** — the kind 21000 RPC transport lifted out of `mint-offers.ts` rather
  than re-derived, as `/docs/spike-findings.md` §13.13 asked. `mint-offers.ts` now imports it.
- **The ladder goes through the storefront's own trust boundary before it is published.** The
  watcher loads pre-signed events from a file on disk and treats them as hostile: each rung is
  run through `parseListings()` from `storefront/src/listing.ts`, which deletes nostr-tools'
  cached `verified` symbol before checking the signature (findings §13.10) and re-derives
  stock/status from the tags rather than trusting the file's own index.
- **No offer deletion on sellout.** §7.4(a) said to; measuring what `DeleteUserOffer` actually
  does says otherwise — see §7.4 and findings §13.17.
- **No `InventoryPolicy` interface.** See §8.
- **No live storefront updates.** The page still reads once at load. A visitor standing on the
  page while an item sells sees it after a refresh, which is what a printed flyer's QR gets
  anyway. `storefront/src/nostr.ts` notes where a subscription would go.

**Proven with real money on 2026-08-21, for 2,000 sat.** The fixture gained `mugs` — 1,000 sat,
`stock 3`, the same shape as `lamp` at 1/30th the cost per settlement — precisely so the
multi-unit path could be exercised without spending 60,000 sats. Two payments produced
`1 sold -> stock 2` then `2 sold -> stock 1`, each landing on the relays at base+1 and base+2 and
each reading back through the storefront's own parser. What that closed, and the tests could not,
is that the node reports **two distinct settled invoices against one `offer_id`** and the watcher
counts them as two.

*Demo: `node watch-sales.ts` on the seller's machine, `node check-buy.ts yardsale-2026-08-mugs
--pay` on a phone, refresh the page — the count drops, with no server involved. One `mugs` unit
is deliberately unsold so the last rung (sold, `clink_offer` dropped) is available on stage for
1,000 sat. Better still: re-seed first, and watch the watcher put `plants` back to sold on its
own — availability is recomputed from the node, never remembered.*

**Slice 4 — Authoring.** Signer abstraction (NIP-07 + NIP-46), item form, photo upload to Blossom, publish 30402. *Demo: create a listing live.*

**Slice 5 — Deploy from the app.** Generate site files, upload, publish kind 15128. *Demo: full zero-to-storefront in under two minutes.*

**Slice 6 — Admin panel.** Edit, restock, mark sold, view settled sales, private notes via NIP-78.

**Slice 7 — Refunds.** Watcher auto-refunds oversold items using the buyer pointer our page put in `payer_data` (§7.3), paying via a kind `21002` debit from a **separate watcher key** whose grant carries a node-enforced frequency cap (§11 q10). Test the cap and the `BanDebit` kill switch against a funded node *before* the demo. *Demo: the money comes back.*

**Slice 8 — Fallback payment path.** BOLT11/BOLT12 for buyers without a CLINK-capable wallet, degrading to "pay and message me" semantics. This is what makes it usable by actual neighbors next month. Copy must state that a raw-QR payer forfeits the automatic refund, because they never supplied a `payer_data` pointer (§7.3).

**Slice 9 — Polish.** Geohash map of nearby sales, printable item-sticker QR sheet (design §4), masthead editing, 404 page, empty states.

---

## 11. Spike checklist — mostly answered

Full answers with citations live in `/docs/spike-findings.md`; field names live in
`/docs/clink-notes.md`. Summary of where each question landed:

| # | Question | Answer |
|---|---|---|
| 1 | Node funded, channel with inbound liquidity | **CLOSED 2026-08-21.** Inbound *rented* from Olympus rather than funded — an empty Pub can never bootstrap itself. 6,000-sat test payment received. Keep the warning: an unfunded node still reports `max: 10000000`, and a fixed-price offer is not range-checked at all, so a successful invoice request is *not* proof it can receive |
| 2 | Raw request/response captured | **CLOSED.** Request, decline, invoice and receipt all captured on the wire (findings §2, §5) |
| 3 | Multiple offers per account? | **Yes, unlimited, per item.** `clink_offer` per listing; `item_ref` deleted (§6.1) |
| 4 | Decline on custom logic? | **No pre-invoice hook.** Strict mode = delete the offer on depletion, or hold the service key ourselves (§7.4) |
| 5 | Settlement receipt on the wire? | **CLOSED, and worse than the source read suggested.** Kind `21001`, NIP-44 encrypted to the payer, `{"res":"ok"}`, **no preimage on a payment with `internal: 0`** — a real external settlement that a spec-following client would misread as internal (`clink-offers.md:333`). Not seller-readable. Rewrote §7.2 and §7.6 |
| 6 | `payer_data` end-to-end? | **Node side now verified on the wire, not just in source** (findings §6): required key declared at mint, `code: 1` + `payer_data:["refund_pointer"]` when omitted, invoice when supplied. The key name is ours (§7.3). Wallet behaviour **OPEN — needs you**, and secondary: our page is the client |
| 7 | nsite deploy + `/404.html` | **OPEN — needs you** (`nsyte` is a global install). NIP-5A itself read: `/404.html` confirmed required, plus the kind `10063` requirement in §6.4 |
| 8 | Bunker prompt count for 10 items | **ANSWERED 2026-08-21 from source.** **1 prompt** with `perms` granted at connect, **5** without — both Amber and nsec.app honour `perms` for arbitrary kinds, and both key a remembered grant on `(app, type, kind)`, so twenty Blossom auths of one kind cost one approval. Under the ~15 threshold on every path; slice 4 builds as planned. Unmeasured on hardware — one confirmation run remains in findings §8 |
| 9 | Blossom auth per upload | **Batching is permitted** — multiple `x` tags in one kind `24242` event (§5) |
| 10 | Credential scoping for the watcher | **Better than feared.** `admin.connect` is never needed. Three levels exist (Admin / User / Guest); the refund path should use a **CLINK Debit grant held by a separate watcher key**, with a node-enforced frequency cap and `BanDebit` as the kill switch. Residual: observation still needs a User-scoped key, which implies spend authority over that account — so keep the observe key and the refund key separate, and try the credential-free loopback `callback_url` (§7.2) |
| 11 | Guest account with its own offer? | **Yes, and slice 2 did it with no human in the loop.** The dev key spoke to the guest `app.nprofile`, got an account auto-created by `NostrUserAuthGuard`, and minted four offers — no pairing, no approval. **This corrects the `AuthorizeManage` assumption**: that grant gates CLINK Manage (kind 21003) only, not the native `AddUserOffer` RPC (kind 21000, `auth_type = "User"`). See findings §13.4. CLINK Enroll (kind `21004`) is still **not implemented** by Lightning.Pub 0.0.37 |

**One item is still open** — 6, the wallet half only — and it has a `NEEDS HUMAN` block in the
findings with the exact command to run. Question 7 closed in slice 1; 1, 2 and 5 closed with the
2026-08-21 payment, along with the node-side half of 6; 8 was answered from the signers' source
the same day.

**What is left needs a phone, not a node**, and none of it blocks a slice. Question 8's residual
is a confirmation run rather than a discovery: the source says the lever works, and nobody has
watched it work.

See also `/docs/runbook.md` for install gotchas already found (macOS `LND_LOG_DIR` crash loop, `.wallet_secret` permissions, pairing, uptime).

**Rule: do not guess CLINK field names, event kinds, or error codes. Read them from `/docs/clink-notes.md`, the spec files in the CLINK repo, or captured traffic.**

---

## 12. Security requirements

Both Boltz and lnp2pbot were shut down in August 2026 after AI-assisted attackers outpaced small teams. The architecture here is the mitigation — no pooled liquidity, no server holding keys, no public HTTP endpoint of ours. Preserve it:

- No nsec, node credential, or Lightning.Pub pairing ever transmitted to or stored by us.
- No secrets in the repo. No `.env` with keys committed. Use NIP-46 bunker for any CI signing.
- Treat every inbound event as hostile input: validate before parsing, bound sizes, verify signatures before acting.
- Relays can withhold, delay, reorder, and replay — **confirmed, not theoretical**: `wss://relay.lightning.pub` replayed minutes-old kind `21001` events to a fresh subscriber before EOSE, and CLINK Offers defines no request-freshness rule and no single-use construct. Any retry path on the money side must be idempotent, **keyed on the settled invoice / payment hash, never the request event id**.
- The watcher's refund path must have a hard cap and a kill switch. A bug there sends money out. Note the node's outbound is currently **6,000 sats**, all of it created by the one test sale — refunds cannot precede sales, so set the frequency cap against what has actually been sold rather than against a round number. **Let the node enforce both**: a CLINK Debit grant carries a frequency rule (`[number, unit, max]`) checked inside the payment transaction, and `BanDebit` revokes it in one tap. Our code should not be the only thing standing between a bug and the balance.
- The watcher holds **no signing key at all** — it publishes kind 30402 events the seller pre-signed (§7.2). It does hold a node credential to read settlements, and that one is a **separate key** from the seller's identity and Pub account where possible: "User" scope on Lightning.Pub is not read-only, and the same credential that reads settlements can call `PayInvoice`. Slice 3's watcher currently reuses the fixture seller's throwaway `.dev-key`, because on this fixture the seller identity and the node account are one key; slice 7's refund path must not reuse it.
- Never publish the account's default offer: its id is the account pointer, and an unauthorised debit/manage request against a known pointer pushes an approval prompt to the seller's wallet (§6.1).
- The seller's node is the only thing holding funds, and it is theirs.

---

## 13. Demo script (write this before slice 1, revise as you go)

1. Photograph an item. Publish it in the builder. (~30s)
2. Deploy. Show the npub URL resolving. (~30s)
3. Second device: scan, pay, receive.
4. Refresh: item is sold.
5. Show the seller's machine — no inbound ports open, no domain, no certificate, no processor account.
6. Oversell deliberately. Show the automatic refund.
7. Optional: open the same site in Titan over `nsite://` with no gateway at all.

---

## 14. Open questions to resolve as you go

- ~~Do we group a sale by `t` tag or does it need its own event?~~ **Answered in slice 1: kind
  `30405` Product Collection.** See §6.3. Reading the GammaMarkets market-spec first, as this list
  said to, deleted one invented tag and one invented grouping.
- ~~Multi-unit inventory: is `quantity` enough?~~ **Answered: `stock`, standardised at
  `spec.md:124`.** Still open at the *edge*: `stock` is a count with no per-unit identity, so when
  three lamps sell we know how many went, not which. Slice 7's refund path keys on the settled
  invoice, not on a unit, so this does not block — but if per-unit attribution is ever needed, it
  means per-unit `d` tags and the decision belongs before slice 4's authoring UI.
- **Does any marketplace client actually render a kind 30405 collection's `summary`?** We put the
  sale's date and hours there because no tag exists for them. `UNVERIFIED`.
- **Which second Blossom server?** `cdn.satellite.earth` needs an account (401). Blobs on one
  server are one garbage collection away from a broken storefront. See spike findings §9.
- What does the buyer see if their wallet can't speak CLINK? (Slice 8 — decide the copy early. Must include: no `payer_data` pointer means no automatic refund.)
- Where does buyer↔seller pickup messaging live — NIP-17 DMs to the **ephemeral payer pubkey** stored on the invoice as `clink_requester_pub`? Note that key is ephemeral by design, so the buyer's page must keep it or the thread is unreachable. (Was "the receipt's payer pubkey" — we cannot read the receipt.)
- Do we ship a hosted gateway convenience URL, or force gateway choice? (A hosted one is a centralization we should at least name.)
- Is `blind` on a Lightning.Pub offer worth using? It exists in the entity and reaches invoice creation, and is in no CLINK spec. `UNVERIFIED` — find out before enabling it; it may affect receive reliability. Slice 2 mints offers with it unset.
- What is the `p:` offer-id prefix? It routes to a separate "product" system that bypasses `payer_data` validation and amount checks, and is in no CLINK spec. Slice 2 did **not** use it, and the `payer_data` bypass alone probably disqualifies it — a product offer cannot carry a refund pointer, so it cannot be refunded. Confirm before anyone reaches for it.
- **Should the builder mint offers over CLINK Manage (21003) or the native RPC (21000)?** Slice 2 used the native RPC because it needs no grant and the seeder is throwaway. Manage is the portable path, is what "Best Use of CLINK" would reward, and costs one `AuthorizeManage` prompt. Decide before slice 4 writes the authoring UI, and note the spec/implementation disagreement in findings §13.3 (`fields` wrapper) if you take it.
- **Does the printed flyer need the item QRs now?** design.md §4's item stickers encode the item's `noffer`, which exists as of slice 2. But a raw-QR payer supplies no `refund_pointer`, so the node declines them outright — an item sticker today is a QR that cannot be paid. Either the sticker points at the item's page (`#/item/<d>`), or slice 8's fallback path changes what "required" means.
