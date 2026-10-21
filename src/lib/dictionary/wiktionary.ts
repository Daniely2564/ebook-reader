// Offline English Wiktionary (distilled by scripts/distill-wiktionary.mjs), plus
// English→native-language dictionaries and translation lists from the same project.
import { ShardSource } from './shards'
import { POS_LABEL, type DictEntry, type Meaning, type Sense } from './types'
import { inWordNet, irregularBases, lemmaCandidates, normalizeQuery, queryVariants, spellingVariants, stemOf } from './wordnet'

type WkSense = { g: string; l?: string; x?: string[]; s?: string[]; a?: string[]; f?: string; n?: string }
type WkGroup = { p: string; s: WkSense[]; w?: string; i?: string[]; sy?: string[]; an?: string[]; lo?: 1 }
/** An entry in the distilled format (Wiktionary, the bilingual dictionaries, Webster's). */
export type WkEntry = { m?: WkGroup[]; i?: string[]; a?: string; e?: string[]; r?: [string, string][] }

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
  if (pos === 'a' || pos === 'r') return /est$/.test(word) ? 'superlative' : 'comparative'
  if (/ing$/.test(word)) return 'present participle'
  if (/[^s]s$/.test(word)) return 'third-person singular'
  // irregular verbs: went, felt, sung
  return 'past tense'
}

const toSense = (s: WkSense): Sense => ({
  def: s.g,
  examples: s.x ?? [],
  synonyms: s.s ?? [],
  antonyms: s.a ?? [],
  typeOf: [],
  label: s.l,
  formOf: targetOf(s),
  note: s.n,
})

// Case only says something when it isn't the usual sentence or title case: "RAN", "iPod".
const meaningfulCase = (original: string) =>
  original !== 'I' && (original === original.toLowerCase() || /^(?:\p{Lu}[^\p{Lu}\s]*\s?)+$/u.test(original)) ? '' : original

// exact-case groups first ("RAN" for RAN), then lowercase ones, then other spellings ("GO" under go)
const rank = (g: WkGroup, casing: string) => ((g.w ?? '') === casing ? 0 : g.w ? 2 : 1)

export const toEntry = (word: string, raw: WkEntry, groups = raw.m ?? [], casing = ''): DictEntry => ({
  word,
  ipa: raw.i?.[0],
  ipaAlt: raw.i?.[1],
  audio: raw.a ? COMMONS + raw.a : undefined,
  etymology: raw.e,
  meanings: groups
    .map((g, i) => [g, rank(g, casing), i] as const)
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([g]): Meaning => ({
      pos: POS_LABEL[g.p] ?? g.p,
      display: g.w,
      forms: g.i?.filter(f => /\p{L}/u.test(f)),
      synonyms: g.sy,
      antonyms: g.an,
      minor: g.lo ? true : undefined,
      senses: g.s.map(toSense),
    })),
})

// senses not worth leading a reader to another headword
const MINOR = /obsolete|archaic|dated|rare|nonstandard|dialect|misspelling|eye dialect/i
// archaic inflections still lead somewhere useful ("hath" → have); obsolete spellings don't
const MINOR_INFLECTION = /obsolete|misspelling|nonstandard|dialect/i
const isMinor = (s: WkSense) => (INFLECTED_FORM.test(s.g) ? MINOR_INFLECTION : MINOR).test(`${s.l ?? ''} ${s.g}`)
const splitTargets = (t: string) => t.toLowerCase().split(/\s*,\s*|\s+(?:and|or)\s+/).filter(Boolean)

export const lookupWiktionaryOffline = async (raw: string): Promise<DictEntry[]> => {
  const variants = queryVariants(raw)
  const stem = stemOf(variants)
  const casing = meaningfulCase(normalizeQuery(raw))
  const irregular = stem ? await irregularBases(stem) : []
  const results: DictEntry[] = []
  const seen = new Set<string>()

  // The entry a form points at, following one more hop for e.g. "colours" → "colour" → "color".
  // Every headword passed through is added to `via`.
  const resolve = async (target: string, from: string, relation: string | undefined, out: DictEntry[], via = new Set<string>(), hops = 1): Promise<boolean> => {
    const key = target.toLowerCase()
    via.add(key)
    if (seen.has(key)) return true
    const e = await wiktionary.get(key)
    if (!e) {
      // "comparative degree of good and well"
      const parts = splitTargets(key)
      if (parts.length < 2) return false
      let found = false
      for (const part of parts.slice(0, 2)) found = await resolve(part, from, relation, out, via, hops) || found
      return found
    }
    if (e.r) return hops > 0 && resolve(e.r[0][0], from, relation ?? relationName(e.r[0][1]), out, via, hops - 1)
    const groups = e.m ?? []
    if (hops > 0 && groups.length && groups.every(g => g.s.every(isFormSense))) {
      const s = groups[0].s[0]
      return resolve(targetOf(s)!, from, relation ?? relationOf(s), out, via, hops - 1)
    }
    seen.add(key)
    out.push({ ...toEntry(key, e), formOf: from, relation })
    return true
  }

  // "goes" is listed as the plural of the noun "go", but go is mostly a verb
  const relationFor = async (word: string, base: string, pos: string) => {
    if (pos === 'n' && /s$/.test(word) && (await wiktionary.get(base))?.m?.find(g => !g.w)?.p === 'verb') pos = 'v'
    return inflectionName(word, pos)
  }

  // irregular base forms ("children" → child, "felt" → feel)
  const resolveIrregular = async (from: string, out: DictEntry[], via: Set<string>) => {
    for (const { base, pos } of irregular) {
      if (out.length >= 2) break
      await resolve(base, from, await relationFor(from, base, pos), out, via)
    }
  }

  let primary = true
  for (const v of variants) {
    if (seen.has(v)) continue
    const e = await wiktionary.get(v)
    if (!e) continue
    const lemmaHunt = primary
    primary = false
    if (e.r) {
      // form-only headword: show the standard lemma, or else what the redirect points at
      const before = results.length
      if (lemmaHunt) await resolveIrregular(v, results, new Set())
      if (results.length > before) continue
      const [first, ...others] = e.r
      await resolve(first[0], v, relationName(first[1]), results)
      for (const [t, rel] of others) if (INFLECTED_FORM.test(rel)) await resolve(t, v, relationName(rel), results)
      continue
    }
    seen.add(v)
    const groups = e.m ?? []
    const lemmas: DictEntry[] = []
    const via = new Set<string>()
    // "ran" → run, "felt" → feel, "leaves" → leaf: show the lemmas, and keep only the word's own meanings
    const lead = groups[0]?.s[0]
    const leadsWithForm = !!lead && isFormSense(lead) && !isMinor(lead)
    if (lemmaHunt) {
      const follow: WkSense[] = leadsWithForm ? [lead] : []
      for (const g of groups) {
        // "Said" (Sayyid) and "WAs" don't explain "said" and "was"
        if (g.w && g.w !== casing) continue
        const s = g.s.find(x => isFormSense(x) && INFLECTED_FORM.test(x.g) && !isMinor(x))
        if (s && !follow.some(f => targetOf(f) === targetOf(s))) follow.push(s)
      }
      for (const s of follow) {
        if (lemmas.length >= 2) break
        await resolve(targetOf(s)!, v, relationOf(s), lemmas, via)
      }
      await resolveIrregular(v, lemmas, via)
    }
    // drop senses that just point at a lemma shown here
    const shown = (s: WkSense) => isFormSense(s) && splitTargets(targetOf(s)!).some(t => via.has(t))
    const own = groups
      .map(g => (lemmas.length ? { ...g, s: g.s.filter(s => !shown(s)) } : g))
      .filter(g => g.s.length)
    const entry = own.length ? [toEntry(v, e, own, casing)] : []
    // the lemma leads when the word is mainly a form of it ("ran", "felt"), not for "number" → numb
    const lemmaFirst = leadsWithForm || lemmas.some(l => irregular.some(c => c.base === l.word))
    results.push(...(lemmaFirst ? [...lemmas, ...entry] : [...entry, ...lemmas]))
  }

  // other spellings ("well known" → well-known, "realise" → realize), then base forms
  if (!results.length && stem) {
    for (const v of spellingVariants(stem)) {
      const e = await wiktionary.get(v)
      if (e?.m) {
        results.push(toEntry(v, e, e.m, casing))
        seen.add(v)
        break
      }
      if (e?.r && await resolve(e.r[0][0], v, relationName(e.r[0][1]), results)) break
    }
  }
  if (!results.length && stem) {
    // "does" → do (not doe), "tries" → try (not trie): irregular forms, then real lemmas
    // (in WordNet), then the longest suffix rule
    const scored = new Map<string, { pos: string; score: number }>()
    for (const c of await lemmaCandidates(stem)) {
      if (c.base === stem || seen.has(c.base)) continue
      const e = await wiktionary.get(c.base)
      if (!e || !(e.r || e.m?.some(g => g.p === POS_OF[c.pos] && !g.s.every(isFormSense)))) continue
      const score = (c.irregular ? 100 : 0) + (await inWordNet(c.base, c.pos) ? 10 : 0) + c.suffix
      const prev = scored.get(c.base)
      if (!prev || score > prev.score) scored.set(c.base, { pos: c.pos, score })
    }
    const ranked = [...scored].sort((a, b) => b[1].score - a[1].score)
    for (const [base, { pos, score }] of ranked) {
      // a second lemma only when it is irregular too ("leaves" → leaf, leave)
      if (results.length && (score < 100 || results.length >= 2)) break
      await resolve(base, stem, await relationFor(stem, base, pos), results)
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

// translation lists ("run" → 달리다, 뛰다) from the English Wiktionary; each language refers
// to the English sense labels in tr/labels by index
const translations = new Map<string, ShardSource<[number, string[]][]>>()
const translationLabels = new ShardSource<string[]>('dict/tr/labels', 8, 1)

/** Wiktionary language code for an app language code. */
export const translationLang = (lang: string) => (lang.startsWith('zh') ? 'cmn' : lang.split('-')[0])

export const getTranslations = async (lang: string, word: string): Promise<[string, string[]][] | undefined> => {
  const code = translationLang(lang)
  let src = translations.get(code)
  if (!src) translations.set(code, src = new ShardSource(`dict/tr/${code}`, 8, 1))
  const key = word.toLowerCase()
  const rows = await src.get(key)
  if (!rows?.length) return undefined
  const labels = (await translationLabels.get(key)) ?? []
  return rows.map(([i, words]) => [labels[i] ?? '', words])
}
