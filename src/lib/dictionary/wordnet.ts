// Offline English dictionary (WordNet 3.1 + CMU pronunciations), compiled by
// scripts/build-dictionary.mjs into small gzip shards loaded on demand.
import { gunzipSync, strFromU8 } from 'fflate'
import { publicUrl } from '../platform'
import { POS_LABEL, type DictEntry, type Meaning } from './types'

type RawSense = [string, string[], string[]?, string[]?, string[]?]
type RawEntry = { i?: string; m: [string, RawSense[]][] }
type Shard = Record<string, RawEntry>

export interface WordNetMeta {
  name: string
  words: number
  withPronunciation: number
  bytes: number
}

const shardCache = new Map<string, Promise<Shard>>()
const MAX_SHARDS = 48

export const shardKey = (word: string) => {
  const s = word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  let k = ''
  for (const ch of s) {
    if (k.length === 2) break
    k += /[a-z0-9]/.test(ch) ? ch : '_'
  }
  return k.padEnd(2, '_')
}

const fetchBytes = async (path: string) => {
  const res = await fetch(publicUrl(path))
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return new Uint8Array(await res.arrayBuffer())
}

const loadShard = (key: string) => {
  let p = shardCache.get(key)
  if (p) {
    // refresh LRU position
    shardCache.delete(key)
    shardCache.set(key, p)
    return p
  }
  p = fetchBytes(`dict/s/${key}.bin`)
    .then(bytes => JSON.parse(strFromU8(gunzipSync(bytes))) as Shard)
    .catch(() => ({}) as Shard)
  shardCache.set(key, p)
  if (shardCache.size > MAX_SHARDS) shardCache.delete(shardCache.keys().next().value!)
  return p
}

let excPromise: Promise<Record<string, Record<string, string[]>>> | null = null
const loadExceptions = () => excPromise ??= fetch(publicUrl('dict/exc.json'))
  .then(r => r.json())
  .catch(() => ({}))

let metaPromise: Promise<WordNetMeta | null> | null = null
export const getWordNetMeta = () => metaPromise ??= fetch(publicUrl('dict/meta.json'))
  .then(r => (r.ok ? r.json() : null))
  .catch(() => null)

let wordsPromise: Promise<string[]> | null = null
export const loadWordList = () => wordsPromise ??= fetch(publicUrl('dict/words.txt'))
  .then(r => r.text())
  .then(t => t.split('\n'))
  .catch(() => [])

const getRaw = async (word: string) => (await loadShard(shardKey(word)))[word]

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

/** Cleans up a selection into a dictionary query. */
export const normalizeQuery = (raw: string) => raw
  .normalize('NFC')
  .replace(/­/g, '') // soft hyphens
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[‐-―]/g, '-')
  .replace(/^[\s"'([{<«‹*_]+|[\s"')\]}>»›*_.,;:!?…]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim()

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

export const lookupWordNet = async (raw: string): Promise<DictEntry[]> => {
  const query = normalizeQuery(raw)
  if (!query || query.length > 80) return []
  let word = query.toLowerCase()
  const results: DictEntry[] = []
  const seen = new Set<string>()
  const add = (w: string, e: RawEntry, formOf?: string) => {
    if (seen.has(w)) return
    seen.add(w)
    results.push(toEntry(w, e, formOf))
  }

  // archaic contractions keep their leading apostrophe: 'tis, 'twas
  const apos = raw.trim().replace(/[\u2018\u2019\u02bc]/g, "'").toLowerCase()
  // possessives: "Darcy's" → "darcy"
  word = word.replace(/'s$|s'$/, m => (m === "s'" ? 's' : ''))
  const variants = /^'[a-z]+$/.test(apos) ? [apos, word] : [word]
  if (word.includes('-')) variants.push(word.replace(/-/g, ' '), word.replace(/-/g, ''))
  if (word.includes(' ')) variants.push(word.replace(/ /g, '-'))
  // British -ise/-our spellings that WordNet lacks
  if (/is(e|ed|es|ing|ation)$/.test(word)) variants.push(word.replace(/is(e|ed|es|ing|ation)$/, 'iz$1'))
  if (/our$/.test(word)) variants.push(word.replace(/our$/, 'or'))

  for (const v of variants) {
    const e = await getRaw(v)
    if (e) add(v, e)
  }
  // inflections: "running" → "run", "geese" → "goose"
  for (const v of variants.slice(0, 1)) {
    for (const { base, pos } of await lemmaCandidates(v)) {
      if (base === v || seen.has(base)) continue
      const e = await getRaw(base)
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

