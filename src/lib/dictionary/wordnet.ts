// Offline English WordNet (3.1, with CMU pronunciations) plus the lookup helpers
// shared by all built-in dictionaries: query cleanup, lemmatization, word list.
import { fetchGz, ShardSource } from './shards'
import { POS_LABEL, type DictEntry, type Meaning } from './types'
import { publicUrl } from '../platform'

type RawSense = [string, string[], string[]?, string[]?, string[]?]
type RawEntry = { i?: string; m: [string, RawSense[]][] }

export interface DictMeta {
  words: number
  withPronunciation: number
  bytes: number
  sources: {
    wordnet: { words: number }
    wiktionary?: { words: number; redirects: number }
    bilingual?: Record<string, { words: number }>
    translations?: Record<string, { words: number }>
  }
}

const wordnet = new ShardSource<RawEntry>('dict/wn')

let excPromise: Promise<Record<string, Record<string, string[]>>> | null = null
const loadExceptions = () => excPromise ??= fetch(publicUrl('dict/exc.json'))
  .then(r => r.json())
  .catch(() => ({}))

let metaPromise: Promise<DictMeta | null> | null = null
export const getDictMeta = () => metaPromise ??= fetch(publicUrl('dict/meta.json'))
  .then(r => (r.ok ? r.json() : null))
  .catch(() => null)

let wordsPromise: Promise<string[]> | null = null
export const loadWordList = () => wordsPromise ??= fetchGz('dict/words.bin')
  .then(t => t.split('\n'))
  .catch(() => [])

const toEntry = (word: string, raw: RawEntry, formOf?: string): DictEntry => ({
  word,
  ipa: raw.i,
  formOf,
  meanings: raw.m.map(([pos, senses]): Meaning => ({
    pos: POS_LABEL[pos] ?? pos,
    senses: senses.map(([def, examples, synonyms = [], antonyms = [], typeOf = []]) =>
      ({ def, examples, synonyms, antonyms, typeOf })),
  })),
})

// WordNet "morphy" detachment rules
const RULES: Record<string, [string, string][]> = {
  n: [['s', ''], ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'], ['men', 'man'], ['ies', 'y']],
  v: [['s', ''], ['ies', 'y'], ['es', 'e'], ['es', ''], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', '']],
  a: [['er', ''], ['est', ''], ['er', 'e'], ['est', 'e']],
  r: [],
}

// archaic elisions that keep their leading apostrophe: 'tis, 'twas, 'gainst, 'em
const ELISION = /^'(?:t(?:is|was|were|will|would|wixt)|tween|gainst|neath|em|mid(?:st)?|round|cause|til|bout|fore|n)$/i
export const isElision = (word: string) => ELISION.test(word.replace(/[‘’ʼ]/g, "'"))

/** Cleans up a selection into a dictionary query. */
export const normalizeQuery = (raw: string) => {
  const s = raw
    .normalize('NFC')
    .replace(/\u00ad/g, '') // soft hyphens
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  const trimmed = s.replace(/^[\s"'([{<«‹*_]+|[\s"')\]}>»›*_.,;:!?…]+$/g, '')
  const elided = s.replace(/^["([{<«‹*_]+|[\s"')\]}>»›*_.,;:!?…]+$/g, '')
  return ELISION.test(elided) ? elided : trimmed
}

/** Base-form candidates for an inflected word, most likely first. */
export const lemmaCandidates = async (word: string) => {
  const exc = await loadExceptions()
  const out: { base: string; pos: string }[] = []
  for (const pos of ['n', 'v', 'a', 'r']) {
    for (const base of exc[pos]?.[word] ?? []) out.push({ base, pos })
    for (const [suffix, repl] of RULES[pos]) {
      if (word.length > suffix.length + 1 && word.endsWith(suffix))
        out.push({ base: word.slice(0, -suffix.length) + repl, pos })
    }
  }
  return out
}

/** Spelling variants of a query to try in order: case, possessives, hyphens, British spellings. */
export const queryVariants = (raw: string) => {
  const query = normalizeQuery(raw)
  if (!query || query.length > 80) return []
  // possessives: "Darcy's" → "darcy"
  const word = query.toLowerCase().replace(/'s$|s'$/, m => (m === "s'" ? 's' : ''))
  const variants = [word]
  if (word.startsWith("'")) variants.push(word.slice(1))
  // abbreviations keep their final period: "e.g.", "etc.", "Mr."
  if (/[a-z]\.[a-z]/.test(word)) variants.unshift(`${word}.`)
  else if (/\.\s*$/.test(raw)) variants.push(`${word}.`)
  if (word.includes('-')) variants.push(word.replace(/-/g, ' '), word.replace(/-/g, ''))
  if (word.includes(' ')) variants.push(word.replace(/ /g, '-'))
  if (/is(e|ed|es|ing|ation)$/.test(word)) variants.push(word.replace(/is(e|ed|es|ing|ation)$/, 'iz$1'))
  if (/our$/.test(word)) variants.push(word.replace(/our$/, 'or'))
  return [...new Set(variants.filter(Boolean))]
}

export const lookupWordNet = async (raw: string): Promise<DictEntry[]> => {
  const variants = queryVariants(raw)
  const results: DictEntry[] = []
  const seen = new Set<string>()
  const add = (w: string, e: RawEntry, formOf?: string) => {
    if (seen.has(w)) return
    seen.add(w)
    results.push(toEntry(w, e, formOf))
  }
  for (const v of variants) {
    const e = await wordnet.get(v)
    if (e) add(v, e)
  }
  // inflections: "running" → "run", "geese" → "goose"
  for (const v of variants.slice(0, 1)) {
    for (const { base, pos } of await lemmaCandidates(v)) {
      if (base === v || seen.has(base)) continue
      const e = await wordnet.get(base)
      if (e && e.m.some(([p]) => p === pos || (pos === 'a' && p === 's'))) add(base, e, v)
    }
  }
  return results
}

export const suggestWords = async (prefix: string, limit = 8) => {
  const words = await loadWordList()
  const p = prefix.toLowerCase().trim()
  if (!p) return []
  let lo = 0
  let hi = words.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (words[mid] < p) lo = mid + 1
    else hi = mid
  }
  const out: string[] = []
  for (let i = lo; i < words.length && out.length < limit && words[i].startsWith(p); i++) out.push(words[i])
  return out
}

const editDistance = (a: string, b: string, max: number) => {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      best = Math.min(best, cur[j])
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/** "Did you mean…" suggestions for a word that isn't in the dictionary. */
export const similarWords = async (word: string, limit = 6) => {
  const words = await loadWordList()
  const w = normalizeQuery(word).toLowerCase()
  if (w.length < 3) return []
  const max = w.length <= 4 ? 1 : 2
  const scored: [string, number][] = []
  for (const cand of words) {
    if (cand[0] !== w[0] && cand[1] !== w[1]) continue
    if (cand.length < 3) continue
    const d = editDistance(w, cand, max)
    if (d <= max) scored.push([cand, d])
  }
  return scored.sort((a, b) => a[1] - b[1] || a[0].length - b[0].length).slice(0, limit).map(([c]) => c)
}

