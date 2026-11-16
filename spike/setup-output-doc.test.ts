// Keeps the output docs/setup.md quotes in step with what the scripts print. Step 5's block is
// checked against a real run of new-key.ts, made in a fresh temp dir through NEW_KEY_DIR. Step 7's
// and Step 11's blocks are checked against the source of authorize-manage.ts and watch-sales.ts,
// which are not run here: they need a key or a node, and write into spike/ with no override.
// A quoted line is split on its placeholders (`<…>`, and any word holding `…`, like `npub1…` or
// `…/spike/.my-key`), the source on `${…}`. Every literal piece of 8 or more characters must be in
// the source, so a reworded message fails.
// Run: npm test (in /spike). It reads files and runs new-key.ts once: no relay, no node, no real key.
//
// Proved able to fail (L8) by four mutations, each run once and then restored:
//   1. `# wrote a new secret key to` reworded to `# saved a new secret key to` in new-key.ts
//      -> "Step 5's quoted lines are what new-key.ts prints" fails.
//   2. `# granted manage_id` reworded to `# got manage_id` in authorize-manage.ts
//      -> "Step 7's quoted lines are in authorize-manage.ts" fails.
//   3. `OLDER watcher key cannot be read` reworded to `OLDER watcher key is unreadable` in
//      watch-sales.ts -> "Step 11's quoted lines are in watch-sales.ts" fails.
//   4. the `#   cat …/spike/.my-key.nmanage | pbcopy` line deleted from the page's Step 7 block
//      -> "Step 7's quoted lines …" fails: "Step 7 quotes 10 # lines, want 11".
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, '..', 'docs', 'setup.md'), 'utf8')

const stepSection = (n: number): string => {
  const step = new RegExp(`^#{2,3}\\s+Step\\s+${n}\\b[\\s\\S]*?(?=^#{2,3}\\s+Step\\s+${n + 1}\\b|^##\\s(?!#))`, 'm').exec(PAGE)?.[0]
  assert.ok(step, `no Step ${n} section`)
  return step
}

// The lines of the first ``` fence in a section that names no language: the quoted output, not
// the `bash` block that runs it.
const outputBlock = (section: string): string[] => {
  const out: string[] = []
  let open: string | undefined
  for (const raw of section.split('\n')) {
    const fence = /^\s*```(\S*)/.exec(raw)
    if (fence && open === undefined) { open = fence[1]!; continue }
    if (fence) { if (open === '') return out; open = undefined; continue }
    if (open === '') out.push(raw.trim())
  }
  assert.fail('no untagged ``` block in the section')
}

// The literal pieces of a quoted line, 8 characters or more.
const literals = (line: string): string[] =>
  line.split(/<[^>]*>|\S*…\S*/).filter(piece => piece.length >= 8)

// A script's source with every `${…}` turned into a character no quoted piece holds, so a piece
// can never match across one.
const sourceOf = (script: string): string =>
  readFileSync(join(HERE, script), 'utf8').replace(/\$\{[^}]*\}/g, '\u0000')

const assertInSource = (lines: string[], script: string, mustCover: string[]) => {
  const src = sourceOf(script)
  const pieces = lines.flatMap(literals)
  for (const piece of pieces) assert.ok(src.includes(piece), `"${piece}" is quoted on the page but is not in ${script}`)
  for (const want of mustCover) assert.ok(pieces.some(p => p.includes(want)), `the page quotes no line with "${want}"`)
}

test('Step 5\'s quoted lines are what new-key.ts prints', () => {
  const quoted = outputBlock(stepSection(5))
  assert.equal(quoted.length, 3, `Step 5 quotes ${quoted.length} lines, want 3`)
  const dir = mkdtempSync(join(tmpdir(), 'setup-output-doc-'))
  try {
    const stdout = execFileSync(process.execPath, ['new-key.ts'], {
      cwd: HERE, env: { ...process.env, NEW_KEY_DIR: dir }, encoding: 'utf8',
    })
    const printed = stdout.trimEnd().split('\n')
    assert.equal(printed.length, 3, `new-key.ts printed ${printed.length} lines`)
    assert.match(printed[0]!, /^npub1[02-9ac-hj-np-z]{58}$/)
    assert.equal(quoted[0], 'npub1…')
    const real = quoted.slice(1).map(l => l.replaceAll('…/spike/.my-key', join(dir, '.my-key')))
    assert.ok(real[0] !== quoted[1], 'Step 5 does not quote the key path as …/spike/.my-key')
    assert.deepEqual(printed.slice(1), real)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Step 7\'s quoted lines are in authorize-manage.ts, and so is the second-run line', () => {
  const step = stepSection(7)
  const quoted = outputBlock(step).filter(l => l.startsWith('#'))
  assert.equal(quoted.length, 11, `Step 7 quotes ${quoted.length} # lines, want 11`)
  const secondRun = [...step.matchAll(/`(# already authorised[^`]*)`/g)].map(m => m[1]!)
  assert.equal(secondRun.length, 1, 'Step 7 does not quote the second-run line once')
  assertInSource([...quoted, ...secondRun], 'authorize-manage.ts', [
    'node app pubkey', 'authorising', 'granted manage_id', 'already authorised (manage_id',
    'wrote the nmanage pointer to', 'pbcopy', 'treat it like the pairing string',
  ])
})

test('Step 11\'s quoted lines are in watch-sales.ts', () => {
  const quoted = outputBlock(stepSection(11))
  assert.equal(quoted.length, 4, `Step 11 quotes ${quoted.length} lines, want 4`)
  assert.ok(quoted.every(l => l.startsWith('#')), 'Step 11 quotes a line that is not a # line')
  assertInSource(quoted, 'watch-sales.ts', [
    'a new watcher key', 'OLDER watcher key cannot be read with it', '# watcher key',
  ])
})
