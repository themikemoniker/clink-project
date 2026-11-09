// The builder's `npm test` must fail on a type error: Node strips types without checking them.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
const tscPath = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))

test('script: npm test runs tsc --noEmit before node --test', () => {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
  const script = pkg.scripts?.test ?? ''
  const tsc = script.indexOf('tsc --noEmit')
  const node = script.indexOf('node --test')
  assert.ok(tsc >= 0, `test script has no "tsc --noEmit": ${script}`)
  assert.ok(node >= 0, `test script has no "node --test": ${script}`)
  assert.ok(tsc < node, `"tsc --noEmit" must come before "node --test": ${script}`)
})

function typecheck(source: string): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'typecheck-gate-'))
  try {
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true },
      files: ['fixture.ts'],
    }))
    writeFileSync(join(dir, 'fixture.ts'), source + '\nexport {}\n')
    const r = spawnSync(process.execPath, [tscPath, '-p', dir], { encoding: 'utf8' })
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('behaviour: the builder tsc passes a clean file', () => {
  const r = typecheck('const a: number = 1;')
  assert.equal(r.status, 0, r.out)
})

test('behaviour: the builder tsc fails a type error with TS2322', () => {
  const r = typecheck('const a: number = "x";')
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /TS2322/)
})
