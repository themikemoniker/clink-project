# Lamppost — Architecture & Build Spec

**Working name:** **Lamppost**, settled in slice 2. Named for the flyer taped to one: paper that
stays current because the QR on it points at a live page. It appears in exactly two places —
the masthead when a sale has no title of its own, and a colophon on the printed flyer.
**Target:** hackathon submission, "Best Use of CLINK"

**Current state and next actions live in `/docs/status.md`** — read that first in a new session.

**Status:** slice 4 shipped (2026-08-21). Authoring is live in `/builder`: a Signer (NIP-07 +
NIP-46), an item form, canvas resize + Blossom upload, and the kind 30402 published to public
relays — with the item's offer minted over **CLINK Manage, kind 21003**. That transport was not a
preference: moving authoring behind a Signer makes Lightning.Pub's native kind 21000 RPC
unreachable, because it is keyed on a raw ECDH secret NIP-46 does not expose (§10, findings
§13.18). Slice 4 also corrected §5's `perms` string (it was missing `21003`), settled §14's image
placeholder tag (NIP-92 `imeta`, and no blurhash — §6.1), and corrected §9's stack: the builder
ships with no React, no Tailwind and no shadcn/ui, and no new runtime dependency at all.

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
7. **We do not custody a seller's funds by default, and never silently.** Their money lands on a
   node we do not operate unless they have explicitly chosen otherwise. See §3.1 for the models
   and §3.2 for the one case where we do hold funds and what that costs. This is a different axis
   from rules 1 and 2 — satisfying those does not satisfy this.

### 3.1 Custody model

**Decided 2026-08-21.** The word "custody" appeared exactly once in this project before that date
(`/CLAUDE.md`, "no-key-custody"), and it referred to keys. Nobody had written down who holds the
*money*. The architecture already assumed an answer in §1, §4 and §12; §6.6 and §11 q11 quietly
assumed a different one. This section settles it.

**The rule: by default, the seller's money lands on a node we do not operate.**

| Model | Who holds the sats | Status |
|---|---|---|
| **1. Seller runs their own Pub** | Seller | **Default, and what the demo runs on.** What §1, §4 and §12 describe |
| **2. Subaccount on our Pub** | **Us** | **Opt-in fallback only.** Never a silent default. Constraints in §3.2 |
| **3. Seller uses somebody else's Pub** | That operator | **Supported, and named.** The app is agnostic; the seller is not |

**What model 2 actually means, from the source rather than from principle.** Lightning.Pub's
multi-tenancy is real (§11 q11) and it is custodial. On a Pub we operate:

- A guest seller's balance is `balance_sats`, an integer column, beside `locked`, a boolean — that
  is the entire `User` entity (`~/lightning_pub/src/services/storage/entity/User.ts:4-22`). Their
  money is a number in our database and a freeze switch we hold.
- The sats are in **our** channels. Payouts run through our LND (`paymentManager.ts:476+`), and an
  account-to-account transfer is `PayInternalInvoice` — a database move, no Lightning involved.
- We would hold `GetSeed`, `BanUser`, `CloseChannel` and the rest of the 21 Admin-scoped RPCs
  (`proto/service/methods.proto`, `auth_type = "Admin"`; see `/docs/spike-findings.md` §10).
- Lightning.Pub's own admin dashboard reports the aggregate of guest balances as `users_balance`
  alongside LND assets in `GetAssetsAndLiabilities` (`adminManager.ts:382-402`). The software books
  them as **liabilities** because that is the accounting term for money you are holding for
  someone else.

Holding other people's money and paying it out on request is the activity money-transmission
regimes are written about. Whether any particular jurisdiction reaches a small community Pub is a
lawyer's question and not ours. What is ours to state plainly: model 2 creates the pooled balance
§12's threat model is built around not having, and it narrows §1's claim from "no custodian exists"
to "no custodian by default." **Both remain true statements. Only the second one is true of a
seller who took the fallback**, and the pitch must not blur them.

**Rules 1 and 2 do not protect against this.** They are about keys, and they hold under every
model — a guest seller's nostr identity key never touches our infrastructure. Custody of funds is
a separate axis, and the shared-Pub design hands us the second without ever touching the first.
That is why it needed its own rule.

**What the single Pub instance in this repo is.** It is the *seller's* node, and the seller is us:
the throwaway identity in `/spike/.dev-key` owns the account, and the 9,000 sats sitting in it are
our own. That is model 1 and it stays model 1. It becomes model 2 the moment a second person's sats
live in it — not when we add a feature, but when someone else's balance appears in that table.
Anyone we knowingly hand the guest `app.nprofile` to is someone we have agreed to hold money for;
that can be a defensible thing to do for people you know, and it is not a product.

**What keeps us out of custody, structurally.** The storefront pays whatever `noffer` the listing
carries, and never learns anything about the destination beyond TLV 0's service pubkey and TLV 1's
relay. The builder's job is to publish a pointer, not to be the destination. Provisioning therefore
stays behind one swappable function (`/docs/spike-findings.md` §11): paste-a-pairing-string today,
CLINK Enroll (kind `21004`) when Lightning.Pub implements it. Nothing in the code needs to know
whose node it is, which is precisely what makes "not ours" cheap to hold to.

**What model 3 costs, and it is a disclosure cost, not an architectural one.** A seller on somebody
else's Pub is custodied by that operator, and the buyer cannot see it: every seller on one Pub
shares a service pubkey in TLV 0 and differs only in TLV 2 (`/docs/spike-findings.md` §11). The
storefront already handles this correctly — a listing's authority is its own signature, never its
payment pointer (`storefront/src/listing.ts`) — so no code changes. What is owed is honesty: the
builder must tell a seller pasting a pairing string that the operator of that node holds their
money until they withdraw it, and the pitch must not describe such a seller as self-custodial.

**On stage:** "the seller's node" means a node the seller controls, and that is what the demo
shows. The honest sentence about the fallback is that a seller who has no node can borrow ours,
that this makes us their custodian for as long as a balance sits there, and that the architecture's
point is that **nobody has to be one** — not that nobody is.

### 3.2 The subaccount fallback (model 2)

**Decided 2026-08-21, after §3.1.** A seller with no Lightning node needs some way to take money,
and "go run a node first" is not a product. So we offer a subaccount on our Pub. This section is
the price of that decision, written down before the code exists.

**The default when a seller pastes no pointer is still "no Buy button", and that is already built.**
`buyableOffer()` (`storefront/src/listing.ts`) returns nothing without a decodable `clink_offer`, so
the item renders as cash-at-the-table — the same path `records` and `boxes` exercise in the fixture.
For a yard sale that is a normal outcome, not a failure. **The subaccount is a thing a seller
chooses, never a thing that happens to them because a field was blank.**

Seven constraints. They are not optional; a fallback without them is the pooled-liquidity target
`/CLAUDE.md` says this project exists in response to.

1. **Explicit opt-in, with the sentence said out loud.** One screen, plain words: *your money sits
   in a node we run until you withdraw it; we can see the balance and we could freeze it.* If that
   sentence is not on the screen, the feature is not shipped.
2. **The subaccount is owned by the seller's own pubkey.** `NostrUserAuthGuard` auto-creates an
   account for whatever key asks (`nostrMiddleware.ts:13-18`, findings §11), so the account belongs
   to the key that signs their listings. We hold the funds; we do not hold the credential. They can
   reach the account from any CLINK client without us.
3. **Withdrawal is CLINK Debits (kind 21002), not the native RPC.** Findings §13.18: a bunker-held
   key cannot construct a kind 21000 request, so `PayInvoice`/`PayAddress` are unreachable from our
   builder. Debits are NIP-44 and therefore reachable. Whether Lightning.Pub requires an account
   owner to hold a self-grant before debiting their own subaccount is **`UNVERIFIED`** — check it
   before any UI promises a withdraw button, because a subaccount you cannot withdraw from is not a
   fallback, it is a trap.
4. **Sweep, do not vault.** Collect a payout pointer at signup — same shape as the buyer's
   `refund_pointer`, and `render.ts` already validates that shape (Lightning address or `noffer`).
   Forward each settlement to it so the resting balance is minutes of exposure rather than the
   length of a yard sale. A pass-through is a much smaller thing to be than a wallet.
5. **Cap it, and let the node enforce the cap.** Same requirement §12 puts on the refund path, same
   mechanism: a Debit grant carries a frequency rule checked inside the payment transaction, and
   `BanDebit` is the kill switch (findings §10). Our code must not be the only thing between a bug
   and other people's money.
6. **A stated exit, and it is cheap.** When a seller gets their own node they re-mint offers there
   and republish their `30402`s. The `noffer` is a tag, so migrating custody is a republish, not a
   migration. Say this at signup — a fallback nobody can leave is not a fallback.
7. **It does not scale, for reasons that have nothing to do with custody.** Every seller on our Pub
   draws inbound from the same rented channel — 98,160 sat, leased to 2026-11-19 (findings §1). Two
   active sellers exhaust it, and an exhausted channel hands buyers valid invoices that cannot
   settle. Cap the number of fallback sellers at what the channel can carry, and put the lease
   expiry where someone will see it.

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
- **NIP-46 `perms` was the lever, and it works.** **Answered 2026-08-21** from both signers' source (`/docs/spike-findings.md` §8). Amber and nsec.app each honour `perms` for arbitrary kinds, and Amber's *default* sign policy is the one that persists them. Send `perms=get_public_key,nip44_encrypt,nip44_decrypt,sign_event:30402,sign_event:30405,sign_event:21003,sign_event:15128,sign_event:10063,sign_event:24242,sign_event:30078` — note `30405`, which the pre-slice-4 draft of this line omitted, note **`21003`**, which slice 4 added because the builder mints each offer over CLINK Manage and that is a signed event (the storefront's kind 21001s are signed by a fresh ephemeral key per purchase, which no bunker ever sees), and note that neither signer accepts a bare `sign_event` with no kind. The live copy is `PERMS` in `/builder/src/signer.ts`.

**An item is `1 + units` signatures, not one — and slice 4 is where that reaches a UI.** The
availability ladder (§7.2) pre-signs every future stock state, so an item with stock 3 costs
four kind 30402 signatures. Ten items averaging two units is 30, not 10. All the same kind, so a
remembered `sign_event:30402` grant still covers them for **one** approval — the budget is
unchanged, the *expectation* is not. `/builder` therefore shows the real count before the seller
starts: a seller told "one approval" who then sees thirty is a seller who abandons a publish
halfway and leaves a listing with no ladder behind it.

**Slice 3 added that term, and removed a worse one.** The ladder pre-signs
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
| `g` | geohash. ~~powers the "sales near me" map~~ **There is no map — cut in slice 9, findings §31.** It powers one thing: the sale's own location as an RFC 5870 `geo:` link on the masthead, which the buyer's OS hands to their own map app. One tag, at 7 characters (±76 m). A proximity query would need several at decreasing precision, which is a NIP-CC geocaching convention (`CC.md:53`) and not a NIP-99 one. **Slice 9 is also the first thing that ever decoded this tag, and it found the fixture's had been 5.94 km wrong since slice 1** |
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
| `imeta` | NIP-92 `92.md`. **The image-placeholder tag slice 1 deferred, resolved in slice 4.** Variadic space-delimited key/value pairs; MUST carry `url` plus one other field, and MAY carry any NIP-94 field (`94.md`) — which is where `blurhash`, `x`, `dim`, `alt` and `fallback` are actually defined. Nothing in NIP-99 or GammaMarkets carries any of them |

**We write `imeta`, and we deliberately do not write `blurhash`.** The tag carries `url`, `m`,
`x` (the blob's sha256, so the storefront can check a fetch against its content address — the
generalised lesson of findings §13.11), `dim`, `alt` (accessibility, and no other tag here has
anywhere to put it), and one `fallback` per additional Blossom server, which is the standard
answer to blobs living on exactly one server the moment a second one exists. A blurhash would
need an encoder in the builder and a decoder inside the storefront's gzip budget (§9), to
replace a flat tone that already works — so the field name is pinned with a citation and shipping
one later is an hour rather than a research task. One caveat: `92.md` says each `imeta` SHOULD
match a URL in the event's *content* and ours match `image` tags, so a generic NIP-92 client will
not look for them. Inventing our own tag instead is exactly what §14 exists to prevent.

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

**The builder authors this event as of slice 9, and until then nothing in it did.** `30405` was
written by `/spike/seed-listings.ts` and by nothing else, while `builder/src/listing.ts` put
`["a","30405:<seller>:yardsale-2026-08"]` on every item it published — so every seller who was
not us signed items into a collection that existed only for us, and their storefront rendered its
own fallback name as the masthead. `builder/src/sale.ts` + `publish.ts` `publishSale` close it:
one signature, and no new bunker approval, because `sign_event:30405` has been in `PERMS` since
slice 4 (findings §8).

Two properties of this event that are load-bearing and easy to lose:

- **It is a replacement, so every member goes in every time.** Publishing a subset silently
  un-lists the rest — the items survive on the relays and `orderBySale` renders them as strays at
  the foot of the page, which is a demotion nobody asked for rather than a deletion. `publishSale`
  refuses to publish if the parser reads back fewer members than it was handed.
- **Its `d` is every item's `d` prefix**, via `listingD`. That makes it the most dangerous string
  in the builder: `admin.ts` `draftFrom` refuses to edit an item whose `d` falls outside the
  prefix, so changing it orphans everything the seller has published. It is therefore **not a form
  field** — it is read back off the seller's own published collection, and defaults to `sale` (no
  date in it) for a seller who has none yet. §10 slice 9.

### 6.4 Site hosting — NIP-5A

- **kind 15128** — root site manifest for the pubkey (one site per seller). Use this for v1.
- **kind 35128** — named site manifest, if a seller wants multiple sales.
- **kind 34128** — legacy, one event per file. **Do not use.** One signature per file is a UX disaster with a bunker.

Manifest carries `path` tags mapping absolute paths to sha256 hashes (`["path", "/abs/path", "<sha256>"]`, `5A.md:45-49`), optional `server` hints for Blossom, and `title`/`description`. Provide `/404.html` — NIP-5A requires host servers to fall back to it (`5A.md:196`), and client-side routing depends on it.

Two things the pre-spike draft missed:

- **`x` aggregate hash** (`5A.md:51`, `67-85`) — `["x", "<sha256-hex>", "aggregate"]`, the sha256 of the sorted `"<hash> <path>\n"` lines. Recommended, and cheap: it makes a site version indexable and lets us tell two deploys apart. Emit it.
- **Blob discovery will 404 without a server list.** A host server prefers `server` tags on the manifest, then **MUST** try the author's BUD-03 kind `10063` user-server list, and if there is neither it **MUST return 404** (`5A.md:186-190`). So the deploy flow publishes a kind `10063` (or emits `server` tags, or both). One extra signature, once per seller.

Kind `5128` manifest snapshots also exist (`5A.md:59-65`) — a regular event pinning one version. Not needed for v1; useful later for "show me the sale as it was."

Blobs go to **multiple** Blossom servers. They garbage-collect. Mirror — and as of slice 5 we
actually can. Slice 1 found exactly one public server that would accept an nsite's HTML and
concluded that mirroring the site was advice we could not follow; **slice 5 found the cause was
our own BUD-11 auth header**, which we were encoding as the base64url the spec requires and
three of the four working servers reject. Standard base64 gets `cdn.hzrd149.com`,
`blossom.primal.net`, `files.sovbit.host` and `nostr.download`, all four verified serving every
blob of both deployed sites (`/docs/spike-findings.md` §9, §13.23).

Mirroring also turns out to be nearly free of signatures, contra §5's pessimism: BUD-11 11.md:25
makes a token with no `server` tag valid on every server, so **N blobs across M servers is N
signatures**. The dead lever was batching *blobs* into one token, not reusing one token across
*servers*.

**One root site per pubkey** (`5A.md:16`), which is sharper than it reads: a second kind 15128
under the same key silently replaces the first. The builder is an nsite too (rule 5), so it
gets its own identity rather than sharing the seller's. Findings §13.22.

**Deploy is implemented** in `/builder/src/deploy.ts`, with `/spike/deploy-nsite.ts` as the Node
driver over it — the §13.13 lift pattern, so the browser and the script cannot diverge on the
aggregate hash. It refuses to publish a manifest unless at least one server holds a complete
copy — a manifest whose blobs are missing is a site that 404s, and failing loudly at deploy
beats discovering it from a buyer in a driveway. `/spike/check-deploy.ts` verifies a deploy
against the relays and Blossom, and reports the gateway separately as the cache it is.

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

**Answered in slice 2 (§11 q11): yes, a guest account holds its own independently-addressable
offer.** One community Pub can therefore host an entire market of sellers.

**This section used to stop there, and stopping there was the mistake.** It read as pure unlocked
scope — "builder others can use no longer requires every seller to run a node" — and never priced
what running that Pub would mean. It means custody. A guest seller's balance is an integer and a
freeze flag in the operator's database, the sats are in the operator's channels, and the Pub books
the aggregate as a liability. **§3.1 is now the governing section**, and §3.2 scopes the one case
where we do it: an opt-in fallback for a seller with no node, never a silent default.

What survives here is the capability, not the business: a seller may use *somebody else's* Pub
(§3.1 model 3), and the app is deliberately agnostic about whose node answers an `noffer`. Two
consequences to design around, both from `/docs/spike-findings.md` §11:

1. **Identity does not come from the payment pointer.** Every seller on one Pub shares a service
   pubkey in TLV 0 and differs only in TLV 2, so a buyer cannot tell from an `noffer` which seller
   they are paying — only which node. Authority comes from the signature on the kind `30402`.
   `storefront/src/listing.ts` already works this way.
2. **Liveness and custody are shared.** One Pub down is every seller on it down, and one operator
   holds every balance on it. The builder must say so, in words, to a seller pasting a pairing
   string.

---

## 7. Flows

### 7.1 Publish

```
Seller in builder app
  → uploads photos            → Blossom (ONE signed 24242 auth for the whole batch)
  → authors items             → kind 30402 events, signed, published to relays
  → app generates static site → files hashed, uploaded to Blossom
  → app publishes manifest    → kind 15128, signed
Buyer opens npub1xxx.<gateway>        (Titan's nsite:// does NOT reach us — see §14)
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

  **NARROWED 2026-08-24 by roadmap item 25, and this line was too strong.** Driven at the live node, free, by `node spike/check-empty-pointer.ts`: a request with the key **absent** is declined `code 1` as this section says, and `{"refund_pointer": ""}`, `{"refund_pointer": " "}` and `{"refund_pointer": "not-a-pointer"}` were each issued a BOLT11. `ValidateExpectedData` checks only `typeof payerData[key] !== 'string'` (`offerManager.ts:148-152`), so what the node enforces is that the key is **present and is a string** and nothing about the value. What is true, and what the rest of this section actually rests on: **the declining is ours, not the node's.** `storefront/src/render.ts` gates the Buy form on `isPointer` before it will request an invoice, so no payment routed through our page can be unrefundable. A client that is not ours can get an invoice with a junk pointer, and the settlement it produces is a `queued` journal row no human can act on — which is precisely the outcome the slice-8 block at the end of this section rejects "make the key optional" for. That block's reasoning is unchanged; only this bullet's attribution was wrong.
- Someone who scans the raw QR with a generic wallet cannot pay at all. Deliberate trade-off, **re-affirmed in slice 8 after the refund path existed to test it** — see the block at the end of this section.

The refund itself is a kind `21002` debit from the watcher's key against the seller's `ndebit` pointer, capped by a node-enforced frequency rule — see §11 q10 and §12.

This is a feature, not an apology. Demo it. Sending money back to someone who never gave you an invoice is the single most persuasive thing in this project.

**Built in slice 7. Three things the paragraph above did not have, and each was a decision rather than a detail.**

1. **A pointer is not a destination, and the two kinds cost different things.** `render.ts` accepts a Lightning address *or* an noffer, and its placeholder is `you@yourwallet.com` — so the address is the common case. An noffer resolves to a BOLT11 over a relay, by `storefront/src/buy.ts` with the roles swapped: the watcher becomes the paying client and the *buyer's* node is the service. **A Lightning address resolves over LNURL-pay, which is HTTPS to a host we do not control.** It is not our server so it is not a rule 1 violation, but it is the only third-party dependency anywhere in this project and the first time a refund's success depends on somebody else's uptime.

   The decision: **resolve both, and queue what cannot be resolved.** A failure is a `queued` row in `spike/.refunds.json` that the watcher reprints every five minutes, not a swallowed error — so a dead LNURL host becomes money the seller can hand over at the table rather than money that quietly stayed put. The buy form's hint text now says which is which, because a buyer who is asked for a pointer deserves to know that one of the two answers has a server in it.

   The line for the stage, before a judge finds it: *a Lightning address is a hostname, and a hostname is a server. The noffer path has none.*

2. **A refund is the project's first write, and the node has nowhere to record one.** §8's "the node holds the state" works because reading is idempotent for free; paying is not. The failure is one sentence — pay, crash before recording, restart, recompute the same oversell from the node, pay again.

   The candidate tried first was CLINK's `k1`, the only single-use construct in the protocol: derive it from the settled invoice and a double refund becomes something the *node* refuses. **It collapsed on inspection, exactly where it was marked `UNVERIFIED`.** Lightning.Pub's k1 set is an in-memory array with a **5-minute TTL**, lost on restart, and it is consumed *before* validation so a refused request still burns it (findings §13.28). The derived `k1` is kept as a second layer against a crash loop; the durable answer is a journal in `spike/.refunds.json`, keyed on the settled invoice — which is the settlement identifier `/CLAUDE.md`'s idempotency rule actually names.

   **It is written before the payment, not after**, because the dangerous crash is "while paying" rather than "after paying". A row left `pending` means we do not know whether money moved, and it is never retried automatically — retrying might double-pay and dropping it might strand a buyer, so it is printed until a human reconciles against the node.

3. **The cap and the kill switch are the node's, and they were watched firing.** `spike/check-refund.ts` drops the grant's frequency rule to 1 sat, sends a 10-sat debit, and records `{"code":5,…,"range":{"min":1,"max":1}}`; then restores the cap, calls `BanDebit`, and records `{"code":1,"error":"Request Denied Warning"}` on a debit that was well within it. Both checks run inside the payment transaction, so a refusal is a rollback. Nothing is paid to prove either. Findings §13.29.

**SLICE 8 RE-DECIDED THE TRADE-OFF ABOVE, WITH REFUNDS ACTUALLY BUILT, AND KEPT IT.** The line
"a payment that would be unrefundable is therefore declined rather than accepted" was a slice-2
decision made before anything could send money back. Slice 8 is the slice entitled to revisit it,
and it does not — for a reason that turned out to be stronger than the original one.

**The alternative is not "accept the payment and skip the refund". It is "accept the payment and
generate a permanent alarm".** An offer minted `payer_data: []` produces a settled invoice
carrying no pointer, so `spike/refund.ts` `resolvePointer` answers
`{queue: true, error: 'no refund pointer on the settled invoice'}` and the watcher writes a
`queued` row. `queued` means *a human is needed*, and it is reprinted every five minutes — but no
human can act on this one either, because nothing on that invoice identifies who paid. A
deliberate design choice would arrive at the seller's terminal disguised as an unresolved bug,
forever. Shipping that would need a fifth journal state meaning *deliberately unrefundable*, and
a state that exists only to say "ignore me" is a strong signal the thing above it is wrong.

**And the middle option does not exist at the node.** "Make the key optional, so a wallet that can
supply a pointer does and one that cannot still pays" is not implementable: `payer_data` on an
offer is a required-key list with no optional tier (`offerManager.ts:139-142`), and a key the
offer does not declare is **discarded rather than stored** (`offerManager.ts:276` writes only
`validated`, built from the declared keys alone). A generous wallet volunteering the pointer
against a permissive offer would have it dropped on the floor. Findings §6.

⇒ **The requirement stays, and the page becomes the fallback.** Every route to paying an item
funnels through the form that asks for a pointer — including the printed sticker, which encodes
the storefront deep link rather than the raw `noffer` (design.md §4). The stage line: *we decline
money we could not give back, and the reason you can only pay here is the reason you can be
refunded.*

### 7.4 Strict mode (build behind the same interface)

The intent stands: return an error instead of an invoice for a depleted item, so no payment occurs and no refund is needed.

**Lightning.Pub has no pre-invoice hook.** There is no plugin, webhook, or rule engine in front of invoice creation; the only decline paths are fixed-function (amount out of range, unknown offer, negative price, missing required `payer_data`, over-long description), and the offer's `callback_url` fires *after* settlement, not before (`/docs/spike-findings.md` §4). So strict mode is not a config flag on the node.

Two reachable implementations:

- **(a) Delete the offer on depletion — was the default, and slice 3 did NOT ship it.** The idea: when the watcher sees the last unit sell, it deletes the item's offer (CLINK Manage `delete`, or the `DeleteUserOffer` RPC), so the next request returns `code: 1` — a clean, spec-shaped decline that a buyer's client can display. It is one RPC from code that already exists.

  **Measured while building slice 3, and it is disqualifying as written** (`/docs/spike-findings.md` §13.17). `DeleteUserOffer` drops only the `UserOffer` row (`offerStorage.ts:27-29`); the settled invoices survive. But `GetUserOfferInvoices` looks the offer up first and throws `"Offer not found"` when it is gone (`offerManager.ts:89-93`), and that RPC is the **only** way the stored `payer_data` leaves the node — the sole other reader is the offer's own settlement `callback_url` (`paymentSideEffects.ts:27`), which our offers leave empty. So deleting a depleted offer permanently destroys the buyer's refund pointer for every invoice under it, and blinds the watcher to the item. An oversell *is* a payment that settles after depletion, so this would break slice 7 in exactly the case slice 7 exists for.

  Two candidates that keep the invoice history, neither tested: `UpdateUserOffer` the price outside the payable range instead of deleting the row, or set a loopback `callback_url` at mint time so the pointer is delivered at settlement and never has to be read back. ~~**Decide before slice 7.**~~

  **DECIDED IN SLICE 6, and the answer is neither of those: nothing is done to the offer at all.**
  "Mark sold" publishes the item at stock 0, and `ladder.ts` `atStock` already strips the
  `clink_offer` tag at that rung — so the listing stops advertising a payable pointer and every
  storefront stops drawing a Buy button. The offer row itself is left untouched on the node.

  What that buys, in order of importance:
  - **The refund pointer survives.** `GetUserOfferInvoices` still resolves the offer, so slice 7
    can still read the `payer_data` of a payment that lands late. That is the whole case slice 7
    exists for.
  - **It costs no node call.** No Manage `update`, no `delete`, no new failure mode on a path the
    seller is using at a table with a phone. `builder/src/publish.ts` enforces it at one choke
    point: at stock 0 the offer is dropped whatever the caller passed.
  - **It works on the fixture's items**, whose offers Manage cannot touch at all (findings §13.20).
    An implementation that required a Manage `update` would have been unusable on the live demo.

  What it does not buy: the window stays open. A buyer holding a cached page can still reach the
  offer and pay it. That is the §7.3 oversell, it is unchanged, and the honest line on stage is
  that closing it properly needs (b) below — holding the CLINK service key ourselves — not a
  cleverer use of the offer row.
- **(b) Hold the CLINK service key ourselves.** The shop daemon becomes the pubkey in the `noffer`'s TLV `0`, evaluates inventory, and only then asks the Pub for an invoice. True strict mode with no race — at the cost of making the daemon a required always-on component and moving the service identity off the Pub.

v1 was going to ship (a) and now ships neither. The oversell window in slice 3 is what the storefront closes on its own — a sold item draws no Buy button — plus the watcher shouting `OVERSOLD` at the seller when a second settlement lands. "Strict" was always going to mean "best-effort with a much smaller window," not "atomic"; today it means best-effort. Do not oversell it on stage.

### 7.5 Restock / edit

Seller changes quantity or price in the admin panel → app republishes the 30402 with the same `d` tag → relays replace it → every storefront reflects it on next load. ~~One signature.~~

**Built in slice 6, and "one signature" was wrong by the width of the ladder.** There is no edit
event in nostr — NIP-01 replaces on (kind, pubkey, `d`) and there is no update verb — so an edit
is a fresh publish of the whole item. The real cost:

- **`1 + units` signatures**, because the availability ladder is cut from one version of the
  listing (§7.2) and an edited listing needs an edited ladder. Restock *is* an edit: changing the
  quantity changes `units`, which changes how many rungs there are.
- **Zero offer mints, unless the price changed.** The edit carries the item's existing
  `clink_offer` forward, re-deriving the price from the pointer's own TLV 4 rather than trusting
  the listing (`builder/src/admin.ts` `reusableOffer`). Two reasons, both load-bearing: Manage
  `create` is explicitly not idempotent (`clink-manage.md:226`), so a seller fixing a typo three
  times would otherwise leave three payable offers on their node; and the fixture's five offers
  were minted natively and Manage cannot re-create them under the same identity anyway
  (findings §13.20). A price change falls through to a fresh mint, and the superseded offer is
  left alone rather than deleted — §7.4.
- **A new `.ladder.json`, and a watcher restart.** Not optional, and the failure if it is skipped
  is silent: the rungs the watcher is holding are now *older* than the listing on the relays, and
  a relay answers OK to a replaceable event it does not store. The watcher would log `3/4 relays`
  forever while the item stayed on sale after it sold. Findings §13.26. `spike/ladder.ts`
  `isStale` catches it at watcher startup and refuses that item loudly; the builder's copy says
  so at publish time.
- **The slug is read-only during an edit.** Changing it would publish a *second* item and leave
  the original on the relays with a ladder nothing re-cuts.

Two kinds of item are deliberately not editable in the builder's form, because a round trip
through it would lose data rather than change it: anything priced in fiat (this project has no
conversion and no oracle — §6.1 — so an 80 MXN item would republish as 80 sats), and anything
whose `d` falls outside this sale's prefix. `spike/check-admin.ts` drives the real published
events through the round trip and fails on anything *lost*, which is the asymmetry that matters:
gaining a tag is fine, losing one is unrecoverable.

### 7.6 Pickup

The pre-spike draft had the seller verifying the buyer's settlement receipt offline. **The seller cannot decrypt it** — it is NIP-44 encrypted to the payer (`/docs/spike-findings.md` §5). Offline pickup proof has to be designed, not inherited from CLINK.

The cheap version, and the one to build: the invoice the node stores carries the buyer's ephemeral request pubkey (`clink_requester_pub`). The buyer's page keeps that ephemeral key. At the driveway the seller's device shows a QR challenge, the buyer's page signs it with that key, and the seller checks the signature against the pubkey on the settled invoice — which the watcher already synced. No signal needed on either side once both have loaded.

~~Decide this before slice 6;~~ until then, pickup is "seller looks up the sale in the admin panel," which is fine for a demo and needs signal.

**Still unbuilt after slice 8, and slice 8 is where its cost got named.** Both this and §14's
pickup-messaging question depend on the same thing: the buyer's page keeping the ephemeral key it
minted in `buy.ts`, which today is dropped when the page navigates away (that is the
`KEY HANDLING NOTICE` there, and it is correct as it stands). Persisting it is a new decision
about storing key material in a browser, and `/CLAUDE.md` rule 2 is watching. **If it is ever
kept, keep it for both** — one persisted key buys offline pickup proof *and* a reachable buyer,
and two separate decisions about the same key is how one of them ends up with weaker handling.

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

**Builder + admin** — loaded once by a motivated user. **Corrected in slice 4: shipped without
React, Tailwind or shadcn/ui.**
- Vite + TypeScript, hand-written DOM calls and hand-written CSS — the same shape `/storefront`
  already proved. Two runtime dependencies, both already pinned elsewhere in this repo:
  `nostr-tools` and `uqr@0.1.3` (dynamically imported) for the `nostrconnect://` QR. Amber
  connects by scanning that code — a URI shown as text on a laptop is not a path a phone can
  take — so the QR is what makes the one-approval flow reachable at all.
- Slice 4's builder is one form, an upload list and a connect screen. Native `<form>`, `<label>`,
  `<input>`, `<output>` and `<dialog>` give the focus order, labelling and keyboard behaviour
  design.md §5 wanted Radix for, and ~200 dev packages for that is a poor trade in an app that
  must itself deploy as an nsite (rule 5) and is therefore fetched blob by blob from a gateway.
- ~~Revisit at slice 6, which is where the admin panel actually wants tables, dialogs and
  toasts.~~ **Slice 6 revisited it and the answer is no. This line is closed, not deferred
  again.** The admin panel wanted one list, two buttons per row and a textarea — it reuses the
  item form as its edit form, because in nostr an edit *is* a re-publish under the same `d` and
  there is no second form to build. It cost **+4.3 KB gzip in total** (53.0 → 57.3). React plus
  ReactDOM is ~45 KB gzip before a single component, i.e. **ten times the feature it was
  supposed to help build**, in an app that is itself fetched blob by blob from a cold gateway
  (rule 5) and already carries a built storefront in `public/site`. There are no tables, and the
  status line has been the toast since slice 4.
- Measured at the end of slice 5: **148.3 KB raw / 52.9 KB gzip** cold (+2.1 KB gzip for the
  deploy module), plus a 4.2 KB gzip QR chunk now fetched on the bunker path *or* a deploy, and
  2.4 KB CSS. No budget applies here the way it does to the storefront — design.md §5 says
  "whatever it takes" — but it is worth knowing it is ~1.6x the storefront and every KB is still
  a blob fetch.
- **It also carries a built copy of the storefront**, in `public/site` (5 files, ~99 KB raw),
  put there by `bundle-storefront.mjs` and deployed as blobs in the builder's own manifest.
  Those are NOT in the bundle above and are fetched only when somebody presses Deploy — see
  §10 slice 5 for why that beats inlining them as raw assets.

~~- Vite + React + TypeScript~~
~~- Tailwind + shadcn/ui (forms, dialogs, tables, toasts, upload progress)~~

**Generated storefront** — loaded cold from a gateway, on mobile data, in a driveway:
- Hand-written CSS, no component library. Newspaper classifieds aesthetic.
- **No framework at all.** Slice 1 shipped Vite + TypeScript + hand-written DOM calls. Preact was
  not needed and was not added; revisit only if slice 2/3 state gets genuinely hairy.
- Budget: ~~~30KB JS~~ ~~32 KB~~ **33 KB gzip JS cold**, ~10KB CSS. Justify every dependency. The
  number has been raised twice, deliberately and with the reasoning written down both times —
  slice 8 (30 → 32) and slice 9 (32 → 33). See "the budget moved" below rather than treating this
  line as the whole story.
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
an exact `2.24.3`.

**Slice 5 moved the storefront QR from build time to deploy time and removed the `qrcode`
devDependency with it.** The QR encodes the site's own URL, which contains the seller's npub —
so encoding it at build time is exactly what made the storefront a per-seller artifact. It is
now injected into the `<!--QR-->` marker in `index.html` by `builder/src/deploy.ts`, using the
`uqr` both apps already ship. The page still carries no encoder; what changed is the cold HTML,
**441 B → 2,354 B gzip**. That +1.9 KB gzip is the honest price of one generic build, and it
buys the whole of slice 5.

Measured at the end of slice 5, and the JS is unchanged from slice 2 apart from the bech32 npub
decode that replaced the build-time constant:

| Asset | Raw | gzip |
|---|---|---|
| JS, cold load | 83.7 KB | **31.0 KB** |
| JS, QR chunk (Buy button only) | 10.3 KB | 3.9 KB |
| CSS | 5.8 KB | 2.0 KB |
| HTML as built (no QR) | 0.7 KB | 0.4 KB |
| HTML as deployed (QR injected) | 10.6 KB | 2.4 KB |

**The budget moved in slice 8, from ~30 to 32 KB gzip, and this is the reasoning rather than a
quiet edit.** It had drifted past 30 three times without anyone saying so, which is the thing
worth fixing — a budget nobody restates is a budget nobody is keeping.

| when | JS gzip cold | what the increment bought |
|---|---|---|
| slice 1 | 19.6 KB | reading listings off relays |
| slice 2 | 30.9 KB | **taking money** — NIP-44 (6.0) plus signing (~3.5) |
| slice 5 | 31.0 KB | one build for any seller: a bech32 npub decode replacing a build-time constant |
| slice 7 | 31.31 KB | `LN_ADDRESS` lifted so the page and the watcher agree, and honest hint text |
| slice 8 | **31.61 KB** | `noBuyReason` and the §10 copy — two items on the live fixture stopped being dead ends |
| slice 9 | **32.01 KB** | `geoUri` (0.15) — the sale's location, decoded and tappable, replacing §10's cut map — plus `missingItemNote` and the `g` parse: a scanned sticker for an item that is gone stops landing on a silent index |

Measured 2026-08-21: **32.01 KB gzip JS** cold + 2.12 CSS + 2.4 HTML as deployed, plus a 3.91 KB
QR chunk fetched only by a buyer who taps Buy. So a visitor who browses pulls ~36 KB and a
visitor who buys pulls ~40.

**Slice 9 spent the headroom and then went 10 bytes past the line, and this is the disclosure
rather than a rounding.** Slice 8 left "~0.4 KB of headroom" and said the next slice that wanted
it had to say what it was spending it on; slice 9 spent 0.40 and landed at 32.01 against a 32.00
ceiling. Two of the three obvious trims were taken because they were also simplifications — the
masthead decodes the geohash once instead of twice, and the `d` bound is applied once instead of
twice — and gzip did not move. **The third was refused on this section's own precedent**: the
only remaining lever is copy, and shrinking the sentence that tells somebody who scanned a
sticker why the thing is not there would be deleting an explanation to improve a statistic. That
is the identical trade §9 already refuses for `verifyEvent`.

⇒ **The ceiling moves to 33 KB, with the same condition attached.** ~1 KB of headroom, and the
next slice that wants it says what it bought. If that ever stops being written down, the number
has stopped being a budget — which is what this table exists to make visible.

**Two commands, two numbers, and every figure in these docs is vite's.** `npm run build` reports
31.61 kB; `npm run size` gzips at level 9 and reports 31,373 bytes. Both are correct and they
differ by ~0.7% because of the compression level. The tables here have always used vite's, which
is the more conservative of the two — do not mix them mid-comparison, which is how a slice
appears to have shrunk the bundle by changing which command it ran.

**Why 32 rather than a diet.** Nearly all of it is secp256k1 for `verifyEvent`, which
`/CLAUDE.md` requires on every inbound event; the next largest piece is NIP-44, without which
there is no payment. Neither is negotiable, and the only remaining lever is copy — which means
hitting 30 would mean deleting the sentences that tell a buyer why they are being asked for a
refund pointer, in order to improve a statistic. That is the same trade §9 already refuses for
`verifyEvent`, so it is refused here too. 32 was a real ceiling with ~0.4 KB of headroom, and the
next slice that wanted a KB had to say what it was spending it on. Slice 9 did, and the table
above is where it said it.

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

  This says nothing about the builder, ~~which is React and~~ which can afford the SDK — the
  builder is **not** React (corrected in slice 4, closed in slice 6 above). Note also that the
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
sale. ~~Delete that script and `spike/.dev-key` when slice 4 lands a real Signer.~~ **Reversed
2026-08-21: the key stays** — it is the storefront's own npub and the owner of the node account,
and the watcher needs it to read settlements. The current reasoning is in the header of
`spike/seed-listings.ts`.

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

- **Payment proven 2026-08-21.** 6,000 sats — 8,000 in total across three settled invoices by the
  end of that day, 9,000 across four as of 2026-08-23 — moved over Lightning into the seller's node and the
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

**Slice 4 — Authoring. DONE 2026-08-21.** Lives in `/builder`: Vite + TypeScript, no framework,
zero new runtime dependencies. A Signer (NIP-07 + NIP-46), an item form, canvas resize + Blossom
upload, an offer minted over **CLINK Manage**, and the kind 30402 published to four relays.

**The blocker underneath the one-line description was the same shape as slices 2 and 3's: the
transport.** Moving authoring behind a Signer makes Lightning.Pub's native kind 21000 RPC
**unreachable** — it is encrypted with the Pub's own v1 envelope, keyed on `sha256` of the raw
ECDH x-coordinate, and NIP-46 exposes no raw-ECDH method (`/docs/spike-findings.md` §13.18, read
before the slice and measured during it). Kind 21003 is NIP-44 v2 and a bunker signs it happily.
So §14's "Manage or the native RPC?" was not a preference to weigh: **Manage is the only
offer-minting transport a NIP-46 seller can drive.** Two corrections fell out of building it —
the `AuthorizeManage` grant costs **zero** prompts rather than one (§13.19), and Manage and the
native RPC see different sets of offers (§13.20).

What it covers, and what it deliberately does not:

- **`/builder/src/signer.ts`** — one `Signer` type, both paths behind it. nostr-tools 2.24.3
  already declares the interface and implements the NIP-46 half (`BunkerSigner`, with
  `nip44Encrypt`/`nip44Decrypt`), so this is ~40 lines of glue rather than an abstraction of our
  own. The NIP-46 client key is persisted in `localStorage`, without which the seller re-approves
  the connection every session (findings §8).
- **`/builder/src/manage.ts`** — the kind 21003 client and an `nmanage` decoder. The reference
  SDK's `SendNmanageRequest` takes a raw `privateKey`, so it cannot be used with a Signer at all.
- **`/spike/authorize-manage.ts`** — the one-time bootstrap. Manage cannot issue its own grant,
  because `AuthorizeManage` is itself a kind 21000 call. Run once, at the desk, with the raw key.
- **`/builder/src/photos.ts`** — slice 1's deferred generator half: canvas resize to the same
  1200/480/160 the seeder faked, one signed kind 24242 per blob (never batched — findings §9),
  and the returned sha256 compared against ours every time.
- **The ladder is cut here now, and delivered as a file.** An item is `1 + units` signatures
  (§5). The rungs cannot go on a relay — publishing the stock-0 rung marks the item sold
  instantly — cannot go through a backend (rule 1), and cannot be NIP-78-encrypted to self,
  because the watcher holds no key to decrypt with, which is the whole point of slice 3. So the
  browser hands the seller a `.ladder.json` in exactly the shape `/spike/watch-sales.ts` already
  reads, and they drop it next to the watcher. Nothing on the watcher side changed.
- **Nothing is published until it survives `parseListings()`** — the storefront's own trust
  boundary, the same door slice 3's watcher makes the ladder go through. A listing whose price
  and whose minted offer disagree fails here rather than reaching a relay with a dead Buy button.
- **The `imeta` tag, with no blurhash.** See §6.1.
- **No blurhash, no edit flow, no 30405 re-signing, no deploy.** A new item appears at the foot
  of the sale because `orderBySale` renders collection members first and strays after, which
  costs no second signature. Editing an item — and therefore re-cutting its ladder — is slice 6.
  Deploy is slice 5.

*Demo: `cd builder && npm run dev`, connect Amber, fill the form, publish — then refresh the
storefront and the item is there, with a working Buy button, having touched no server of ours.
The headless version, which needs no phone: `cd spike && node check-manage.ts`.*

**Slice 5 — Deploy from the app. DONE 2026-08-21.** The builder generates the site files,
mirrors them to four Blossom servers and publishes the kind 15128 manifest plus the kind 10063
server list — and the builder itself is now an nsite, which was the last thing rule 5 was owed.

**Three blockers underneath the one-line description, and none of them was the deploy.**
`/spike/deploy-nsite.ts` already did all of this correctly against real Blossom and real relays.
None of it could run in a browser.

1. **A static app cannot run `vite build`.** So the builder must already be carrying the
   storefront's bytes. It carries them as **files in `public/site`** (put there by
   `bundle-storefront.mjs`, a `prebuild` step) rather than inlined into its own JS as raw
   assets: Vite copies `public/` verbatim, so the builder `fetch`es them from its own origin at
   deploy time, and when the builder is deployed as an nsite they are blobs in its own manifest.
   Zero bundle growth for an app that is itself fetched blob by blob from a gateway.

2. **The storefront was compiled per seller, which makes one pre-built copy impossible.**
   `main.ts` hardcoded `SELLER_PUBKEY`; `vite.config.ts` `define`d `__SELLER_NPUB__` and
   `__SITE_URL__` and encoded the flyer QR from that URL. **The whole `define` block is gone.**
   An nsite's canonical URL *is* `<npub>.<gateway>` (`5A.md:136`) and a host server "MUST parse
   the left-most DNS label… if the label is a valid npub, decode it and resolve the root site
   manifest" (`5A.md:156-158`) — so the gateway already had to decode our npub to serve us the
   bytes, and the page reads the same label back out of `location.hostname`. One build, any
   seller. `?seller=npub1…` is the fallback for `npm run dev`. It used to be described as the
   fallback for Titan's `nsite://` too; that was answered on 2026-08-21 and the answer is that
   Titan cannot address us at all — §14.

   This is a simplification, not extra work, and it is checked like a trust boundary because it
   is one: whoever controls the hostname controls whose signatures the page accepts. The bech32
   checksum is honoured rather than the string pattern-matched, so a flipped character resolves
   to nobody rather than to a plausible wrong pubkey.

3. **Rule 5 is a bootstrap problem only if you read it as self-deployment.** It is not: rule 5
   says the builder must be *hosted* with no server of ours, and putting it on a gateway is a
   developer action, not a seller action. So `node spike/deploy-nsite.ts ../builder/dist`
   publishes the builder from a dev machine, the same tool and the same module the in-app deploy
   uses for the seller's sale. One tool, two directories, no cycle. What it *did* need was its
   own identity — see §6.4 on one root site per pubkey.

What it covers, and what it deliberately does not:

- **`/builder/src/deploy.ts`** — the browser-safe half: hashing, the aggregate, the QR
  injection, both event templates, and the deploy itself. `/spike/deploy-nsite.ts` is now the
  ~90 lines a browser cannot have (a filesystem walk and a key-backed Signer) driving it. The
  §13.13 lift pattern, chosen for the aggregate hash specifically: it is the one thing here
  that fails silently when it is wrong, so it gets exactly one implementation.
- **`/builder/src/blossom.ts`** — the BUD-11 auth and the mirror, lifted out of `photos.ts` for
  the same reason, and where **the find of the slice** lives: we were encoding the auth token as
  the base64url 11.md:50 requires, and three of the four servers that will store an nsite's HTML
  reject it. Standard base64 works on all five. Blobs live on four servers now, not one.
- **`/spike/check-deploy.ts`** — relays, then Blossom, then what the page would show from the
  hostname alone, then the gateway reported separately as the cache it is. The `check-buy.ts`
  contract: it drives the shipped modules, so if it and the builder disagree, it is wrong.
- **The 10063 is republished every deploy.** Findings §7 says once per seller; it is a
  replaceable event and one signature of a kind the signer already granted, and a missing 10063
  is a mandatory 404 (`5A.md:188-190`) with no other symptom. Cheap insurance beats a rule.
- **No `/site` route in the builder, no preview, no gateway picker beyond a text field, no
  redeploy diffing.** Slice 6 and 9.
- **No named sites (kind 35128) and no snapshots (kind 5128).** §6.4 rules both out for v1;
  nothing in slice 5 wanted them.

*Demo: `cd builder && npm run dev`, connect a signer, press Deploy, and the sale is a URL. The
headless version, which needs no browser and no phone:
`node spike/deploy-nsite.ts --key .deploy-test-key` then `node spike/check-deploy.ts <npub>`.*

**Slice 6 — Admin panel. DONE 2026-08-21.** Edit, restock, mark sold, ~~view settled sales~~,
private notes via NIP-78. Four of the five bullets shipped; the fifth was deleted rather than
deferred, and the reason is the most interesting thing in the slice.

Two new modules in `/builder` and two new scripts in `/spike`. **Zero new dependencies, in either
package.**

| file | what |
|---|---|
| `builder/src/admin.ts` | read the sale back off the relays, listing → draft, offer reuse, units sold |
| `builder/src/notes.ts` | NIP-78 kind 30078, NIP-44 encrypted to self. One event for the shop |
| `builder/src/admin.test.ts` | 12 tests, `node --test`, same style as the other four suites |
| `spike/sales-report.ts` | settled sales, where the key already is — the deleted bullet's answer |
| `spike/check-admin.ts` | drives the shipped admin module against the LIVE sale. No key, no node |

**1. "View settled sales" has no CLINK path, and that deletes the bullet.** CLINK Manage's only
resource is `offer` (`clink-manage.md:29`; `managementManager.ts:115-134` agrees) — there is no
invoice or settlement resource anywhere in CLINK. Settled sales live behind
`GetUserOfferInvoices`, which `nostrMiddleware.ts:52-80` routes only from a kind 21000 event, and
kind 21000 is keyed on a raw ECDH secret NIP-46 does not expose (findings §13.18). **A browser
holding no key cannot see the seller's sales.** Findings §13.25. So the panel shows `units −
stock` off the relays, with no credential at all, and `spike/sales-report.ts` gives amounts,
timestamps, refund-pointer presence and — since the balance question came up after slice 9 — the
account balance and what of it is still payable, on the machine where the key is. That last pair
is `GetUserInfo` (`methods.proto:513-518`), *not* `latest_balance`: that field is on
`LiveUserOperation` and `PayInvoiceResponse`, never on the `UserOperation` rows
`GetUserOperations` returns. It is an architectural
consequence of the custody claim in §3.1, and it is worth saying out loud rather than hiding.

**2. An edit is a re-cut ladder, and the dangerous failure was the opposite of the predicted
one.** See §7.5. The predicted failure — a stale rung republishing old text over new — needs the
edit to land within `units` seconds of the original publish, a 1–3 second window. The reachable
one is that a relay answers OK to a replaceable event it does not store, so a stale ladder fails
*silently and successfully* and the item stays on sale after it sells. Findings §13.26. Fixed in
`spike/ladder.ts` `isStale`, checked at watcher startup.

**3. The fixture's five native offers stay native.** §14 has been holding this since slice 4. An
edit reuses the `clink_offer` the listing already carries rather than minting, so Manage never
needs to see them — which means the decision costs nothing and re-minting `mugs` mid-demo does
not orphan the settled invoices slice 7's refund pointers live in (findings §13.17).

### What slice 6 deliberately did not build

- **No 30405 re-signing, and the deferral is closed rather than moved.** Slice 4 left reordering
  to here. `orderBySale` renders collection members in order and strays after, so a
  builder-authored item appears at the foot of the sale — which is publish order, which is
  chronological, which is what a yard sale looks like. A drag-to-reorder UI for a nine-item sale
  is a feature nobody asked for at the cost of one more signed event and a second list to keep
  in sync with the first.
- **No offer deletion, no offer `update`, no Manage `list`.** §7.4 explains the first two.
  `list` had exactly one candidate use — deduping a mint by label, the fix `known-defects.md`
  names for the idempotency gap — and that is money-path work this slice was told not to touch.
- **No refund code**, though §7.4's decision makes it tempting. Slice 7 needs a node-enforced
  frequency cap and a tested `BanDebit` kill switch first.
- **No per-item note events.** One kind 30078 for the whole shop: one signature to save whichever
  note changed, one query to load them all. Two tabs editing at once would last-write-win, which
  is a yard sale with one seller and one laptop.

**Slice 7 — Refunds. DONE 2026-08-21.** The watcher auto-refunds oversold items using the buyer
pointer our page put in `payer_data` (§7.3), paying via a kind `21002` debit from a **separate
watcher key** whose grant carries a node-enforced frequency cap. The cap and the `BanDebit` kill
switch were both driven against the funded node before anything ran unattended, and both were seen
firing. *Demo: the money comes back.*

Two new modules and three new scripts in `/spike`, one shared regex and one shared TLV parser
lifted into `/storefront`. **Zero new dependencies in any package.**

| file | what |
|---|---|
| `spike/ndebit.ts` | CLINK Debits kind 21002: `decodeNdebit`, `payDebit`, `payDebitBudget`, `k1For` |
| `spike/refund.ts` | which invoice is owed money, pointer → BOLT11 (noffer *and* LNURL), the journal |
| `spike/refund.test.ts` | 12 tests, `node --test`, same style as the other five suites |
| `spike/authorize-refunds.ts` | the one-time grant, at the desk, with the raw key. The dance |
| `spike/check-refund.ts` | proves the cap and `BanDebit` against the real node. Costs nothing |
| `spike/watch-sales.ts` | `--refunds`, off by default |

**1. The transport was answered in advance and the grant path was not.** Findings §10 did the
credential work — `admin.connect` is never needed, a Debit grant with a frequency rule held by a
separate key is the narrowest thing that permits refunds, and the node enforces the cap
in-transaction. All of that held. What did not: §10 and the slice brief both named `EditDebit` as
the grant path. `AuthorizeDebit` is commented out (`methods.proto:690-694`) and `EditDebit` throws
`Debit does not exist` — it edits rules on a grant that already exists. **The only way to create
one is for the account owner to answer a pending request**, so granting is a three-step dance:
the refund key sends a *budget* request (no `bolt11`, nothing paid), the node pushes a
`LiveDebitRequest` to the owner's key on the kind 21000 channel, and the owner answers
`RespondToDebit` with `AUTHORIZE` and **its own** rules. Findings §13.27.

**2. `k1` cannot carry the idempotency, and the brief said to check rather than assume.** Checked:
the node's k1 set is in memory with a 5-minute TTL and is consumed before validation, so it covers
a crash loop and nothing slower. The journal is the durable half. Findings §13.28, §7.3 above.

**3. The one third-party server in the project is in the refund path, on purpose.** A Lightning
address is LNURL-pay over HTTPS. Resolved, with a seller-visible queue when it fails. §7.3.

### What slice 7 deliberately did not build

- **No refund UI.** A browser behind a Signer cannot see the invoice it would be refunding
  (findings §13.25), so a human in the loop would mean a terminal prompt next to the node rather
  than a screen. Refunds are automatic, armed by `--refunds`, and bounded by the node.
- **No partial refunds, no refund of a *non*-oversold sale.** "The buyer changed their mind" is a
  conversation at a table, not a protocol. The watcher refunds exactly what §7.3 defines as owed.
- **No retirement of the depleted offer**, and slice 7 is the slice entitled to revisit §7.4's
  decision. It does not: `GetUserOfferInvoices` is the only reader of the stored refund pointer
  and it throws once the offer row is gone (findings §13.17), so the refund path depends on
  exactly the thing slice 6 chose to leave alone. The decision survives the slice that tested it.
- **No `callback_url` at mint time.** Findings §13.17's other candidate would deliver `payer_data`
  at settlement and remove the read-back dependency, at the cost of an HTTP listener on the
  seller's machine. Polling already works and rule 1's spirit is fewer servers, not more.

**Slice 8 — Fallback payment path. DONE 2026-08-21, and the one-line description contained a
factual error, so the slice began by correcting it.**

~~BOLT11/BOLT12 for buyers without a CLINK-capable wallet, degrading to "pay and message me"
semantics. This is what makes it usable by actual neighbors next month. Copy must state that a
raw-QR payer forfeits the automatic refund, because they never supplied a `payer_data` pointer
(§7.3).~~

**1. BOLT12 does not exist anywhere in this stack.** `grep -rni bolt12 ~/lightning_pub/src
~/lightning_pub/proto` returns nothing, `lno1` appears nowhere, and — the part that was not
expected — `lncli help` on this LND v0.21.2-beta build matches "offer" **zero** times, so there
is no shell-out escape hatch either. CLINK's own "Offer" is a different thing that shares a word:
an `noffer` is a bech32 TLV pointer to a *nostr* service that issues a BOLT11 on request, while a
BOLT12 `lno1` is a self-contained onion-routed offer with no nostr in it. Findings §30.

That leaves BOLT11, which this project already produces on every single buy. **So the slice was
never about a payment format**, and the real question underneath it is who is allowed to pay.

**2. Three tiers of buyer, and the honest version of the slice is which ones we take money from.**

| who | supplies `refund_pointer`? | reachable afterwards? | can pay? |
|---|---|---|---|
| our page (kind 21001 client, ephemeral key) | **yes** — a form field, before the invoice | yes, `clink_requester_pub` | **yes** |
| a CLINK wallet scanning a raw `noffer` | only if it can be prompted for an arbitrary key | yes, same field | **no** — declined, `code: 1` |
| anyone scanning a plain BOLT11 QR | no | **no** — nothing identifies them | **no such QR is published** |

**3. The decision: keep the requirement, and make the page the fallback.** Three candidates were
on the table and two are disqualified by measurement rather than by taste:

- **(a) Mint a second offer per item with `payer_data: []`** and knowingly accept unrefundable
  payments. Rejected. It is unrefundable *by construction* — the settled invoice carries no
  pointer, so `spike/refund.ts` `resolvePointer` returns `{queue: true}` and the watcher parks it
  as `queued` **forever**, reprinting it every five minutes at a seller who cannot act on it
  either, because nothing on that invoice says who paid. A deliberate design choice would arrive
  at the seller's terminal disguised as an unresolved bug. It also needs a second `clink_offer`
  tag or a second QR outside the listing, and every storefront including ours would have to
  decide which to draw.
- **(c) Relax the requirement to *optional*.** **Not implementable — there is no such tier at the
  node**, and this is the finding that made 0.2's wallet question stop being load-bearing.
  `ValidateExpectedData` (`offerManager.ts:139-142`) returns `{passed:true, validated:{}}` the
  moment the key list is empty; a key is required or it is not requested, with no third state.
  Worse, the invoice is written `payer_data: validated ? { data: validated } : undefined`
  (`offerManager.ts:276`) where `validated` is built from the **declared keys alone**, so a
  generous wallet volunteering `refund_pointer` against a `payer_data: []` offer has it dropped
  on the floor. No wallet behaviour can create the middle tier. Findings §6.
- **(b) Keep `payer_data: ["refund_pointer"]` required and make the *page* the fallback.**
  **Chosen.** Every path funnels through the form that asks for a pointer: the item sticker
  encodes the storefront deep link `#/item/<d>` rather than a raw `noffer` (design.md §4), and a
  wallet that reaches the raw offer anyway is declined by the node with a typed `code: 1` naming
  the missing key. It is the only option that keeps slice 7's guarantee whole, and it is what
  design.md §4 already assumed while waiting for this slice to confirm it.

**4. So the required copy changed shape, and the page says the true thing.** §10 asked for copy
stating that a raw-QR payer forfeits the automatic refund. Under (b) **nobody can forfeit it** —
the node declines them before money moves — so a warning about losing a refund would be copy
about a state this design does not have. What the buy form says instead, before the buyer types a
pointer: *this is the only way to pay this item; a wallet that scans the seller's offer code
directly is turned away by their node for the same reason — it has nowhere to send a refund.*

**5. What was actually built is smaller than the description and lands somewhere else.** The
visible hole was not the one §10 named. `renderBuy` opened with `if (!offer || !price) return
false`, so an item with no offer rendered **no buy panel and no explanation** — two items on the
live fixture that a visitor can see, want, and get no answer about: `records` at 80 MXN and
`boxes` at free. `render.ts` `noBuyReason` now gives each one a next step rather than a status
message, and it is tested. See §7.3.

| file | what |
|---|---|
| `storefront/src/render.ts` | `noBuyReason`, the §10 copy, and four exports made testable |
| `storefront/src/render.test.ts` | 17 tests — the decline codes, the price formatting, the unserved buyers |
| `storefront/src/offer.ts` | `isPointer`, shared by the page, `check-buy.ts` and the watcher |
| `spike/check-buy.ts` | `--pointer`, and `--pay` refuses without one |
| `spike/refund.ts` | `matchingPayments`, for reconciling a `pending` row against the node |

**What slice 8 deliberately did not build**

- **No messaging.** §10's "pay and message me" has no messaging to degrade to, and §14's open
  question explains why it is harder than it sounds: `clink_requester_pub` exists **only** for a
  kind 21001 payer, so "message me" could never mean "we message you" for the tier this slice is
  about. It can only mean "here is how you reach the seller" — and the page already carries that,
  because the sale's date, hours and location are on the masthead. A contact field would be a new
  tag, a new authoring input, and a decision about publishing a phone number to public relays,
  which is a privacy question this slice does not own.
- **No new watcher state for a deliberately-unrefundable settlement.** It would have been
  mandatory under (a) and is unreachable under (b): with the requirement kept, no settlement can
  arrive without a pointer. `queued` keeps its existing meaning — *a pointer we could not
  resolve*, which needs a human — rather than acquiring a second one.
- **No fallback offer, no second `clink_offer` tag, no BOLT12.** See above.

**Slice 9 — Polish. DONE 2026-08-21, and the line above was wrong in three of its five items.**
The original read: *"Geohash map of nearby sales, printable item-sticker QR sheet (design §4),
masthead editing, 404 page, empty states."* Taken in order of how wrong each one was:

- ~~**404 page.**~~ **Already done, since slice 1.** `storefront/public/404.html` is a complete
  hand-written page, `builder/src/deploy.ts` **refuses to deploy a site without one** citing
  NIP-5A `5A.md:196`, `deploy.test.ts` asserts the refusal, and both live nsites have one. It sat
  on this list for eight slices as a thing to do. Slice 8's version of this line claimed BOLT12
  and cost an afternoon of correction; the same line's "404 page" was already true and nobody
  noticed. **§10 is a plan written before the answers, not a to-do list — check before building.**
- ~~**Geohash map of nearby sales.**~~ **Cut, and the reasoning is `/docs/spike-findings.md` §31.**
  Three disqualifiers, any one of them fatal: a basemap is a third-party hostname fetched by every
  visitor, on a page whose only network calls today are two relay subscriptions to one known
  author; "nearby" means rendering events from strangers, which moves the trust boundary rather
  than extending it; and the proximity convention that would make the query expressible at all is
  specified in **NIP-CC, the geocaching draft** (`CC.md:53` — "include multiple geohash tags at
  different precision levels"), not in NIP-99, while we emit exactly one `g` tag. Plus a map
  library is one to two orders of magnitude over §9's budget.

  **What shipped instead is the scoped version**: the sale's own `g`, decoded in the page and
  rendered as an RFC 5870 `geo:` link around the neighbourhood on the masthead
  (`storefront/src/render.ts` `geoUri`). The OS hands it to whatever map app the buyer already
  has — no tile server, no library, no cross-author query, and the page never learns they looked.
  Renamed accordingly: **"where this sale is", not "a map of nearby sales."** It cost 0.15 KB
  gzip and it found a 5.94 km error in the fixture's own geohash within a minute of existing,
  because until slice 9 **nothing in this project had ever decoded one**.
- **Masthead editing — this was the slice, and "editing" undersold it by a lot.** There was
  nothing to edit: `builder/src/listing.ts` imported `SALE` from `/spike/fixture.ts` and stamped
  it on every item anybody authored — `d` prefixed `yardsale-2026-08-`, `location` "Colonia
  Americana, Guadalajara", `g` `9ewmr4z`, and an `a` tag pointing at
  `30405:<their own pubkey>:yardsale-2026-08`. So a seller in Oaxaca published items tagged with
  our neighbourhood, signed by their own key, permanently, on four public relays — **and the
  collection those items claimed membership of did not exist**, because `30405` was written only
  by `/spike/seed-listings.ts`. `spike/check-deploy.ts` had been printing
  `(no kind 30405 — the page falls back to its own name)` for exactly this, which reads like a
  graceful fallback rather than the missing half of a feature. New `builder/src/sale.ts` +
  `publish.ts` `publishSale`: the builder authors the sale, one signature, **no new bunker
  approval** because `sign_event:30405` has been in `PERMS` since slice 4 (findings §8).
- **Printable item-sticker QR sheet — built, in the builder.** `builder/src/stickers.ts`, behind
  the same dynamic `uqr` import the deploy button already uses. See design.md §4 for the decision
  and why it is not a third `@media print` block in the storefront.
- **Empty states — two of the three already existed; the one that was missing is the one slice 9
  created the need for.** A `#/item/<d>` deep link for a `d` not in the sale fell through to the
  index in silence — which is precisely what a **sticker that outlived its item** produces, and
  slice 9 is the slice that prints the stickers. `render.ts` `missingItemNote`.

**The sale's `d` is deliberately not a form field.** It is also every item's `d` prefix, and
`admin.ts` `draftFrom` refuses to edit an item outside that prefix, so a text box for it is a box
that — mistyped once — orphans every item the seller has ever published, in silence. It is read
back off the seller's own kind 30405 instead, which costs nothing (the panel already fetches that
event in the same query) and means the live fixture sale keeps `yardsale-2026-08` without anybody
typing it. New sellers get `sale`, with no date in it: a date goes stale at the second sale, and
changing it then would break every `a` tag and every prefix at once.

---

## 11. Spike checklist — mostly answered

Full answers with citations live in `/docs/spike-findings.md`; field names live in
`/docs/clink-notes.md`. Summary of where each question landed:

| # | Question | Answer |
|---|---|---|
| 1 | Node funded, channel with inbound liquidity | **CLOSED 2026-08-21.** Inbound *rented* from Olympus rather than funded — an empty Pub can never bootstrap itself. 6,000-sat test payment received. Keep the warning: an unfunded node still reports `max: 10000000`, and a fixed-price offer is not range-checked at all, so a successful invoice request is *not* proof it can receive |
| 2 | Raw request/response captured | **CLOSED.** Request, decline, invoice and receipt all captured on the wire (findings §2, §5) |
| 3 | Multiple offers per account? | **Yes, unlimited, per item.** `clink_offer` per listing; `item_ref` deleted (§6.1) |
| 4 | Decline on custom logic? | **No pre-invoice hook,** and the answer under it moved twice. ~~Strict mode = delete the offer on depletion~~ — findings §13.17 disqualified that (deletion destroys the buyer's stored refund pointer) and **slice 6 decided the replacement: a sold item drops its `clink_offer` tag and the offer stays on the node, untouched.** Holding the service key ourselves is still the only true strict mode (§7.4) |
| 5 | Settlement receipt on the wire? | **CLOSED, and worse than the source read suggested.** Kind `21001`, NIP-44 encrypted to the payer, `{"res":"ok"}`, **no preimage on a payment with `internal: 0`** — a real external settlement that a spec-following client would misread as internal (`clink-offers.md:333`). Not seller-readable. Rewrote §7.2 and §7.6 |
| 6 | `payer_data` end-to-end? | **Node side now verified on the wire, not just in source** (findings §6): required key declared at mint, `code: 1` + `payer_data:["refund_pointer"]` when omitted, invoice when supplied. The key name is ours (§7.3). Wallet behaviour **OPEN — needs you**, and secondary: our page is the client |
| 7 | nsite deploy + `/404.html` | **OPEN — needs you** (`nsyte` is a global install). NIP-5A itself read: `/404.html` confirmed required, plus the kind `10063` requirement in §6.4 |
| 8 | Bunker prompt count for 10 items | **ANSWERED 2026-08-21 from source.** **1 prompt** with `perms` granted at connect, **5** without — both Amber and nsec.app honour `perms` for arbitrary kinds, and both key a remembered grant on `(app, type, kind)`, so twenty Blossom auths of one kind cost one approval. Under the ~15 threshold on every path; slice 4 builds as planned. Unmeasured on hardware — one confirmation run remains in findings §8 |
| 9 | Blossom auth per upload | **Batching is permitted** — multiple `x` tags in one kind `24242` event (§5) |
| 10 | Credential scoping for the watcher | **CLOSED 2026-08-21 by slice 7, and it was built rather than only read.** `admin.connect` is never needed. The refund path is a **CLINK Debit grant held by a separate watcher key** (`spike/.refund-key`), with a node-enforced frequency cap and `BanDebit` as the kill switch — **both driven at the running node and seen firing**: the cap answers GFY `5` carrying `range.max`, the ban answers GFY `1`, and both checks run inside the payment transaction (findings §13.29). One correction: the grant is created by answering a pending `LiveDebitRequest` with `RespondToDebit`, **not** by `EditDebit`, which cannot create one (findings §13.27). Residual unchanged: observation still needs a User-scoped key, which implies spend authority — so the observe key and the refund key are separate and `watch-sales.ts` refuses to start if they are the same. The credential-free loopback `callback_url` was not tried; polling works and it would add an HTTP listener |
| 11 | Guest account with its own offer? | **Yes, and slice 2 did it with no human in the loop.** *Custody consequence settled in §3.1–§3.2: the capability is real, and we use it only as an opt-in fallback for a seller with no node — never as a default.* The dev key spoke to the guest `app.nprofile`, got an account auto-created by `NostrUserAuthGuard`, and minted four offers — no pairing, no approval. **This corrects the `AuthorizeManage` assumption**: that grant gates CLINK Manage (kind 21003) only, not the native `AddUserOffer` RPC (kind 21000, `auth_type = "User"`). See findings §13.4. CLINK Enroll (kind `21004`) is still **not implemented** by Lightning.Pub 0.0.37 |

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

  **EXTENDED 2026-08-24 by milestone A's item 4, because "every inbound event" was not the whole trust boundary.** The buyer chooses the `refund_pointer`, the node stores it on the settled invoice, and the seller's watcher then *fetches whatever host it names* and asks that host for an invoice it is about to pay. That is an outbound request driven by hostile input, and the rule above did not reach it. Two panel claims were reproduced against a self-signed listener on 127.0.0.1 before anything was changed: the 64 KB body bound was checked one line **after** the whole body was buffered (10 MB in 34 ms), and neither LNURL hop had any address check at all, so a `callback` of `https://127.0.0.1:8443/cb` — a field the buyer's own host chooses — was fetched and parsed. `redirect: 'follow'` was measured following a self-redirect 21 times.

  The fix is a transport change, and the reason is worth keeping: **`dns.resolve()` followed by `fetch(url)` cannot work.** `fetch` re-resolves the name, so the address that was vetted is not the address that is connected to, and a hostile pointer's DNS can answer differently the second time. `fetch` also follows redirects internally and hands back only the final response, so "re-check each hop" is not expressible. `spike/refund.ts` now uses `node:https` (stdlib, no new dependency): the name is resolved once, refused if **any** answer is a private or reserved address, and connected to at that exact address with `servername` and `Host` set so TLS still validates against the hostname. Each redirect is a separate vetted request, capped at eight and re-checked for https, under one deadline for the whole chain. The body is counted in bytes off the stream and the socket destroyed at the bound.

  **CORRECTED 2026-08-24 by the milestone A review, and the corrections are the reason this paragraph is worth re-reading rather than trusting.** Three things the transport change got wrong and the diff did not show:

  * **`req.setTimeout` is an IDLE timeout, not a deadline.** "One deadline for the whole chain" was false: `socket.setTimeout` fires after N ms of *inactivity*. Measured — a host sending one byte every 600 ms held a request whose deadline was 1,000 ms open for 24.6 seconds. At one byte per 9.9 s it stays under both that and the 64 KB bound for a week, and because `tick` is wrapped in `inFlightGuard` — which DROPS the polls behind it — one slow host chosen by one buyer stops the watcher republishing stock entirely. `fetch` had a real deadline for free (`AbortSignal.timeout` aborts the body read too); losing it was the unpriced cost of the change. Now a wall-clock `setTimeout` destroys the request, and the idle timer is gone as redundant.
  * **Dropping `fetch` dropped transparent decompression.** RFC 7231 §5.3.4: a request with *no* `accept-encoding` lets the server use **any** content-coding — absence is not a refusal. `fetch` sent `gzip, deflate` and decompressed; `node:https` does neither, so a host that gzipped handed `JSON.parse` a gzip stream. That throws a `SyntaxError`, which is not a `PermanentHttpError`, so the row journalled `failed` and retried every six minutes forever — a permanent failure wearing a transient label, with no `queued` row to tell the seller a person was needed. The request now sends `accept-encoding: identity` — though note that the one real host driven so far does not
  compress even when asked, so this is correct per the RFC and **unexercised in the wild**.
  * **A name with no address record was classified transient.** `lookup` throwing came out of `fetchHop` as a
  plain error, so the row journalled `failed` and retried every six minutes forever with no `queued` line to
  reach a human. Now `ENOTFOUND`/`ENODATA` are permanent and `EAI_AGAIN` deliberately is not — making our own
  resolver's bad minute permanent would strand every pending refund on a network hiccup, which is worse than
  the bug. This has **no unit test**: the branch needs a resolver, and a 4-second network-dependent case does
  not belong in an otherwise offline suite. The evidence is a live run, recorded in `/docs/known-defects.md`.
  * **Three redirects was under what a real wallet host costs.** An apex-to-www hop, a `/.well-known` rewrite and a CDN region hop is already three, and exceeding the cap is *permanent* here — a `queued` row that is never retried. Eight stops a loop just as well. The cap was measured against a lab host, which is not the same as a wallet provider.

  `isPrivateAddress` is a pure exported function that fails closed, and it is **a named range list rather than a proof** — 6to4 and Teredo are not enumerated. **It did not actually fail closed until the 2026-08-24 review**: the IPv6 branches keyed off `startsWith('::')` and a mask on the first group, so every *uncompressed* spelling of loopback slipped through — `0::1`, `0:0:0:0:0:0:0:1` and `0:0:0:0:0:ffff:10.0.0.1` were all measured as ALLOWED while the docstring promised the opposite. It was unreachable in practice only because WHATWG `URL` and `dns.lookup` both canonicalise before it is called, which is an accident of two other components rather than anything this function guaranteed. The fix is to canonicalise through `new URL` first — the platform's own IPv6 normaliser — which also folds every IPv4-mapped form into the `::` rule. That gap is a row in `/docs/known-defects.md` rather than a silence, because a check that reads as a guarantee and is not one is worse than no check.
- Relays can withhold, delay, reorder, and replay — **confirmed, not theoretical**: `wss://relay.lightning.pub` replayed minutes-old kind `21001` events to a fresh subscriber before EOSE, and CLINK Offers defines no request-freshness rule and no single-use construct. Any retry path on the money side must be idempotent, **keyed on the settled invoice / payment hash, never the request event id**.
- The watcher's refund path must have a hard cap and a kill switch. A bug there sends money out. Note the node's account balance is currently **9,000 sats**, all of it created by test sales — four
  settled invoices (`plants` 6,000, `mugs` 3×1,000), measured by `node spike/sales-report.ts` on
  2026-08-23; the channel reads 9,800 local against 88,978 remote by `lncli listchannels`, the
  difference being the second seller's sub-account. (This said 8,000 across three until
  2026-08-23 — correct on 2026-08-21, and `mugs`' third unit settled that evening.) Refunds cannot precede sales, so set the frequency cap against what has actually been sold rather than against a round number. **Let the node enforce both**: a CLINK Debit grant carries a frequency rule (`[number, unit, max]`) checked inside the payment transaction, and `BanDebit` revokes it in one tap. Our code should not be the only thing standing between a bug and the balance.

  **SATISFIED IN SLICE 7, and both were watched firing rather than asserted.** The grant is live at
  **8,000 sats/day** on `spike/.refund-key`, with an expiry rule alongside it, set by
  `node spike/authorize-refunds.ts`. `node spike/check-refund.ts` proves the mechanism without
  spending anything: it moves the cap to 1 sat, sends a 10-sat debit, records
  `{"code":5,…,"range":{"min":1,"max":1}}`, restores the cap, bans the grant, and records
  `{"code":1,"error":"Request Denied Warning"}` on a debit the cap would have allowed
  (findings §13.29). The kill switch is `node spike/authorize-refunds.ts --revoke`.

  **Two honest caveats, because a cap that has never been crossed is not a cap.** First, 8,000/day
  used to equal the node's whole outbound balance, so the *balance* bound before the rule did —
  which is why the proof moves the cap rather than spending the balance. **That stopped being true
  on 2026-08-23**: the account holds 9,000 (8,946 payable after the Pub's fee) against an
  8,000/day cap, so the cap now binds first and is doing real work for the first time. It was
  never re-sized deliberately; the balance walked past it. Re-decide the number rather than
  inheriting it — **still open as of 2026-08-24, and it is now the first thing item 6 should do**,
  because item 6 is the run that actually crosses it. `node authorize-refunds.ts --cap <n>` re-caps
  an existing grant in one call and needs no dance. Second, our
  own code adds one guard the node cannot: a journal keyed on the settled invoice, because the node
  has no "already refunded" field and CLINK's `k1` turned out to be in-memory with a 5-minute TTL
  (findings §13.28). That guard is a file, and losing the file could double-pay a refund.

  **THIRD, ADDED 2026-08-24 BY MILESTONE A, and it is the one that was actually broken.** Two of
  the three guards above were real; the file was not, twice over. `setInterval(tick, POLL_MS)` had
  no in-flight guard and a refunding tick outlives its own 5s timer by design, so a second tick
  re-read the journal mid-flight and resolved a second BOLT11 for the same sale — and the loser's
  unconditional write then landed `failed` over the winner's `paid`, which `settledByUs` treats as
  retryable six minutes later, by which time the node's k1 debouncer has swept the k1. Both halves
  are closed: an in-flight guard that DROPS rather than queues, and a monotonic write that makes
  `paid` terminal, on the journal itself so every future writer inherits it.

  **And the file is now reconciled against the node at startup** (item 9). The rule that decides
  what that reconcile may do is the important part: **a match on amount and time alone is evidence
  for a human, never an input to whether money moves.** The node stores no link between a debit and
  the settled invoice that caused it, so a `pending` row with a matching outgoing payment produces a
  **prompt**, never a transition. Only the refusals act without a human — an oversell with no
  journal row but a matching payment is blocked, and `--refunds` refuses to start when the journal
  file is absent and the node reports outgoing payments. A non-TTY start runs, transitions nothing,
  and says so loudly: refusing to start would stop the availability watcher too, which is a new
  oversell rather than a guard against one.
- The watcher holds **no signing key at all** — it publishes kind 30402 events the seller pre-signed (§7.2). It does hold a node credential to read settlements, and that one is a **separate key** from the seller's identity and Pub account where possible: "User" scope on Lightning.Pub is not read-only, and the same credential that reads settlements can call `PayInvoice`. Slice 3's watcher currently reuses the fixture seller's throwaway `.dev-key`, because on this fixture the seller identity and the node account are one key; slice 7's refund path must not reuse it.
- Never publish the account's default offer: its id is the account pointer, and an unauthorised debit/manage request against a known pointer pushes an approval prompt to the seller's wallet (§6.1).
- The seller's node is the only thing holding funds, and it is theirs.

---

## 13. Demo script (write this before slice 1, revise as you go)

1. Photograph an item. Publish it in the builder. (~30s)
2. Deploy. Show the npub URL resolving. (~30s)
3. Second device: scan, pay, receive. **The QR scanned in step 3 is the storefront's, and the
   payment happens on the page** — slice 8 confirmed that and it is not an implementation detail
   to gloss. A phone that scans a raw `noffer` gets a typed decline instead, and the reason is
   step 6: the node will not take a payment it could not refund. Say it here, once, rather than
   letting a judge find it at step 6.
4. Refresh: item is sold.
5. Show the seller's machine — **no domain, no certificate, no processor account, and no inbound
   port serving the storefront.** Corrected 2026-08-21: "no inbound ports open" was the old
   wording and it is not true — `lnd` listens on `*:9735` and Lightning.Pub's API on `*:1776`.
   A Lightning node listens because it is a Lightning node; that is a different claim from
   hosting a website, and the true one is the stronger one. `lsof -nP -iTCP -sTCP:LISTEN` on
   stage survives the check; the old sentence does not.
6. Oversell deliberately. Show the automatic refund.
7. ~~Optional: open the same site in Titan over `nsite://` with no gateway at all.~~ **Cut
   2026-08-21 — it does not work, see §14.** What replaces it, and it is a better answer to the
   same question a judge is asking: serve `storefront/dist` from the demo machine and run
   `node spike/check-deploy.ts <npub>` beside it. The page renders from local bytes while the
   command proves those exact hashes are live on four independent Blossom servers. The gateway
   is a cache, and a cache is not the architecture.

**Say this before a judge says it.** There is no BOLT12 in this stack and there is no plain-QR
payment path — the fallback for a neighbour with an ordinary wallet is *the page*, not a second
payment format (§10, findings §30). The trade is stated rather than hidden: one extra tap, in
exchange for every payment being refundable.

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
- ~~**What is `location.hostname` inside Titan's `nsite://` scheme?**~~ **Answered 2026-08-21,
  and it was the wrong question.** The question is not what the hostname looks like in Titan; it
  is whether Titan can address one of our sites at all, and as far as its own README documents,
  **it cannot**. Read from `github.com/btcjt/titan` (v0.1.10, 2026-05-29) rather than tried,
  because trying it means an unsigned 9 MB Tauri binary on the machine holding the node keys:

  - **It resolves registered names, not pubkeys.** The only address forms its README documents
    are `nsite://titan` and `nsite://westernbtc`. Names are bought with a one-time Bitcoin
    OP_RETURN registration ("~$0.10 … first-come, first-served, and permanent"). No
    `nsite://npub1…` form appears in it.
  - **Its resolution flow does not name our kinds.** Quoted: `kind 35129` name index → pubkey,
    `kind 10002` relay list → `kind 35128` site manifest, then Blossom by sha256. We publish
    **15128** (root site, no `d` tag — findings §7) and **10063** (BUD-03 servers). Measured on
    the four sale relays 2026-08-21, all three of our pubkeys: `10063, 15128` and nothing else.
    **Kind 10002 appears nowhere in this project.**
  - One thing stays genuinely open: its overview prose claims "kind 15128/35128" support while
    the flow diagram names only 35128, so an undocumented raw-npub path may exist. `UNVERIFIED`,
    and only an install answers it.

  ⇒ The no-gateway story is not Titan. It is that the manifest and the blobs are the site, and
  `check-deploy.ts` proves it from the relays and Blossom without a gateway in the path at all.
- ~~Which tag carries the image placeholder?~~ **Answered in slice 4: NIP-92 `imeta`, carrying the
  field names it inherits from NIP-94.** We write it, and we deliberately do not write
  `blurhash` — see §6.1 and findings §13.21.
- **Manage and the native RPC do not see the same offers** (findings §13.20), and the fixture's
  five were minted natively. Nothing is broken — they are tagged onto live listings and have been
  paid against — but an edit flow going through Manage cannot touch them. ~~Slice 6 decides:
  re-mint them through Manage, or keep a native path for pre-slice-4 items.~~ **Slice 6 decided:
  neither.** An edit carries the item's existing `clink_offer` forward instead of minting
  (§7.5), so Manage never has to see them and the question dissolves. Re-minting was the
  expensive option and would have orphaned `mugs`' two settled invoices from its new offer,
  which is where slice 7's refund pointers live (findings §13.17). A native path in the browser
  was never available at all (findings §13.18). Only a **price change** mints, and then it is a
  new offer for a new price, which is correct.
- ~~Which second Blossom server?~~ **Answered in slice 5, and the answer was our own code.**
  BUD-11 11.md:50 requires the auth token be base64url; three of the four servers that will
  store an nsite's HTML reject base64url and accept standard base64. `builder/src/blossom.ts`
  sends standard base64 and blobs now live on **four** servers — `cdn.hzrd149.com`,
  `blossom.primal.net`, `files.sovbit.host`, `nostr.download` — each verified serving every blob
  of both deployed sites. Findings §9 and §13.23. Two things still open at the edge: the
  fixture's 21 photos are on `blossom.band` alone until `seed-listings.ts` is re-run, and
  BUD-04 `PUT /mirror` is still untested (we push to each server directly instead).
- ~~What does the buyer see if their wallet can't speak CLINK? (Slice 8 — decide the copy early.
  Must include: no `payer_data` pointer means no automatic refund.)~~ **ANSWERED IN SLICE 8, and
  the required sentence turned out to be about a state this design does not have.** A wallet that
  cannot speak CLINK never reaches a payment: the item sticker encodes the storefront deep link,
  so scanning it opens the page, and a wallet that reaches the raw `noffer` some other way is
  declined by the node with `code: 1` naming `refund_pointer`. **Nobody can forfeit the refund**,
  so the copy says the true thing instead — *this is the only way to pay this item; a wallet that
  scans the seller's offer code directly is turned away by their node for the same reason: it has
  nowhere to send a refund.* It sits in the buy form, above the field, before the buyer types
  anything. §10 §7.3.
- Where does buyer↔seller pickup messaging live — NIP-17 DMs to the **ephemeral payer pubkey** stored on the invoice as `clink_requester_pub`? Note that key is ephemeral by design, so the buyer's page must keep it or the thread is unreachable. (Was "the receipt's payer pubkey" — we cannot read the receipt.)

  **Still open after slice 8, which declined to build it and narrowed it instead.** §10 called for
  the fallback to degrade to "pay and message me" semantics; there is no messaging in this project
  to degrade to, and building one inside a slice about payment formats would have been the wrong
  slice. Three things slice 8 established that whoever picks this up should not re-derive:
  **(i)** `clink_requester_pub` exists only for a kind 21001 payer, so "message me" can never mean
  "we message you" for a buyer who paid any other way — any design assuming we can reach them is
  wrong; **(ii)** the ephemeral key dies with the tab, so a thread keyed on it needs the browser to
  persist key material, which is a rule-2 decision and not a feature; **(iii)** §7.6's pickup proof
  has the *same* dependency, so if the key is ever kept, keep it for both. Meanwhile the honest
  fallback is the one already on the page: the sale's date, hours and location are on the masthead,
  and a buyer who cannot pay online comes to the sale.
- Do we ship a hosted gateway convenience URL, or force gateway choice? (A hosted one is a centralization we should at least name.) **Slice 5 forced the choice, weakly**: the builder has a gateway text field defaulting to `nsite.lol` and does not check that whatever is typed resolves. A dropdown of gateways is a list that goes stale, and the gateway is the one part of the URL we do not control.
- Is `blind` on a Lightning.Pub offer worth using? It exists in the entity and reaches invoice creation, and is in no CLINK spec. `UNVERIFIED` — find out before enabling it; it may affect receive reliability. Slice 2 mints offers with it unset.
- What is the `p:` offer-id prefix? It routes to a separate "product" system that bypasses `payer_data` validation and amount checks, and is in no CLINK spec. Slice 2 did **not** use it, and the `payer_data` bypass alone probably disqualifies it — a product offer cannot carry a refund pointer, so it cannot be refunded. Confirm before anyone reaches for it.
- ~~Should the builder mint offers over CLINK Manage (21003) or the native RPC (21000)?~~ **Answered 2026-08-21: Manage, and it is forced rather than chosen.** The native kind 21000 uses Lightning.Pub's custom `nip44v1` envelope, keyed on the raw ECDH x-coordinate (`nostrPool.ts:110-113`), and NIP-46 never exposes raw ECDH or a private key — so a builder holding only a bunker connection cannot construct a 21000 request at all. CLINK's own `21001`–`21004` are standard NIP-44, which a bunker does expose. Slice 2 got away with the native RPC only because `/spike/.dev-key` is a raw key on disk. **Built in slice 4** (`/builder/src/manage.ts`), verified end to end against the live node by `/spike/check-manage.ts`, and the `fields` wrapper disagreement (§13.3) is handled. Two corrections to this line, both measured while building it: the `AuthorizeManage` prompt is **zero**, not one — it is `auth_type = "User"`, so the account's own key issues its own grant (findings §13.19) — and because that call is itself kind 21000 it needs a one-time bootstrap next to the node (`/spike/authorize-manage.ts`). Full evidence: findings §13.18, §13.19, §13.20.
- **Does the printed flyer need the item QRs now?** design.md §4's item stickers encode the item's `noffer`, which exists as of slice 2. But a raw-QR payer supplies no `refund_pointer`, so the node declines them outright — an item sticker today is a QR that cannot be paid. Either the sticker points at the item's page (`#/item/<d>`), or slice 8's fallback path changes what "required" means.
