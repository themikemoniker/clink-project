# Adversarial review of the README roadmap

Against `docs/prompts/roadmap-review.md`, 2026-08-23. Report only — no code changed, `README.md`
untouched.

Every claim below carries a citation. Where I measured something, the command that produced the
number is named. Where I could not verify, it is in the `UNVERIFIED` list at the foot and nowhere
else.

**What has since landed (2026-08-23).** The corrections in findings 1-5, 8-12 and 15-20 are in
`README.md`; the drift in finding 23 is fixed in `docs/spec.md`, `docs/status.md`,
`docs/runbook.md` and `docs/known-defects.md`; findings 7, 21 and 22 are new roadmap items 24, 26
and 25. **Finding 6 is withdrawn** — landing finding 7's one-line fix disproved it, which is
recorded in place rather than deleted, because how it was wrong is the useful part.

**One correction to the brief before the findings.** The brief attacks an S/M/L estimate column
and asks which sizes are wrong by more than one band. **That column is already gone.** `README.md:234-238`
reads *"There are deliberately **no time estimates here.** Nine slices shipped in about two days;
nothing in that record supports sizing this work, and a size column that is uniformly wrong makes a
milestone look schedulable when it is not."* — which is the change you said you would make
regardless. The M5 sizing question is therefore answered on substance rather than on band, in
finding 5.

---

## 1. Item 9 — **cannot exist as described.** It reverses the money decision it cites.

Item 9's second bullet: *"A `pending` row with a matching payment becomes `paid` **without human
intervention**."*

The ledger row it is drawn from prescribes the opposite, and says why:

> "Read the node's outgoing payments once at startup, and for any journal row that is `pending`,
> print a **prompt** rather than a conclusion: *'the node has one 1,000-sat payment 40 seconds after
> this row was written — mark it paid? [y/N]'*"
> — `docs/known-defects.md`, slice-8 section, row 1

And the deferral reason in the same row: *"Doing it at startup means deciding, automatically, that a
payment matched on **amount and time alone** is the refund in question — and the node stores no link
back to the sale, so two refunds of the same amount in the window are indistinguishable. A heuristic
is fine as evidence for a human and is a different thing as an input to whether money moves again.
That is a decision about money."*

The reporting half already refuses to branch on the match, deliberately: *"It is labelled a heuristic
everywhere it prints and nothing branches on it"* (`docs/known-defects.md`, slice-7 section, row 2).

The failure the roadmap's version introduces is the *opposite* of the one item 9 exists to prevent.
Marking a `pending` row `paid` on an amount-and-time match means a refund that was never sent is
recorded as sent, and the buyer is stranded with no row reprinting to say so. Item 9 is in milestone
A, whose claim is *"Nothing known-broken can lose money"* — and this bullet is a new way to lose it.

**What the roadmap should say instead:** the reconcile prompts a human for every `pending` row it
matches and never transitions a row on its own; only the two *refusal* bullets (block the refund,
refuse to start) may act without a human.

Bullets 3 and 4 of item 9 are fine — both refuse rather than decide, which is the asymmetry the
ledger row is drawing.

---

## 2. M4 — **mis-cited.** "No rule moves" is false, and the reason it is false is not the one the brief suspected.

The brief asks whether M4 gives the watcher a signing key when slice 3's design is that it holds
none. Two things, and the first refutes the premise of the second.

**(a) The watcher already holds a signing key, and already signs.** It reads the seller's secret key
off disk and signs kind 21000 with it:

- `spike/watch-sales.ts:112` — `const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())`, where
  `KEY_FILE` defaults to `.dev-key` (`:80`)
- `spike/pub-rpc.ts:97-99` — `finalizeEvent({ kind: 21000, … }, sk)`

So the ledger's stated reason for not putting the refund journal on a relay — *"A relay could, but
the watcher holds no signing key by design (spec §7.2), so it cannot publish a record of what it
did"* (`docs/known-defects.md`, slice-7 section, row 1) — **is factually wrong**, and M4 is the thing
on either list that notices. That is worth keeping.

**(b) What slice 3 actually guarantees is narrower, and M4 can still break it.** Spec §7.2 and §12
say the watcher signs no *listing*: *"The watcher's key material is **none**… It still holds a node
credential to read settlements, and that one is not read-only (§12)"* (`docs/spec.md:568`), and
§12: *"The watcher holds **no signing key at all** — it publishes kind 30402 events the seller
pre-signed (§7.2). It does hold a node credential to read settlements, and that one is a **separate
key** from the seller's identity and Pub account **where possible**… Slice 3's watcher currently
reuses the fixture seller's throwaway `.dev-key`, because on this fixture the seller identity and the
node account are one key"* (`docs/spec.md:1548`).

M4 says the summary is published *"under **its own** key"*. There are two readings and they are not
equally safe:

- **`.dev-key`** — that key *is* the seller's identity. A daemon publishing a 30078 signed by it can
  publish any kind signed by it, which is exactly the authority the ladder was built to withhold.
- **A third dedicated key**, on the `.refund-key` precedent — correct, but it is a **new credential**
  and new pairing state, which is what M4's "no new credential" denies.

**What the roadmap should say instead:** M4 publishes under a **third key that is neither the
seller's identity nor the refund key**, and the honest line is "no rule breaks, but the watcher gains
an event-signing role §12 says it does not have — recorded, not waved past."

The rest of M4 holds up. `GetUserOfferInvoices` is reachable only over kind 21000 and a browser
behind a Signer cannot speak it (`docs/spike-findings.md` §13.25) — so the transitive route really is
the only one. The "never a refund pointer or a preimage" bullet matches what `sales-report.ts`
already does (it prints presence, never the value).

---

## 3. M1 — **holds up, for the wrong reason.** The relay-cap check sends you to the wrong place, and the decrypt step is unstated.

Three separate answers.

**(a) The `d`-tag collision suspicion is refuted.** `builder/src/notes.ts:8-13` avoids `clink-*` on
kind 30078 because CLINK Beacon reserves that prefix, and the running node publishes under the legacy
`d = "Lightning.Pub"`. `lamppost-ladder-<slug>` collides with neither, and not with `notes.ts`'s own
`NOTES_D = 'lamppost-shop'` (`notes.ts:26`). `loadNotes` filters on `'#d': [NOTES_D]`
(`notes.ts:66`), so ladder events cannot leak into the notes read. No collision.

**(b) The PERMS claim is exact.** `nip44_encrypt`, `nip44_decrypt` and `sign_event:30078` are all in
`PERMS` (`builder/src/signer.ts:41,42,49`). No new permission, no second approval. Correct as written.

**(c) The size argument is wrong, and the verification step it prescribes is the wrong check.**
Measured from the two ladder files on disk:

| | items | compact JSON | largest single item |
|---|---|---|---|
| `spike/.ladder.json` | 5 | 13,274 B | 4,659 B (`mugs`, 3 units) |
| `spike/.merida-key.ladder.json` | 6 | **40,381 B** | **16,923 B** (`jabon`, 12 units) |

The binding limit is **not** a relay cap. Measured NIP-11 `limitation.max_message_length` today:
`relay.damus.io` 1,000,000; `nos.lol` 131,072; `relay.primal.net` 1,000,000. The binding limit is
**NIP-44's 65,535-byte plaintext ceiling** — `writeU16BE` throws *"invalid plaintext size: must be
between 1 and 65535 bytes"* (`builder/node_modules/nostr-tools/lib/esm/index.js:2372-2373`). At the
Mérida sale's measured 6,730 B/item, a shop-wide event is already at **62% of that ceiling with six
items**, and hits it at nine — which is the same number of items `design.md` §3 says the flyer holds.

So M1's conclusion (one event per item) is right and its stated reason ("will hit relay event-size
caps") is wrong. Per item, the ceiling is ~46 units of a photo-carrying item; no yard-sale item
reaches it.

**What the roadmap should say instead:** one event per item because a shop-wide event is at 62% of
NIP-44's 65,535-byte plaintext ceiling at six items (measured against `.merida-key.ladder.json`) —
and delete "Verify the cap on all four relays", which is not the constraint.

**(d) The decrypt step is unstated and it pins the observe key.** The watcher must NIP-44 *decrypt* a
payload the builder encrypted seller→seller, which needs the seller's private key. It has one today
only because `watch-sales.ts:11-13` says *"Today it is the seller's own throwaway `.dev-key` because
the fixture seller and the node account are one identity"* — a fixture coincidence that spec §12 says
should be a separate key "where possible". Encrypting the ladder *to the seller's own key* converts
that coincidence into a requirement.

**What the roadmap should add:** encrypt the ladder to the **watcher's** pubkey, not the seller's, so
M1 survives the credential split §12 asks for — and say that "exactly the way `notes.ts` wraps
private notes" is the shape, not the recipient.

---

## 4. M3 — **cannot exist as described.** The member-list removal is the half that does *not* work.

M3: *"Add a NIP-09 kind 5 deletion request **and** removal from the kind 30405 member list — relays
honour deletion at their discretion, so the member-list removal is the half that actually works."*

Backwards. The storefront never reads the member list to decide *what* to render:

- `storefront/src/nostr.ts:39` — the only listing query is
  `{ kinds: [LISTING_KIND, SALE_KIND], authors: [pubkey] }`. Every 30402 the seller ever published,
  regardless of collection membership.
- `storefront/src/listing.ts:274-281` — `orderBySale` only **sorts**. A non-member gets
  `Number.MAX_SAFE_INTEGER` and falls to the end, then ties break on `d`.

The ledger already records this outcome for the adjacent defect: *"They are **not deleted** — they
survive on the relays and `storefront/src/listing.ts` `orderBySale` renders collection members first
and strays after, so they drop to the foot of the sale page in `d` order. A demotion, not a loss"*
(`docs/known-defects.md`, slice-9 section, row 1).

So removing an item from the 30405 moves it down the page and nothing else. Only the NIP-09 request —
the half M3 calls unreliable — could stop it rendering, and only on relays that honour it.

**Interaction with item 13, which the brief asks about:** it is worse than neutral. Item 13's defect
is that `publishSale` sends whatever the last four-relay read returned. M3's delete works *by*
shrinking that member list. So until item 13 lands, "delete an item" and "a slow relay ate an item"
are the same event on the wire, and item 13's proposed guard — *"refuse to shrink a sale without an
explicit confirmation"* — is a prompt M3 will trip on every legitimate delete. The ledger names this
exact collision: *"comparing against it means 'refuse to shrink the sale', and shrinking the sale is
also what removing an item legitimately looks like"* (`docs/known-defects.md`, slice-9 section, row 1).

**What the roadmap should say instead:** retirement is a re-publish at stock 0 with `status: sold`
(which `ladder.ts` `atStock` already produces) plus an optional NIP-09 request; the member-list
removal hides nothing, and M3 must land after item 13 or it will fight item 13's confirmation prompt.

M3's fiat half holds up exactly as written — `builder/src/admin.ts:112` is
`if (item.price && item.price.currency !== 'sats') return null`, and the reasoning in the function
header matches the roadmap's ("a sats-only form would republish it as 80 sats").

---

## 5. M5 — **mis-cited, and cheaper than the brief feared.** §7.6 already designed pickup, and the re-mint is avoidable.

**(a) The citation is wrong.** M5 says *"`docs/spec.md` §7.6 flagged that this must be designed
rather than inherited, and it never was."* §7.6 designs it, in full:

> "The cheap version, and the one to build: the invoice the node stores carries the buyer's ephemeral
> request pubkey (`clink_requester_pub`). The buyer's page keeps that ephemeral key. At the driveway
> the seller's device shows a QR challenge, the buyer's page signs it with that key, and the seller
> checks the signature against the pubkey on the settled invoice — which the watcher already synced."
> — `docs/spec.md:723`

It also names why it is unbuilt, which is not "nobody designed it": *"Both this and §14's pickup-
messaging question depend on the same thing: the buyer's page keeping the ephemeral key it minted in
`buy.ts`, which today is dropped when the page navigates away… Persisting it is a new decision about
storing key material in a browser, and `/CLAUDE.md` rule 2 is watching. **If it is ever kept, keep it
for both**"* (`docs/spec.md:733-736`).

M5 proposes a *different* mechanism and never mentions the one on the books, so the pairing §7.6
insists on ("keep it for both") is silently dropped. A pickup code in `payer_data` also proves less:
§7.6's challenge proves the person at the table holds the key that paid; a buyer-chosen code proves
they remember what they typed.

**(b) The re-mint premise the brief suspected is wrong — Manage `update` can change `payer_data` in
place.** Read from the running node:

- `managementManager.ts:290-315` `updateOffer` passes `payer_data: nmanageReq.offer.fields.payer_data`
  straight to `UpdateUserOffer`, keyed on the existing `nmanageReq.offer.id`, then returns
  `GetOffer(id)`. The offer id — and therefore the `noffer` — is unchanged.
- So for any offer the builder minted (`builder/src/manage.ts` `mintOffer`, Manage `create`), adding a
  second required key is **one `update` per offer**: no new pointer, no listing re-publish, no ladder
  re-cut, no `1 + units` signatures.

**The exception is the five fixture offers, and it is already a known and accepted cost.**
`validateOfferAccess` refuses unless `offer.management_pubkey === requestorPub`
(`managementManager.ts:275-282`), and the fixture's five were minted natively so the column is `''`
(`docs/spike-findings.md` §13.20). Those five would have to be re-minted — but §13.20 already says
*"They get re-minted through Manage if and when they are ever edited"*, so M5 inherits that cost
rather than creating it.

**(c) One implementation note M5 needs.** `ValidateExpectedData` only checks
`typeof payerData[key] !== 'string'` (`offerManager.ts:148-152`), so an **empty string satisfies a
required key**. A pickup code declared this way is not enforced by the node; the page must enforce it,
exactly as `render.ts:510` already enforces `isPointer` for `refund_pointer`. (See MISSING-4 — this
has a consequence for `refund_pointer` today.)

**What the roadmap should say instead:** M5 is a Manage `update` per Manage-minted offer plus a
re-mint of the five native fixture offers, and it must first answer why it supersedes spec §7.6's
`clink_requester_pub` challenge rather than sitting beside it.

---

## 6. ~~MISSING — the second seller has never received a satoshi~~ — **withdrawn. It has, and no tool in the repo could see it.**

**This finding was wrong, and fixing finding 7 is what proved it wrong.** Both sources said it
plainly and both were stale: `docs/prompts/demo-day.md:48-51` (*"The Mérida sub-account has never
received money… the single largest unproven thing in the demo"*) and `docs/status.md:75`
(`manage_id 2, balance 0`).

After adding `--key` to `sales-report.ts` (finding 7), `node sales-report.ts --key .merida-key`
reports:

```
artesanias-jabon                  800   1/12       800          1/1   2026-08-21T22:13:28.000Z
# 1 settled invoice(s), 800 sats received
```

The payment landed on the evening of 2026-08-21, **hours after** both of those lines were written,
and sat unreported for two days because no command in this repo could address that account.

**It arrived over the channel rather than internally**, which is the distinction `demo-day.md:57-59`
warns about. `lncli listchannels` reads `local_balance 9800` against the two accounts' 9,000 + 800.
A `PayInternalInvoice` between two accounts on one Pub is a database move that leaves channel local
balance untouched, so the sum matching is the evidence it was real Lightning.

**So milestone B's claim survives** and findings §11 — one Pub hosting a market of sellers, each
with their own sub-account — is proven with money rather than argued. The roadmap records this as a
struck-through item 23 rather than a task.

The residual is small and stays where it is: `.merida-key` has no refund grant, so the oversell path
has never run for that seller. Item 6 covers that class on the default seller.

**The lesson is finding 7's, not this one's.** A settled invoice was invisible to every document in
the project for two days, and one flag surfaced it in a single command.

---

## 7. MISSING — `sales-report.ts` is hardcoded to one seller, and M4 and 19 both rest on it.

`spike/sales-report.ts:49` — `const KEY_FILE = join(HERE, '.dev-key')`. There is no `--key` flag;
`grep -n "arg(" sales-report.ts` returns only the `--nprofile` argument. Verified by running it:
`node sales-report.ts --key .merida-key` silently reports the **default** seller.

By contrast `spike/watch-sales.ts:80` is `const KEY = arg('key', '.dev-key')`, and
`.merida-key.offers.json` / `.merida-key.ladder.json` both exist. So the watcher is multi-seller and
the only tool that reports money is not.

This lands on two roadmap items:

- **M4** says *"Carry exactly what `spike/sales-report.ts` prints"* — for a second seller it prints
  somebody else's sales.
- **19** ("a second seller who is not us") ships a person a system in which they cannot see what they
  earned, from a terminal or otherwise.

**And it hid a real payment for two days.** Fixing it is what produced finding 6's retraction: an
800-sat settled invoice on the second seller's account, dated 2026-08-21T22:13:28Z, that no document
in the project knew about and no command could reach. This is the cheapest item in the report and it
was the one concealing a fact two other documents got wrong.

**What the roadmap should say instead:** a one-line `arg('key', '.dev-key')` in `sales-report.ts`,
in milestone A next to the other authoring defects, because it is a five-minute change that item 19
is otherwise blocked behind. **Landed 2026-08-23**, mirroring `watch-sales.ts:80-81`'s `suffixed()`
pattern so the ladder path derives from the same flag.

---

## 8. M7 — **mis-cited twice.** `check-deploy.ts` walks the wrong blobs, and mirroring alone would buy nothing.

M7: *"A command that reports per-blob mirror count across the kind 10063 list and re-uploads anything
below a threshold. `check-deploy.ts` already does the walk; this is the repair half."*

**(a) The walk is over the nsite's own files, not item photos.** `spike/check-deploy.ts:109-119`
iterates `paths` — the file list from the kind 15128 manifest — and counts complete mirrors of *those*.
Item photos are never in `paths` and are never checked.

**(b) Mirroring without re-publishing buys nothing, because the listings name one URL and no
fallback.** Measured across both live ladders:

| | distinct blobs | hosts | `imeta`/`fallback` |
|---|---|---|---|
| `spike/.ladder.json` | 15 | `…blossom.band` only | **none** |
| `spike/.merida-key.ladder.json` | 18 | `cdn.hzrd149.com` only | **none** |

Every photo tag is a bare `["image", "https://…", "1200x900"]`. `spike/seed-listings.ts` writes no
`imeta` at all (`grep -n imeta spike/seed-listings.ts` → nothing), and both live sales were seeded.
Even where `imeta` *is* written — `builder/src/listing.ts:75` `imetaTag` writes `fallback` — nothing
consumes it: `grep -rn imeta storefront/src/` returns one CSS comment (`style.css:140`) and no code,
which the ledger already records (*"`x` and `dim` are still written and unread"*).

So a mirror repair tool would upload blobs that no rendered page can reach.

**What the roadmap should say instead:** M7 is three things, not one — walk the *item* blobs (new
code, not `check-deploy.ts`'s walk), re-publish the listings so the mirrors appear in `imeta
fallback`, and teach `storefront/src/listing.ts` `srcset` to fall back — and the measured state is 33
single-homed blobs across two sales, not "the fixture's 21 photos".

*(The "21 photos" figure comes from `docs/spec.md:1645`; the 5-item ladder carries 15 distinct blob
URLs. The Mérida sale's 18, on a different single host, are recorded nowhere.)*

---

## 9. Item 2 — **holds up, and it under-scopes by one branch.** `--reset` has the same bug.

The defect is verified structurally: the key file check and mint sit at
`spike/authorize-refunds.ts:119`, the `--revoke` branch at `:191`.

But `--revoke` is not the only branch downstream of the mint. `:202` is
`if (process.argv.includes('--reset')) { await rpc('ResetDebit', { npub: refundPub }) … }` — the same
`refundPub`, derived from the same possibly-just-invented key. A fix that guards only `--revoke`
leaves a second switch that reports success on a key that was never granted anything.

One cheap note on scope: bullet 3 ("Read the granted pubkey back from `GetDebitAuthorizations` and
ban *that*") already has its helper — `grants()` at `:169` — and `--revoke` already calls
`describe(await grants())` at `:194`, one line after it prints `BANNED`. The change is reordering,
not new machinery.

**What the roadmap should say instead:** move the mint below **both** the `--revoke` and `--reset`
branches, and reuse `grants()` at `:169` rather than treating the file as the source of truth.

---

## 10. Item 8 — **mis-cited.** It contradicts a decision already reasoned out in a file the author never opened.

Item 8: *"Playwright is already installed in `shots/` — reuse it… Wire it into `npm test` so it is
not a thing anyone remembers to do."*

`docs/prompts/browser-verify-and-deploy.md:31-52` works through exactly this and lands somewhere else:

- *"`/docs/status.md` says tests are `node --test`, no framework, three suites, **'do not start a
  fourth pattern.'** Playwright ships its own runner with its own config file, its own assertions and
  its own reporter. Using it would be exactly the fourth pattern that line forbids."*
- *"A browser test that launches Chromium and talks to public relays is not that. Decide whether it
  is a separate script in `/spike`… **The `check-*.ts` family is the better fit and it keeps `npm
  test` honest.**"*

And the signer problem item 8 does not mention at all: *"Playwright cannot be either signer, and
pretending otherwise is the whole risk"* — the `window.nostr` shim holds a private key in a page, so
*"`/CLAUDE.md` rule 2 applies to it directly"* (`browser-verify-and-deploy.md:54-92`). Item 8's second
assertion — *"assert the print stylesheet hides `<main>`"* — is the **builder's** print block
(`docs/known-defects.md`, slice-9 section, row 3 names `builder/src/style.css`), which needs a
signed-in panel, which needs that shim. That is not "two files, a handful of assertions".

One smaller point: `shots/package.json` is `"private": true` with its own `devDependencies`. "Already
installed" means installed in a third package, not in `builder/` or `storefront/`.

**What the roadmap should say instead:** item 8 is a `spike/check-browser.ts` in the `check-*.ts`
family driving the `playwright` library from `node --test`, not a `npm test` addition — and it
inherits the rule-2 decision about the `window.nostr` shim that `browser-verify-and-deploy.md`
already framed.

---

## 11. Item 20 — **mis-cited.** The line to change is in a different file.

Item 20 (and `docs/runbook.md:11`) both say *"`unlocker.ts:116` hardcodes the Linux log path"*.

- `unlocker.ts:104` — `const lndLogPath = this.settings.getSettings().lndSettings.lndLogDir`. It only
  *reads* the setting. Lines 116-123 are the polling loop.
- The hardcoded default is `settings.ts:116` —
  `lndLogDir: chooseEnv('LND_LOG_DIR', dbEnv, resolveHome("/.lnd/logs/bitcoin/mainnet/lnd.log"), addToDb)`

The line number is right and the file is wrong, which is the kind of mis-citation that costs an hour
when somebody opens a PR against it.

**What the roadmap should say instead:** `settings.ts:116` `chooseEnv('LND_LOG_DIR', …,
resolveHome("/.lnd/logs/bitcoin/mainnet/lnd.log"), …)`, read by `unlocker.ts:104`.

---

## 12. M2 — **the dependency is backwards.** It does not need M1.

M2 is marked *"(needs M1)"* and says *"If yes: it rides in the same encrypted 30078 as the notes."*

That event exists today. `builder/src/notes.ts` shipped in slice 6: kind 30078, `d: lamppost-shop`,
NIP-44 to self, already loaded by the panel, already saved by it (`notes.ts:80-99`). Adding one key
to the note map is a change to `parseNotes`/`saveNotes`, not to anything M1 builds. M1 creates
*different* events (`lamppost-ladder-<slug>`) that M2 never touches.

M2's real blocker is the one it already names correctly — the decision about whether the account
pointer may leave the browser — and that decision has an input the roadmap does not give it:

**the `nmanage` pointer alone confers no authority.** `validateGrantAccess`
(`managementManager.ts:254-273`) requires a per-requestor `ManagementGrant` row and returns
`authRequired` when there is none, for every requestor including the account owner
(`docs/spike-findings.md` §13.4). Whoever holds the pointer still needs a grant against their own
pubkey. It is an address, not a bearer credential — which is a materially different risk from
`admin.connect`, and is the fact the decision should turn on.

**What the roadmap should say instead:** drop "(needs M1)", note that the carrier event shipped in
slice 6, and record that the pointer is an address rather than a bearer token
(`managementManager.ts:254-273`) as an input to the decision.

---

## 13. Item 13 — **mis-placed.** Half of one button is in A and the other half is in D.

Milestone A's claim is *"Nothing known-broken can lose money **or destroy a seller's work**."* Item
3's second bullet is in A because a click in the wrong window *"publishes a kind 30405 with an empty
member list and un-lists the whole sale."* Item 13, in D, is the same button producing a member list
that is short rather than empty.

Both are `#publish-sale` → `doPublishSale` → `publishSale(signer, draft, owned.map(…))`
(`builder/src/main.ts:357`). Item 3 fixes "fires before `owned` is populated"; item 13 fixes "fires
when `owned` is short". Fix one and the button can still drop items.

I am **not** attacking C-before-D generally — the argument in `README.md:208-212` is sound, and the
"building D first means building parts of it twice" point is borne out by finding 14 below. The
placement of item 13 specifically is what is wrong.

There is a real reason item 13 is bigger than item 3, and the roadmap should keep it: the fix needs a
"refuse to shrink" rule, and shrinking is also what a legitimate delete looks like
(`docs/known-defects.md`, slice-9 section, row 1) — which is why it entangles with M3 (finding 4).

**What the roadmap should say instead:** item 13's *quorum* and *show-the-count* bullets belong in A
with item 3 (same button, same class of loss); its *refuse-to-shrink* bullet stays in D and is
sequenced against M3.

---

## 14. Item 11 — **holds up, but it re-adopts an implementation the ledger costed and rejected.**

Item 11's second bullet: *"Have the watcher re-check staleness per tick, not only at startup."*

The ledger row prices exactly that and declines it: *"Re-checking every tick means a relay read per
poll per item — five items at 5s is 60 relay reads a minute for a state that changes when a human
presses a button. A watcher that re-read its own ladder file on change would be the better shape."*
Its prescribed fix is *"Watch `.ladder.json` with `fs.watch` and re-derive `watching` when it
changes"* (`docs/known-defects.md`, slice-6 section, row 2).

The roadmap picks the rejected option without saying so. The sequencing is defensible — M1 deletes the
file, so `fs.watch` would be thrown away — but that is an argument the roadmap should make, because
right now it silently reverses a costed decision.

Worth noting the arithmetic is worse than the ledger's: the Mérida sale has 6 watched items, so it is
72 relay reads a minute there.

**What the roadmap should say instead:** item 11 re-checks on **ladder update** — the `fs.watch` event
before M1, the relay subscription after it — not per tick, and say that this is why it is sequenced
behind M1 rather than built twice.

---

## 15. M8 — **holds up, verified from source, with one privacy correction.**

Re-fetched today from `nostr-protocol/nips` `master` (the NIPs repo is not on this machine, per
`docs/status.md` traps):

- `README.md:116` — `- [NIP-CC: Geocaching](CC.md)`. The roadmap's "NIP-CC (geocaching), not NIP-99"
  is correct.
- `CC.md:53` — *"`g` (required) - geohash of cache location. **To allow for a proximity search,
  include multiple geohash tags at different precision levels (3-9 characters)**"*. Verbatim support
  for the mechanism.
- `99.md:53` — *"`\"g\"`, a geohash for more precise location"*. Nothing about multiple precisions,
  as claimed.
- `01.md:139` — *"In the case of tag attributes such as `#e`, for which an event may have multiple
  values, the event and filter condition values must have at least one item in common."* Set
  intersection of exact values; no prefix matching. The premise holds.

**The correction.** `CC.md:53` says 3-9 characters and `CC.md:261` tells clients to *"Validate geohash
precision meets minimum requirements (8+ characters…)"*. This project deliberately publishes
**7**: `builder/src/sale.ts:124-126` — *"7 characters is ±76 m, which is a driveway. **More would
publish which house.**"* Applying NIP-CC literally would reverse that decision silently.

**What the roadmap should say instead:** publish **prefixes** of the existing 7-character geohash
(3-7), never longer, and note that NIP-CC's own 8+ recommendation is for caches rather than homes and
is deliberately not followed here.

*(Small drift, not in the roadmap: the traps in `docs/status.md` cite `01.md:33` for exact tag
matching. `01.md:33` is event-id serialization; the filter semantics are at `01.md:139`.)*

---

## 16. Item 14 — **already exists**, two of three bullets, as documentation.

- Bullet 1, the lease date: `docs/runbook.md:100` already reads *"**It is a lease.** This one expires
  **2026-11-19.** Calendar it."* What does not exist is the check in the day-to-day block —
  `docs/runbook.md:131-137` is four shell aliases plus `lncli state` and `lncli getinfo`, no lease
  check — and an alarm.
- Bullet 2 is a restatement of `docs/runbook.md:120-126` §4 Uptime, near-verbatim, including
  `caffeinate -s` and "an always-on machine". It also appears in the demo-day checklist at `:145`.
- Bullet 3 is already in the runbook (`:110` — *"An invoice request succeeding proves nothing"*) and
  in the traps list.

**What the roadmap should say instead:** item 14 is one line in `docs/runbook.md` §5 and a calendar
entry for 2026-11-19; the uptime and invoice-vs-settlement bullets are already written down and
should be dropped rather than re-scoped.

---

## 17. Item 18 — **partly already exists.** "One answer instead of three" is already one answer.

Item 18: *"Have `check-deploy.ts` report the gateway's cache age alongside the relay and Blossom
state, so 'did my deploy land' has one answer instead of three."*

`spike/check-deploy.ts` is already structured as exactly that: section 1 relays, section 2 Blossom,
section 4 *"GATEWAY — a cache in front of the two above, NOT the source of truth"* (`:148`), which
byte-compares every path against the manifest and prints `STALE` per path, then explains that staleness
is *"almost always the hour-long gateway cache… not a broken deploy"* (`:162-165`).

What is genuinely missing is the number: it does not read the response's `age` / `cache-control`
headers, so it can say "stale" but not "for another 41 minutes".

Bullet 3 ("Build stickers after deploying") is already a trap in `docs/status.md` and already the
design note in `design.md` §4, so it is a documentation duplicate rather than work.

**What the roadmap should say instead:** item 18 is one addition — print the gateway's remaining
cache TTL from the response headers in `check-deploy.ts` section 4 — plus the cache-busting question,
which is genuinely open.

---

## 18. Items 5 and 17 — **duplicate.** The same fix is scheduled in A and again in E.

Item 5, first bullet: *"`storefront/src/render.ts:521` — the Buy form awaits `requestInvoice` with no
`catch`… **Fix on sight.**"*
Item 17, first bullet: *"Wrap the Buy form's `requestInvoice` so a rejection re-enables the form and
explains itself."*

Same defect, same fix, milestones A and E.

The claim itself is real and the citation is exact — `render.ts:521` is
`const outcome = await requestInvoice(`, with `submit.disabled = true` and `field.disabled = true` at
`:517-518` and the re-enable at `:540`, no `try`. But the trigger is narrower than "a rejection":
`attempt` in `buy.ts` resolves rather than rejects on every network and protocol path
(`buy.ts:190-215`, one `finish()` per branch plus a deadline). The reachable throws are *before* the
promise — `getConversationKey(sk, offer.pubkey)` at `buy.ts:130` on a pubkey that is not a curve
point, and `finalizeEvent`/`encrypt` — i.e. a malformed `clink_offer` in the seller's own listing, not
a dead relay.

**What the roadmap should say instead:** delete item 17's first bullet (item 5 owns it), and item 5
should name the trigger — a `clink_offer` whose pubkey is not a valid curve point reaches
`getConversationKey` and throws synchronously — so the fix lands in `buyableOffer` as well as in a
`try`.

---

## 19. Item 15 — **the dependency is wrong, and one gotcha will eat the "five minutes".**

Item 15 is marked *"(needs 7)"*. Item 7 is the browser/Amber bunker session. Item 15's verification is
*"pair ShockWallet, point the builder at an account with no grant, send one 21003, and see whether
the wallet renders a prompt"* — a phone with a **wallet**, not a bunker. `spike/authorize-manage.ts`
already drives this path from a terminal with a raw key, so nothing about it waits on the NIP-46
handshake.

The mechanism is source-verified and item 15's description of it is accurate:
`sendManageAuthorizationRequest` (`managementManager.ts:59-63`) pushes
`{requestId: "GetLiveManageRequests", npub, request_id}` to the **account owner's** pubkey, and
`AuthorizeManage` is `auth_type = "User"` (`proto/service/methods.proto:678-679`) — both kind 21000,
both things a paired wallet can speak.

**The gotcha:** `handleAuthRequired` rate-limits a repeat from the same pubkey with
`{res:'GFY', code:4, error:'Rate Limited', retry_after: 600}` (`managementManager.ts:70-72`). A second
probe inside ten minutes returns a rate-limit, not a prompt, and will read as "the wallet does not
render one".

**What the roadmap should say instead:** item 15 needs a paired ShockWallet, not item 7 — and one
probe per ten minutes, because a repeat inside `retry_after: 600` answers GFY 4 rather than prompting.

---

## 20. M6 — **partly already decided.** The code picked one of the two options for new sellers.

M6's first bullet asks to *"Decide the model: a new `d` per sale with an explicit migration, or one
long-lived sale that items join and leave."*

Slice 9 already chose the second for everybody who is not the fixture:
`builder/src/sale.ts:53` — `d: 'sale'`, and `docs/spec.md:1486` explains it — *"New sellers get
`sale`, with no date in it: a date goes stale at the second sale, and changing it then would break
every `a` tag and every prefix at once."*

So the undated, long-lived collection is the shipped model. What is genuinely open is (a) the fixture
seller, stuck on the dated `yardsale-2026-08`, and (b) M6's second and third bullets — archiving, and
"this sale has ended" — which nothing has decided.

**What the roadmap should say instead:** the model is already chosen (`sale.ts:53`, spec §10 slice 9);
M6 is the archiving decision plus the ended-sale render, and a migration for the one dated collection
that predates the choice.

---

## 21. MISSING — the builder's own nsite is live on a throwaway key, and a kind 15128 root site is one per pubkey.

`docs/status.md:71` lists the builder at
`npub1qqm97k4eg432zydvkclnhhnkyd7dgjxmndmaapk48jzms9uyl5qqlerxa2.nsite.lol`, and
`docs/prompts/browser-verify-and-deploy.md:160-163` flags it as an open decision needing an answer:
*"Does the builder's nsite get redeployed… or does it get a real identity? It is on a throwaway key
generated during slice 5."*

This is rule 5's own artifact — *"The builder itself deploys as an nsite. If our own app needed a
server, the thesis would be false"* — running under a key nobody intended to keep. And moving it is
not free later: a kind 15128 root site is one per pubkey (`5A.md:16`, `docs/spike-findings.md` §13.22),
so a real identity means a **new URL**, and every link, slide and printed reference to the old one
breaks. It also compounds with item 10, which correctly lists `.builder-key` as gone-forever-if-lost —
the roadmap protects a key it has not decided to keep.

**What the roadmap should say instead:** a decision item in E — *"give the builder a real identity or
commit to the slice-5 key"* — sequenced before anything prints or publishes its URL, because the
choice is one-way.

---

## 22. MISSING — a required `payer_data` key is satisfied by an empty string, which weakens a guarantee three documents state.

`offerManager.ts:148-152`:

```
for (const key of expectedKeys) {
    if (typeof payerData[key] !== 'string') { return { passed: false, expected: expectedKeys } }
    validated[key] = payerData[key]
}
```

`typeof '' === 'string'`, so `{"refund_pointer": ""}` passes and the invoice is issued.

Three places assert this cannot happen:

- `docs/spec.md:593` — *"A payment that would be unrefundable is therefore declined rather than
  accepted."*
- `docs/design.md` §4 — *"A raw `noffer` sticker is **unpayable by anything that cannot supply
  `refund_pointer`**."*
- `docs/spec.md:613` — the slice-8 re-decision, which argues the alternative would produce *"a
  `queued` row… no human can act on"*. That is exactly what an empty pointer produces:
  `resolvePointer` sees no pointer, and `watch-sales.ts:307` classifies it `'none'` → a `queued` row
  nobody can resolve.

The path is not hypothetical: the node's own decline names the key it wants —
`{"code":1,"error":"Missing or invalid payer_data: refund_pointer","payer_data":["refund_pointer"]}`
(`docs/spec.md:591`) — so a client that retries with any string value gets an invoice. Our own page is
safe (`render.ts:510` gates on `isPointer` before requesting), which is why nobody has hit it.

**What the roadmap should say instead:** an item in A — *"an empty string satisfies a required
`payer_data` key at the node (`offerManager.ts:148-152`), so the decline guarantee holds only for
clients that go through our form; either narrow the claim in spec §7.3 and design.md §4, or file it
upstream."* This is also a prerequisite for M5, whose pickup code has the same hole.

---

## 23. Measured drift — three numbers the roadmap and the docs both inherit are stale.

Not roadmap items, but item 6 and spec §12 are sized against them.

Run today (`node spike/sales-report.ts`, `lncli getinfo`, `lncli listchannels`, `curl /api/health`):

| | docs say | measured 2026-08-23 |
|---|---|---|
| settled invoices, default seller | 3, **8,000 sats** (`docs/spec.md:1535`, `docs/status.md:74`) | **4, 9,000 sats** |
| settled invoices, second seller | 0, **balance 0** (`docs/status.md:75`, `demo-day.md:48`) | **1, 800 sats**, settled 2026-08-21T22:13:28Z |
| channel local balance | 8,000 | **9,800** (remote 89,206) |
| node health | `{"status":"ERROR","reason":"not synced"}` (`demo-day.md:33`) | **`{"status":"OK"}`**, `synced_to_chain: true` |

The two account figures sum exactly to channel local (9,000 + 800 = 9,800), which is how the second
seller's payment is known to have arrived over Lightning rather than as an internal transfer.

Two consequences:

- **Spec §12's caveat is now false.** It says *"8,000/day equals the node's whole outbound balance, so
  in normal operation the balance binds before the rule does — which is why the proof moves the cap
  rather than spending the balance."* The account holds 9,000 (8,946 payable after fee), so the
  8,000/day cap now binds first. The cap became real and nothing records it.
- **Item 6's plan is confirmed by measurement.** `sales-report.ts` shows
  `yardsale-2026-08-mugs 1000 3/3 3000 refundable 3/3` with the offer still listed — so a further
  payment of it is the §7.3 oversell exactly as item 6 says, at 1,000 sats. Item 6 holds up.

One addition item 6 should carry from `demo-day.md:110-116`: run the refund with **`--once`**, which
exits before `setInterval` is installed (`watch-sales.ts:512-518`) and sidesteps item 1's race
entirely. Item 6's dependency on item 1 makes this belt-and-braces rather than necessary, but the
command as written in the roadmap (`node watch-sales.ts --refunds`) is the polling one.

---

## Items that hold up as written

Checked against source, not accepted:

- **1** — no in-flight guard exists (`grep -n ticking spike/watch-sales.ts` → nothing); the timer is
  `setInterval(… , POLL_MS)` at `:520` with `POLL_MS = 5_000` at `:92`; `record` at `:361` writes
  `journal[row.invoice] = {…}` unconditionally at `:370`. Both prescribed fixes are correct. *(The
  ledger's `:512` for the timer is off by 8 — `:512` is the initial `await tick()`.)*
- **3** — `builder/src/manage.ts:170` is `existing?.find(o => o.label === label)`, dedupe on label
  alone, confirmed. `#publish-sale` is enabled synchronously at `builder/src/main.ts:116`, confirmed.
- **4** — `getJson` does `const text = await res.text()` and checks `MAX_BODY_BYTES` on the line after
  (`spike/refund.ts:256-257`); no private-address check on either hop. Two small credits the roadmap
  does not take: https *is* already required on both hops (`lnurlpUrl` builds `https://` by
  construction at `:211`, and `payRequestCallback` refuses a non-https callback at `:221` and
  re-checks `url.protocol` at `:227`), and `redirect: 'follow'` inherits undici's default redirect
  cap rather than being unbounded.
- **5** — all five citations check out except one: the `k1`/TLV-3 claim is at
  `spike/watch-sales.ts:335` (`k1: k1For(row.invoice)`), not `:327` (a comment). The roadmap already
  flags this one with "Check the citation before acting", which was the right instinct. `admin.ts:82`,
  `main.ts:507` (`showSale()`), `index.html:206` and `render.ts:521` are all exact.
- **6** — confirmed by measurement, see finding 23.
- **7** — the contradiction is real: `docs/status.md:264` says *"The Amber import has happened"* and
  `docs/status.md:270` says *"The import itself is unrun and needs a phone."* Resolving it first is
  correct.
- **10** — `.builder-key` / one-nsite-per-pubkey confirmed (`5A.md:16`, findings §13.22); the backup
  at `~/.lamppost-key-backup/` is on one machine, per `docs/status.md:257`.
- **12** — no launchd plist or systemd unit exists anywhere in `docs/`
  (`grep -rn "launchd\|systemd\|plist" docs/*.md` returns only the runbook's description of the node's
  own crash loop).
- **16** — not built; `stockNote` (`storefront/src/render.ts:53`) says only "N available". Cheaper than
  it looks: `Item.created_at` is already parsed (`storefront/src/listing.ts:63`, `:183`), so it is a
  render change with no parser work.
- **21** — the BUD-11 conflict is documented with the transcript (`docs/spike-findings.md` §9,
  `builder/src/blossom.ts:23-25`) and has not been filed.
- **22** — verified both halves: the SDK ships it
  (`spike/node_modules/@shocknet/clink-sdk/build/constants.js:5`, `nenroll.js`), and
  `grep -rn 21004 ~/lightning_pub/src` returns **nothing**.
- **M4's transport reasoning**, **M1's PERMS and `d`-tag claims**, **M3's fiat half**, **M8's
  premise**, and the **"Deliberately not on this roadmap"** section — all four exclusions are
  correctly grounded (`spike-findings.md` §13.25, §31, §30 and `CLAUDE.md` rule 1 respectively).

---

## UNVERIFIED

1. **`relay.nostr.band`'s event-size limit.** The other three answered a NIP-11 request today
   (damus 1,000,000 / nos.lol 131,072 / primal 1,000,000). `relay.nostr.band` returned no NIP-11
   document over HTTPS on two attempts. *To resolve:* connect over WebSocket and publish a sized test
   event, or ask the operator. Does not change finding 3 — NIP-44's 65,535-byte plaintext ceiling
   binds well below nos.lol's 131,072, which is the lowest measured relay cap.

2. **Whether Amber implements NIP-44's extended (u32) plaintext prefix.** The installed nostr-tools
   accepts up to 4,294,967,295 bytes via a u32 prefix
   (`builder/node_modules/nostr-tools/lib/esm/index.js:2378-2384`), but the builder's encryption is
   done by the *signer*, not by nostr-tools. Finding 3 uses the conservative 65,535 ceiling.
   *To resolve:* one encrypt of a >65,535-byte plaintext through the connected bunker, during item 7's
   session.

3. **Whether CLINK Manage `update` adding a key to `payer_data` violates `clink-manage.md:193`**
   (*"`update` MUST NOT add new fields to an offer"*, via `docs/clink-notes.md` §4.3). The running
   node's implementation does not enforce it for array members
   (`managementManager.ts:298-308` validates only that each entry is a string), so finding 5's cost
   estimate holds against *this* node. *To resolve:* read `clink-manage.md:193` in the CLINK spec repo
   — not on this machine — to see whether "fields" means offer-object fields or declared payer keys.

4. **Whether an external wallet can actually pay a `refund_pointer`-required offer with an empty
   string** (finding 22). Read from source (`offerManager.ts:148-152`), not driven on the wire.
   *To resolve:* one `check-buy.ts`-shaped request with `payer_data: {refund_pointer: ""}` against the
   live node — free, no `--pay`.

5. **The precise reachability of `render.ts:521`'s missing `catch`** (finding 18). The rejection paths
   I can find are all synchronous throws before the promise in `buy.ts` (`getConversationKey` on a
   non-curve pubkey at `:130`). *To resolve:* one `node --test` case calling `requestInvoice` with a
   malformed offer pubkey, which is also the regression test the fix wants.

6. **`docs/status.md`'s "the fixture's 21 photos"** (`spec.md:1645`). The 5-item ladder carries 15
   distinct blob URLs; I did not enumerate blobs for the four items with no ladder entry. The
   single-host finding (finding 8) does not depend on the count.
