import { defineConfig } from 'vite'

// Deliberately almost empty, and that is slice 5's doing.
//
// This file used to `define` __SELLER_NPUB__ and __SITE_URL__ from a hardcoded pubkey, and
// encode the flyer's QR at build time from that URL. Both made the storefront a per-seller
// artifact, which is incompatible with a builder that carries one pre-built copy and deploys it
// for whoever is signed in. The page now reads its seller from `location.hostname` (NIP-5A
// 5A.md:156-158) and its URL from `location.origin`.
//
// The QR moved to DEPLOY time rather than run time, so the page still ships no QR encoder: the
// deployer knows the npub and the gateway, and substitutes the `<!--QR-->` marker in index.html
// for a `<symbol id="qr">` on its way to Blossom. See builder/src/deploy.ts `withQR`.
//
// `assetsInlineLimit: 0` stays: every asset must be a real file, because an nsite manifest maps
// paths to blobs and an inlined one has no path.
export default defineConfig({
  build: { target: 'es2022', assetsInlineLimit: 0 },
})
