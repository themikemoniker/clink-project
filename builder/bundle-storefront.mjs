// Put a built copy of the storefront inside the builder, so the builder can deploy it.
//
// THE PROBLEM THIS SOLVES: "generate the site files" (spec §10, slice 5) cannot mean `vite
// build` — a static page has no build step and no filesystem. The bytes have to already be
// there. The obvious answer is to inline them into the builder's JS as raw assets, which
// roughly doubles the bundle and puts 90 KB of base64 through the parser at load.
//
// They go in `public/` instead. Vite copies that directory verbatim, so the storefront's files
// stay files: the builder fetches them from its own origin at deploy time, and when the builder
// is itself deployed as an nsite (rule 5) they are blobs in its own manifest, fetched only when
// somebody actually deploys. Zero bundle growth, and the honest arrangement — the builder
// carries the storefront it ships.
//
// Run automatically by `npm run dev` and `npm run build` (predev/prebuild in package.json).
import { execFileSync } from 'node:child_process'
import { cpSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'storefront')
const DEST = join(HERE, 'public', 'site')

execFileSync('npm', ['--prefix', SRC, 'run', 'build'], { stdio: 'inherit' })

rmSync(DEST, { recursive: true, force: true })
cpSync(join(SRC, 'dist'), DEST, { recursive: true })

const walk = dir =>
  readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

// The file list, because a browser cannot read a directory. Absolute paths as the deployed site
// will serve them — `/index.html`, not `/site/index.html` — so nothing downstream has to know
// where the builder happened to keep them.
const paths = walk(DEST).map(f => '/' + relative(DEST, f).split(/[\\/]/).join(posix.sep)).sort()
writeFileSync(join(HERE, 'public', 'site.json'), JSON.stringify(paths, null, 2) + '\n')

console.log(`bundled ${paths.length} storefront files into public/site: ${paths.join(', ')}`)
