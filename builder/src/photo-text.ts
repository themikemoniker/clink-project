// G1.1 (#154): what #photo-state says, in the seller's language. Pure, DOM-free.
import { fmt, type Lang } from './i18n.ts'

/** null is the default hint; `have` is an edited item's photo, `stored` a fresh upload. */
export type PhotoView = null | { kind: 'none' } | { kind: 'have' | 'stored'; widths: number[] }

export const photoState = (lang: Lang, view: PhotoView): string =>
  !view ? fmt(lang, 'photo.hint')
    : view.kind === 'none' ? fmt(lang, 'photo.none')
    : fmt(lang, `photo.${view.kind}`, { sizes: view.widths.map(w => `${w}px`).join(', ') })
