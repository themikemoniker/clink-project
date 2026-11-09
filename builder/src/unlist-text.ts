// G1.1: the two un-list sentences that carry a count, in the seller's language. Pure, DOM-free.
// Kept out of i18n.ts so its STRINGS table has one writer at a time.
import type { Lang } from './i18n.ts'

// needs-native-review: plain Spanish written by the lab, not yet read by a native speaker.

/** The line above the list of items a publish would drop. */
export const unlistWhat = (lang: Lang, n: number): string =>
  lang === 'es'
    ? `Esto quitaría de la venta ${n} ${n === 1 ? 'artículo que hoy está' : 'artículos que hoy están'} en tu venta:`
    : `This would un-list ${n} item${n === 1 ? '' : 's'} that your sale lists right now:`

/** The status message when a publish is stopped until the seller ticks the box. */
export const unlistSay = (lang: Lang, n: number): string =>
  lang === 'es'
    ? `Publicar esto quitaría de la venta ${n} ${n === 1 ? 'artículo' : 'artículos'}. Lee el recuadro de arriba y márcalo si fue a propósito.`
    : `Publishing this would un-list ${n} item${n === 1 ? '' : 's'}. Read the box above, then tick it if you meant to.`
