// Spike: print raw settlement-ish events addressed to a pubkey.
//   21001 = CLINK Offers receipt/response  (clink-offers.md "Payment Receipt")
//   21002 = CLINK Debits ACK/GFY           (clink-debits.md "Response Event")
//    9735 = NIP-57 zap receipt (public, unencrypted)
// Reality check from the spike: 21001/21002 are ephemeral and addressed to the *payer*,
// and their content is NIP-44 encrypted to that payer. A seller watching their own pubkey
// sees nothing here. Decryption is deliberately not implemented (no keys in this repo).
// Usage: node watch-receipts.ts <npub|hex> [wss://relay ...]
import { SimplePool, nip19 } from 'nostr-tools'

const [who, ...relayArgs] = process.argv.slice(2)
if (!who) throw new Error('usage: node watch-receipts.ts <npub|hex> [relay ...]')

const pubkey = who.startsWith('npub') ? (nip19.decode(who).data as string) : who
const relays = relayArgs.length ? relayArgs : ['wss://relay.lightning.pub']

const pool = new SimplePool()
console.log(`# watching ${relays.join(', ')} for kinds 21001/21002/9735 p-tagged to ${pubkey.slice(0, 12)}…`)
pool.subscribeMany(relays, { kinds: [21001, 21002, 9735], '#p': [pubkey] }, {
  onevent: (e) => {
    const e_tag = e.tags.find(t => t[0] === 'e')?.[1]
    console.log(`\n# ${new Date(e.created_at * 1000).toISOString()} kind ${e.kind} from ${e.pubkey.slice(0, 12)}…` +
      (e_tag ? ` re request ${e_tag.slice(0, 12)}…` : ''))
    console.log(JSON.stringify(e, null, 2))
  },
  // Kind 21001/21002 are in NIP-01's ephemeral range, but relay.lightning.pub replayed
  // minutes-old requests to us before EOSE. Anything above this line may be a replay.
  oneose: () => console.log('# --- end of stored events; live from here ---'),
})
