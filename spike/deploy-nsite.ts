// Deploy a built directory as an nsite, headlessly.
//
// SLICE 5 TURNED THIS INSIDE OUT. It used to be ~150 self-contained lines; the hashing, the
// aggregate, the Blossom auth and both event shapes now live in `/builder/src/deploy.ts` and
// this file is the ~90 lines a browser cannot have: a filesystem walk and a Signer over a key
// on disk. Same pattern as slice 3's pub-rpc.ts lift (findings §13.13) and slice 4's
// check-manage.ts — it imports the SHIPPED module rather than a copy, so if this and the
// builder ever disagree, this is wrong.
//
// That makes it slice 5's headless verification, the way check-buy.ts and check-manage.ts are
// slices 2 and 4's: a real deploy to real Blossom servers and real relays, driving the exact
// code the builder runs, with no browser and no phone in the loop.
//
// It is also how the BOOTSTRAP CYCLE is broken. /CLAUDE.md rule 5 says the builder itself
// deploys as an nsite — which reads like the builder has to deploy itself. It does not: rule 5
// is about the builder being HOSTED with no server of ours, and putting it on a gateway is a
// developer action, not a seller action. So `node deploy-nsite.ts ../builder/dist` publishes the
// builder from this machine, the same way `node deploy-nsite.ts` publishes the storefront, and
// the in-app deploy exists for the seller's sale. One tool, two directories, no cycle.
//
// KEY HANDLING NOTICE: the builder ships two Signer paths and neither is this one — a browser
// has an extension or a bunker, and both hold the key out of reach. This script needs a Signer
// and has no browser, so it wraps a key file the same way check-manage.ts does. Same
// /CLAUDE.md rule-2 exception, same throwaway identity, and it adds no key path to the builder.
//
// Usage:
//   node deploy-nsite.ts [dir]            deploy ../storefront/dist by default
//     --key <file>                        default .dev-key. Use a throwaway for experiments
//     --gateway <host>                    default nsite.lol — only changes the printed URL
//     --relays wss://a,wss://b
//     --blossom https://a,https://b
//     --title <text> --description <text>
//     --dry                               hash and build both events, publish nothing
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, getPublicKey, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import { hexToBytes } from '@noble/hashes/utils'
import { SALE, SALE_RELAYS } from './fixture.ts'
import { contentType, deploy, DEFAULT_GATEWAY, type SiteFile } from '../builder/src/deploy.ts'
import { SERVERS } from '../builder/src/blossom.ts'
import type { Signer } from '../builder/src/signer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]!
}
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'))
const DIR = positional[0] ?? join(HERE, '..', 'storefront', 'dist')
const KEY_FILE = join(HERE, arg('key', '.dev-key'))
const DRY = process.argv.includes('--dry')

if (!existsSync(KEY_FILE)) throw new Error(`no ${KEY_FILE} — pass --key <file>, or run seed-listings.ts first`)
if (!existsSync(DIR)) throw new Error(`${DIR} does not exist — run \`npm run build\` first`)

const sk = hexToBytes(readFileSync(KEY_FILE, 'utf8').trim())
const pk = getPublicKey(sk)

// The stand-in Signer. Deliberately the narrowest possible shim over the raw key: four methods,
// no storage, no reconnection, nothing the browser paths have.
const signer: Signer = {
  label: 'spike PlainKeySigner',
  getPublicKey: async () => pk,
  signEvent: async (e: EventTemplate) => finalizeEvent(e, sk) as VerifiedEvent,
  nip44Encrypt: async (to, text) => encrypt(text, getConversationKey(sk, to)),
  nip44Decrypt: async (to, ct) => decrypt(ct, getConversationKey(sk, to)),
  close: async () => {},
}

// 5A.md:47 — "an absolute path ending with a filename and extension". POSIX separators
// regardless of the host OS, because this is a URL path, not a filesystem path.
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

const files: SiteFile[] = walk(DIR).map(full => {
  const path = '/' + relative(DIR, full).split(/[\\/]/).join(posix.sep)
  return { path, bytes: new Uint8Array(readFileSync(full)), type: contentType(path) }
})

const relays = arg('relays', SALE_RELAYS.join(',')).split(',')
const servers = arg('blossom', SERVERS.join(',')).split(',')
const gateway = arg('gateway', DEFAULT_GATEWAY)

console.log(`# deploying ${DIR}`)
console.log(`# as        ${pk}  (key: ${relative(HERE, KEY_FILE)})`)
console.log(`# ${files.length} files, ${(files.reduce((n, f) => n + f.bytes.length, 0) / 1024).toFixed(1)} KB total`)
if (DRY) console.log('# --dry: nothing will be uploaded or published\n')

const result = await deploy(
  signer,
  relays,
  files,
  {
    gateway,
    servers,
    meta: { title: arg('title', SALE.title), description: arg('description', 'A yard sale that takes Lightning, with no server anywhere in it.') },
    dryRun: DRY,
  },
  step => console.log(`# ${step.text}`),
)

for (const f of result.files) console.log(`#   ${f.sha256.slice(0, 12)}  ${f.path}`)
console.log(`
# aggregate  ${result.aggregate}
# manifest   ${result.manifest.id}
# servers    ${result.servers.join(', ') || '(none — dry run)'}
#
# ${result.url}/
# ${result.url}/definitely-missing        <- should serve /404.html
#
# VERIFY AGAINST THE RELAY AND BLOSSOM, NEVER AGAINST THE GATEWAY. The gateway sends
# cache-control: max-age=3600 and serves the previous build until it lapses, which looks
# exactly like a broken deploy and is not (/docs/spike-findings.md §7):
#   nak req -k 15128 -a ${pk} ${relays[0]} | jq '.tags'
#   nak req -k 10063 -a ${pk} ${relays[0]} | jq '.tags'
#   curl -sI ${result.servers[0] ?? servers[0]}/${result.files[0]?.sha256}`)
process.exit(0)
