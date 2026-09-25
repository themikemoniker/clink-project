// How the two smoke suites get a chromium, in one place because both of them need the same answer.
//
// This repo has already paid once for a predicate that existed in two copies: M3 exported `isSats`
// because `admin.ts` and `listing.ts` had each written their own currency check and the two
// disagreed (docs/known-defects.md, the 2026-08-27 review). `storefront/smoke.test.ts` and
// `builder/smoke.test.ts` both said `chromium.launch()`, so this is the same shape before it
// becomes the same defect. It lives here rather than in `builder/` because the dependency
// direction is storefront <- spike <- builder: `builder/src/admin.ts:28` and six other files
// already import from `../../storefront/src`, and nothing in storefront imports upward.
//
// THE PROBLEM. Playwright resolves its browser from a build number baked into the version pinned
// in package.json: `playwright: 1.62.1` wants chromium build 1234 and looks for it at
// `$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1234/...`. A machine that ships a perfectly
// good chromium under a DIFFERENT build number therefore has a browser `launch()` will not find.
// That is measured, not hypothetical: on the cloud container this project runs sessions in,
// `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` holds build 1194 with a `chromium` symlink at the
// top of it, and on 2026-09-25 all 14 headless tests (5 storefront, 9 builder) failed in `before`
// with "Executable doesn't exist at .../chromium_headless_shell-1234/chrome-headless-shell" while
// every one of the 207 offline tests passed. Fourteen tests reading as red for a reason that is
// not the code is the same harm item 8 was written to prevent, one level up: a suite nobody can
// believe is a suite nobody reads.
//
// THE RULE, and it is the part to keep if this file is ever rewritten. The pinned browser wins
// whenever it can launch, so a machine with an ordinary `npx playwright install` behaves exactly
// as it did before this file existed and no CI result changes meaning. A fallback is used only
// when the pinned browser cannot start AND a named alternative is really on disk, and when one is
// used it SAYS SO on stderr with the version it got, because "which browser proved this" is a
// fact this project records rather than assumes. If there is no alternative on disk, playwright's
// own error is rethrown untouched: it already says to run `playwright install`, which is the right
// advice on a developer machine and the wrong thing to bury.
//
// WHAT IT COSTS, disclosed rather than discovered later: the fallback browser is whatever the host
// shipped, so the version can skew from the pinned one (chrome 141.0.7390.37 against the pinned
// 151.0.7922.34 on 2026-09-25, ten majors). Every assertion in both suites is structural (a
// selector exists, an attribute is set, a stylesheet rule applies), which is why that skew is
// acceptable here and why the warning names the version instead of hiding it. A test that starts
// depending on a specific chromium version is a test that should pin its own browser and say so.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'

/**
 * The chromium to try when the pinned build is missing, or null when there is nothing to try.
 *
 * Pure, with `env` and `exists` injected, for the same reason `chooseLadder` and `freshnessNote`
 * are: the interesting branches are the ones a machine cannot be asked to reproduce on demand.
 *
 * `CLINK_CHROMIUM` is ours and is the escape hatch for a host that keeps its browser somewhere
 * neither we nor playwright would guess. The second candidate is the cloud container's own
 * convention, read off this environment rather than invented: it sets `PLAYWRIGHT_BROWSERS_PATH`
 * and puts a `chromium` symlink at the top of that directory pointing at whichever build it
 * shipped. It is NOT a playwright feature, so it is derived from the variable rather than
 * hardcoded to `/opt`, and it is checked against the disk rather than trusted: a stale
 * `PLAYWRIGHT_BROWSERS_PATH` must read as "no fallback" and let the original error through, not
 * as a second confusing launch failure.
 */
export const fallbackChromium = (
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): string | null => {
  const browsersPath = env.PLAYWRIGHT_BROWSERS_PATH
  const candidates = [env.CLINK_CHROMIUM, browsersPath ? join(browsersPath, 'chromium') : undefined]
  for (const candidate of candidates) if (candidate && exists(candidate)) return candidate
  return null
}

/** The pinned chromium if it launches, else a named one that is really on disk, else the throw. */
export const launchChromium = async (): Promise<Browser> => {
  try {
    return await chromium.launch()
  } catch (pinned) {
    const executablePath = fallbackChromium(process.env, existsSync)
    if (!executablePath) throw pinned
    const browser = await chromium.launch({ executablePath })
    const why = (pinned as Error).message?.split('\n')[0] ?? 'reason not reported'
    console.warn(
      `smoke: playwright's pinned chromium did not launch (${why}); ` +
        `ran ${executablePath} instead, chrome ${browser.version()}`,
    )
    return browser
  }
}

/**
 * Replace `window.WebSocket` with a stub that answers every REQ from `events`, then EOSE.
 *
 * Shared for the same reason `launchChromium` is: `builder/smoke.test.ts` needs the relay read
 * stubbed to reach the code paths behind a signer, and the alternative was a second copy of the
 * class below. It speaks only the three frames these pages use.
 *
 * The events must be REAL SIGNED events. SimplePool verifies everything it accepts
 * (`nostr-tools/lib/esm/index.js:1177`), so unsigned fixtures are dropped before they reach the
 * page and every assertion downstream passes for the wrong reason. `storefront/smoke-fixture.json`
 * is a capture off the four public relays for exactly this, and it is shared rather than re-captured.
 */
export const installRelayStub = (page: Page, events: unknown[]): Promise<unknown> =>
  page.addInitScript((evs: unknown[]) => {
    class FakeWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = 0
      onopen: ((e: unknown) => void) | null = null
      onmessage: ((e: { data: string }) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      onclose: ((e: unknown) => void) | null = null
      url: string
      constructor(url: string) {
        this.url = url
        setTimeout(() => {
          this.readyState = 1
          this.onopen?.({})
        }, 0)
      }
      send(raw: string) {
        let msg: unknown[]
        try {
          msg = JSON.parse(raw)
        } catch {
          return
        }
        if (msg[0] !== 'REQ') return
        const sub = msg[1]
        setTimeout(() => {
          if (this.readyState !== 1) return
          for (const ev of evs) this.onmessage?.({ data: JSON.stringify(['EVENT', sub, ev]) })
          this.onmessage?.({ data: JSON.stringify(['EOSE', sub]) })
        }, 0)
      }
      close() {
        if (this.readyState === 3) return
        this.readyState = 3
        this.onclose?.({ code: 1000, reason: '', wasClean: true })
      }
      addEventListener() {}
      removeEventListener() {}
    }
    // @ts-expect-error replacing the browser global on purpose
    window.WebSocket = FakeWebSocket
  }, events)

/**
 * A `window.nostr` that answers the two questions `connectNip07` asks and signs NOTHING.
 *
 * `signer.ts:89` gates on `typeof nostr.signEvent === 'function'` and `:94` refuses an extension
 * with no `nip44`, so both have to exist for the panel to open at all. `signEvent` THROWS rather
 * than returning a plausible event: no test that uses this stub is entitled to publish, and a
 * test that starts signing by accident should fail loudly instead of minting an event under a key
 * that does not exist. `nip44.decrypt` returns an empty notes object because
 * `storefront/smoke-fixture.json` carries no kind 30078, so `loadNotes` should find nothing to
 * decrypt; if that ever changes this is the line to revisit.
 *
 * This is NOT a substitute for item 7. It proves the page's own code runs against a signer-shaped
 * object, not that a real extension behaves this way, and the prompt count item 7 exists to
 * measure is invisible here by construction.
 */
export const installNip07Stub = (page: Page, pubkeyHex: string): Promise<unknown> =>
  page.addInitScript((pk: string) => {
    // @ts-expect-error installing the extension global on purpose
    window.nostr = {
      getPublicKey: async () => pk,
      signEvent: async () => {
        throw new Error('smoke stub: signEvent must not be called')
      },
      nip44: {
        encrypt: async () => {
          throw new Error('smoke stub: nip44.encrypt must not be called')
        },
        decrypt: async () => '{}',
      },
    }
  }, pubkeyHex)
