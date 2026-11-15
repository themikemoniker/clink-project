# Setup: from a fresh clone to a published sale

This page lists, in order, every step a seller takes. It starts at `git clone` and ends at a
published sale. Each step says what to run, or which screen to use, and what you should see.
You need nothing but this page and the files in this repo. Where a step depends on something
this repo cannot show, the page says `UNVERIFIED`.

This page uses `.my-key` as the seller key's name all the way through. Each command block starts
in the repo root, the folder `git clone` made. If you are still in `spike/` from the last block,
`cd ..` first.

## Before you start: rehearse

[`docs/dry-run.md`](dry-run.md) walks the publish and deploy half of this page on a throwaway key
and a test relay, with no node and no money. It also says what a rehearsal cannot cover: a payment
and a stock countdown both need a real node and real sats.

## Why is there a terminal step at all

The builder never holds your key. It signs through a NIP-07 extension or a NIP-46 bunker. A
bunker can sign events and encrypt with NIP-44, but it never gives out raw ECDH. Lightning.Pub's
own kind 21000 RPC is encrypted with a key derived from raw ECDH, so a bunker cannot speak kind
21000 at all (`spike/authorize-manage.ts:5-12`, `docs/spike-findings.md` §13, item 18). The builder
makes its node calls over CLINK Manage, kind 21003, instead. But Manage cannot create its own
grant. The only call that creates one is `AuthorizeManage`, and that call is kind 21000
(`spike/authorize-manage.ts:18-22`). So one call in the whole seller path needs the raw key, once,
in a terminal next to the key file. That is Step 7. After it, nothing in the authoring path needs
a raw key again.

## Step 1: prerequisites and the clone

**Run**

Install Node 24 or newer. It runs the `.ts` files in `spike/` directly, with no build step
(README, "Repo layout", `README.md:44`). Then clone this repo:

```bash
git clone <this repo's URL>
cd <the folder it made>
node --version
```

**You should see** `node --version` print `v24` or higher.

## Step 2: a node

**Run** README → Setup → "Seller — do you need to run a node?". Pick one:

- **Option A**: an account on someone else's Lightning.Pub. The operator gives you their guest
  pairing string, an `nprofile1…`. It is the contents of `~/lightning_pub/app.nprofile` on their
  machine, and it carries no admin authority. Keep it: Step 7 needs it as
  `--nprofile nprofile1…`.
- **Option B**: your own Lightning.Pub (`docs/runbook.md`). On the node machine the pairing string
  is already at `~/lightning_pub/app.nprofile`, which is the default the scripts read
  (`spike/authorize-manage.ts:53`). You pass no `--nprofile`, and you run Step 7 on that
  machine.

**You should see** an `nprofile1…` string from your operator (Option A), or a running node with
`~/lightning_pub/app.nprofile` on it (Option B).

## Step 3: install the scripts' dependencies

**Run**

```bash
cd spike && npm install
```

**You should see** npm finish with no error. `spike/` is its own package. Its scripts import
`nostr-tools` and `@shocknet/clink-sdk` (`spike/package.json`), so nothing in `spike/` runs before
this.

## Step 4: install the storefront's dependencies

**Run**

```bash
cd storefront && npm install
```

**You should see** npm finish with no error. This is needed only because Step 6's
`export-key-qr.ts` borrows the storefront's QR library (`spike/export-key-qr.ts:29-31`). It is also
needed if you run the builder locally in Step 8, because the builder builds the storefront first
(`README.md:49-54`).

## Step 5: make your seller key

**Run**

```bash
cd spike
node new-key.ts
```

With no argument it makes `spike/.my-key` (`spike/new-key.ts:26`). If you give it a name, the name
must match `^\.[\w-]*-key$` or it refuses (`spike/new-key.ts:28-31`). It never overwrites a key
that already exists (`spike/new-key.ts:33-36`). It uses no relay, no node and no network.

**You should see** three lines (`spike/new-key.ts:42-44`):

```
npub1…
# wrote a new secret key to …/spike/.my-key (mode 600, gitignored). Back it up: it is the account.
# next: node authorize-manage.ts --key .my-key --nprofile <nprofile1… from your node operator>
```

Do not run the `# next:` line yet. Steps 6 and 7 do it, in that order.

## Step 6: put the same key in your signer

The builder makes its node calls as whatever pubkey your signer reports. The grant from Step 7 goes
to the pubkey in `spike/.my-key` and to nobody else (`spike/authorize-manage.ts:72-76`). So your
signer must hold that same key. A bunker never gives its key out, so the key has to go from the
file into the signer.

**Run** this in your own terminal, not in an AI session or a screen share:

```bash
cd spike
node export-key-qr.ts --key .my-key --yes
```

It prints your npub and the same pubkey as 64 hex characters, and never prints the secret
(`spike/export-key-qr.ts:76-86`). It writes `spike/.my-key.qr.svg` and `spike/.my-key.nsec`, both
chmod 600 (`spike/export-key-qr.ts:49-50`, `:72-73`). Scan the QR, or paste the nsec, into your
signer. How the import screen looks in Amber or nsec.app is `UNVERIFIED`. Then delete the two
files:

```bash
cd spike
rm .my-key.nsec .my-key.qr.svg
```

**You should see** this, once you connect that signer in Step 8: the builder's **Signed in as**
line reads `<signer> — <first 8 hex>…<last 8 hex>` of your pubkey (`whoami` in
`builder/src/i18n.ts`, `builder/src/main.ts:152`). Those 16 hex characters must match the start
and end of the hex line this step printed. If they differ, your signer holds some other key and
the import failed. Do Step 6 again before you go on.

## Step 7: authorise your key on the node (the one terminal step)

**Run** on the machine that can reach your node:

```bash
cd spike
node authorize-manage.ts --key .my-key                          # Option B: your own node, default --nprofile
node authorize-manage.ts --key .my-key --nprofile nprofile1…    # Option A: a guest account on someone else's Pub
```

Run one of the two lines. All four of these hold:

- **Which key.** The `--key` file, `spike/.my-key`. The script reads `--key` relative to `spike/`
  (`spike/authorize-manage.ts:45-46`). Always pass `--key .my-key`: without it the script reads
  `spike/.dev-key`, the author's fixture seller, which you do not have
  (`spike/authorize-manage.ts:45`, `:49`). Your signer must hold this same key (Step 6).
- **Where the key comes from.** `node new-key.ts` in Step 5. The script's own error says so if the
  file is missing: `no …/.my-key — pass --key <file>, or make one with: node new-key.ts`
  (`spike/authorize-manage.ts:49`).
- **What it prints.** These lines (`spike/authorize-manage.ts:54-55`, `:91` or `:95`, `:105-113`):

  ```
  # node app pubkey <12 hex>… on wss://…
  # authorising     npub1…
  # granted manage_id …

  # wrote the nmanage pointer to …/spike/.my-key.nmanage  (gitignored, chmod 600)
  #   nmanage1…   <length> chars
  #
  # Paste the whole line from that file into the builder's "seller's node" field:
  #   cat …/spike/.my-key.nmanage | pbcopy
  #
  # It carries the account pointer, so treat it like the pairing string: seller's browser only,
  # never a relay, never a log, never this repo (/docs/spec.md §6.1).
  ```

  On a second run the third line is `# already authorised (manage_id …) — leaving it alone`
  instead (`spike/authorize-manage.ts:89-91`). The terminal shows only a shortened preview of the
  pointer. The whole `nmanage1…` pointer is in `spike/.my-key.nmanage`
  (`spike/authorize-manage.ts:47`, `:102-103`). `.gitignore` covers that file with `spike/.*-key.*`
  (`git check-ignore -v spike/.my-key.nmanage`). `pbcopy` exists only on macOS. Elsewhere, open the
  file and copy its one line.
- **Why it exists.** A NIP-46 bunker cannot do raw ECDH, so it cannot speak kind 21000.
  `AuthorizeManage` is kind 21000, and without it no Manage call from the builder is accepted
  (`spike/authorize-manage.ts:5-22`, `docs/spike-findings.md` §13, item 18). See "Why is there a
  terminal step at all" above.

**A guest seller must pass `--nprofile` here.** The default pairing file,
`~/lightning_pub/app.nprofile`, exists only on the operator's machine
(`spike/authorize-manage.ts:53`). Without the file, the script treats that path as the pairing
string, which does not decode, so it stops (`spike/pub-rpc.ts:55-57`). Every later command that
reaches the node takes the same `--key .my-key --nprofile nprofile1…` pair.

**You should see** the lines above, and a file at `spike/.my-key.nmanage`.

## Step 8: open the builder and connect your signer

**Run** one of these:

- the live builder, `https://npub1qqm97k4eg432zydvkclnhhnkyd7dgjxmndmaapk48jzms9uyl5qqlerxa2.nsite.lol/`
  (`README.md:63`), or
- your own copy (Step 4 must be done first):

  ```bash
  cd builder && npm install && npm run dev
  ```

  and open the address it prints.

On the **1 · Your signer** screen (`s1.h`), press **Browser extension (NIP-07)** (`s1.nip07`), or
**Connect a bunker — one approval** (`s1.scan`) and scan the code with your signer, or paste a
`bunker://…` link and press **Connect** (`s1.connect`). Use the signer that got the key in Step 6.
Approve every permission it asks for.

**You should see** **Signed in as** (`s1.as`) followed by `<signer> — <8 hex>…<8 hex>`
(`builder/index.html:56`, `builder/src/main.ts:152`). Check those hex characters against Step 6.

## Step 9: paste the pointer

**Run** on the **2 · Your node** screen (`s2.h`): paste the whole `nmanage1…` line from
`spike/.my-key.nmanage` into the **CLINK Manage pointer** box (`s2.label`).

**You should see** the line under the box change to (`node.ok` in `builder/src/i18n.ts`, set at
`builder/src/main.ts:223`):

```
Node <8 hex>… on wss://…. Offers will be minted over CLINK Manage.
```

The 8 hex characters are the start of the node app pubkey that Step 7 printed. If you see `That is
not an nmanage1… pointer.` (`node.bad`), you pasted part of the line or the wrong line. Leave the
box empty and your items publish cash-only, with no Buy button (`node.none`).

## Step 10: author an item, publish it, publish the sale, deploy

**Run**, in this order:

1. On **4 · The item** (`builder/index.html:147`), fill in an item and press **Publish this item**
   (`item.publish`).
2. On **3 · Your sale** (`builder/index.html:87`), give the sale a name and press **Publish my sale**
   (`builder/index.html:140`). The button stays off until your items have been read back from the
   relays. The line under it says why (`noPublishSaleReason`, `builder/src/admin.ts:267-280`).
3. On **7 · Publish the sale as a website** (`deploy.h`), press **Deploy my storefront**
   (`deploy.btn`).

**You should see**

- after **Publish this item**, on **6 · Give the watcher its ladder** (`result.h`)
  (`result.buy`, `builder/src/ladder-text.ts:9`):

  ```
  <title> is live on <ok>/<total> relays as <d>, with a Buy button.
  ```

  If it says `cash at the table` instead (`result.cash`), no pointer was set in Step 9.
- after **Publish my sale** (`builder/src/sale-text.ts:15`):

  ```
  “<sale name>” is live on <ok>/<total> relays as <d>, listing <n> item(s).
  ```

- after **Deploy my storefront**, the status line `Live at <url>` (`deploy.live`,
  `builder/src/deploy.ts:242`), then **Your sale is live at** and a link to your storefront
  (`builder/index.html:302-304`, `builder/src/main.ts:827-830`), with this under it
  (`deploy.detail`):

  ```
  <n> files on <s> Blossom server(s), manifest on <ok>/<all> relays. Site version <v>…. The first request may time out while the gateway fetches the blobs — reload once.
  ```

Whether a buyer's payment then goes through cannot be seen from the builder. A payment needs real
sats and cannot be rehearsed (`docs/dry-run.md`, "What a dry run is, and what it cannot cover").

**Your sale is published here.** The optional parts are not on this page yet: the watcher, which
counts stock down as items sell, and refunds are still in README → Setup.
