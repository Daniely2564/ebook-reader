#!/usr/bin/env node
// Compiles the offline dictionaries shipped with Lumen Reader.
//
// Sources (all redistributable, licenses copied next to the output):
//   - Wiktionary (CC BY-SA 4.0), distilled into data/wiktionary/ by
//     distill-wiktionary.mjs: English definitions, labels, examples, IPA,
//     etymology, irregular forms, translation tables, and English words
//     defined in other languages (bilingual packs, e.g. English–Korean)
//   - WordNet 3.1 (`wordnet-db`)           concise definitions, synonyms…
//   - WordNet 3.0 exception lists          irregular forms (went → go)
//     (`wndb-with-exceptions`)
//   - CMU Pronouncing Dictionary           WordNet pronunciations, as IPA
//     (`cmu-pronouncing-dictionary`)
//   - Webster's Revised Unabridged         a second full dictionary, parsed by webster.mjs
//     Dictionary (1913, public domain)
//     (`websters-english-dictionary`)
//
// Senses are put in reading order (common meaning first) by sense-order.mjs, using the
// WordNet corpus counts in index.sense.
//
// Output (public/dict/):
//   meta.json            build info and available sources
//   words.bin            gzip'd sorted headword list (autocomplete, "did you mean")
//   exc.json             irregular inflections per part of speech (WordNet)
//   wk/, wn/, wb/,       gzip'd JSON shards: <key>.bin, keyed by the first two
//   bi/<lang>/           letters (three for large prefixes, listed in index.json)
//   tr/<lang>/           Wiktionary translation tables for one language, sharded by first letter
//
// WordNet shard entry: { "<word>": { "i": "<ipa>", "m": [[pos, [[definition, examples[], synonyms[], antonyms[], typeOf[]], …]], …] } }
// Wiktionary and Webster entries use the distilled format documented in distill-wiktionary.mjs.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createOrdering } from './sense-order.mjs'
import { parseWebster } from './webster.mjs'

const VERSION = 8
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, 'public', 'dict')
const require = createRequire(import.meta.url)

if (process.argv.includes('--if-missing')) {
  try {
    const metaFile = path.join(out, 'meta.json')
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    // rebuild when the distilled Wiktionary data or these scripts are newer than the last build
    const built = fs.statSync(metaFile).mtimeMs
    const data = path.join(root, 'data', 'wiktionary')
    const inputs = [
      ...(fs.existsSync(data) ? fs.readdirSync(data).map(f => path.join(data, f)) : []),
      ...['build-dictionary.mjs', 'webster.mjs', 'sense-order.mjs'].map(f => path.join(root, 'scripts', f)),
    ]
    const stale = inputs.some(f => fs.statSync(f).mtimeMs > built)
    if (meta.version === VERSION && !stale) process.exit(0)
  } catch { /* build it */ }
}

const wnDir = path.join(path.dirname(require.resolve('wordnet-db/package.json')), 'dict')
// The package's postinstall copies data/*.exc into dict/; package managers that skip install scripts (pnpm) leave only data/.
const excPkg = path.dirname(require.resolve('wndb-with-exceptions/package.json'))
const excDir = fs.existsSync(path.join(excPkg, 'dict', 'noun.exc')) ? path.join(excPkg, 'dict') : path.join(excPkg, 'data')
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
// a file URL: Windows paths ("D:\\…") are not valid import specifiers
const { dictionary: cmu } = await import(pathToFileURL(path.join(cmuDir, 'index.js')).href)
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

// ---------------------------------------------------------------- sense frequencies
// index.sense: "bear%2:42:01:: 02636952 1 23" → the first verb sense of "bear" was tagged 23 times
const senseCounts = new Map()
for (const line of fs.readFileSync(path.join(wnDir, 'index.sense'), 'utf8').split('\n')) {
  if (!line) continue
  const [key, , num, cnt] = line.split(' ')
  const pct = key.indexOf('%')
  const pos = 'xnvara'[+key[pct + 1]]
  const k = `${clean(key.slice(0, pct))}|${pos}`
  if (!senseCounts.has(k)) senseCounts.set(k, [])
  senseCounts.get(k)[+num - 1] = +cnt
}
const ordering = createOrdering(entries, senseCounts)

let withIpa = 0
for (const [word, entry] of entries) {
  const ipa = ipaFor(word)
  if (ipa) {
    entry.i = ipa
    withIpa++
  }
}

// ---------------------------------------------------------------- write
const shardKey = (word, len) => {
  const s = word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  let k = ''
  for (const ch of s) {
    if (k.length === len) break
    k += /[a-z0-9]/.test(ch) ? ch : '_'
  }
  return k.padEnd(len, '_')
}

/** Must match shardFile() in src/lib/dictionary/shards.ts: Windows can't create con.bin, prn.bin… */
const shardFile = key => (/^(con|prn|aux|nul)$/.test(key) ? `${key}_` : key)

const SPLIT_ABOVE = 400_000 // bytes of JSON per two-letter shard before it is split by the third letter
let totalBytes = 0
/** Writes a {word: entry} map as shards by the first `len` letters; large shards are split by one more letter. */
const writeShards = (dir, map, len = 2) => {
  fs.mkdirSync(path.join(out, dir), { recursive: true })
  const byTwo = new Map()
  for (const [word, entry] of map) {
    const k = shardKey(word, len)
    if (!byTwo.has(k)) byTwo.set(k, new Map())
    byTwo.get(k).set(word, entry)
  }
  const split = []
  let bytes = 0
  let files = 0
  const write = (key, m) => {
    const gz = gzipSync(Buffer.from(JSON.stringify(Object.fromEntries(m))), { level: 9 })
    fs.writeFileSync(path.join(out, dir, `${shardFile(key)}.bin`), gz)
    bytes += gz.length
    files++
  }
  for (const [k, m] of byTwo) {
    const size = [...m].reduce((n, [w, e]) => n + w.length + JSON.stringify(e).length, 0)
    if (size <= SPLIT_ABOVE) {
      write(k, m)
      continue
    }
    split.push(k)
    const byThree = new Map()
    for (const [w, e] of m) {
      const k3 = shardKey(w, len + 1)
      if (!byThree.has(k3)) byThree.set(k3, new Map())
      byThree.get(k3).set(w, e)
    }
    for (const [k3, m3] of byThree) write(k3, m3)
  }
  fs.writeFileSync(path.join(out, dir, 'index.json'), JSON.stringify({ split: split.sort() }))
  totalBytes += bytes
  return { words: map.size, files, bytes }
}

const readLines = file => {
  const map = new Map()
  const text = gunzipSync(fs.readFileSync(file)).toString('utf8')
  for (const line of text.split('\n')) {
    if (!line) continue
    const [key, value] = JSON.parse(line)
    map.set(key, value)
  }
  return map
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const sources = {}
sources.wordnet = writeShards('wn', new Map([...entries].map(([w, e]) => [w, { ...(e.i ? { i: e.i } : {}), m: ordering.orderWordNet(w, e.m) }])))

const wkDir = path.join(root, 'data', 'wiktionary')
const allWords = new Set(entries.keys())
// parts of speech Wiktionary gives each word, for Webster's
const wkPos = new Map()
if (fs.existsSync(path.join(wkDir, 'en.jsonl.gz'))) {
  const wk = readLines(path.join(wkDir, 'en.jsonl.gz'))
  for (const [w, e] of wk) {
    if (e.r) continue
    allWords.add(w)
    if (e.m) {
      wkPos.set(w, new Set(e.m.map(g => g.p)))
      e.m = ordering.orderGroups(w, e.m, { fill: true })
    }
    // Wiktionary only had a weak, letter or regional transcription ("to" /t̪oː/): use CMUdict's
    if ('iq' in e) {
      const ipa = ipaFor(w)
      if (ipa) e.i = [ipa]
      delete e.iq
    }
  }
  sources.wiktionary = { ...writeShards('wk', wk), redirects: [...wk.values()].filter(e => e.r).length }
  sources.bilingual = {}
  sources.translations = {}
  for (const f of fs.readdirSync(wkDir).sort()) {
    const bi = f.match(/^bi-([a-z]+)\.jsonl\.gz$/)
    if (bi) sources.bilingual[bi[1]] = writeShards(`bi/${bi[1]}`, readLines(path.join(wkDir, f)))
    const tr = f.match(/^tr-([a-z]+)\.jsonl\.gz$/)
    // tr-labels holds the English sense labels the languages refer to by index
    if (tr) sources.translations[tr[1]] = writeShards(`tr/${tr[1]}`, readLines(path.join(wkDir, f)), 1)
  }
} else {
  console.warn('data/wiktionary/en.jsonl.gz not found — building WordNet only')
}

// ---------------------------------------------------------------- Webster's 1913
{
  const POS_NAME = { n: 'noun', v: 'verb', a: 'adj', r: 'adv' }
  const wnPos = new Map()
  for (const [w, e] of entries) wnPos.set(w, new Set(e.m.map(([p]) => POS_NAME[p])))
  const webster = require('websters-english-dictionary').dictionary()
  const wb = new Map()
  for (const [word, text] of Object.entries(webster)) {
    const key = word.toLowerCase()
    const knownPos = new Set([...(wnPos.get(key) ?? []), ...(wkPos.get(key) ?? [])])
    const e = parseWebster(key, text, { posOf: w => wnPos.get(w), knownPos: knownPos.size ? knownPos : undefined })
    if (!e) continue
    e.m = ordering.orderGroups(key, e.m)
    wb.set(key, e)
    allWords.add(key)
  }
  sources.webster = writeShards('wb', wb)
}

const words = [...allWords].sort()
fs.writeFileSync(path.join(out, 'words.bin'), gzipSync(Buffer.from(words.join('\n')), { level: 9 }))

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
  'Lumen Reader offline dictionaries — data sources and licenses',
  '',
  '== Wiktionary ==',
  'Definitions, examples, pronunciations, etymologies and translations are adapted from',
  'Wiktionary (https://en.wiktionary.org and https://ko.wiktionary.org), via the kaikki.org',
  'extracts (https://kaikki.org), and are available under the Creative Commons',
  'Attribution-ShareAlike 4.0 License (https://creativecommons.org/licenses/by-sa/4.0/).',
  'Pronunciation recordings are played from Wikimedia Commons under their own licenses.',
  '',
  "== Webster's Revised Unabridged Dictionary (1913) ==",
  'Public domain. Text from Project Gutenberg (https://www.gutenberg.org), as packaged by the',
  'websters-english-dictionary npm module (https://github.com/andrewosh/websters-english-dictionary).',
  '',
  '== WordNet 3.1 ==',
  fs.readFileSync(path.join(wnDir, '..', 'LICENSE'), 'utf8'),
  '',
  '== CMU Pronouncing Dictionary ==',
  fs.readFileSync(path.join(cmuDir, 'license'), 'utf8'),
].join('\n'))

const meta = {
  version: VERSION,
  words: words.length,
  withPronunciation: withIpa,
  sources,
  bytes: totalBytes,
  built: new Date().toISOString(),
}
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2))
console.log(`Dictionary: ${words.length} headwords — Wiktionary ${sources.wiktionary?.words ?? 0}, WordNet ${sources.wordnet.words}, Webster ${sources.webster.words}, ` +
  `bilingual ${Object.keys(sources.bilingual ?? {}).join(', ') || 'none'} — ${(totalBytes / 1048576).toFixed(1)} MB compressed — ${((Date.now() - t0) / 1000).toFixed(1)}s`)
