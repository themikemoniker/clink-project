// A Nostr relay for REHEARSALS ONLY: docs/dry-run.md Step A. Run: node test-relay.ts [--port N]
//
// NOT A RELAY TO RUN IN PRODUCTION. No auth, no persistence (events live in memory and are gone
// when it stops), no limits beyond message size, 127.0.0.1 only. It exists so Step B runs from a
// fresh clone with nothing installed. Node has no WebSocket server, so RFC 6455 is written by hand
// over `node:http`'s `upgrade` (text frames, masked client frames, ping/pong, close; no fragments).
//
// WIRE: what nostr-tools 2.24.3 sends (EVENT, REQ, CLOSE) and parses in `_onmessage` (OK, EVENT,
// EOSE, CLOSED, NOTICE), node_modules/nostr-tools/lib/esm/abstract-relay.js. KIND RANGES: its
// lib/esm/kinds.js helpers; NIP-01 is not vendored here, so anything beyond them is UNVERIFIED.
// TIES on created_at keep the lowest id, as storefront/src/listing.ts `newestPerAddress` does.
// FILTERS are matched here, not by nostr-tools `matchFilter`, which tests `filter.until &&` and so
// would let `until: 0` match everything.
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { pathToFileURL } from 'node:url'
import { isAddressableKind, isEphemeralKind, isReplaceableKind } from 'nostr-tools/kinds'
import { verifyEvent, type Event } from 'nostr-tools/pure'

const MAX_MESSAGE = 512 * 1024 // bigger than the fattest ladder, so the 64-bit length path is reachable
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11' // RFC 6455 section 1.3

type Filter = Record<string, unknown>
type Conn = { send: (msg: unknown[]) => void; subs: Map<string, Filter[]> }

const hex = (n: number) => (v: unknown) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v)
const uint = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0
const arrayOf = (v: unknown, ok: (x: unknown) => boolean) => Array.isArray(v) && v.every(ok)

const eventShape = (e: any): e is Event =>
  !!e && typeof e === 'object' && hex(64)(e.id) && hex(64)(e.pubkey) && hex(128)(e.sig) &&
  uint(e.kind) && e.kind <= 65535 && uint(e.created_at) && typeof e.content === 'string' &&
  arrayOf(e.tags, t => arrayOf(t, x => typeof x === 'string'))

// Returns an error string, or undefined for a filter this relay understands.
const filterError = (f: any): string | undefined => {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'filter is not an object'
  for (const [k, v] of Object.entries(f)) {
    if (k === 'ids' || k === 'authors') { if (!arrayOf(v, hex(64))) return `${k} must be 64-hex strings` }
    else if (k === 'kinds') { if (!arrayOf(v, uint)) return 'kinds must be integers' }
    else if (k === 'since' || k === 'until' || k === 'limit') { if (!uint(v)) return `${k} must be a non-negative integer` }
    else if (/^#[a-zA-Z]$/.test(k)) { if (!arrayOf(v, x => typeof x === 'string')) return `${k} must be strings` }
    else return `unsupported filter field ${k}`
  }
}

export const matches = (f: Filter, e: Event): boolean => {
  const inList = (k: string, v: unknown) => f[k] === undefined || (f[k] as unknown[]).includes(v)
  if (!inList('ids', e.id) || !inList('authors', e.pubkey) || !inList('kinds', e.kind)) return false
  if (f.since !== undefined && e.created_at < (f.since as number)) return false
  if (f.until !== undefined && e.created_at > (f.until as number)) return false
  return Object.keys(f).every(k => k[0] !== '#' || e.tags.some(t => t[0] === k.slice(1) && (f[k] as string[]).includes(t[1]!)))
}

const newestFirst = (a: Event, b: Event) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)

// `afterStore` is for tests only: it runs synchronously after an event is stored and before its OK
// is sent, and may `inject` signed events (stored and pushed like any other, with no OK).
type AfterStore = (stored: Event, inject: (e: Event) => void) => void

export const startTestRelay = async ({ port = 7777, afterStore }: { port?: number; afterStore?: AfterStore } = {}) => {
  const byKey = new Map<string, Event>() // regular events keyed by id, the rest by address
  const conns = new Set<Conn>()
  const sockets = new Set<Socket>() // upgraded sockets are not tracked by the http server

  const keyOf = (e: Event) =>
    isReplaceableKind(e.kind) ? `${e.kind}:${e.pubkey}`
    : isAddressableKind(e.kind) ? `${e.kind}:${e.pubkey}:${e.tags.find(t => t[0] === 'd')?.[1] ?? ''}`
    : e.id

  const onEvent = (conn: Conn, e: unknown) => {
    const id = (e as any)?.id
    if (!eventShape(e)) return conn.send(typeof id === 'string' ? ['OK', id, false, 'invalid: malformed event'] : ['NOTICE', 'invalid: malformed event'])
    let valid = false
    try { valid = verifyEvent(e) } catch {}
    if (!valid) return conn.send(['OK', e.id, false, 'invalid: bad id or signature'])
    // Fan out before OK: on one socket, a push for this event is always sent before its OK.
    conn.send(['OK', e.id, true, accept(e) ?? ''])
  }

  // Stores (unless ephemeral) and pushes a verified event. Returns a reason when it was not new.
  const accept = (e: Event): string | undefined => {
    if (!isEphemeralKind(e.kind)) {
      const key = keyOf(e)
      const prev = byKey.get(key)
      if (prev?.id === e.id) return 'duplicate: already have this event'
      if (prev && newestFirst(e, prev) > 0) return 'duplicate: have a newer version'
      byKey.set(key, e)
      afterStore?.(e, accept)
    }
    for (const c of conns) for (const [subId, filters] of c.subs) if (filters.some(f => matches(f, e))) c.send(['EVENT', subId, e])
  }

  const onReq = (conn: Conn, subId: unknown, filters: unknown[]) => {
    if (typeof subId !== 'string' || subId === '') return conn.send(['NOTICE', 'invalid: REQ needs a subscription id'])
    // A REQ reusing an id ends the old subscription first, whether or not the new one is valid.
    conn.subs.delete(subId)
    const error = filters.length === 0 ? 'REQ has no filters' : filters.map(filterError).find(Boolean)
    if (error) return conn.send(['CLOSED', subId, `invalid: ${error}`])
    const fs = filters as Filter[], stored = [...byKey.values()].sort(newestFirst)
    // Each filter's own `limit` counts from its newest match; the union is replayed newest first.
    const hits = new Set(fs.flatMap(f => stored.filter(e => matches(f, e)).slice(0, (f.limit as number | undefined) ?? Infinity)))
    for (const e of stored) if (hits.has(e)) conn.send(['EVENT', subId, e])
    conn.send(['EOSE', subId])
    conn.subs.set(subId, fs)
  }

  const onText = (conn: Conn, text: string) => {
    let msg: unknown
    try { msg = JSON.parse(text) } catch { return conn.send(['NOTICE', 'invalid: not JSON']) }
    if (!Array.isArray(msg)) return conn.send(['NOTICE', 'invalid: not a JSON array'])
    const [type, ...rest] = msg
    if (type === 'EVENT' && rest.length === 1) return onEvent(conn, rest[0])
    if (type === 'REQ') return onReq(conn, rest[0], rest.slice(1))
    if (type === 'CLOSE' && typeof rest[0] === 'string') { conn.subs.delete(rest[0]); return }
    conn.send(['NOTICE', `invalid: unsupported message ${JSON.stringify(type)}`])
  }

  const frame = (opcode: number, payload: Buffer) => {
    const n = payload.length
    const head = n < 126 ? Buffer.from([0x80 | opcode, n])
      : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b })()])
    return Buffer.concat([head, payload]) // server frames are never masked
  }

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const key = req.headers['sec-websocket-key']
    const ok = req.headers.upgrade?.toLowerCase() === 'websocket' && typeof key === 'string' && req.headers['sec-websocket-version'] === '13'
    if (!ok) return socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    let open = true
    const write = (opcode: number, payload: Buffer) => { if (open && socket.writable) socket.write(frame(opcode, payload)) }
    const conn: Conn = { send: msg => write(1, Buffer.from(JSON.stringify(msg))), subs: new Map() }
    conns.add(conn)
    sockets.add(socket)
    const drop = () => { open = false; conn.subs.clear(); conns.delete(conn); sockets.delete(socket) }
    const fail = (code: number) => { write(8, Buffer.from([code >> 8, code & 255])); drop(); socket.end() }
    socket.on('close', drop).on('error', drop)
    if (head.length) socket.unshift(head)
    let buf = Buffer.alloc(0)
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      while (open && buf.length >= 2) {
        const fin = buf[0]! & 0x80, opcode = buf[0]! & 0x0f, masked = buf[1]! & 0x80
        let len = buf[1]! & 0x7f, at = 2
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4 }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10 }
        if (!masked) return fail(1002) // RFC 6455 5.1: a client frame must be masked
        if (len > MAX_MESSAGE) return fail(1009)
        if (buf.length < at + 4 + len) return
        const mask = buf.subarray(at, at + 4)
        const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len))
        for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!
        buf = buf.subarray(at + 4 + len)
        if (!fin || opcode === 0) return fail(1003) // fragmentation is not supported
        if (opcode === 1) onText(conn, payload.toString('utf8'))
        else if (opcode === 8) { write(8, payload.subarray(0, 2)); drop(); socket.end() }
        else if (opcode === 9) write(10, payload)
        else if (opcode !== 10) return fail(1003) // binary and reserved opcodes
      }
    })
  }

  const server = createServer((_req, res) => res.writeHead(426).end('test relay: WebSocket only\n'))
  server.on('upgrade', onUpgrade)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${address.port}`,
    address: address.address,
    liveSubscriptions: () => [...conns].reduce((n, c) => n + c.subs.size, 0),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); for (const s of sockets) s.destroy() }),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--port')
  const port = i === -1 ? 7777 : Number(process.argv[i + 1])
  if (!uint(port) || port > 65535) { console.error(`--port must be 0-65535`); process.exit(2) }
  const relay = await startTestRelay({ port })
  console.log(`# test relay listening on ${relay.url}`)
}
