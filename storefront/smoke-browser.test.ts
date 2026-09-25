// The half of `smoke-browser.ts` that is provable without a browser: which executable we would
// reach for, and, more importantly, when we would reach for none.
//
// The last case is the load-bearing one. `fallbackChromium` returning null is what makes
// `launchChromium` rethrow playwright's own "run playwright install" error, so a developer whose
// browsers are simply not installed gets that advice instead of a second, stranger failure from a
// path that was never there. A bug that turned "nothing on disk" into "a path" would replace a
// clear error with a confusing one on every machine in the project, which is the sort of thing a
// browser test cannot catch because it needs the browser to be missing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fallbackChromium } from './smoke-browser.ts'

const none = () => false
const all = () => true

test('nothing named and nothing on disk means no fallback, so the pinned error survives', () => {
  assert.equal(fallbackChromium({}, all), null)
  assert.equal(fallbackChromium({ CLINK_CHROMIUM: '/nope/chrome' }, none), null)
})

test('a stale PLAYWRIGHT_BROWSERS_PATH reads as no fallback rather than as a path', () => {
  // The variable being set says nothing about the disk. This is the case that must not become a
  // launch attempt: the container sets it, an ordinary machine with a wiped cache sets it too.
  assert.equal(fallbackChromium({ PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' }, none), null)
})

test('the container convention is derived from PLAYWRIGHT_BROWSERS_PATH, not hardcoded to /opt', () => {
  assert.equal(
    fallbackChromium({ PLAYWRIGHT_BROWSERS_PATH: '/somewhere/else' }, all),
    '/somewhere/else/chromium',
  )
})

test('CLINK_CHROMIUM wins, because a host that names its browser has said the last word', () => {
  assert.equal(
    fallbackChromium({ CLINK_CHROMIUM: '/my/chrome', PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' }, all),
    '/my/chrome',
  )
})

test('an absent CLINK_CHROMIUM falls through to the container convention rather than refusing', () => {
  assert.equal(
    fallbackChromium(
      { CLINK_CHROMIUM: '/gone/chrome', PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' },
      p => p === '/opt/pw-browsers/chromium',
    ),
    '/opt/pw-browsers/chromium',
  )
})
