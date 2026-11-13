// Keeps /docs/dry-run.md from drifting away from the scripts it tells a stranger to run.
// Run: npm test (in /spike). It reads files only: no relay, no node, no key.
//
// Proved able to fail (L8) by three mutations of the page, each run once and then restored:
//   1. `--relays $TEST_RELAY` in Step B misspelled as `--relayz` -> "every --flag …" fails.
//   2. the "Rehearse first" link removed from README.md         -> "README links …" fails.
//   3. the switch section's commands replaced by the q193 ones (`node mint-offers.ts` and
//      `node seed-listings.ts` with no --key, no new-key.ts line) -> "the switch to real makes
//      the key it uses" fails. That is the defect the q193 review found: the default switch-over
//      needed spike/.dev-key, which the rehearsal never creates.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, '..', 'docs', 'dry-run.md'), 'utf8')
const README = readFileSync(join(HERE, '..', 'README.md'), 'utf8')

type Command = { line: string; script: string }

// Every `node <script>.ts …` line inside a ``` fence, in page order.
const commandsIn = (markdown: string): Command[] => {
  const out: Command[] = []
  let fenced = false
  for (const raw of markdown.split('\n')) {
    if (/^\s*```/.test(raw)) { fenced = !fenced; continue }
    const m = fenced ? /^\s*node\s+([\w.-]+\.ts)\b/.exec(raw) : null
    if (m) out.push({ line: raw.trim(), script: m[1]! })
  }
  return out
}

// The section under the first heading that says "switch to (the) real", up to the next heading
// of the same or a higher level.
const switchSection = (markdown: string): string | undefined => {
  const lines = markdown.split('\n')
  const start = lines.findIndex(l => /^#{1,6}\s/.test(l) && /switch to (the )?real/i.test(l))
  if (start === -1) return undefined
  const level = /^(#+)/.exec(lines[start]!)![1]!.length
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

const source = (script: string) => readFileSync(join(HERE, script), 'utf8')
const flagsOn = (line: string) => [...line.matchAll(/(?<![\w-])--[a-z][\w-]*/g)].map(m => m[0])

const COMMANDS = commandsIn(PAGE)

test('the page shows at least one command per step', () => {
  // Without this the two checks below would pass on a page whose fences had all gone.
  assert.ok(COMMANDS.length >= 6, `only ${COMMANDS.length} node commands found in fenced blocks`)
})

test('every node <script>.ts line in a fenced block names a script that exists in spike/', () => {
  for (const { line, script } of COMMANDS) {
    assert.ok(existsSync(join(HERE, script)), `${script} does not exist in spike/ — "${line}"`)
  }
})

test('every --flag on those lines appears as --flag in that script\'s source', () => {
  for (const { line, script } of COMMANDS) {
    if (!existsSync(join(HERE, script))) continue // reported by the test above
    const src = source(script)
    for (const flag of flagsOn(line)) {
      // Whole flag only: `--relay` must not pass on the strength of `--relays`.
      assert.match(src, new RegExp(`${flag}(?![\\w-])`), `${flag} is not in ${script} — "${line}"`)
    }
  }
})

test('the page has a "switch to (the) real" heading whose section names SALE_RELAYS and .dev-key', () => {
  const section = switchSection(PAGE)
  assert.ok(section, 'no heading matching /switch to (the )?real/i')
  assert.match(section, /SALE_RELAYS/)
  assert.match(section, /\.dev-key/)
})

test('the switch to real makes the key it uses: every seller-key command passes --key K after `node new-key.ts K`', () => {
  // A script reads a seller key if its source falls back to .dev-key. Derived, not listed, so a
  // new key-reading script is covered the day it lands.
  const readsKey = (script: string) => existsSync(join(HERE, script)) && source(script).includes(`arg('key', '.dev-key')`)
  const section = switchSection(PAGE)
  assert.ok(section, 'no switch section')
  const made = new Set<string>()
  let keyed = 0
  for (const { line, script } of commandsIn(section)) {
    const created = /^node\s+new-key\.ts\s+(\.[\w-]+)/.exec(line)
    if (created) { made.add(created[1]!); continue }
    if (!readsKey(script)) continue
    keyed++
    const key = /--key\s+(\S+)/.exec(line)?.[1]
    assert.ok(key, `"${line}" has no --key, so it falls back to spike/.dev-key, which the rehearsal never creates`)
    assert.notEqual(key, '.rehearsal-key', `"${line}" switches to real on the rehearsal key`)
    assert.ok(made.has(key), `"${line}" uses ${key}, but no earlier \`node new-key.ts ${key}\` in the switch section makes it`)
  }
  assert.ok(keyed > 0, 'the switch section runs no seller-key command at all')
})

test('README links docs/dry-run.md', () => {
  assert.match(README, /\]\(docs\/dry-run\.md\)/)
})

test('no wss:// public relay URL sits on a fenced node command unless that line says PUBLIC WRITE', () => {
  // Simple on purpose: a wss:// host other than localhost/127.0.0.1 on a command line is a public
  // write, and the only one this page may show is the warning line that says so.
  for (const { line } of COMMANDS) {
    const publicUrl = [...line.matchAll(/wss:\/\/([^\s/,:]+)/g)].some(m => !/^(localhost|127\.0\.0\.1)$/.test(m[1]!))
    if (publicUrl) assert.match(line, /PUBLIC WRITE/, `public relay URL on an unmarked command: "${line}"`)
  }
})
