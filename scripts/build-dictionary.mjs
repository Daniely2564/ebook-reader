#!/usr/bin/env node
// Compiles the offline English dictionary shipped with Lumen Reader.
//
// Sources (all redistributable, licenses copied next to the output):
//   - WordNet 3.1 (`wordnet-db`)           definitions, examples, synonyms…
//   - WordNet 3.0 exception lists          irregular forms (went → go)
//     (`wndb-with-exceptions`)
//   - CMU Pronouncing Dictionary           pronunciations, converted to IPA
//     (`cmu-pronouncing-dictionary`)
//   - Wiktionary (CC BY-SA 4.0)            articles, pronouns, prepositions,
//     scripts/data/wiktionary-closed-class  conjunctions… that WordNet lacks
//     (see distill-wiktionary.mjs)
//
// Output (public/dict/):
//   meta.json          build info
//   words.txt          sorted headword list (autocomplete / "did you mean")
//   exc.json           irregular inflections per part of speech
//   s/<xx>.bin         gzip'd JSON shards keyed by the first two letters
//
// Shard entry format (kept terse — this ships inside the app):
//   { "<word>": { "i": "<ipa>", "m": [[pos, [[definition, examples[], synonyms[], antonyms[], typeOf[]], …]], …] } }

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const VERSION = 4
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, 'public', 'dict')
const require = createRequire(import.meta.url)

if (process.argv.includes('--if-missing')) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'))
    if (meta.version === VERSION) process.exit(0)
  } catch { /* build it */ }
}

const wnDir = path.join(path.dirname(require.resolve('wordnet-db/package.json')), 'dict')
const excDir = path.join(path.dirname(require.resolve('wndb-with-exceptions/package.json')), 'dict')
const cmuDir = path.dirname(require.resolve('cmu-pronouncing-dictionary/package.json'))

const t0 = Date.now()
const POS_FILES = { n: 'noun', v: 'verb', a: 'adj', r: 'adv' }
const clean = w => w.replace(/_/g, ' ').replace(/\((a|p|ip)\)$/, '')

// ---------------------------------------------------------------- synsets
/** @type {Map<string, {words: string[], gloss: string, ptrs: [string, string, string, number, number][]}>} */
const synsets = new Map()
for (const [pos, file] of Object.entries(POS_FILES)) {
  const text = fs.readFileSync(path.join(wnDir, `data.${file}`), 'utf8')
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('  ')) continue
    const bar = line.indexOf(' | ')
    const head = line.slice(0, bar).split(' ')
    const gloss = line.slice(bar + 3).trim()
    const offset = head[0]
    const wCnt = parseInt(head[3], 16)
    const words = []
    let i = 4
    for (let k = 0; k < wCnt; k++, i += 2) words.push(clean(head[i]))
    const pCnt = parseInt(head[i++], 10)
    const ptrs = []
    for (let k = 0; k < pCnt; k++, i += 4) {
      const st = head[i + 3]
      ptrs.push([head[i], head[i + 1], head[i + 2] === 's' ? 'a' : head[i + 2],
        parseInt(st.slice(0, 2), 16), parseInt(st.slice(2), 16)])
    }
    synsets.set(`${pos}${offset}`, { words, gloss, ptrs })
  }
}

const parseGloss = gloss => {
  const examples = []
  const def = gloss
    .replace(/;?\s*"([^"]*)"\s*(?:-+\s*[^;"]*)?/g, (_, ex) => {
      if (ex.trim()) examples.push(ex.trim())
      return ''
    })
    .replace(/[;\s]+$/, '')
    .trim()
  return { def, examples }
}

// ---------------------------------------------------------------- pronunciations
const ARPA = {
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ', B: 'b', CH: 'tʃ', D: 'd', DH: 'ð',
  EH: 'ɛ', ER: 'ɝ', EY: 'eɪ', F: 'f', G: 'ɡ', HH: 'h', IH: 'ɪ', IY: 'i', JH: 'dʒ', K: 'k',
  L: 'l', M: 'm', N: 'n', NG: 'ŋ', OW: 'oʊ', OY: 'ɔɪ', P: 'p', R: 'r', S: 's', SH: 'ʃ',
  T: 't', TH: 'θ', UH: 'ʊ', UW: 'u', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
}
const ONSETS = new Set(['pl', 'pr', 'tr', 'dr', 'kl', 'kr', 'kw', 'ɡl', 'ɡr', 'ɡw', 'bl', 'br', 'fl', 'fr',
  'θr', 'ʃr', 'sp', 'st', 'sk', 'sm', 'sn', 'sw', 'sl', 'sf', 'tw', 'dw', 'θw', 'spl', 'spr', 'str', 'skr',
  'skw', 'pj', 'bj', 'kj', 'ɡj', 'mj', 'fj', 'vj', 'hj', 'nj', 'lj', 'spj', 'skj'])
const arpaToIpa = arpa => {
  const ph = arpa.split(' ').map(p => {
    const m = p.match(/^([A-Z]+)([012])?$/)
    if (!m) return null
    const [, base, stress] = m
    let sym = ARPA[base]
    if (!sym) return null
    if (base === 'AH' && stress === '0') sym = 'ə'
    if (base === 'ER' && stress === '0') sym = 'ɚ'
    return { sym, vowel: stress != null, stress }
  })
  if (ph.some(p => !p)) return null
  const vowels = ph.filter(p => p.vowel).length
  const marks = new Map()
  if (vowels > 1) for (let i = 0; i < ph.length; i++) {
    const s = ph[i].stress
    if (s !== '1' && s !== '2') continue
    // walk back over the longest legal onset
    let j = i
    while (j > 0 && !ph[j - 1].vowel) {
      const cluster = ph.slice(j - 1, i).map(p => p.sym).join('')
      if (j - 1 === i - 1 ? ph[j - 1].sym !== 'ŋ' : ONSETS.has(cluster)) j--
      else break
    }
    // never put a mark between a vowel and the start of the word for word-initial consonants
    marks.set(j, s === '1' ? 'ˈ' : 'ˌ')
  }
  return ph.map((p, i) => (marks.get(i) ?? '') + p.sym).join('')
}
const { dictionary: cmu } = await import(path.join(cmuDir, 'index.js'))
const ipaFor = word => {
  const parts = word.split(/[\s-]+/)
  if (parts.length > 3) return null
  const res = []
  for (const part of parts) {
    const arpa = cmu[part]
    if (!arpa) return null
    const ipa = arpaToIpa(arpa)
    if (!ipa) return null
    res.push(ipa)
  }
  return res.join(' ')
}

// ---------------------------------------------------------------- entries
const entries = new Map()
for (const [pos, file] of Object.entries(POS_FILES)) {
  const text = fs.readFileSync(path.join(wnDir, `index.${file}`), 'utf8')
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('  ')) continue
    const f = line.trim().split(' ')
    const lemma = clean(f[0])
    const synCnt = parseInt(f[2], 10)
    const offsets = f.slice(f.length - synCnt)
    const senses = []
    for (const off of offsets) {
      const syn = synsets.get(`${pos}${off}`)
      if (!syn) continue
      const { def, examples } = parseGloss(syn.gloss)
      const lower = syn.words.map(w => w.toLowerCase())
      const self = lower.indexOf(lemma) + 1 // 1-based word number within the synset
      const synonyms = syn.words.filter((_, k) => lower[k] !== lemma).slice(0, 8)
      const antonyms = []
      const typeOf = []
      for (const [sym, tOff, tPos, src, dst] of syn.ptrs) {
        if (sym === '!' && (src === 0 || src === self)) {
          const t = synsets.get(`${tPos === 'a' ? 'a' : tPos}${tOff}`)
          const w = t && (dst ? t.words[dst - 1] : t.words[0])
          if (w && !antonyms.includes(w)) antonyms.push(w)
        } else if ((sym === '@' || sym === '@i') && !typeOf.length) {
          const t = synsets.get(`${tPos}${tOff}`)
          if (t) typeOf.push(...t.words.slice(0, 3))
        }
      }
      const sense = [def, examples.slice(0, 3)]
      if (synonyms.length || antonyms.length || typeOf.length) sense.push(synonyms)
      if (antonyms.length || typeOf.length) sense.push(antonyms)
      if (typeOf.length) sense.push(typeOf)
      senses.push(sense)
    }
    if (!senses.length) continue
    let entry = entries.get(lemma)
    if (!entry) entries.set(lemma, entry = { m: [] })
    const existing = entry.m.find(([p]) => p === pos)
    if (existing) existing[1].push(...senses)
    else entry.m.push([pos, senses])
  }
}

// closed-class words (the, whom, amid, 'tis…) from Wiktionary, listed first
const closed = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'data', 'wiktionary-closed-class.json'), 'utf8'))
const CLOSED_POS = ['article', 'pron', 'prep', 'conj', 'det', 'particle', 'contraction', 'intj']
for (const [word, data] of Object.entries(closed)) {
  let entry = entries.get(word)
  if (!entry) entries.set(word, entry = { m: [] })
  const extra = CLOSED_POS.filter(p => data[p]).map(p => [p, data[p].map(([def, ex]) => [def, ex ? [ex] : []])])
  entry.m.unshift(...extra)
  if (data.i) entry.wikiIpa = data.i
}

let withIpa = 0
for (const [word, entry] of entries) {
  const ipa = ipaFor(word) ?? entry.wikiIpa
  delete entry.wikiIpa
  if (ipa) {
    entry.i = ipa
    withIpa++
  }
}

// ---------------------------------------------------------------- write
export const shardKey = word => {
  const s = word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  let k = ''
  for (const ch of s) {
    if (k.length === 2) break
    k += /[a-z0-9]/.test(ch) ? ch : '_'
  }
  return k.padEnd(2, '_')
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 's'), { recursive: true })

const shards = new Map()
for (const [word, entry] of entries) {
  const key = shardKey(word)
  if (!shards.has(key)) shards.set(key, {})
  shards.get(key)[word] = { ...(entry.i ? { i: entry.i } : {}), m: entry.m }
}
let bytes = 0
for (const [key, data] of shards) {
  const gz = gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 })
  bytes += gz.length
  fs.writeFileSync(path.join(out, 's', `${key}.bin`), gz)
}

const words = [...entries.keys()].sort()
fs.writeFileSync(path.join(out, 'words.txt'), words.join('\n'))

const exc = {}
for (const [pos, file] of Object.entries(POS_FILES)) {
  exc[pos] = {}
  for (const line of fs.readFileSync(path.join(excDir, `${file}.exc`), 'utf8').split('\n')) {
    const [form, ...bases] = line.trim().split(' ').map(clean)
    if (form && bases.length) exc[pos][form] = bases
  }
}
fs.writeFileSync(path.join(out, 'exc.json'), JSON.stringify(exc))

fs.writeFileSync(path.join(out, 'LICENSES.txt'), [
  'Lumen Reader offline dictionary — data sources and licenses',
  '',
  '== WordNet 3.1 ==',
  fs.readFileSync(path.join(wnDir, '..', 'LICENSE'), 'utf8'),
  '',
  '== CMU Pronouncing Dictionary ==',
  fs.readFileSync(path.join(cmuDir, 'license'), 'utf8'),
  '',
  '== Wiktionary ==',
  'Definitions of articles, pronouns, prepositions, conjunctions, determiners, particles,',
  'interjections and contractions are adapted from Wiktionary (https://en.wiktionary.org),',
  'via kaikki.org extracts, and are available under the Creative Commons',
  'Attribution-ShareAlike 4.0 License (https://creativecommons.org/licenses/by-sa/4.0/).',
].join('\n'))

const meta = {
  version: VERSION,
  name: 'WordNet 3.1 + Wiktionary + CMU Pronouncing Dictionary',
  words: entries.size,
  withPronunciation: withIpa,
  shards: shards.size,
  bytes,
  built: new Date().toISOString(),
}
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2))
console.log(`Dictionary: ${meta.words} words (${withIpa} with IPA) in ${meta.shards} shards, ` +
  `${(bytes / 1048576).toFixed(1)} MB compressed — ${((Date.now() - t0) / 1000).toFixed(1)}s`)
