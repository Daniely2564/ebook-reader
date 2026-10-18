import { getUserDicts } from '../db'
import { getSettings } from '../settings'
import { lookupWikipedia, lookupWiktionary } from './online'
import { getStarDict } from './stardict'
import type { DictResult, DictSource } from './types'
import { lookupWordNet, normalizeQuery, similarWords } from './wordnet'

export * from './types'
export { normalizeQuery, similarWords, suggestWords, getWordNetMeta, loadWordList } from './wordnet'

export const WORDNET: DictSource = { id: 'wordnet', name: 'English Dictionary', kind: 'offline' }
export const WIKTIONARY: DictSource = { id: 'wiktionary', name: 'Wiktionary', kind: 'online' }
export const WIKIPEDIA: DictSource = { id: 'wikipedia', name: 'Wikipedia', kind: 'online' }

/** Offline lookups: built-in dictionary plus enabled user (StarDict) dictionaries. */
export const lookupOffline = async (raw: string): Promise<DictResult[]> => {
  const query = normalizeQuery(raw)
  if (!query) return []
  const results: DictResult[] = []
  const [wn, dicts] = await Promise.all([lookupWordNet(query), getUserDicts().catch(() => [])])
  if (wn.length) results.push({ source: WORDNET, entries: wn })

  for (const record of dicts.filter(d => d.enabled)) {
    try {
      const sd = getStarDict(record)
      let entries = await sd.lookup(query)
      if (!entries.length && query !== query.toLowerCase()) entries = await sd.lookup(query.toLowerCase())
      // try the lemma the built-in dictionary found (e.g. "went" → "go")
      if (!entries.length && wn[0]?.formOf) entries = await sd.lookup(wn[0].word)
      if (entries.length) results.push({ source: { id: record.id, name: record.name, kind: 'user' }, entries })
    } catch (e) {
      console.warn('Dictionary failed', record.name, e)
    }
  }
  return results
}

export const lookupOnline = async (raw: string, source: 'wiktionary' | 'wikipedia', lang?: string, signal?: AbortSignal): Promise<DictResult | null> => {
  if (!getSettings().onlineLookup) return null
  const query = normalizeQuery(raw)
  const entries = source === 'wiktionary'
    ? await lookupWiktionary(query, lang, signal)
    : await lookupWikipedia(query, lang, signal)
  return entries.length ? { source: source === 'wiktionary' ? WIKTIONARY : WIKIPEDIA, entries } : null
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
