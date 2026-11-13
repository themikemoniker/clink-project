// G1.1: the photo status line (#photo-state) in the seller's language. Pure, DOM-free.
// main.ts keeps the shown view, so the language switch can re-write it.
import { fmt, type Lang } from './i18n.ts'

/** null is the default hint; `have` is an edited item's stored photo; `stored` is a fresh upload. */
export type PhotoView = null | { kind: 'none' } | { kind: 'have' | 'stored'; widths: number[] }

export const photoState = (lang: Lang, view: PhotoView): string => {
  if (!view) return fmt(lang, 'photo.hint')
  if (view.kind === 'none') return fmt(lang, 'photo.none')
  const sizes = view.widths.map(w => `${w}px`).join(', ')
  return fmt(lang, view.kind === 'have' ? 'photo.have' : 'photo.stored', { sizes })
}
