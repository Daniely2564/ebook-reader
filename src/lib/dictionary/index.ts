import { getUserDicts } from '../db'
import { getSettings } from '../settings'
import { lookupWikipedia, lookupWiktionary } from './online'
import { getStarDict } from './stardict'
import type { DictEntry, DictResult, DictSource } from './types'
import { getTranslations, lookupBilingual, lookupWiktionaryOffline, translationLang } from './wiktionary'
import { getDictMeta, lookupWordNet, normalizeQuery, queryVariants, similarWords } from './wordnet'

export * from './types'
export { normalizeQuery, similarWords, suggestWords, getDictMeta, loadWordList, type DictMeta } from './wordnet'

const LANG_NAMES = new Intl.DisplayNames(['en'], { type: 'language' })
export const languageName = (code: string) => {
  try {
    return LANG_NAMES.of(code) ?? code
  } catch {
    return code
  }
}

export const WIKTIONARY: DictSource = { id: 'wiktionary', name: 'Wiktionary', kind: 'offline' }
export const WORDNET: DictSource = { id: 'wordnet', name: 'WordNet', kind: 'offline' }
export const WIKTIONARY_WEB: DictSource = { id: 'wiktionary-web', name: 'Wiktionary.org', kind: 'online' }
export const WIKIPEDIA: DictSource = { id: 'wikipedia', name: 'Wikipedia', kind: 'online' }
export const ONLINE_SOURCES = [WIKTIONARY_WEB, WIKIPEDIA]
export type OnlineSourceId = 'wiktionary-web' | 'wikipedia'
export const isOnlineSource = (id: string): id is OnlineSourceId => ONLINE_SOURCES.some(s => s.id === id)

/** Built-in dictionaries that can be turned off in Settings (bilingual ones only when installed). */
export const getBuiltinSources = async (): Promise<(DictSource & { words: number; description: string })[]> => {
  const meta = await getDictMeta()
  const out = [
    { ...WIKTIONARY, words: (meta?.sources.wiktionary?.words ?? 0) - (meta?.sources.wiktionary?.redirects ?? 0), description: 'Definitions, usage labels, examples, forms, origins and pronunciation' },
    { ...WORDNET, words: meta?.sources.wordnet.words ?? 0, description: 'Concise definitions with synonyms and opposites (Princeton WordNet 3.1)' },
  ]
  for (const [lang, info] of Object.entries(meta?.sources.bilingual ?? {}) as [string, { words: number }][])
    out.push({ id: `bi-${lang}`, name: `English–${languageName(lang)}`, kind: 'offline', words: info.words, description: `English words explained in ${languageName(lang)} (${languageName(lang)} Wiktionary)` })
  return out
}

const pushUnique = (list: string[], ...words: (string | undefined)[]) => {
  for (const w of words) if (w && !list.includes(w)) list.push(w)
}

/** Offline lookups: built-in dictionaries plus enabled user (StarDict) dictionaries. */
export const lookupOffline = async (raw: string): Promise<DictResult[]> => {
  const query = normalizeQuery(raw)
  if (!query) return []
  const { dictDisabled, translateTo } = getSettings()
  const off = new Set(dictDisabled)
  const myLang = translateTo.split('-')[0]
  const [wk, wn, dicts, meta] = await Promise.all([
    off.has(WIKTIONARY.id) ? [] : lookupWiktionaryOffline(raw),
    off.has(WORDNET.id) ? [] : lookupWordNet(raw),
    getUserDicts().catch(() => []),
    getDictMeta(),
  ])
  // lemma hints for the other dictionaries: "ran" → "run"
  const words: string[] = []
  pushUnique(words, ...queryVariants(raw))
  for (const e of [...wk, ...wn]) pushUnique(words, e.word)

  const results: DictResult[] = []
  if (wk.length) {
    if (myLang !== 'en' && meta?.sources.translations?.[translationLang(myLang)]) {
      await Promise.all(wk.map(async (e: DictEntry) => {
        const senses = await getTranslations(myLang, e.word)
        if (senses?.length) e.translations = { lang: myLang, senses }
      }))
    }
    results.push({ source: WIKTIONARY, entries: wk })
  }
  const biId = `bi-${myLang}`
  if (meta?.sources.bilingual?.[myLang] && !off.has(biId)) {
    const entries = await lookupBilingual(myLang, words.slice(0, 4)).catch(() => [])
    if (entries.length) results.push({ source: { id: biId, name: languageName(myLang), kind: 'offline' }, entries })
  }
  if (wn.length) results.push({ source: WORDNET, entries: wn })

  for (const record of dicts.filter(d => d.enabled)) {
    try {
      const sd = getStarDict(record)
      let entries = await sd.lookup(query)
      if (!entries.length && query !== query.toLowerCase()) entries = await sd.lookup(query.toLowerCase())
      // try the lemmas the built-in dictionaries found (e.g. "went" → "go")
      for (const w of words) {
        if (entries.length) break
        if (w !== query.toLowerCase()) entries = await sd.lookup(w)
      }
      if (entries.length) results.push({ source: { id: record.id, name: record.name, kind: 'user' }, entries })
    } catch (e) {
      console.warn('Dictionary failed', record.name, e)
    }
  }
  return results
}

export const lookupOnline = async (raw: string, source: OnlineSourceId, lang?: string, signal?: AbortSignal): Promise<DictResult | null> => {
  if (!getSettings().onlineLookup) return null
  const query = normalizeQuery(raw)
  const entries = source === 'wiktionary-web'
    ? await lookupWiktionary(query, lang, signal)
    : await lookupWikipedia(query, lang, signal)
  return entries.length ? { source: source === 'wiktionary-web' ? WIKTIONARY_WEB : WIKIPEDIA, entries } : null
}

export const didYouMean = (raw: string) => similarWords(raw)

const HISTORY_KEY = 'lumen-lookup-history'
export const getLookupHistory = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
  } catch {
    return []
  }
}
export const addLookupHistory = (word: string) => {
  const w = normalizeQuery(word)
  if (!w) return
  const list = [w, ...getLookupHistory().filter(x => x.toLowerCase() !== w.toLowerCase())].slice(0, 100)
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list))
  } catch { /* storage unavailable */ }
}
export const clearLookupHistory = () => {
  try {
    localStorage.removeItem(HISTORY_KEY)
  } catch { /* storage unavailable */ }
}
