// Lightning.Pub's native kind 21000 RPC transport. Lifted verbatim out of mint-offers.ts in
// slice 3 so the watcher can speak it too — /docs/spike-findings.md §13.13 says "lift them when
// the watcher needs them, do not re-derive them", and this is that.
//
// TRANSPORT: this is NOT CLINK. It is the Pub's own envelope — neither NIP-04 nor NIP-44:
// xchacha20 keyed on sha256 of the ECDH x-coordinate, payload = base64(0x01 ‖ nonce[24] ‖
// ciphertext). Source: ~/lightning_pub/src/services/nostr/nip44v1.ts, used at
// nostrPool.ts:111,177. The request body is {rpcName, authIdentifier, requestId, body} and
// nostrMiddleware.ts:92 drops it unless `authIdentifier` equals the event pubkey.
//
// CREDENTIAL SCOPE: every RPC reached through here is `auth_type = "User"`, which is NOT
// read-only — the same key can call PayInvoice (/docs/spike-findings.md §10). Callers get
// exactly the account owned by the key they hand in. `admin.connect` is nprofile:token with
// full node authority and must never reach this file (/CLAUDE.md rule 3); the pairing string
// here is the guest `app.nprofile`, which carries no token.
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { SimplePool, finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { xchacha20 } from '@noble/ciphers/chacha.js'
import { base64 } from '@scure/base'

export const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}

export type PubRpc = {
  pubkey: string // us
  appPub: string // the node's app pubkey, from the pairing string
  relays: string[]
  rpc: (rpcName: string, body: unknown, timeoutMs?: number) => Promise<any>
  close: () => void
}

export const connectPub = (sk: Uint8Array, pairing: string): PubRpc => {
  const pk = getPublicKey(sk)
  const nprofile = (existsSync(pairing) ? readFileSync(pairing, 'utf8') : pairing).trim()
  const decoded = nip19.decode(nprofile)
  if (decoded.type !== 'nprofile') throw new Error('pairing must be an nprofile1… or a file holding one')
  const appPub = decoded.data.pubkey
  const relays = decoded.data.relays?.length ? decoded.data.relays : ['wss://relay.lightning.pub']

  const shared = sha256(secp256k1.getSharedSecret(sk, hexToBytes('02' + appPub)).slice(1, 33))
  const seal = (plaintext: string) => {
    const nonce = randomBytes(24)
    const body = new TextEncoder().encode(plaintext)
    return base64.encode(new Uint8Array([1, ...nonce, ...xchacha20(shared, nonce, body)]))
  }
  const open = (payload: string) => {
    const buf = base64.decode(payload)
    if (buf[0] !== 1) throw new Error(`unsupported envelope version ${buf[0]}`)
    return new TextDecoder().decode(xchacha20(shared, buf.subarray(1, 25), buf.subarray(25)))
  }

  const pool = new SimplePool()
  const pending = new Map<string, (res: any) => void>()
  // One filter OBJECT — nostr-tools 2.24.3 (/docs/spike-findings.md §13.9).
  pool.subscribeMany(relays, { kinds: [21000], '#p': [pk], authors: [appPub] }, {
    onevent: e => {
      let res: any
      try {
        res = JSON.parse(open(e.content))
      } catch (err) {
        return console.log(`#   undecryptable response: ${String(err).slice(0, 80)}`)
      }
      // Unsolicited pushes land here too — a settled invoice arrives with the fixed
      // requestId "GetLiveUserOperations" (paymentSideEffects.ts:107). Nothing is waiting on
      // that id, so it falls through. See the note in watch-sales.ts on why we poll instead.
      pending.get(res.requestId)?.(res)
    },
  })

  const rpc = async (rpcName: string, body: unknown, timeoutMs = 15_000): Promise<any> => {
    const requestId = bytesToHex(randomBytes(16))
    const content = seal(JSON.stringify({ rpcName, authIdentifier: pk, requestId, body }))
    const event = finalizeEvent(
      { kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [['p', appPub]], content },
      sk,
    )
    let timer: NodeJS.Timeout
    const answered = new Promise<any>((resolve, reject) => {
      pending.set(requestId, resolve)
      timer = setTimeout(() => reject(new Error(`${rpcName}: no response in ${timeoutMs}ms`)), timeoutMs)
    })
    await Promise.any(pool.publish(relays, event))
    const res = await answered.finally(() => {
      clearTimeout(timer)
      pending.delete(requestId)
    })
    if (res.status !== 'OK') throw new Error(`${rpcName}: ${res.reason ?? JSON.stringify(res)}`)
    return res
  }

  return { pubkey: pk, appPub, relays, rpc, close: () => pool.close(relays) }
}
