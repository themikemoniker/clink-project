// G1.1 (#181): panel 6's two written lines, #result-text and #ladder-note, in the seller's
// language. Pure, DOM-free. The keys are in i18n.ts (needs-native-review); en is the old English.
import { countKey, fmt, type Lang } from './i18n.ts'

export type ResultVars = { title: string; ok: number; total: number; d: string; noffer: boolean }

/** `#result-text`: the item is live, with a Buy button or cash only. */
export const resultLine = (lang: Lang, { title, ok, total, d, noffer }: ResultVars): string =>
  fmt(lang, noffer ? 'result.buy' : 'result.cash', { title, ok: String(ok), total: String(total), d })

export type NoteVars = { items: number; total: number; ladderRelaysOk?: number; wasEdit: boolean }

/**
 * `#ladder-note`, M1's three outcomes: no watcher key (a file to carry across), sent to the watcher
 * on at least one relay, or sent to none. The edit warning follows the two file outcomes only: on
 * the relay path the watcher's old ladder has just been replaced.
 */
export const ladderNote = (lang: Lang, { items, total, ladderRelaysOk, wasEdit }: NoteVars): string => {
  const count = fmt(lang, countKey('ladder.items', items), { n: String(items) })
  const edit = wasEdit ? ' ' + fmt(lang, 'ladder.edit') : ''
  if (ladderRelaysOk === undefined) return `${count} ${fmt(lang, 'ladder.file')}${edit}`
  if (ladderRelaysOk > 0) return `${count} ${fmt(lang, 'ladder.sent', { ok: String(ladderRelaysOk), total: String(total) })}`
  return `${count} ${fmt(lang, 'ladder.notSent')}${edit}`
}

/** What panel 6 shows, kept so the language switch can write it again. null before a publish. */
export type ResultView = { result: ResultVars; note: NoteVars } | null
