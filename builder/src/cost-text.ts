// G1.1: the item form's approval count (#cost) and the deploy line (#deploy-cost), in the seller's
// language. Pure, DOM-free. Kept out of i18n.ts so its STRINGS table has one writer at a time.
// Only the words live here: the numbers come from main.ts (`approvalCount`, the file list).
import type { Lang } from './i18n.ts'

// needs-native-review: plain Spanish written by the lab, not yet read by a native speaker.

const s = (k: number) => (k === 1 ? '' : 's')

export type ItemCost = {
  n: number // the approval count, from approvalCount
  uploads: number
  mint: boolean
  noffer: boolean
  fiatCurrency?: string
  units: number
  watcher: boolean
}

/** The whole `#cost` sentence. en is word for word what refreshCost built before this slice. */
export const itemCost = (lang: Lang, { n, uploads, mint, noffer, fiatCurrency, units, watcher }: ItemCost): string => {
  if (lang === 'es') {
    const parts = [
      ...(uploads ? [`${uploads} ${uploads === 1 ? 'foto' : 'fotos'}`] : []),
      ...(mint ? ['1 forma de cobro'] : []),
      ...(noffer ? ['0 formas de cobro, porque este artículo ya tiene una con este precio'] : []),
      ...(fiatCurrency ? [`0 formas de cobro, porque el precio está en ${fiatCurrency} y se paga en efectivo`] : []),
      '1 anuncio',
      `${units} ${units === 1 ? 'aviso' : 'avisos'} de cuántos quedan`,
      ...(watcher ? ['1 lista privada para tu ayudante de ventas'] : []),
    ]
    return `${n} ${n === 1 ? 'aprobación' : 'aprobaciones'}: ${parts.join(' + ')}. ` +
      'Tu app de firma debería preguntarte una vez y recordar el resto. Si te pregunta cada vez, no guardó los permisos.'
  }
  const parts = [
    ...(uploads ? [`${uploads} photo upload${s(uploads)}`] : []),
    ...(mint ? ['1 offer'] : []),
    ...(noffer ? ['0 offers — this item already has one, at this price'] : []),
    ...(fiatCurrency ? [`0 offers — priced in ${fiatCurrency}, so it stays cash at the table`] : []),
    '1 listing',
    `${units} availability step${s(units)}`,
    // M1: one more signature, and only when there is a watcher to encrypt it to. The encryption
    // itself is not a signature and is not counted.
    ...(watcher ? ['1 encrypted ladder for your watcher'] : []),
  ]
  return `${n} signature${s(n)}: ${parts.join(' + ')}. ` +
    `Your signer should ask once per kind and remember the rest — if it asks every time, it ignored the permissions we requested.`
}

/**
 * The `#deploy-cost` sentence for `n` storefront files: n uploads + 1 manifest + 1 server list.
 * n === 0 means the file list is missing. en is word for word the old text. es never sends the
 * seller to a terminal.
 */
export const deployCost = (lang: Lang, n: number): string => {
  if (lang === 'es') {
    return n
      ? `${n + 2} aprobaciones: ${n} ${n === 1 ? 'archivo' : 'archivos'} de tu tienda + 1 índice de tu tienda + 1 lista de servidores. ` +
        'Los archivos son todos iguales para tu app de firma, así que debería preguntarte por ellos una sola vez.'
      : 'Faltan los archivos de tu tienda. Todavía no se puede publicar.'
  }
  return n
    ? `${n + 2} signatures: ${n} file uploads + 1 site manifest + 1 Blossom server list. ` +
      `The uploads are all one kind, so your signer should ask about them once.`
    : 'The storefront files are missing. Run `npm run build` in /builder.'
}
