# Node Runbook

Operational notes for the seller's Lightning.Pub node. Captured from a real macOS install, August 2026.

---

## 1. Known install gotchas

### macOS: LND log path (causes an infinite crash-restart loop)

`settings.ts:116` hardcodes the header-sync log at `~/.lnd/logs/bitcoin/mainnet/lnd.log`, which is the Linux default — `chooseEnv('LND_LOG_DIR', dbEnv, resolveHome("/.lnd/logs/bitcoin/mainnet/lnd.log"), addToDb)`, read by `unlocker.ts:104`. (This line said `unlocker.ts:116` until 2026-08-23: right line number, wrong file. `unlocker.ts:116-123` is the polling loop, not the default.) On macOS LND lives at `~/Library/Application Support/Lnd`, so the file never exists, `waitForLndSync` polls a missing path, times out at 300s, throws, and launchd restarts it. Symptom: repeated 300s timeouts in `pub.log` roughly every 5 minutes, while LND itself is perfectly healthy and synced.

Workaround (either):

```bash
ln -s "$HOME/Library/Application Support/Lnd" ~/.lnd
```

or set `LND_LOG_DIR=` in `~/lightning_pub/.env` and drop the symlink.

**Upstream fix:** `LND_LOG_DIR` should default per-platform. Worth filing as a PR — an ecosystem contribution that judges notice, and it costs almost nothing.

### File permissions

`~/lightning_pub/.wallet_secret` decrypts the seed and ships as 644.

```bash
chmod 600 ~/lightning_pub/.wallet_secret
```

Back it up somewhere offline. Losing it loses the wallet.

---

## 2. Pairing

Admin pairing string (the installer prints this only if Pub is healthy at first run):

```bash
node ~/lightning_pub/scripts/qr_generator.js "$(cat ~/lightning_pub/admin.connect)"
```

Scan with ShockWallet via Add Source, or paste `admin.connect` into its node-connection screen.

**`admin.connect` is `nprofile:token` — full admin access to the node.** Never screenshot it, never paste it into a chat or an issue, never put it in `.env` committed to the repo, never let the builder app touch it. If it leaks:

```bash
rm ~/lightning_pub/admin.npub && sleep 1
```

which regenerates it.

Guest string (no admin token) — anyone who pastes this into ShockWallet gets an account on this node:

```bash
cat ~/lightning_pub/app.nprofile
```

No port forwarding, DNS, or Tor needed for either. The wallet reaches the node over Nostr relays.

---

## 3. Funding and liquidity

A fresh node is 0 channels, 0 sats. Deposit on-chain from the paired wallet. Pub manages channels itself — it shops quotes from LSPs (Zeus, Voltage, Flashsats) and requests one when outbound is needed, and borrows liquidity from a bootstrap peer Pub until a channel is affordable.

**Nothing about this is instant** — except it was, once we stopped trying to fund it.

### What actually worked (2026-08-21)

Depositing on-chain and letting Pub open a channel **cannot bootstrap an empty node**: Pub pays
the LSP out of its liquidity-provider balance (`lsp.ts:269-284`), and on a fresh install that
balance is 0. Deadlock.

Rent the inbound instead. You pay a **fee**, the LSP opens the channel with *their* sats on
*their* side, and the node needs no on-chain balance at all. The fee is a bolt11, payable from
any phone wallet.

```bash
export PATH="$HOME/lnd:$PATH"          # lncli is not on PATH by default

# 1. peer with the LSP first, or the order is rejected
lncli connect 031b301307574bbe9b9ac7b79cbe1700e31e544513eae0b5d7497483083f99e581@45.79.192.236:9735

# 2. quote + order (100,000 is Olympus's minimum; nothing smaller is sold)
curl -sL -X POST https://lsps1.lnolymp.us/api/v1/create_order \
  -H 'content-type: application/json' \
  -d '{"public_key":"<your node pubkey>","lsp_balance_sat":"100000","client_balance_sat":"0",
       "required_channel_confirmations":0,"funding_confirms_within_blocks":6,
       "channel_expiry_blocks":13000,"announce_channel":false}'

# 3. pay the returned bolt11 from any wallet, then:
lncli listchannels | grep -E 'active|remote_balance'
```

Cost on 2026-08-21: **7,157 sat for 100,000 inbound**, 90-day lease. The channel came up
**active immediately** despite the order stating 3 confirmations. `remote_balance` is your
inbound and the only number that matters.

**It is a lease.** This one expires **2026-11-19**. Calendar it.

**Floors that do not scale down**: Olympus minimum 100,000 sat, LND `minchansize` 20,000, LND
anchor reserve ~10,000 on-chain, Pub's `LSP_CHANNEL_THRESHOLD` 1,000,000. You can price items
at any size; you cannot rent a proportionally smaller channel.

**Private channel caveat.** `announce_channel: false` means invoices must carry route hints or
nobody can pay. Pub does this correctly (`lnd.ts:412` passes `privateHints = true`), but
`blind` offers set it to false (`addInvoiceReq.ts:6`) and would be unpayable — see
`/docs/spike-findings.md` §13.5.

Still send yourself a test payment to prove it end to end. An invoice request succeeding proves
nothing; `maxSendable` falls back to 10,000,000 whenever the liquidity provider is reachable.

**Done 2026-08-21:** 6,000 sat received over CLINK, `internal: 0`, `service_fee: 0`, settled in
seconds. `cd spike && node check-buy.ts yardsale-2026-08-plants --pay` reproduces it — it prints
an invoice and waits for you to scan. Each sale shifts the balance: after that one,
`local_balance 6000 / remote_balance 92160`. Inbound is consumed by selling and outbound is
created by it, which is why slice 7's refunds cannot precede any sales.

---

## 4. Uptime

A laptop is not a server. When the Mac sleeps, the node goes offline — payments fail, and anyone relying on a guest account on it is stranded.

- Demo day minimum: `caffeinate -s`, or Energy Saver → prevent sleep
- Anything real: move it to an always-on machine

This is worth saying out loud in the pitch. The claim is "no public web infrastructure" — no DNS, no TLS, no open ports, no merchant account — not "no computer." The node must be running.

---

## 5. Backups — the files that are not in the repo

**Item 10, 2026-08-24.** Twelve gitignored files in `/spike` are load-bearing and none of them is
in git. They fail in three different ways, and the classification is the point: it decides what a
backup is actually for.

| | files | what losing it costs | what recreates it |
|---|---|---|---|
| **Gone forever** | `.builder-key`, `.deploy-test-key` | A kind 15128 root site is **one per pubkey** (`5A.md:16`, findings §13.22), so losing `.builder-key` loses the builder's nsite URL permanently. The old blobs stay on Blossom and become unreachable. | Nothing. A new key is a new URL. Neither holds funds, which is the only reason this is survivable. |
| **Gone forever, and it holds money** | `.dev-key`, `.merida-key` | The seller identity, the storefront's npub, the authority behind every published listing and the ladder's signatures — and the Lightning.Pub account that holds the sats. | Nothing. |
| **Redo the work** | `.refund-key` + `.ndebit` | A new refund key needs the whole three-step authorisation dance (findings §13.27). The live grant expires **2026-09-20**. | `node authorize-refunds.ts`, at the desk, with the node up. |
| **Redo the work** | `.ladder.json`, `.merida-key.ladder.json` | The pre-signed availability rungs. Without them the watcher has nothing to publish and stock goes stale. | `node seed-listings.ts` re-cuts it — and the watcher must then be restarted, and re-seeding republishes every listing. |
| **Redo the work** | `.offers.json`, `.merida-key.offers.json`, `.nmanage`, `.merida-key.nmanage` | Which offer belongs to which item, and the Manage grant pointer. | `node mint-offers.ts` (idempotent, reuses by label) and `node authorize-manage.ts`. |
| **Recreated by nothing** | `.refunds.json` | The **only** durable record of which oversells have been refunded. The node has no "already refunded" field and CLINK's `k1` is in memory with a five-minute TTL (findings §13.28). Losing it can pay a buyer twice. | Nothing recreates it. Item 9's startup reconcile is the mitigation and it is a prompt, not a recovery: `--refunds` now **refuses to start** when this file is absent and the node reports outgoing payments. |

`.refunds.json` does not exist yet on this machine, because no refund has been paid. It appears
the first time `watch-sales.ts --refunds` writes a row, and from that moment it is the most
irreplaceable file in the project.

### Back up

One archive, every load-bearing file, `chmod 600`. It contains four private keys, so it is
treated the way the keys are: encrypted or on media you control, never in the repo, never in
cloud storage that syncs.

```bash
cd spike
tar -czf ~/lamppost-backup-$(date +%F).tar.gz   .builder-key .deploy-test-key .dev-key .merida-key .refund-key   .nmanage .merida-key.nmanage .ndebit   .offers.json .merida-key.offers.json   .ladder.json .merida-key.ladder.json   $(ls .refunds.json .merida-key.refunds.json 2>/dev/null)
chmod 600 ~/lamppost-backup-$(date +%F).tar.gz
```

`.refunds.json` is listed through `ls` because it does not exist until the first refund, and
`tar` fails the whole archive on a missing file. **When it does exist, back up more often than
this**: everything else in the archive can be recreated by redoing work, and that one cannot.

⚑ **The one step this does not close.** `spike/.dev-key` is also backed up to
`~/.lamppost-key-backup/dev-key-2026-08-21.hex`, and **that copy is on this machine only** — so a
disk failure loses the seller identity and the 9,000 sats in its account. Getting a copy off it is
a human step with a second device: copy the archive above to an encrypted USB stick or a hardware
password manager, verify it there, and record the date. It is not something a session at this
terminal can do.

### Restore, and the drill

`watch-sales.ts` and `sales-report.ts` resolve every path from **their own file location**, not
from the working directory, and they import `../storefront`. So a restore is a whole `spike/`
sitting next to a `storefront/` — untarring the archive somewhere else and pointing a flag at it
is not a thing either script supports.

```bash
tar -xzf ~/lamppost-backup-<date>.tar.gz -C <a clone>/spike
cd <a clone>/spike
node watch-sales.ts --once     # observe and republish. Spends nothing without --refunds
node sales-report.ts           # the default seller
node sales-report.ts --key .merida-key
```

**Drilled 2026-08-24, into a scratch tree, from the archive alone.** A procedure that has never
been run is a belief:

```
# node 3f0abe5a9446… on wss://relay.lightning.pub
# refunds OFF. An oversell will be logged and nothing will be paid.
# watching 5 item(s): couch(1) bike(1) lamp(3) mugs(3) plants(1)
# 2026-08-24T17:46:11.712Z yardsale-2026-08-mugs: 3 sold -> stock 0 (SOLD), 3/4 relays
# 2026-08-24T17:46:15.283Z yardsale-2026-08-plants: 1 sold -> stock 0 (SOLD), 3/4 relays

# acting as npub1lvvw3qfk9fmjuxll9lpxpf0lgl9sr5l60gj5xjv5scphwnxmg7sq0lalws
# 4 settled invoice(s), 9000 sats received
# acting as npub1j7jwqfnwnkp3rk5lv9s7qlnfra609eepy42vmk80z5fq5nncxffq2q900q
# 1 settled invoice(s), 800 sats received
```

Three things it proved beyond "the files came back": file modes survive the `tar` round trip
(the five keys restore `-rw-------`), the restored `.ladder.json` is still current enough that
the stale-ladder check watches all five items rather than refusing any, and `--key` reaches the
**second** seller's sub-account — 800 sats on `artesanias-jabon` — rather than silently reporting
the first. The two republishes are relay no-ops: the rungs were already the live listings.

---

## 5a. The kill switch, and what changed on 2026-08-24

This is the block somebody reads at 3am, so the short version first:

```bash
cd spike
node authorize-refunds.ts --show      # what the node actually has. Needs no key file
node authorize-refunds.ts --revoke    # BanDebit. THE KILL SWITCH
node authorize-refunds.ts --revoke --npub <64 hex>   # from a machine without spike/.refund-key
```

**It used to be able to lie, and that is why the behaviour changed.** The refund key was minted at
module top level, *above* the `--revoke` and `--reset` branches, so on any machine where
`spike/.refund-key` was absent — a fresh clone, a restored `.dev-key`, a deleted file — the switch
wrote a brand-new random key, derived a pubkey from it, and banned **that**. The node creates a
banned row happily. It printed `# BANNED the refund key` and exited 0 while the real grant stayed
live and a watcher elsewhere kept spending. Three things are different now:

- **It refuses rather than improvises.** No key file and no `--npub` means it exits non-zero and
  says so. It never creates a key.
- **The verdict comes from the node.** It re-reads `GetDebitAuthorizations` after the call and
  prints its success line from the after-state. If the node still reports the key AUTHORIZED it
  throws and tells you to ban it from ShockWallet by hand and stop the watcher yourself.
- **"Nothing to stop" is not success.** If the node reports no grant for this key it prints no
  success line, lists any **other** grants on the account — a live grant you do not hold the key
  for is exactly what you need to see at that moment — and exits 1.

`--show` needs no key file, so on a fresh clone it lists what the node has rather than inventing a
key to compare against. If refunds are going out and you do not know from where, that is the first
command.

**`node check-refund.ts` proves the cap and the switch and costs nothing** — every debit it sends
is one the node refuses. It ends with the grant **removed** on purpose; re-arm with
`node authorize-refunds.ts`.

---

## 6. Day-to-day

```
lpub-status    lpub-log    lnd-log    lpub-restart
lncli state              # expect SERVER_ACTIVE
lncli getinfo            # expect synced_to_chain: true
```

**The watcher reconciles at startup now (2026-08-24), and that changes what starting it looks
like.** Under `--refunds` it reads the node's outgoing payments before the first tick and:

- **refuses to start** if `spike/.refunds.json` is missing and the node has sent money. That is the
  restored-an-old-file case, and starting would recompute every oversell already refunded and pay
  it again. The error names the escape hatch: check `node sales-report.ts --outgoing`, then
  `echo '{}' > spike/.refunds.json` deliberately.
- **refuses to start** if the node's outgoing payments cannot be read at all, because not knowing
  what has already been sent *is* the double-pay condition. Drop `--refunds` to keep publishing
  availability.
- **prompts** on any `pending` row it can match — and a prompt needs a terminal. Started under
  launchd there is no stdin, so it runs, transitions nothing, and prints the evidence with a line
  saying nobody could answer. **Start it from a terminal after any run that left a `pending` row.**

---

## 7. Demo-day checklist

- [ ] Node on an always-on machine, or `caffeinate -s` running
- [ ] `lncli state` → SERVER_ACTIVE
- [ ] `synced_to_chain: true`
- [ ] Channel open, inbound liquidity confirmed
- [ ] Test payment sent and received today
- [ ] Second node/wallet funded for the buyer side
- [ ] Refund path tested with a real oversell
- [ ] A backup archive taken today, and off this machine (§5)
- [ ] `admin.connect` not on screen, not in any open terminal, not in the slides
