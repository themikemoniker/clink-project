import { npubEncode } from 'nostr-tools/nip19'
import QRCode from 'qrcode'
import { defineConfig } from 'vite'

// Keep in step with SELLER_PUBKEY in src/main.ts. Slice 5 generates both.
const SELLER_PUBKEY = 'fb18e881362a772e1bff2fc260a5ff47cb01d3fa7a254349948603774cdb47a0'

// NIP-5A 5A.md:134-168 — a root site's canonical URL is a single DNS label, <npub>.<gateway>.
// Which gateway is the deployer's choice, so this is a default, not a claim that it resolves.
// Override at build: VITE_SITE_URL=https://... npm run build
const SITE_URL = process.env.VITE_SITE_URL ?? `https://${npubEncode(SELLER_PUBKEY)}.nsite.lol`

// The QR is print-only and its content is known at build time, so encoding it here costs the
// page zero runtime bytes — a QR library in the bundle would be ~15KB of the ~30KB budget for
// something no screen reader and no buyer on a phone ever sees.
const qrSymbol = async (url: string) => {
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '0 0 33 33'
  const inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true">` +
    `<symbol id="qr" viewBox="${viewBox}">${inner}</symbol></svg>`
}

export default defineConfig({
  define: {
    __SITE_URL__: JSON.stringify(SITE_URL),
    __SELLER_NPUB__: JSON.stringify(npubEncode(SELLER_PUBKEY)),
  },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  plugins: [
    {
      name: 'storefront-qr',
      async transformIndexHtml(html) {
        return html.replace('<!--QR-->', await qrSymbol(SITE_URL))
      },
    },
  ],
})
