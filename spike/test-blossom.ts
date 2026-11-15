// A Blossom server for REHEARSALS ONLY: docs/dry-run.md Steps C and D. Run: node test-blossom.ts [--port N]
//
// NOT A BLOSSOM SERVER TO RUN IN PRODUCTION. Blobs live in memory and are gone when it stops, any
// pubkey may upload, 127.0.0.1 only. It exists so `seed-listings.ts --blossom` and the real
// `deploy-nsite.ts` run from a fresh clone with nothing installed. Built on `node:http` only.
//
// WIRE: only what this repo's two clients send and read. `builder/src/blossom.ts` `mirror()` and
// `spike/seed-listings.ts:158-190` both `PUT <server>/upload` with `authorization` and
// `content-type` and a raw body, and read a JSON `{url?, sha256?}` back. AUTH: `authHeader` in
// builder/src/blossom.ts: `Nostr ` + standard base64 of a kind 24242 event with `t=upload`, an
// `expiration` and ONE `x` tag. Node's base64 decoder also takes the base64url alphabet. BUD-11 is
// not vendored here; status codes, `size` and `type` in the reply, and anything else are UNVERIFIED.
//
// THE IDENTITY IS THE HASH OF THE BODY THIS SERVER READ, never the auth's `x` tag. An auth with more
// than one `x` is refused: blossom.band took the first `x` as the identity and silently stored blob B
// under blob A's hash ("ONE AUTH PER BLOB", builder/src/blossom.ts).
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { verifyEvent, type Event } from 'nostr-tools/pure'

const MAX_BLOB = 50 * 1024 * 1024 // a stray upload cannot eat more memory than this

// Returns why the auth does not cover a blob with this sha256, or undefined when it does.
export const authError = (header: string | undefined, sha256: string, now = Math.floor(Date.now() / 1000)): string | undefined => {
  if (!header?.startsWith('Nostr ')) return 'missing "Nostr <base64>" authorization header'
  let e: Event
  try { e = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8')) } catch { return 'authorization is not base64 JSON' }
  if (!e || typeof e !== 'object' || !Array.isArray(e.tags) || !e.tags.every(t => Array.isArray(t))) return 'authorization is not an event'
  let valid = false
  try { valid = verifyEvent(e) } catch {}
  if (!valid) return 'bad id or signature'
  if (e.kind !== 24242) return `kind ${e.kind}, not 24242`
  const values = (name: string) => e.tags.filter(t => t[0] === name).map(t => t[1])
  if (!values('t').includes('upload')) return 'no t=upload tag'
  const exp = values('expiration')
  if (exp.length !== 1 || !/^\d+$/.test(exp[0] ?? '') || Number(exp[0]) <= now) return 'expiration missing or not in the future'
  const xs = values('x')
  if (xs.length !== 1) return `${xs.length} x tags; one auth per blob`
  if (xs[0] !== sha256) return `x tag ${String(xs[0]).slice(0, 12)} is not the body's sha256 ${sha256.slice(0, 12)}`
}

// Reads the body up to `max` bytes. Resolves undefined, having stopped reading, once it is over.
const readBody = (req: IncomingMessage, max: number) => new Promise<Buffer | undefined>((resolve, reject) => {
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > max) { req.pause(); req.removeAllListeners('data'); return resolve(undefined) }
    chunks.push(c)
  })
  req.on('end', () => resolve(Buffer.concat(chunks)))
  req.on('error', reject)
})

export const startTestBlossom = async ({ port = 7778, maxBlob = MAX_BLOB }: { port?: number; maxBlob?: number } = {}) => {
  const blobs = new Map<string, { bytes: Buffer; type: string }>()
  let base = ''

  const server = createServer(async (req, res) => {
    const reply = (status: number, body: string, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'text/plain', ...headers }).end(body + '\n')
    try {
      if (req.method === 'PUT' && req.url === '/upload') {
        const bytes = await readBody(req, maxBlob)
        if (!bytes) return res.writeHead(413, { connection: 'close' }).end(`blob over ${maxBlob} bytes\n`, () => req.destroy())
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const why = authError(req.headers.authorization, sha256)
        if (why) return reply(401, why)
        const type = req.headers['content-type'] ?? 'application/octet-stream'
        blobs.set(sha256, { bytes, type })
        const body = { url: `${base}/${sha256}`, sha256, size: bytes.length, type }
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      }
      const sha = /^\/([0-9a-f]{64})$/.exec(req.url ?? '')?.[1]
      if ((req.method === 'GET' || req.method === 'HEAD') && sha) {
        const blob = blobs.get(sha)
        if (!blob) return reply(404, 'no such blob')
        res.writeHead(200, { 'content-type': blob.type, 'content-length': String(blob.bytes.length) })
        return res.end(req.method === 'GET' ? blob.bytes : undefined)
      }
      reply(404, 'test blossom: only PUT /upload and GET or HEAD /<sha256>')
    } catch (err) {
      if (!res.headersSent) reply(500, String(err).slice(0, 200))
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  base = `http://127.0.0.1:${address.port}` // the bound port, so the `url` it answers is fetchable
  return {
    url: base,
    address: address.address,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--port')
  const port = i === -1 ? 7778 : Number(process.argv[i + 1])
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) { console.error(`--port must be 0-65535`); process.exit(2) }
  const blossom = await startTestBlossom({ port })
  console.log(`# test blossom listening on ${blossom.url}`)
}
