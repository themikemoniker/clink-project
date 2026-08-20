// One relay read, then the socket closes. The page is read outdoors on mobile data; holding a
// subscription open costs battery for updates slice 1 does not use. Slice 3 is where a live
// subscription earns its keep, because that is when the watcher starts republishing stock.
import { SimplePool } from 'nostr-tools/pool'
import type { Event } from 'nostr-tools/pure'
import { LISTING_KIND, SALE_KIND } from './listing.ts'

// A relay that floods us must not be able to grow the array without bound. Well past any real
// sale, small enough to stay a bound.
const MAX_EVENTS = 2_000

export const fetchSaleEvents = (
  pubkey: string,
  relays: string[],
  timeoutMs = 6_000,
): Promise<Event[]> =>
  new Promise(resolve => {
    const pool = new SimplePool()
    const events: Event[] = []
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sub.close()
      pool.close(relays)
      resolve(events)
    }
    // A relay can accept the subscription and simply never send EOSE. The timeout is what makes
    // a dead relay cost a slow load instead of a blank page.
    const timer = setTimeout(finish, timeoutMs)

    // One filter OBJECT, not an array. nostr-tools 2.24.3 changed this signature; passing an
    // array makes strfry answer "bad req: provided filter is not an object" and the
    // subscription silently never fires. See /docs/spike-findings.md §13.9.
    const sub = pool.subscribeMany(
      relays,
      { kinds: [LISTING_KIND, SALE_KIND], authors: [pubkey] },
      {
        onevent: ev => {
          if (events.length < MAX_EVENTS) events.push(ev)
          else finish()
        },
        oneose: finish, // fires once every relay has sent EOSE
      },
    )
  })
