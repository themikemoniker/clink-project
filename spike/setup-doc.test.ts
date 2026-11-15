// Keeps docs/setup.md, the one ordered seller page, runnable by a stranger who has only that page:
// every `node X.ts` it fences exists with the flags it passes, `npm install` comes first, every
// authorize-manage.ts line carries `--key .my-key` (the default is the author's .dev-key), a guest
// seller's `--nprofile` is carried with `--key`, the watcher is never sent to a start that fails on
// the missing offers file, and no ladder filename is one the `--key .my-key` watcher ignores.
// Run: npm test (in /spike). It reads files only: no relay, no node, no key.
//
// Proved able to fail (L8) by two mutations of docs/setup.md, each run once and then restored:
//   1. `--key .my-key` deleted from the Option B `node authorize-manage.ts --key .my-key` fence line
//      -> "every fenced authorize-manage.ts line passes --key .my-key" fails.
//   2. the fenced `cd spike && npm install` line deleted -> "`npm install` in spike/ comes before
//      the first new-key.ts and authorize-manage.ts" fails.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const README = readFileSync(join(HERE, '..', 'README.md'), 'utf8')
const PAGE = readFileSync(join(HERE, '..', 'docs', 'setup.md'), 'utf8')

const flagsOn = (line: string) => [...line.matchAll(/(?<![\w-])--[a-z][\w-]*/g)].map(m => m[0])

// Every line inside a ``` fence, in page order.
const fencedLines = (markdown: string): string[] => {
  const out: string[] = []
  let fenced = false
  for (const raw of markdown.split('\n')) {
    if (/^\s*```/.test(raw)) { fenced = !fenced; continue }
    if (fenced) out.push(raw.trim())
  }
  return out
}

// The commands a fenced line runs: `cd spike && npm install` is two. Quoted output (`# …`) and
// trailing comments are not commands.
const commandsOf = (line: string): string[] =>
  line.startsWith('#') ? [] : line.replace(/\s+#.*$/, '').split('&&').map(c => c.trim()).filter(Boolean)

const FENCED = fencedLines(PAGE)
const COMMANDS = FENCED.flatMap(commandsOf)
const scriptOf = (cmd: string) => /^node\s+([\w-]+\.ts)(?![\w.-])/.exec(cmd)?.[1]

// The one sentence that quotes the builder's own `.ladder.json` text (i18n.ts `result.download`,
// `ladder.file`; publish.ts:296). Exempt word for word, and nothing else is.
const LADDER_QUOTE = 'The builder\'s button reads **Download .ladder.json** (`result.download`), the line under it says "Save it as .ladder.json next to watch-sales.ts, then restart the watcher." (`ladder.file`, `builder/src/i18n.ts:215`), and the file it saves is named `.ladder.json` (`builder/src/publish.ts:296`).'

test('README\'s Setup section links docs/setup.md before any other link in it', () => {
  const start = README.indexOf('\n## Setup\n')
  assert.ok(start !== -1, 'README has no "## Setup" heading')
  const next = README.indexOf('\n## ', start + 1)
  const setup = README.slice(start, next === -1 ? undefined : next)
  const first = /\[[^\]]*\]\(([^)]+)\)/.exec(setup)
  assert.ok(first, 'README\'s Setup section has no link')
  assert.equal(first[1], 'docs/setup.md')
})

test('the page\'s "Step N" headings are numbered consecutively from 1, each with Run and You should see', () => {
  const steps = [...PAGE.matchAll(/^#{2,3}\s+Step\s+(\d+)\b/gm)]
  assert.ok(steps.length >= 10, `only ${steps.length} Step headings`)
  assert.deepEqual(steps.map(m => Number(m[1])), steps.map((_, i) => i + 1))
  const bodies = PAGE.split(/^#{2,3}\s+Step\s+\d+\b/m).slice(1)
  bodies.forEach((body, i) => {
    assert.match(body, /\*\*Run\*\*/, `Step ${i + 1} has no **Run**`)
    assert.match(body, /\*\*You should see\*\*/, `Step ${i + 1} has no **You should see**`)
  })
})

test('every fenced `node X.ts` names a script in spike/, and every flag on it is in that script', () => {
  // `node --version` (Step 1) runs no script.
  const runs = COMMANDS.filter(c => /^node\s+(?!-)/.test(c))
  assert.ok(runs.length > 0, 'no fenced `node X.ts` command in docs/setup.md')
  for (const cmd of runs) {
    const script = scriptOf(cmd)
    assert.ok(script, `"${cmd}" does not run a .ts script`)
    assert.ok(existsSync(join(HERE, script)), `${script} is not in spike/ — "${cmd}"`)
    const src = readFileSync(join(HERE, script), 'utf8')
    for (const flag of flagsOn(cmd)) {
      // Whole flag only: `--key` must not pass on the strength of `--keys`.
      assert.match(src, new RegExp(`${flag}(?![\\w-])`), `${flag} is not in ${script} — "${cmd}"`)
    }
  }
})

test('`npm install` in spike/ comes before the first new-key.ts and authorize-manage.ts', () => {
  const install = FENCED.findIndex(l => /^cd\s+spike\s*&&\s*npm\s+install(?![\w-])/.test(l))
  assert.ok(install !== -1, 'no fenced `cd spike && npm install` line')
  for (const script of ['new-key.ts', 'authorize-manage.ts']) {
    const at = FENCED.findIndex(l => commandsOf(l).some(c => scriptOf(c) === script))
    assert.ok(at !== -1, `no fenced \`node ${script}\` line`)
    assert.ok(install < at, `\`node ${script}\` comes before \`cd spike && npm install\``)
  }
})

test('every fenced authorize-manage.ts line passes --key .my-key (the default is .dev-key)', () => {
  const lines = FENCED.filter(l => /\bauthorize-manage\.ts\b/.test(l))
  assert.ok(lines.length >= 2, 'want an own-node and a guest authorize-manage.ts line')
  const without = lines.filter(l => !/--key\s+\.my-key(?![\w.-])/.test(l))
  assert.deepEqual(without, [], 'authorize-manage.ts without --key .my-key')
})

test('a guest\'s --nprofile travels with --key: each node script on the page has a --key .my-key --nprofile line', () => {
  const keyed = new Set(COMMANDS.filter(c => /--key\s+\.my-key(?![\w.-])/.test(c)).map(scriptOf))
  const needsPairing = [...keyed].filter((s): s is string => !!s && /arg\('nprofile'/.test(readFileSync(join(HERE, s), 'utf8')))
  assert.ok(needsPairing.includes('authorize-manage.ts'), 'authorize-manage.ts is not among the node scripts')
  for (const script of needsPairing) {
    const guest = COMMANDS.find(c => scriptOf(c) === script && /--key\s+\.my-key(?![\w.-])/.test(c) && /--nprofile\s+nprofile1/.test(c))
    assert.ok(guest, `${script} has no fenced \`--key .my-key --nprofile nprofile1…\` line for a guest seller`)
  }
})

test('Step 7 names the .nmanage output, kind 21000, and new-key.ts as the key\'s source', () => {
  const step = /^#{2,3}\s+Step\s+7\b[\s\S]*?(?=^#{2,3}\s+Step\s+8\b)/m.exec(PAGE)?.[0]
  assert.ok(step, 'no Step 7 followed by a Step 8')
  assert.match(step, /spike\/\.my-key\.nmanage/)
  assert.match(step, /kind 21000/)
  assert.match(step, /new-key\.ts/)
  assert.match(step, /authorize-manage\.ts/)
})

test('the watcher is never fenced without --watcher-key or --once, and the offers gap is stated', () => {
  const runs = COMMANDS.filter(c => scriptOf(c) === 'watch-sales.ts')
  assert.ok(runs.length > 0, 'no fenced watch-sales.ts line: the Watcher key step is missing')
  const bare = runs.filter(c => !flagsOn(c).some(f => f === '--watcher-key' || f === '--once'))
  assert.deepEqual(bare, [], 'watch-sales.ts with neither --watcher-key nor --once fails on the offers file')
  assert.match(PAGE, /\.my-key\.offers\.json/)
  assert.match(PAGE, /mint-offers\.ts/)
  assert.match(PAGE, /[Kk]nown gap/)
})

test('no .ladder.json filename lacks the .my-key prefix, outside the one quote of the builder\'s text', () => {
  const quotes = PAGE.split(LADDER_QUOTE).length - 1
  assert.equal(quotes, 1, 'the builder-text sentence is not on the page exactly once, word for word')
  const rest = PAGE.replace(LADDER_QUOTE, '')
  const bare = rest.split('\n').filter(l => /(?<!\.my-key)\.ladder\.json/.test(l))
  assert.deepEqual(bare, [], 'a .ladder.json the --key .my-key watcher would not read')
  assert.match(rest, /spike\/\.my-key\.ladder\.json/)
})
