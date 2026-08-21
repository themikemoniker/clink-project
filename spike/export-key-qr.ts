// ONE-TIME MIGRATION TOOL. Hands /spike/.dev-key to a NIP-46 bunker so the builder's Signer can
// adopt the existing identity — same npub, same nsite URL, same node account, same offers, same
// ladder — instead of slice 4 minting a fresh one and orphaning all of it (findings §7: the
// gateway caches for an hour, so a new URL is a demo-day risk).
//
// THIS EXPORTS A PRIVATE KEY. That is the whole job, and it is the one moment in this project
// where a key is deliberately moved. Three rules it follows so that moment stays small:
//
//   1. It prints NOTHING secret. Only file paths and the (public) npub. The key must not end up
//      in a terminal transcript, a scrollback buffer, or an AI session's context.
//   2. Its outputs are gitignored and chmod 600, and it tells you to delete them after.
//   3. It needs --yes, so it cannot run by accident or by tab-completion.
//
// RUN IT IN YOUR OWN TERMINAL. If you run it through Claude Code's `!` prefix the output lands
// in the conversation — which is harmless here, because the output is only paths, but get in the
// habit: the `cat` of the .nsec file that follows must NOT be run that way.
//
// Why a QR: the key is on this Mac and Amber is on a phone, so the alternatives are typing 63
// characters or routing an nsec through a copy-paste channel (a notes app, a messenger, a
// clipboard manager) that keeps history. A QR on the screen is the shortest path between the
// two devices that leaves nothing behind once the file is deleted.
//
// Usage: node export-key-qr.ts [--key <file>] --yes
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils.js'
// Reusing the storefront's devDependency rather than adding one to /spike for a script that
// exists for a single afternoon. Deep import because Node will not resolve across package roots.
import qrcodeModule from '../storefront/node_modules/qrcode/lib/index.js'

const qrcode = (qrcodeModule as { toString?: unknown }).toString
  ? (qrcodeModule as unknown as { toString(text: string, opts: object): Promise<string> })
  : ((qrcodeModule as { default: { toString(text: string, opts: object): Promise<string> } }).default)

const HERE = dirname(fileURLToPath(import.meta.url))
// `--key` because there is more than one seller now, and each one's identity has to reach a
// bunker before the builder can sign as them. The outputs are named after the key rather than
// fixed, so two exports cannot land on top of each other — these files are the private key in
// plain text, and silently overwriting one with another seller's is how the wrong nsec gets
// imported into the wrong bunker.
const argOf = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const KEY = argOf('key', '.dev-key')
const KEY_FILE = join(HERE, KEY)
const NSEC_FILE = join(HERE, `${KEY}.nsec`)
const QR_FILE = join(HERE, `${KEY}.qr.svg`)

if (!process.argv.includes('--yes')) {
  console.log(`This exports the private key in ${KEY_FILE} as an nsec and as a QR image.

It is for one purpose: importing a seller's identity into a NIP-46 bunker so the builder can
sign as them without holding it. Re-run with --yes if that is what you are doing.`)
  process.exit(1)
}

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE}`)
const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const pk = getPublicKey(sk)

// Back up before exporting, not after. If this machine dies between the two, the identity — and
// the node account holding the sale's sats — dies with it.
const BACKUP = join(process.env.HOME ?? '', '.lamppost-key-backup')
if (!existsSync(BACKUP)) {
  console.log(`# WARNING: no backup found at ${BACKUP}. Back the key up before importing it anywhere.`)
}

const nsec = nip19.nsecEncode(sk)
writeFileSync(NSEC_FILE, nsec + '\n', { mode: 0o600 })
writeFileSync(QR_FILE, await qrcode.toString(nsec, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', width: 480 }), { mode: 0o600 })

// Everything below is public. The npub is on four relays and in the storefront's URL already.
console.log(`# identity  ${nip19.npubEncode(pk)}
#           ${pk}
#
# Wrote two files, both chmod 600 and gitignored:
#   ${QR_FILE}     <- open in a browser, scan with your signer
#   ${NSEC_FILE}   <- the same key as text, if you would rather paste it
#
# The QR is a private key on your screen. Close the tab when you are done, and then:
#   rm ${NSEC_FILE} ${QR_FILE}
#
# Do NOT cat the .nsec file inside an AI session, a screen share, or a recorded terminal.`)
process.exit(0)
