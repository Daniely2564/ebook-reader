// Offline English Wiktionary (distilled by scripts/distill-wiktionary.mjs), plus
// English→native-language dictionaries and translation lists from the same project.
import { fetchGz, ShardSource } from './shards'
import { POS_LABEL, type DictEntry, type Meaning, type Sense } from './types'
import { lemmaCandidates, queryVariants } from './wordnet'

type WkSense = { g: string; l?: string; x?: string[]; s?: string[]; a?: string[]; f?: string }
type WkGroup = { p: string; s: WkSense[]; w?: string; i?: string[]; sy?: string[]; an?: string[] }
type WkEntry = { m?: WkGroup[]; i?: string[]; a?: string; e?: string[]; r?: [string, string][] }

const COMMONS = 'https://upload.wikimedia.org/wikipedia/commons/'
const wiktionary = new ShardSource<WkEntry>('dict/wk')

// "Commonwealth standard spelling of color." → "color"
const ALT_OF = /\b(?:spelling|form) of ([^.;:()“”"]+?)\s*(?:\(“[^”]*”\))?\.?$/i
const INFLECTION = /\b(?:plural|past|participle|present|comparative|superlative|person|gerund|singular|inflection|spelling|form)\b/i
const NOT_LEMMA = /^(?:initialism|acronym|abbreviation|clipping|ellipsis|contraction|synonym|eye dialect)\b/i
const INFLECTED_FORM = /\b(?:plural|past|participle|present|comparative|superlative|person|gerund|singular)\b/i
const POS_OF: Record<string, string> = { n: 'noun', v: 'verb', a: 'adj', r: 'adv' }

const targetOf = (s: WkSense) => {
  if (s.f) return s.f
  const m = ALT_OF.exec(s.g)
  return m && m[1].split(' ').length <= 3 ? m[1] : undefined
}

/** A sense that just points at another headword ("simple past of run", "alternative form of café"). */
const isFormSense = (s: WkSense) => !!targetOf(s) && INFLECTION.test(s.g) && !NOT_LEMMA.test(s.g)

// "present participle and gerund of run" → "present participle and gerund"
const relationName = (text: string) => text.replace(/\s+(?:of|for)\s.*$/i, '').replace(/^./, c => c.toLowerCase())
const relationOf = (s: WkSense) => relationName(s.g)

const inflectionName = (word: string, pos: string) => {
  if (pos === 'n') return 'plural'
  if (pos === 'a') return /est$/.test(word) ? 'superlative' : 'comparative'
  if (/ing$/.test(word)) return 'present participle'
  if (/ed$/.test(word)) return 'past tense'
  if (/s$/.test(word)) return 'third-person singular'
  return 'inflection'
}

const toSense = (s: WkSense): Sense => ({
  def: s.g,
  examples: s.x ?? [],
  synonyms: s.s ?? [],
  antonyms: s.a ?? [],
  typeOf: [],
  label: s.l,
  formOf: targetOf(s),
})

// exact-case groups first ("RAN" for RAN), then lowercase ones, then other spellings ("GO" under go)
const rank = (g: WkGroup, original?: string) => (original && (g.w ?? '') === (original === original.toLowerCase() ? '' : original) ? 0 : g.w ? 2 : 1)

const toEntry = (word: string, raw: WkEntry, groups = raw.m ?? [], original?: string): DictEntry => ({
  word,
  ipa: raw.i?.[0],
  ipaAlt: raw.i?.[1],
  audio: raw.a ? COMMONS + raw.a : undefined,
  etymology: raw.e,
  meanings: groups
    .map((g, i) => [g, rank(g, original), i] as const)
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([g]): Meaning => ({
      pos: POS_LABEL[g.p] ?? g.p,
      display: g.w,
      forms: g.i?.filter(f => /\p{L}/u.test(f)),
      synonyms: g.sy,
      antonyms: g.an,
      senses: g.s.map(toSense),
    })),
})

const MINOR = /obsolete|archaic|rare|nonstandard|dialect|misspelling|eye dialect/

export const lookupWiktionaryOffline = async (raw: string): Promise<DictEntry[]> => {
  const variants = queryVariants(raw)
  const original = raw.trim()
  const results: DictEntry[] = []
  const seen = new Set<string>()

  // the entry a form points at, following one more hop for e.g. "colours" → "colour" → "color"
  const resolve = async (target: string, from: string, relation: string | undefined, out: DictEntry[], hops = 1): Promise<boolean> => {
    const key = target.toLowerCase()
    if (seen.has(key)) return true
    const e = await wiktionary.get(key)
    if (!e) {
      // "comparative degree of good and well"
      const parts = key.split(/\s*,\s*|\s+(?:and|or)\s+/).filter(Boolean)
      if (parts.length < 2) return false
      let found = false
      for (const part of parts.slice(0, 2)) found = await resolve(part, from, relation, out, hops) || found
      return found
    }
    if (e.r) return hops > 0 && resolve(e.r[0][0], from, relation ?? relationName(e.r[0][1]), out, hops - 1)
    const groups = e.m ?? []
    if (hops > 0 && groups.length && groups.every(g => g.s.every(isFormSense))) {
      const s = groups[0].s[0]
      return resolve(targetOf(s)!, from, relation ?? relationOf(s), out, hops - 1)
    }
    seen.add(key)
    out.push({ ...toEntry(key, e), formOf: from, relation })
    return true
  }

  let primary = true
  for (const v of variants) {
    if (seen.has(v)) continue
    const e = await wiktionary.get(v)
    if (!e) continue
    const lemmaHunt = primary
    primary = false
    if (e.r) {
      // form-only headword: show what it points at
      const [first, ...others] = e.r
      await resolve(first[0], v, relationName(first[1]), results)
      for (const [t, rel] of others) if (INFLECTED_FORM.test(rel)) await resolve(t, v, relationName(rel), results)
      continue
    }
    seen.add(v)
    const groups = e.m ?? []
    const lemmas: DictEntry[] = []
    // "ran" → run, "leaves" → leaf, leave: show the lemmas, and keep only the word's own meanings
    const leadsWithForm = !!groups[0]?.s[0] && isFormSense(groups[0].s[0])
    if (lemmaHunt) {
      const follow: WkSense[] = []
      if (leadsWithForm) follow.push(groups[0].s[0])
      for (const g of groups.slice(leadsWithForm ? 1 : 0)) {
        if (!g.s.every(isFormSense)) continue
        const s = g.s.find(x => !MINOR.test(x.l ?? '') && !follow.some(f => targetOf(f) === targetOf(x)))
        if (s && !follow.includes(s)) follow.push(s)
      }
      for (const s of follow) {
        if (lemmas.length >= 2) break
        await resolve(targetOf(s)!, v, relationOf(s), lemmas)
      }
    }
    // drop senses that just point at a lemma shown above
    const shown = (s: WkSense) => isFormSense(s) && lemmas.some(l => targetOf(s)!.toLowerCase().split(/\s*,\s*|\s+(?:and|or)\s+/).includes(l.word))
    const own = groups
      .map(g => (lemmas.length ? { ...g, s: g.s.filter(s => !shown(s)) } : g))
      .filter(g => g.s.length)
    const entry = own.length ? [toEntry(v, e, own, original)] : []
    results.push(...(leadsWithForm ? [...lemmas, ...entry] : [...entry, ...lemmas]))
  }

  // nothing under the word itself: try its base forms ("geese" → goose, "cats" → cat)
  if (!results.length && variants[0]) {
    for (const { base, pos } of await lemmaCandidates(variants[0])) {
      if (seen.has(base)) continue
      const e = await wiktionary.get(base)
      if (!e) continue
      if (e.r || e.m?.some(g => g.p === POS_OF[pos])) {
        if (await resolve(base, variants[0], inflectionName(variants[0], pos), results)) break
      }
    }
  }
  return results
}

// English → native language dictionaries built from that language's Wiktionary
const bilingual = new Map<string, ShardSource<WkEntry>>()

export const lookupBilingual = async (lang: string, words: string[]): Promise<DictEntry[]> => {
  let src = bilingual.get(lang)
  if (!src) bilingual.set(lang, src = new ShardSource<WkEntry>(`dict/bi/${lang}`, 12))
  const out: DictEntry[] = []
  for (const w of [...new Set(words.map(x => x.toLowerCase()))]) {
    const e = await src.get(w)
    if (e?.m) out.push(toEntry(w, e))
  }
  return out
}

// translation lists ("run" → 달리다, 뛰다) from the English Wiktionary
const translations = new Map<string, Promise<Map<string, [string, string[]][]>>>()

/** Wiktionary language code for an app language code. */
export const translationLang = (lang: string) => (lang.startsWith('zh') ? 'cmn' : lang.split('-')[0])

export const getTranslations = async (lang: string, word: string) => {
  const code = translationLang(lang)
  let p = translations.get(code)
  if (!p) {
    p = fetchGz(`dict/tr/${code}.bin`)
      .then(t => new Map(Object.entries(JSON.parse(t) as Record<string, [string, string[]][]>)))
      .catch(() => new Map())
    translations.set(code, p)
  }
  return (await p).get(word.toLowerCase())
}
