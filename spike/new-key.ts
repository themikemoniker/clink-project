// A new seller's first step: make the key file that authorize-manage.ts reads, and nothing else.
//
// Before this script the only thing that created a key in /spike was seed-listings.ts, as a side
// effect of publishing the author's fixture yard sale to public relays. A stranger wants the key,
// not our sale. This writes one fresh secret key and stops: no relay, no node, no network.
//
// KEY HANDLING NOTICE — the same narrow /CLAUDE.md rule-2 exception as seed-listings.ts: a raw key
// on disk, chmod 600, gitignored, for the one kind 21000 call a Signer cannot make
// (authorize-manage.ts). The secret is written to the file and never printed; stdout gets the npub.
//
// The name must match `^\.[\w-]*-key$`, which is exactly what the `spike/.*-key` glob in
// /.gitignore covers, so a key made here cannot be committed by accident. An existing file is
// never overwritten: overwriting a key loses the account behind it.
//
// NEW_KEY_DIR overrides the directory the key is written to (default: this one). It exists for
// new-key.test.ts, which must never touch a real key.
//
// Usage: node new-key.ts [<name>]      (default .my-key)
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

const HERE = process.env.NEW_KEY_DIR || dirname(fileURLToPath(import.meta.url))
const NAME = process.argv[2] ?? '.my-key'

if (!/^\.[\w-]*-key$/.test(NAME)) {
  console.error(`refusing "${NAME}": the name must match ^\\.[\\w-]*-key$ (e.g. .my-key) so .gitignore covers it`)
  process.exit(1)
}
const KEY_FILE = join(HERE, NAME)
if (existsSync(KEY_FILE)) {
  console.error(`refusing: ${KEY_FILE} already exists. Overwriting a key loses its account — pick another name`)
  process.exit(1)
}

const sk = generateSecretKey()
// `wx` as well as the existsSync above: the open itself fails if the file appeared in between.
writeFileSync(KEY_FILE, bytesToHex(sk), { mode: 0o600, flag: 'wx' })
chmodSync(KEY_FILE, 0o600)
console.log(nip19.npubEncode(getPublicKey(sk)))
console.log(`# wrote a new secret key to ${KEY_FILE} (mode 600, gitignored). Back it up: it is the account.`)
console.log(`# next: node authorize-manage.ts --key ${NAME} --nprofile <nprofile1… from your node operator>`)
