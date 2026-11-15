// Keeps README's seller setup honest about which key the signer must hold: the one in --key,
// handed to the signer with export-key-qr.ts. Run: npm test (in /spike). It reads files only:
// no relay, no node, no key.
//
// Proved able to fail (L8) by one mutation of README.md, run once and then restored:
//   1. the fenced `node export-key-qr.ts --key .my-key --yes` line deleted -> "README has a
//      fenced …" fails (and so do the two tests that start from that line).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const README = readFileSync(join(HERE, '..', 'README.md'), 'utf8')

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

// README text from the first fenced `node new-key.ts` line up to the "Then, in the browser" heading.
const keySection = (): string | undefined => {
  const lines = README.split('\n')
  const start = lines.findIndex(l => /^\s*node\s+new-key\.ts\b/.test(l))
  const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s+Then, in the browser/.test(l))
  if (start === -1 || end === -1) return undefined
  // Start at the fence that opens the new-key.ts block, so fence parity inside the slice holds.
  const fence = lines.findLastIndex((l, i) => i < start && /^\s*```/.test(l))
  return lines.slice(fence === -1 ? start : fence, end).join('\n')
}

const EXPORT_LINE = /^node\s+export-key-qr\.ts\s+--key\s+\.my-key\s+--yes(?![\w-])/

test('README has a fenced `node export-key-qr.ts --key .my-key --yes` line, and its flags exist in the script', () => {
  const line = fencedLines(README).find(l => EXPORT_LINE.test(l))
  assert.ok(line, 'no fenced `node export-key-qr.ts --key .my-key --yes` line in README.md')
  const src = readFileSync(join(HERE, 'export-key-qr.ts'), 'utf8')
  const flags = flagsOn(line)
  assert.deepEqual(flags.slice(0, 2), ['--key', '--yes'])
  for (const flag of flags) {
    // Whole flag only: `--key` must not pass on the strength of `--keys`.
    assert.match(src, new RegExp(`${flag}(?![\\w-])`), `${flag} is not in export-key-qr.ts — "${line}"`)
  }
})

test('between new-key.ts and "Then, in the browser", a paragraph next to export-key-qr.ts says "same" and "signer"', () => {
  const section = keySection()
  assert.ok(section, 'no `node new-key.ts` line followed by a "Then, in the browser" heading')
  const paragraphs = section.split(/\n\s*\n/)
  const at = paragraphs.findIndex(p => p.includes('export-key-qr.ts'))
  assert.ok(at !== -1, 'export-key-qr.ts is not mentioned between new-key.ts and "Then, in the browser"')
  const near = paragraphs.slice(Math.max(0, at - 1), at + 2)
  assert.ok(
    near.some(p => /\bsame\b/i.test(p) && /\bsigner\b/i.test(p)),
    'no paragraph within one of export-key-qr.ts says both "same" and "signer"',
  )
})

test('the key the export line names stays gitignored: it matches ^\\.[\\w-]*-key$', () => {
  const section = keySection()
  assert.ok(section, 'no key section')
  const line = fencedLines(section).find(l => /^node\s+export-key-qr\.ts\b/.test(l))
  assert.ok(line, 'no fenced export-key-qr.ts line in the key section')
  const key = /--key\s+(\S+)/.exec(line)?.[1]
  assert.ok(key, `"${line}" has no --key`)
  assert.match(key, /^\.[\w-]*-key$/)
  // The same name the authorize-manage.ts lines grant, or the signer ends up with a different key.
  const granted = fencedLines(section).filter(l => /^node\s+authorize-manage\.ts\b/.test(l)).map(l => /--key\s+(\S+)/.exec(l)?.[1])
  assert.ok(granted.length > 0, 'no fenced authorize-manage.ts line in the key section')
  for (const g of granted) assert.equal(g, key, 'authorize-manage.ts grants a different --key than the one exported')
})
