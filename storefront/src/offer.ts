// The second trust boundary. A `noffer` reaches us on a relay event and a `bolt11` reaches us
// from a node we have never met; both decide where money goes, so both are parsed here, with
// bounds, and neither parser throws. Nothing below is recalled from memory:
//
//   noffer TLV layout      CLINK/specs/clink-offers.md:17-31   (quoted in /docs/clink-notes.md §2.1)
//   BOLT11 human-readable  bolt11 §"Human-Readable Part"
import { bech32 } from '@scure/base'

// Lightning.Pub hardcodes a 10-sat floor on what it will invoice (offerManager.ts:224,251 —
// /docs/spike-findings.md §13.7). Nothing below it is buyable, so nothing below it gets a Buy
// button; the alternative is a button that always answers `code: 5`.
export const MIN_PAYABLE_SATS = 10

// clink-offers.md:19-27. TLV 3 is the one-byte pricing type; clink-offers.md:29 says an absent
// TLV 3 and TLV 4 means Spontaneous, so we default rather than reject — the reference SDK
// requires TLV 3, which is stricter than its own spec, and we are lenient on receive.
export const PRICE_FIXED = 0
export const PRICE_VARIABLE = 1
export const PRICE_SPONTANEOUS = 2

export type Offer = {
  pubkey: string // TLV 0 — the receiving service
  relay: string // TLV 1 — where it listens
  offer: string // TLV 2 — opaque per-item id
  priceType: number // TLV 3
  priceSats?: number // TLV 4, whole satoshis (clink-offers.md:31)
}

// A noffer for a yard sale item is ~200 characters. nostr-tools' Bech32MaxSize is 5000, which is
// a fine ceiling for nprofiles carrying relay lists and a silly one for a tag we render.
const MAX_NOFFER = 1_000

const utf8 = new TextDecoder('utf-8', { fatal: true })

// TLV: [type][length][value]…, repeated. A truncated record is a corrupt pointer, not a
// best-effort one — bail rather than pay attention to whatever survived.
//
// EXPORTED IN SLICE 7, and it is a deletion rather than an addition. CLINK has three bech32 TLV
// pointers — `noffer` (here), `nmanage` (builder/src/manage.ts) and `ndebit` (spike/ndebit.ts) —
// and by slice 6 the first two had a copy of this loop each. A third copy is how a bounds check
// gets fixed in two places out of three. One loop, three callers, one set of tests.
export const parseTLV = (data: Uint8Array): Map<number, Uint8Array> => {
  const out = new Map<number, Uint8Array>()
  for (let i = 0; i < data.length; ) {
    const type = data[i]!
    const len = data[i + 1]
    if (len === undefined || i + 2 + len > data.length) return new Map()
    if (!out.has(type)) out.set(type, data.subarray(i + 2, i + 2 + len)) // first wins
    i += 2 + len
  }
  return out
}

export const tlvText = (bytes: Uint8Array | undefined, max: number): string | undefined => {
  if (!bytes || bytes.length === 0 || bytes.length > max) return undefined
  try {
    return utf8.decode(bytes)
  } catch {
    return undefined // not valid UTF-8; a relay URL made of arbitrary bytes is not a relay URL
  }
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')

// The reference encoder writes TLV 4 as a fixed 4-byte big-endian integer
// (`@shocknet/clink-sdk` nip19Extension.js `integerToUint8Array`) and its decoder reads any
// length as big-endian. Accept 1–6 bytes so we stay inside Number's safe range whatever a
// future encoder does.
const bigEndian = (bytes: Uint8Array | undefined): number | undefined => {
  if (!bytes || bytes.length === 0 || bytes.length > 6) return undefined
  return bytes.reduce((n, b) => n * 256 + b, 0)
}

// A Lightning address, `user@host`. It lives here rather than in render.ts as of slice 7, because
// it stopped being a form-validation regex the moment something started *paying* what it accepts:
// the page collects the buyer's refund pointer with it, and /spike/refund.ts resolves the same
// string over LNURL-pay and sends money to whatever comes back. Two copies of that rule would be
// a page accepting a pointer the watcher cannot pay, which surfaces months later as a refund that
// went nowhere. The node itself checks only `typeof === 'string'` (offerManager.ts:139-155).
//
// {1,253} not {3,253} on the host: the shorter bound rejected `bob@ln.tips` and every other
// address whose second-level domain is two characters, which is a buyer who cannot buy at all.
export const LN_ADDRESS = /^[^\s@]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}$/i

export const decodeNoffer = (raw: string): Offer | null => {
  if (typeof raw !== 'string' || raw.length > MAX_NOFFER || !raw.startsWith('noffer1')) return null
  let data: Uint8Array
  try {
    // bech32.decode verifies the checksum, which is the whole reason this is not a hand-rolled
    // base32 loop: a pointer that flipped a character in transit must not decode to a valid-
    // looking pubkey. @scure/base is already in the tree — nostr-tools' own nip19 uses it.
    const { prefix, words } = bech32.decode(raw as `noffer1${string}`, MAX_NOFFER)
    if (prefix !== 'noffer') return null
    data = new Uint8Array(bech32.fromWords(words))
  } catch {
    return null
  }

  const tlv = parseTLV(data)
  const pubkey = tlv.get(0)
  const relay = tlvText(tlv.get(1), 512)
  const offer = tlvText(tlv.get(2), 512)
  if (!pubkey || pubkey.length !== 32 || !offer) return null
  // No relay, no destination. The service listens where the offer says it listens, and falling
  // back to the storefront's own relays would just publish a payment request into the void.
  if (!relay || !/^wss:\/\/[^\s]+$/.test(relay)) return null

  const priceByte = tlv.get(3)
  const priceSats = bigEndian(tlv.get(4))
  // clink-offers.md:27 — a currency code in TLV 5 means the price is in that currency and TLV 4
  // MUST be absent. We have no oracle and never will (/CLAUDE.md rule 1), so we cannot check
  // such an offer against a displayed price. Refuse it rather than pay an amount we cannot read.
  if (tlv.has(5)) return null

  return {
    pubkey: hex(pubkey),
    relay,
    offer,
    priceType: priceByte?.[0] ?? (priceSats === undefined ? PRICE_SPONTANEOUS : PRICE_FIXED),
    priceSats,
  }
}

// Whole satoshis encoded in a BOLT11's human-readable part, or null if the invoice carries no
// amount, an amount we cannot represent exactly, or an amount that is not a whole number of sats.
//
// This exists for one check: the invoice the node returns must ask for the number the page
// showed the buyer. Without it, "the offer and the displayed price agree" is a claim about our
// own authoring tools and not about the invoice actually being paid.
const MSAT_PER_UNIT: Record<string, number> = { '': 1e11, m: 1e8, u: 1e5, n: 1e2, p: 0.1 }

// MAINNET ONLY, and slice 7 is why it is `^lnbc` and not an alternation. This used to accept
// `lntb`/`lnbcrt`/`lnsb` as well, on the reasoning that a testnet invoice can only appear if the
// seller's own node is misconfigured and a mainnet wallet would refuse it anyway. That reasoning
// covered one direction. Slice 7 added the other: the refund path *pays* a BOLT11 that arrived
// from a stranger's wallet, via an noffer or an LNURL host we do not control, and there the
// question is not "will a wallet refuse this" but "are we about to try". An invoice on the wrong
// chain is a refund that fails at the node instead of at the parser, which is a worse place.
export const invoiceSats = (bolt11: string): number | null => {
  if (typeof bolt11 !== 'string' || bolt11.length < 10 || bolt11.length > 4_000) return null
  // The bech32 separator is the LAST '1'; everything before it is the human-readable part.
  const hrp = bolt11.slice(0, bolt11.toLowerCase().lastIndexOf('1'))
  const parsed = /^lnbc(\d{1,12})([munp])?$/.exec(hrp.toLowerCase())
  if (!parsed) return null
  const msat = Number(parsed[1]) * MSAT_PER_UNIT[parsed[2] ?? '']!
  if (!Number.isSafeInteger(msat) || msat <= 0 || msat % 1000 !== 0) return null
  return msat / 1000
}
