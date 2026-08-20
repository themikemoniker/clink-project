# Node Runbook

Operational notes for the seller's Lightning.Pub node. Captured from a real macOS install, August 2026.

---

## 1. Known install gotchas

### macOS: LND log path (causes an infinite crash-restart loop)

`unlocker.ts:116` hardcodes the header-sync log at `~/.lnd/logs/bitcoin/mainnet/lnd.log`, which is the Linux default. On macOS LND lives at `~/Library/Application Support/Lnd`, so the file never exists, `waitForLndSync` polls a missing path, times out at 300s, throws, and launchd restarts it. Symptom: repeated 300s timeouts in `pub.log` roughly every 5 minutes, while LND itself is perfectly healthy and synced.

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

**Nothing about this is instant.** On-chain confirmation plus channel open is the long pole on the whole project. Start it days before demo day and send yourself a test payment to prove it end to end.

---

## 4. Uptime

A laptop is not a server. When the Mac sleeps, the node goes offline — payments fail, and anyone relying on a guest account on it is stranded.

- Demo day minimum: `caffeinate -s`, or Energy Saver → prevent sleep
- Anything real: move it to an always-on machine

This is worth saying out loud in the pitch. The claim is "no public web infrastructure" — no DNS, no TLS, no open ports, no merchant account — not "no computer." The node must be running.

---

## 5. Day-to-day

```
lpub-status    lpub-log    lnd-log    lpub-restart
lncli state              # expect SERVER_ACTIVE
lncli getinfo            # expect synced_to_chain: true
```

---

## 6. Demo-day checklist

- [ ] Node on an always-on machine, or `caffeinate -s` running
- [ ] `lncli state` → SERVER_ACTIVE
- [ ] `synced_to_chain: true`
- [ ] Channel open, inbound liquidity confirmed
- [ ] Test payment sent and received today
- [ ] Second node/wallet funded for the buyer side
- [ ] Refund path tested with a real oversell
- [ ] `admin.connect` not on screen, not in any open terminal, not in the slides
