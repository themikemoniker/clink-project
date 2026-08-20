// Spike: send a CLINK Offers (kind 21001) invoice request to a noffer and print raw events.
// Wire format: CLINK/specs/clink-offers.md "Nostr Events (Kind 21001)".
// Usage: node request-invoice.ts <noffer1...> [amount_sats] ['{"payer_data":"json"}']
import { decodeBech32 } from '@shocknet/clink-sdk'
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'

const [nofferStr, amountArg, payerDataArg] = process.argv.slice(2)
if (!nofferStr) throw new Error('usage: node request-invoice.ts <noffer1...> [amount_sats] [payer_data_json]')

const { data: offer } = decodeBech32(nofferStr as `noffer1${string}`)
console.log('# decoded noffer\n', JSON.stringify(offer, null, 2))

const sk = generateSecretKey()                       // ephemeral payer key (spec: "MAY use ephemeral keys")
const pk = getPublicKey(sk)
const convo = nip44.getConversationKey(sk, offer.pubkey)

// Decrypted request payload — field names from clink-offers.md "Decrypted Request Payload".
const payload = {
  offer: offer.offer,                                // noffer TLV 2
  ...(amountArg ? { amount_sats: Number(amountArg) } : {}),
  ...(payerDataArg ? { payer_data: JSON.parse(payerDataArg) } : {}),
}
const request = finalizeEvent({
  kind: 21001,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['p', offer.pubkey], ['clink_version', '1']],
  content: nip44.encrypt(JSON.stringify(payload), convo),
}, sk)

console.log('# request payload (plaintext)\n', JSON.stringify(payload, null, 2))
console.log('# request event (raw, as published)\n', JSON.stringify(request, null, 2))

const pool = new SimplePool()
const relays = [offer.relay]
// Response correlation: kind 21001, ["p", <me>], ["e", <request id>]. The receipt (if any)
// arrives later on this same filter, so we keep the sub open instead of closing on first hit.
const sub = pool.subscribeMany(relays, { kinds: [21001], '#p': [pk], '#e': [request.id] }, {
  onevent: (e) => {
    console.log('# response event (raw)\n', JSON.stringify(e, null, 2))
    console.log('# response content (decrypted)\n', nip44.decrypt(e.content, convo))
  },
})
await Promise.any(pool.publish(relays, request))
console.log(`# published to ${relays.join(', ')} as ${pk.slice(0, 12)}…, waiting 60s for response + receipt`)
setTimeout(() => { sub.close(); pool.close(relays); process.exit(0) }, 60_000)
