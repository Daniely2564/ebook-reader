// Offline Webster's Revised Unabridged Dictionary (1913, public domain), parsed into the
// distilled Wiktionary format by scripts/webster.mjs.
import { ShardSource } from './shards'
import type { DictEntry } from './types'
import { toEntry, type WkEntry } from './wiktionary'
import { lemmaCandidates, queryVariants, stemOf } from './wordnet'

const webster = new ShardSource<WkEntry>('dict/wb')

/**
 * Webster's entries for a query. `found` are the other built-in dictionaries' results:
 * their headwords, in their order, say which lemma to show ("ran" → run) and whether the
 * word's own entry comes first.
 */
export const lookupWebster = async (raw: string, found: DictEntry[]): Promise<DictEntry[]> => {
  const variants = queryVariants(raw)
  const wanted: { word: string; formOf?: string; relation?: string }[] = []
  const add = (word: string, formOf?: string, relation?: string) => {
    if (!wanted.some(w => w.word === word)) wanted.push({ word, formOf, relation })
  }
  for (const e of found) add(e.word.toLowerCase(), e.formOf, e.relation)
  for (const v of variants) add(v)

  const out: DictEntry[] = []
  for (const { word, formOf, relation } of wanted) {
    if (out.length >= 3) break
    const e = await webster.get(word)
    if (e?.m) out.push({ ...toEntry(word, e), formOf: formOf && formOf !== word ? formOf : undefined, relation })
  }
  // inflections the other dictionaries didn't explain: "abhorred" → abhor
  const stem = stemOf(variants)
  if (!out.length && stem) {
    for (const { base } of await lemmaCandidates(stem)) {
      if (base === stem) continue
      const e = await webster.get(base)
      if (e?.m) {
        out.push({ ...toEntry(base, e), formOf: stem })
        break
      }
    }
  }
  return out
}
