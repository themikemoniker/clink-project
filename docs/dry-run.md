# Dry run: rehearse the seller path on a throwaway key

This page joins flags that already exist into one rehearsal. It runs on a throwaway seller key
and on a relay you control. The last section says exactly how to switch to the real key and the
real relays.

Run every command here from `spike/`. The scripts resolve `--key` against their own directory
(`join(HERE, KEY)`, `spike/seed-listings.ts:50`, `spike/deploy-nsite.ts:53`), so `.rehearsal-key`
means `spike/.rehearsal-key`.

## What a dry run is, and what it cannot cover

A dry run here covers **publishing listings, the availability ladder, and the nsite deploy**,
all on a throwaway identity, with no node and no money.

It **cannot** cover a payment or a stock countdown. Both need a running Lightning.Pub node and
real sats, and there is no mock payment in this repo:

- `mint-offers.ts` connects to the node to mint the offers (`connectPub`,
  `spike/mint-offers.ts:59`). It does that even with `--dry`.
- `watch-sales.ts` refuses to start without an offers file (`spike/watch-sales.ts:146`). That
  file only comes from `mint-offers.ts`. The watcher is what counts stock down.
- `check-buy.ts` is free only up to the invoice, and it needs the node too.

One command costs real sats. **Do not run it in a rehearsal.**

```bash
node check-buy.ts <item> --pay --pointer <addr-or-noffer>   # COSTS REAL SATS. Not part of a dry run.
```

So a buyer payment and stock going down can only be seen on the real setup, with a real node and
real sats. This page does not pretend otherwise.

## Step A: a test relay

You need a relay you control, for example one listening on `ws://127.0.0.1:<port>`. Nothing in
this repo runs one, so this page names no relay software.

`UNVERIFIED: start command for a local relay.`

Every command below takes it through one shell variable:

```bash
cd spike
TEST_RELAY=ws://127.0.0.1:<port>
```

**Always pass `--relays`.** Each script below defaults to `SALE_RELAYS` (`spike/fixture.ts:28-33`),
which are four public relays. `check-ladder-relay.ts` run without `--relays` is a public write to
those four (`spike/check-ladder-relay.ts:34`):

```bash
node check-ladder-relay.ts      # PUBLIC WRITE: no --relays means the four SALE_RELAYS. Not a rehearsal.
```

## Step B: the relay round trip

```bash
node check-ladder-relay.ts --relays $TEST_RELAY
```

It makes its own two throwaway keys in memory and writes nothing to disk
(`spike/check-ladder-relay.ts:13-17`, `:45-48`). It publishes a ladder event to the relay, reads it
back, decrypts it, and checks that a live subscription receives a re-published copy.

Each check prints one line (`spike/check-ladder-relay.ts:37-40`). A pass starts with `  ok  `
and a failure starts with `  FAIL`. A good run has only `ok` lines and ends with:

```
# ALL CHECKS PASSED
```

It exits 0. On a failure it prints `# N CHECK(S) FAILED` and exits 1
(`spike/check-ladder-relay.ts:161-162`). If this step fails, your relay is the problem, and
nothing after this step will work either.

## Step C: a throwaway seller

```bash
node seed-listings.ts --key .rehearsal-key --relays $TEST_RELAY --blossom http://127.0.0.1:<blossom-port>
```

**The key.** If `spike/.rehearsal-key` does not exist, the script creates it with mode 600 and
prints `# generated a new throwaway dev key at …` (`spike/seed-listings.ts:74-77`). It is
gitignored: `.gitignore` has `spike/.*-key` and `spike/.*-key.*`, which cover the key and both
state files below (`git check-ignore -v spike/.rehearsal-key` shows it). It holds no funds.

**The listings.** It publishes the fixture yard sale (`spike/fixture.ts`) under the throwaway key,
one kind 30402 per item and one kind 30405 for the sale, to `$TEST_RELAY` only
(`spike/seed-listings.ts:57`, `:293-300`).

**No Buy buttons. That is the point.** The offers file is derived from the key, so it is
`spike/.rehearsal-key.offers.json` (`suffixed()`, `spike/seed-listings.ts:51-53`). In a rehearsal it
does not exist, because only `mint-offers.ts` writes it, and that needs the node. The script then
prints `# no …/.rehearsal-key.offers.json — publishing without clink_offer tags; run mint-offers.ts
first` (`spike/seed-listings.ts:90-92`). The listings carry no `clink_offer` tag, so no Buy button
appears. This is the rehearsal's no-node mode.

**The ladder file.** The script ends by writing `spike/.rehearsal-key.ladder.json`
(`spike/seed-listings.ts:272`). Never point `watch-sales.ts` at it unless you mean to run a
watcher. Running a watcher is outside this page.

**Blossom: what gets written where.** Before it publishes, the script fetches photos at three
widths from `https://picsum.photos` into `spike/seed-photos/`, unless they are already there
(`spike/seed-listings.ts:112-123`). That is a public read. It then uploads every photo to every
Blossom server in its list (`spike/seed-listings.ts:158-190`). By default that list is five public
servers (`spike/seed-listings.ts:68-71`): `cdn.hzrd149.com`, `blossom.primal.net`,
`files.sovbit.host`, `nostr.download` and `blossom.band`. Each upload is signed by the rehearsal
key with a kind 24242 auth event.

`--blossom` replaces that list. Pass a Blossom server you control.

`UNVERIFIED: start command for a local Blossom server.`

If nothing listens at the address you pass, every upload fails as unreachable and the run goes on
(`spike/seed-listings.ts:169-172`). It prints `# WARNING: no blob uploaded; listings will have no
images` (`:192`), and the listings publish without images. That is still a valid relay-only
rehearsal. Leave out `--blossom` and the photos go to the five public servers.

**Seeing it.** The storefront's relay list is hard-coded (`storefront/src/main.ts:13-18`), so
`npm run dev` with `?seller=npub1…` does not read your test relay. `check-admin.ts` and
`check-deploy.ts` read only `SALE_RELAYS` and have no `--relays` flag. That gap is known and is
not fixed here. To check what landed, query `$TEST_RELAY` directly. `deploy-nsite.ts` prints `nak
req` lines for that (Step D).

## Step D: deploy

The deploy needs a built storefront first: `npm run build` in `storefront/`. That puts it in
`storefront/dist`, which is `deploy-nsite.ts`'s default directory (`spike/deploy-nsite.ts:52`).

First the free version. It publishes nothing and contacts no server:

```bash
node deploy-nsite.ts --key .rehearsal-key --dry
```

`--dry` hashes the files and signs both events, then skips the upload and the publish
(`builder/src/deploy.ts:208`, `:228`). `--key` is needed even with `--dry`. Without it the script
looks for `spike/.dev-key` and stops if it is missing (`spike/deploy-nsite.ts:53`, `:56`).

Then the real deploy, to the test relay:

```bash
node deploy-nsite.ts --key .rehearsal-key --relays $TEST_RELAY --blossom http://127.0.0.1:<blossom-port>
```

This one **still touches Blossom**. It uploads every storefront file before it publishes. If no
server ends up holding a complete copy, it refuses to publish the manifest
(`builder/src/deploy.ts:208-221`). So an unreachable `--blossom` does not work here the way it does
in Step C: the deploy fails. You need a Blossom server that accepts the files. Without
`--blossom`, the storefront files go to the public servers in `SERVERS`
(`builder/src/blossom.ts:45-51`, `spike/deploy-nsite.ts:87`).

The URL it prints is on a public gateway. Whether that gateway can read a manifest that is only on
your test relay is `UNVERIFIED`. Assume it cannot. Use the `nak req … $TEST_RELAY` lines the
script prints (`spike/deploy-nsite.ts:120-121`) to check the manifest instead.

## The builder UI

The builder's relay list is `SALE_RELAYS` (`builder/src/publish.ts:8`, `:17`), and it has no
setting, so a publish rehearsed in the builder goes to the four public relays. For a rehearsal
that touches only your relay, use the scripts above.

## Switch to the real setup

The rehearsal made exactly one key, `spike/.rehearsal-key`, and that key must not become the
seller. **Nothing above created a real seller key.** So the switch starts by making one.

1. Stop passing `--key .rehearsal-key`, `--relays …` and `--blossom …`. With no `--relays`, every
   script uses the real relays.
2. Make the real seller key. README → Setup → "The one step ShockWallet does not do for you
   yet" is where it comes from: `node new-key.ts <name>` writes a fresh key to `spike/<name>`
   (mode 600, gitignored) and refuses to overwrite one that exists (`spike/new-key.ts:33-36`).
   This page uses `.my-key`.

   **Do not lean on the `.dev-key` default.** With no `--key`, every script uses `spike/.dev-key`,
   the author's fixture seller, which exists only on the author's machine. Without it,
   `mint-offers.ts` and `deploy-nsite.ts` stop with `no …/.dev-key`
   (`spike/mint-offers.ts:53`, `spike/deploy-nsite.ts:56`), and `seed-listings.ts` silently
   creates a new `.dev-key` and publishes the fixture sale under it to the four public relays
   (`spike/seed-listings.ts:74-77`). If you are the author and already hold `spike/.dev-key`,
   you may drop `--key .my-key` from the lines in step 4 and skip `new-key.ts`. Everyone else
   passes `--key` every time.
3. The real relays are `SALE_RELAYS` in `spike/fixture.ts:28-33`, the four public relays every
   script above falls back to when `--relays` is left out.
4. Mint the offers against the node, then publish and deploy on the real key and the real relays:

   ```bash
   node new-key.ts .my-key                       # the real seller key; the rehearsal never made one
   node mint-offers.ts --key .my-key --dry       # still connects to the node; mints nothing, writes nothing
   node mint-offers.ts --key .my-key             # needs the running node; writes .my-key.offers.json
   node seed-listings.ts --key .my-key           # real relays, now WITH clink_offer tags
   node deploy-nsite.ts --key .my-key            # real Blossom servers, real relays
   ```

   On someone else's Pub, give `mint-offers.ts` the operator's pairing string with
   `--nprofile nprofile1…` (README → Setup explains the default). The state files are
   `spike/.my-key.offers.json` and `spike/.my-key.ladder.json`, derived from the key's name
   (`spike/mint-offers.ts:46`, `spike/seed-listings.ts:51-53`).

   These scripts publish a fixture module, `spike/fixture.ts` unless you pass `--fixture`. To
   sell your own items, author them in the builder instead: run
   `node authorize-manage.ts --key .my-key` once and follow README → Setup → "Then, in the
   browser". The builder publishes to the same `SALE_RELAYS`.
5. When you are finished, delete `spike/.rehearsal-key*`. That removes the key and its state
   files: `spike/.rehearsal-key.ladder.json`, and `spike/.rehearsal-key.offers.json` if you ever
   minted against it. Both are derived from the key's file name (`suffixed()`,
   `spike/seed-listings.ts:51`), so they mean nothing without it. Do not delete `.my-key`: it is
   the account.
