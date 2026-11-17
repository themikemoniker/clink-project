// G1.1 (#181): panel 6's two written lines, #result-text and #ladder-note, in the seller's
// language. Pure, DOM-free. The keys are in i18n.ts (needs-native-review); en is the old English.
import { countKey, fmt, type Lang } from './i18n.ts'

// #276: `noNode` is set only when the cash line is down to the empty node box (not fiat, not
// stock 0), so only that seller is told to paste a pointer.
export type ResultVars = { title: string; ok: number; total: number; d: string; noffer: boolean; noNode?: boolean }

/** `#result-text`: the item is live, with a Buy button or cash only, plus how to add one. */
export const resultLine = (lang: Lang, { title, ok, total, d, noffer, noNode }: ResultVars): string => {
  const line = fmt(lang, noffer ? 'result.buy' : 'result.cash', { title, ok: String(ok), total: String(total), d })
  return !noffer && noNode ? `${line} ${fmt(lang, 'result.noNode')}` : line
}

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
