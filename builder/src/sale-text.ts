// G1.1: the sentence shown after "Publish sale" succeeds, in the seller's language. Pure, DOM-free.
// Kept out of i18n.ts so its STRINGS table has one writer at a time.
import type { Lang } from './i18n.ts'

// needs-native-review: plain Spanish written by the lab, not yet read by a native speaker.

export type SaleLive = { title: string; ok: number; total: number; d: string; items: number; mapLink: boolean }

/** The `#sale-state` sentence once the sale is published. en is word for word the old text. */
export const saleLive = (lang: Lang, { title, ok, total, d, items, mapLink }: SaleLive): string =>
  lang === 'es'
    ? `“${title}” ya está publicada en ${ok} de ${total} servidores como ${d}, con ${items} ${items === 1 ? 'artículo' : 'artículos'}.` +
      (mapLink ? ' Ahora el barrio de tu venta se puede tocar en tu tienda para abrir un mapa.' : '')
    : `“${title}” is live on ${ok}/${total} relays as ${d}, listing ${items} item(s).` +
      (mapLink ? ' Its neighbourhood is now a tappable map link on your storefront.' : '')
