// Step 5 of check-ladder-relay.ts, moved out so it can be tested offline: the script runs at top
// level against real relays, so nothing in it can be imported by a test. Run: npm test  (in /spike)
//
// THE RULE. A republished ladder has "arrived" only when the exact event that was published comes
// back, matched by `id`. Matching by `d` is not proof: the original event for the same item has
// the same `d`, and a relay may hand that stored original back over a subscription whose `since`
// lands in the same second. The critic reproduced exactly that (item #29).
import type { Filter } from 'nostr-tools/filter'
import type { SimplePool } from 'nostr-tools/pool'

/**
 * Open a subscription, then publish `next`, and report whether `next` itself came back over it.
 *
 * `next` is signed BEFORE this is called, so its id is known before the first event can arrive.
 * `accepted` is whatever `publish` resolved to, awaited even when the event arrives first, because
 * a relay may push an event before it sends its OK.
 *
 * The window ends at the first of: `next` arriving, `timeoutMs` passing, or `publish` rejecting.
 * A rejected `publish` counts as 0 accepted and ends the window AT ONCE rather than at the timeout,
 * and nothing delivered after the window ends can change the result. The subscription is closed
 * and the timer cleared on every path, exactly once.
 */
export const replacementArrives = async (
  pool: Pick<SimplePool, 'subscribe'>,
  relays: string[],
  filter: Filter,
  next: { id: string },
  publish: () => Promise<number>,
  timeoutMs: number,
): Promise<{ accepted: number; arrived: boolean }> => {
  let sub: { close: () => void } | undefined
  let closed = false
  let arrived = false
  let settle!: () => void
  const settled = new Promise<void>(resolve => (settle = resolve))
  const finish = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    sub?.close()
    settle()
  }
  const timer = setTimeout(finish, timeoutMs)
  try {
    sub = pool.subscribe(relays, filter, {
      onevent: ev => {
        if (closed || ev.id !== next.id) return
        arrived = true
        finish()
      },
    })
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
  // A pool may deliver synchronously inside subscribe(), before `sub` was assigned, so the close
  // in finish() found nothing to close. Close it now.
  if (closed) sub.close()
  // Publish only once the subscription is open, which is what an edit looks like from here.
  let accepted: number
  try {
    accepted = await publish()
  } catch {
    accepted = 0
    finish()
  }
  await settled
  return { accepted, arrived }
}
