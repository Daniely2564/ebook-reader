#!/usr/bin/env node
// One-time helper: distills English closed-class words (articles, pronouns,
// prepositions, conjunctions, determiners, particles, interjections and
// contractions) from Wiktionary extracts published by kaikki.org into
// scripts/data/wiktionary-closed-class.json. WordNet only covers nouns, verbs,
// adjectives and adverbs, so this fills the gap for words like "the", "whom",
// "amid", "thee" or "'tis".
//
// Usage: download the JSONL files below into a folder, then
//   node scripts/distill-wiktionary.mjs <folder>
// https://kaikki.org/dictionary/English/pos-<pos>/kaikki.org-dictionary-English-by-pos-<pos>.jsonl
// for <pos> in: article conj det pron prep particle intj contraction
//
// Wiktionary content is available under CC BY-SA 4.0 (attribution in LICENSES).
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createRequire } from 'node:module'

const dir = process.argv[2]
if (!dir) throw new Error('usage: distill-wiktionary.mjs <folder with kaikki jsonl files>')
const require = createRequire(import.meta.url)
const { dictionary: cmu } = await import(path.join(path.dirname(require.resolve('cmu-pronouncing-dictionary/package.json')), 'index.js'))

const POS = ['article', 'pron', 'prep', 'conj', 'det', 'particle', 'contraction', 'intj']
const SKIP_TAGS = new Set(['obsolete', 'Internet', 'slang', 'vulgar', 'offensive', 'nonstandard', 'misspelling', 'proscribed', 'pronunciation-spelling', 'eye-dialect'])
const LABEL_TAGS = ['archaic', 'dated', 'poetic', 'formal', 'informal', 'colloquial', 'dialectal', 'rare', 'literary', 'British', 'US', 'Scotland']

const glossOf = glosses => {
  if (!glosses?.length) return ''
  let g = glosses[glosses.length - 1]
  if (g.startsWith('...') && glosses.length > 1) g = glosses[glosses.length - 2].replace(/\.\.\.$/, '') + ' ' + g.replace(/^\.\.\./, '')
  return g.replace(/\s+/g, ' ').trim()
}

const out = {}
let count = 0
for (const pos of POS) {
  const file = path.join(dir, `${pos}.jsonl`)
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    const d = JSON.parse(line)
    const word = d.word?.replace(/’/g, "'")
    if (d.lang_code !== 'en' || !word || word.length > 24 || word !== word.toLowerCase()) continue
    if (!/^[a-z' -]+$/.test(word) || word.split(' ').length > 3) continue
    // keep interjections/contractions to common words
    if ((pos === 'intj' || pos === 'contraction') && !cmu[word] && !cmu[word.replace(/'/g, '')]) continue
    const senses = []
    for (const s of d.senses ?? []) {
      const tags = s.tags ?? []
      if (tags.some(t => SKIP_TAGS.has(t)) && !tags.includes('archaic')) continue
      let gloss = glossOf(s.glosses)
      if (!gloss || gloss.length > 400) continue
      const labels = LABEL_TAGS.filter(t => tags.includes(t))
      if (labels.length) gloss = `(${labels.join(', ').toLowerCase()}) ${gloss}`
      const ex = s.examples?.map(e => e.text).find(t => t && t.length < 180 && !/^\d{4}/.test(t))
      senses.push(ex ? [gloss, ex] : [gloss])
    }
    if (!senses.length) continue
    const entry = out[word] ??= {}
    const ipa = d.sounds?.find(s => s.ipa?.startsWith('/'))?.ipa
    if (ipa && !entry.i) entry.i = ipa.replace(/^\/|\/$/g, '')
    const list = entry[pos] ??= []
    for (const s of senses) if (list.length < 6 && !list.some(x => x[0] === s[0])) list.push(s)
    count++
  }
}
const target = path.join(path.dirname(new URL(import.meta.url).pathname), 'data', 'wiktionary-closed-class.json')
fs.writeFileSync(target, JSON.stringify(out))
console.log(`${Object.keys(out).length} words from ${count} entries → ${target} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`)
