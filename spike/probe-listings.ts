// Throwaway recon: does anyone publish NIP-99 kind 30402 to public relays today?
import { SimplePool } from 'nostr-tools'
const relays = ['wss://relay.damus.io','wss://nos.lol','wss://relay.nostr.band','wss://relay.primal.net']
const pool = new SimplePool()
const seen = new Map<string, any>()
const sub = pool.subscribeMany(relays, { kinds: [30402], limit: 60 }, {
  onevent: (e) => { if (!seen.has(e.id)) seen.set(e.id, e) },
  oneose: () => {},
})
setTimeout(() => {
  console.log(`# ${seen.size} kind-30402 events`)
  const byAuthor = new Map<string, number>()
  for (const e of seen.values()) byAuthor.set(e.pubkey, (byAuthor.get(e.pubkey) ?? 0) + 1)
  console.log('# authors with >=3 listings:', [...byAuthor].filter(([,n]) => n >= 3).map(([p,n]) => `${p.slice(0,16)}:${n}`).join(' ') || 'none')
  const sample = [...seen.values()].sort((a,b)=>b.created_at-a.created_at)[0]
  if (sample) console.log('# newest sample\n', JSON.stringify({...sample, sig: undefined, content: sample.content.slice(0,200)}, null, 2))
  const tagNames = new Set<string>()
  for (const e of seen.values()) for (const t of e.tags) tagNames.add(t[0])
  console.log('# tag names seen across all:', [...tagNames].sort().join(' '))
  sub.close(); pool.close(relays); process.exit(0)
}, 12_000)
