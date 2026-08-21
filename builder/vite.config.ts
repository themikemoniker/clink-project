import { defineConfig } from 'vite'

// The builder imports three files from outside its own root, deliberately rather than copying
// them: storefront/src/listing.ts and offer.ts are the trust boundary that decides whether a
// listing is renderable and an offer is payable, and spike/ladder.ts is the pre-signed
// availability logic slice 3 shipped and tested. A second copy of any of them is a second thing
// to keep in step on the money path. Vite's dev server refuses to serve outside the root unless
// told, so tell it.
export default defineConfig({
  server: { fs: { allow: ['..'] } },
  build: { target: 'es2022' },
})
