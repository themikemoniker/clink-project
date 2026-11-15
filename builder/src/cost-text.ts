// G1.1 (#151): the item form's approval count (#cost) and the deploy-cost line (#deploy-cost), in
// the seller's language. Pure, DOM-free. The numbers come from main.ts (`approvalCount`); this
// only says them. Kept out of i18n.ts so its STRINGS table has one writer at a time.
import type { Lang } from './i18n.ts'

// needs-native-review: plain Spanish written by the lab, not yet read by a native speaker.

export type CostView = {
  n: number // signatures, from approvalCount
  uploads: number
  mint: boolean
  noffer: boolean
  fiatCurrency: string | null
  units: number
  watcher: boolean
}

const pl = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The `#cost` sentence. en is word for word the old main.ts text; the parts keep their order. */
export const itemCost = (lang: Lang, v: CostView): string => {
  const es = lang === 'es'
  const parts = [
    ...(v.uploads ? [es ? pl(v.uploads, 'subida de foto', 'subidas de fotos') : `${v.uploads} photo upload${v.uploads === 1 ? '' : 's'}`] : []),
    ...(v.mint ? [es ? '1 oferta' : '1 offer'] : []),
    ...(v.noffer ? [es ? '0 ofertas (este artículo ya tiene una con este precio)' : '0 offers — this item already has one, at this price'] : []),
    ...(v.fiatCurrency !== null
      ? [es ? `0 ofertas (el precio está en ${v.fiatCurrency}, así que se paga en efectivo en la mesa)` : `0 offers — priced in ${v.fiatCurrency}, so it stays cash at the table`]
      : []),
    es ? '1 artículo' : '1 listing',
    es ? `${pl(v.units, 'paso', 'pasos')} de disponibilidad` : `${v.units} availability step${v.units === 1 ? '' : 's'}`,
    ...(v.watcher ? [es ? '1 aviso cifrado para tu ayudante' : '1 encrypted ladder for your watcher'] : []),
  ]
  return es
    ? `${pl(v.n, 'aprobación', 'aprobaciones')}: ${parts.join(' + ')}. ` +
      'Tu teléfono debería preguntar una vez por cada tipo y recordar el resto; si pregunta cada vez, ignoró los permisos que pedimos.'
    : `${v.n} signature${v.n === 1 ? '' : 's'}: ${parts.join(' + ')}. ` +
      `Your signer should ask once per kind and remember the rest — if it asks every time, it ignored the permissions we requested.`
}

/** The `#deploy-cost` sentence for `n` storefront files; 0 means the files are missing. en is word for word the old text. */
export const deployCost = (lang: Lang, n: number): string =>
  lang === 'es'
    ? n
      ? `${n + 2} aprobaciones: ${pl(n, 'archivo', 'archivos')} + 1 índice de la tienda + 1 lista de servidores de archivos. ` +
        'Los archivos son del mismo tipo, así que tu teléfono debería preguntar una sola vez.'
      : 'Faltan los archivos de la tienda. Esta página está incompleta; avisa a quien te la dio.'
    : n
      ? `${n + 2} signatures: ${n} file uploads + 1 site manifest + 1 Blossom server list. ` +
        `The uploads are all one kind, so your signer should ask about them once.`
      : 'The storefront files are missing. Run `npm run build` in /builder.'
