#!/usr/bin/env node
// Distills Wiktionary extracts (kaikki.org) into the compact data files that
// the offline dictionary is built from (see build-dictionary.mjs). Run it once
// when updating the data; the output in data/wiktionary/ is committed.
//
//   curl -O https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz
//   curl -O https://kaikki.org/dictionary/downloads/ko/ko-extract.jsonl.gz      (optional)
//   node scripts/distill-wiktionary.mjs kaikki.org-dictionary-English.jsonl.gz [--native ko=ko-extract.jsonl.gz]
//
// Output (data/wiktionary/):
//   en.jsonl.gz          [key, entry] per headword — definitions, labels, examples,
//                        IPA, audio, etymology, synonyms, irregular-form redirects
//   tr-<lang>.jsonl.gz   [key, [[sense, [translations]], …]] English Wiktionary translation tables
//   bi-<lang>.jsonl.gz   [key, entry] English words defined in <lang> (that language's Wiktionary)
//   stats.json
//
// Wiktionary content is available under CC BY-SA 4.0 (attribution in LICENSES).
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createRequire } from 'node:module'
import { createGunzip, gzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const input = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'))
if (!input) throw new Error('usage: distill-wiktionary.mjs <kaikki English .jsonl.gz> [--native ko=<ko-extract.jsonl.gz>] [--out dir]')
const natives = args.flatMap((a, i) => (a === '--native' ? [args[i + 1].split('=')] : []))
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname))
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(root, 'data', 'wiktionary')
fs.mkdirSync(outDir, { recursive: true })
const require = createRequire(import.meta.url)

// ---------------------------------------------------------------- vocabulary used to decide what to keep
const wnDir = path.join(path.dirname(require.resolve('wordnet-db/package.json')), 'dict')
const excDir = path.join(path.dirname(require.resolve('wndb-with-exceptions/package.json')), 'dict')
const wordnet = new Set()
for (const f of ['noun', 'verb', 'adj', 'adv']) {
  for (const line of fs.readFileSync(path.join(wnDir, `index.${f}`), 'utf8').split('\n'))
    if (line && !line.startsWith('  ')) wordnet.add(line.slice(0, line.indexOf(' ')).replace(/_/g, ' '))
}
const exceptions = new Map()
for (const f of ['noun', 'verb', 'adj', 'adv']) {
  for (const line of fs.readFileSync(path.join(excDir, `${f}.exc`), 'utf8').split('\n')) {
    const [form, ...bases] = line.trim().split(' ')
    if (form) exceptions.set(form.replace(/_/g, ' '), bases.map(b => b.replace(/_/g, ' ')))
  }
}
const { dictionary: cmu } = await import(path.join(path.dirname(require.resolve('cmu-pronouncing-dictionary/package.json')), 'index.js'))

// the same detachment rules the app applies at lookup time (src/lib/dictionary/wordnet.ts)
const RULES = [['s', ''], ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'], ['men', 'man'], ['ies', 'y'],
  ['es', 'e'], ['es', ''], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', ''], ['er', ''], ['est', ''], ['er', 'e'], ['est', 'e']]
const derivable = (form, base) => exceptions.get(form)?.includes(base)
  || RULES.some(([suf, rep]) => form.length > suf.length + 1 && form.endsWith(suf) && form.slice(0, -suf.length) + rep === base)

// ---------------------------------------------------------------- helpers
const POS = new Set(['noun', 'verb', 'adj', 'adv', 'prep', 'conj', 'pron', 'det', 'article', 'particle', 'intj', 'num',
  'contraction', 'abbrev', 'phrase', 'prep_phrase', 'adv_phrase', 'proverb', 'postp'])
const PHRASAL = new Set(['phrase', 'prep_phrase', 'adv_phrase', 'proverb', 'verb', 'contraction'])
const TR_LANGS = (process.env.TR_LANGS ?? 'ko,ja,cmn,es,fr,de,it,pt,ru,vi,ar,hi,id,th,tr,nl,pl,uk,fa,he,sv').split(',')
const SKIP_SENSE_TAGS = new Set(['no-gloss', 'misspelling', 'nonstandard-spelling', 'pronunciation-spelling', 'eye-dialect', 'deliberate-misspelling'])
const DEMOTE_TAGS = new Set(['obsolete', 'archaic', 'rare', 'dialectal', 'historical'])
const LITERARY = /archaic|obsolete|literary|poetic|dated|dialect|slang|informal|colloquial|British|rare|figurative|idiomatic/

const clean = s => s?.replace(/\s+/g, ' ').trim() ?? ''
const glossOf = glosses => {
  if (!glosses?.length) return ''
  let g = glosses[glosses.length - 1]
  if (g.startsWith('...') && glosses.length > 1) g = glosses[glosses.length - 2].replace(/\.\.\.$/, '') + ' ' + g.replace(/^\.\.\./, '')
  return clean(g)
}
const labelOf = (raw, gloss) => {
  if (!raw || !raw.startsWith('(')) return ''
  const end = raw.indexOf(')')
  if (end < 0 || !raw.slice(end + 1).trim().startsWith(gloss.slice(0, 12))) return ''
  return clean(raw.slice(1, end))
}
const shortEtym = (text, max) => {
  if (!text) return ''
  const lines = text.split('\n').filter(l => l.trim() && !/^(Etymology tree|Proto-|Old |Middle |English \S+$|Latin \S+$|Ancient Greek|Late Latin|Medieval Latin|Old French|Anglo-Norman|Frankish)/.test(l))
  let t = clean(lines.find(l => /\b(from|From|Borrowed|Coined|Clipping|Blend|Compound|Back-formation|Abbreviation|Equivalent|Of uncertain|Unknown|Onomatopoeic|Probably|Possibly|Ultimately|Named|Short)\b/.test(l)) ?? lines[0] ?? '')
  if (t.length > max) {
    const cut = t.slice(0, max).lastIndexOf(', from ')
    const cut2 = t.slice(0, max).lastIndexOf('. ')
    t = cut2 > 60 ? t.slice(0, cut2 + 1) : cut > 40 ? t.slice(0, cut) + '.' : t.slice(0, max - 1) + '…'
  }
  return t
}
// US/UK and untagged phonemic transcriptions; weak forms ("to" /tə/), letter sounds ("i" /ə/)
// and other regions ("to" /t̪oː/, India) only when nothing else is given
const US = /^(US|General-American|GA)$/
const UK = /^(UK|Received-Pronunciation|British|RP)$/
const isWeakIpa = s => {
  const tags = s.tags ?? []
  if (tags.some(t => /^(phoneme|letter|unstressed|weak|obsolete|archaic|dated)$/i.test(t))) return true
  if (/weak|unstressed|letter/i.test(s.note ?? '')) return true
  // regional unless one of its regions is US or UK ("Australia, General-American, RP" is fine)
  const regions = tags.filter(t => /^[A-Z]/.test(t))
  return regions.length > 0 && !regions.some(t => US.test(t) || UK.test(t))
}
/** [[us?, uk?], quality]: 2 = tagged US/UK, 1 = clean, 0 = weak or regional */
const bestIpa = sounds => {
  const all = (sounds ?? []).filter(s => s.ipa && s.ipa.startsWith('/'))
  const good = all.filter(s => !isWeakIpa(s))
  const ipas = good.length ? good : all
  const pick = re => ipas.find(s => (s.tags ?? []).some(t => re.test(t)))?.ipa
  const us = pick(US)
  const uk = pick(UK)
  const ipa = [...new Set([us ?? ipas[0]?.ipa, uk].filter(Boolean).map(s => s.replace(/^\/|\/$/g, '').split(/\/,\s*\//)[0]))].slice(0, 2)
  return [ipa, !good.length ? 0 : us || uk ? 2 : 1]
}
// only the short, canonical Commons recordings (x/xy/En-us-word.ogg)
const bestAudio = sounds => {
  const list = (sounds ?? []).map(s => s.ogg_url?.replace('https://upload.wikimedia.org/wikipedia/commons/', ''))
    .filter(u => u && /^[0-9a-f]\/[0-9a-f]{2}\/En-(us|uk|au|ca)-[^/]{1,40}\.ogg$/.test(u))
  return list.find(u => /\/En-us-/.test(u)) ?? list[0]
}
// "Near-synonyms: …" and "For quotations using this term, see Citations:…" are notes, not usage
const NOT_EXAMPLE = /^(Near-)?(Synonyms?|Antonyms?|Hypernyms?|Hyponyms?|Holonyms?|Meronyms?|Coordinate terms?|Troponyms?)\s*:|see Citations:|^See also\b|^(c\. )?\d{4}s?,/i
const examplesOf = (examples, max) => {
  const usable = (examples ?? []).filter(e => e.text && !NOT_EXAMPLE.test(e.text.trim()))
  const ex = usable.filter(e => e.type !== 'quotation' && e.text.length <= 160).map(e => clean(e.text))
  if (ex.length) return ex.slice(0, max)
  const q = usable.find(e => e.type === 'quotation' && e.text.length <= 120 && !/[ſ\[\]]/.test(e.text))
  return q ? [clean(q.text)] : []
}
const wordsOf = list => [...new Set((list ?? []).map(x => clean(x.word)).filter(w => w && w.length < 40))]

// ---------------------------------------------------------------- read the English extract
const open = file => readline.createInterface({ input: fs.createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity })
const raw = new Map() // key → { groups, ipa, audio, etym }
const translations = Object.fromEntries(TR_LANGS.map(l => [l, new Map()]))
const stats = { lines: 0 }
const t0 = Date.now()

for await (const line of open(input)) {
  if (++stats.lines % 300000 === 0) console.error(`${stats.lines} lines, ${raw.size} words, ${Math.round((Date.now() - t0) / 1000)}s`)
  let d
  try {
    d = JSON.parse(line)
  } catch {
    continue
  }
  if (d.lang_code !== 'en' || !POS.has(d.pos)) continue
  const word = clean(d.word).replace(/’/g, "'")
  if (!word || word.length > 50 || /\d{3,}|[<>{}|=]/.test(word)) continue
  const key = word.toLowerCase()

  const senses = []
  for (const s of d.senses ?? []) {
    const tags = s.tags ?? []
    if (tags.some(t => SKIP_SENSE_TAGS.has(t))) continue
    const g = glossOf(s.glosses)
    if (!g || g.length > 400) continue
    const sense = { g }
    const label = labelOf(s.raw_glosses?.[s.raw_glosses.length - 1], g)
    if (label) sense.l = label
    const ref = (s.form_of ?? s.alt_of)?.[0]
    const target = ref?.word
    // "'tis": contraction of it + is, which is not a form of "it"
    if (target && !/^\+/.test(ref.extra ?? '') && clean(target).toLowerCase() !== key) sense.f = clean(target)
    // "Abbreviation of et cetera: and so on…" says more than where it points
    if (sense.f && (ref.extra ?? '').split(' ').length > 2) sense._own = true
    sense._x = s.examples
    const syn = wordsOf(s.synonyms).slice(0, 5)
    if (syn.length) sense.s = syn
    const ant = wordsOf(s.antonyms).slice(0, 3)
    if (ant.length) sense.a = ant
    if (tags.some(t => DEMOTE_TAGS.has(t))) sense._demote = true
    senses.push(sense)
  }
  if (!senses.length) continue

  let e = raw.get(key)
  if (!e) raw.set(key, e = { groups: [], etym: [] })
  // the first record's transcription, unless it was only a weak, letter or regional one
  // ("I" the pronoun replaces "i" the letter's /ə/)
  const [ipa, quality] = bestIpa(d.sounds)
  if (ipa.length && (!e.ipa || (!e.ipaQ && quality > 0))) {
    e.ipa = ipa
    e.ipaQ = quality
  }
  e.audio ??= bestAudio(d.sounds)
  if (d.etymology_text && e.etym.length < 2 && !senses.every(s => s.f)) e.etym.push(d.etymology_text)
  const group = { p: d.pos, s: senses, _forms: d.forms }
  if (word !== key) group.w = word
  const syn = wordsOf(d.synonyms).slice(0, 8)
  if (syn.length) group.sy = syn
  const ant = wordsOf(d.antonyms).slice(0, 5)
  if (ant.length) group.an = ant
  const same = e.groups.find(g => g.p === group.p && g.w === group.w)
  if (same) {
    for (const s of group.s) if (!same.s.some(x => x.g === s.g)) same.s.push(s)
    same._forms ??= group._forms
    if (group.sy) same.sy = [...new Set([...(same.sy ?? []), ...group.sy])].slice(0, 8)
    if (group.an) same.an = [...new Set([...(same.an ?? []), ...group.an])].slice(0, 5)
  } else e.groups.push(group)

  // most translation tables are attached to a sense; only unmatched ones stay at the top level
  const trs = [
    ...(d.translations ?? []),
    ...(d.senses ?? []).flatMap(s => (s.translations ?? []).map(t => (t.sense ? t : { ...t, sense: glossOf(s.glosses) }))),
  ]
  for (const t of trs) {
    const lang = t.code ?? t.lang_code
    if (!t.word || !lang) continue
    ;(e.trLangs ??= new Set()).add(lang)
    if (!translations[lang]) continue
    const m = translations[lang]
    let rows = m.get(key)
    if (!rows) m.set(key, rows = [])
    const sense = clean(t.sense ?? '').replace(/\.$/, '').slice(0, 50)
    let row = rows.find(r => r[0] === sense)
    if (!row) {
      if (rows.length >= 3) continue
      rows.push(row = [sense, []])
    }
    const w = clean(t.word) + (t.roman && lang !== 'ko' ? ` (${clean(t.roman)})` : '')
    if (row[1].length < 3 && !row[1].includes(w) && w.length < 40) row[1].push(w)
  }
}

// ---------------------------------------------------------------- choose and trim
const isFormOnly = e => e.groups.every(g => g.s.every(s => s.f && !s._own))
const tierOf = (key, e) => {
  if (key.includes(' ')) return wordnet.has(key) || e.groups.some(g => PHRASAL.has(g.p)) ? 1 : 0
  if (wordnet.has(key) || cmu[key]) return 1
  if (e.audio) return 1
  if (e.groups.some(g => g.s.some(s => s.l && LITERARY.test(s.l)))) return 2
  // newer everyday words not in WordNet 3.1 or CMUdict (influencer, ransomware) usually
  // have translation tables; obscure technical terms rarely do
  if ((e.trLangs?.size ?? 0) >= 4) return 3
  return 0
}
const trimSenses = (senses, max) => {
  if (senses.length <= max) return senses
  const main = senses.filter(s => !s._demote)
  const keep = new Set([...main.slice(0, max), ...senses.filter(s => s._demote).slice(0, Math.max(0, max - main.length))])
  return senses.filter(s => keep.has(s))
}

const entries = new Map()
const kept = new Set()
for (const [key, e] of raw) if (!isFormOnly(e) && tierOf(key, e)) kept.add(key)

for (const [key, e] of raw) {
  if (isFormOnly(e)) {
    // forms become redirects, in Wiktionary's order. Regular ones are kept too: the runtime
    // rules can't always tell "knowest" → know or "stories" → story from storey.
    const redirects = []
    for (const g of e.groups) for (const s of g.s) {
      const target = s.f.toLowerCase()
      if (!kept.has(target) && !wordnet.has(target)) continue
      const rel = clean(s.g.replace(new RegExp(`\\s*(of|for)\\s+${s.f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}]).*$`, 'iu'), '')) || 'form'
      if (!redirects.some(r => r[0] === s.f) && rel.length < 60) redirects.push([s.f, rel])
    }
    if (redirects.length) entries.set(key, { r: redirects.slice(0, 3) })
    continue
  }
  if (!kept.has(key)) continue
  const tier = tierOf(key, e)
  const maxSenses = tier === 1 ? 12 : tier === 2 ? 6 : 4
  const maxEx = tier === 1 ? 2 : 1
  const groups = []
  for (const g of e.groups) {
    const s = trimSenses(g.s, maxSenses).map(({ _x, _demote, _own, ...rest }) => {
      const x = rest.f ? [] : examplesOf(_x, maxEx)
      return x.length ? { ...rest, x } : rest
    })
    const out = { p: g.p, s }
    if (g.w) out.w = g.w
    // irregular inflections only (regular ones add noise)
    const forms = [...new Set((g._forms ?? [])
      .filter(f => f.form && !(f.tags ?? []).some(t => ['table-tags', 'inflection-template', 'class', 'romanization', 'alternative', 'obsolete', 'archaic', 'dialectal', 'nonstandard', 'rare'].includes(t)))
      .map(f => clean(f.form))
      .filter(f => f !== (g.w ?? key) && !f.includes(' ') && f.length < 30 && !/^(no-table-tags|en-)/.test(f) && !derivable(f.toLowerCase(), key)))].slice(0, 5)
    if (forms.length) out.i = forms
    if (g.sy) out.sy = g.sy
    if (g.an) out.an = g.an
    groups.push(out)
  }
  const out = { m: groups }
  if (e.ipa) out.i = e.ipa
  // weak, letter or regional only: the build uses CMUdict instead when it has the word
  if (e.ipa && !e.ipaQ) out.iq = 0
  if (e.audio) out.a = e.audio
  const etym = [...new Set(e.etym.map(t => shortEtym(t, tier === 1 ? 170 : tier === 2 ? 110 : 90)).filter(Boolean))]
  if (etym.length) out.e = etym
  entries.set(key, out)
}

// ---------------------------------------------------------------- bilingual: English words defined in another language
const bilingual = {}
for (const [lang, file] of natives) {
  const m = new Map()
  for await (const line of open(file)) {
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.lang_code !== 'en') continue
    const word = clean(d.word).replace(/’/g, "'")
    if (!word || word.length > 50) continue
    const key = word.toLowerCase()
    const senses = []
    for (const s of d.senses ?? []) {
      const g = clean((s.glosses ?? []).join(' '))
      if (!g || g.length > 300 || /^[,;.]|public domain|^\(?출처/.test(g)) continue
      const x = (s.examples ?? []).map(ex => clean(ex.translation ? `${ex.text} — ${ex.translation}` : ex.text))
        .filter(t => t && t.length <= 200 && /\p{L}/u.test(t) && !/^(동사|명사|형용사|부사|반의어|유의어|참고)\s*:/.test(t)).slice(0, 2)
      senses.push(x.length ? { g, x } : { g })
    }
    if (!senses.length) continue
    let e = m.get(key)
    if (!e) m.set(key, e = { m: [] })
    const p = POS.has(d.pos) ? d.pos : ''
    const same = e.m.find(g => g.p === p)
    if (same) for (const s of senses) { if (same.s.length < 10 && !same.s.some(x => x.g === s.g)) same.s.push(s) }
    else e.m.push({ p, s: senses.slice(0, 10) })
    const ipa = (d.sounds ?? []).find(s => s.ipa)?.ipa
    if (ipa && !e.i) e.i = [ipa.replace(/^\/|\/$/g, '')]
  }
  bilingual[lang] = m
}

// ---------------------------------------------------------------- write
const writeLines = (file, map) => {
  const lines = [...map.keys()].sort().map(k => JSON.stringify([k, map.get(k)]))
  const gz = gzipSync(Buffer.from(lines.join('\n')), { level: 9 })
  fs.writeFileSync(path.join(outDir, file), gz)
  return gz.length
}
for (const f of fs.readdirSync(outDir)) if (/\.jsonl\.gz$/.test(f)) fs.rmSync(path.join(outDir, f))

// Translations of words that at least TR_MIN_LANGS of the languages translate (a proxy for
// how common a word is). The English sense labels are stored once, in tr-labels, and each
// language refers to them by index: [key, [[labelIndex, [words]], …]].
const TR_MIN_LANGS = Number(process.env.TR_MIN_LANGS ?? 6)
const writeTranslations = () => {
  const coverage = new Map()
  for (const m of Object.values(translations))
    for (const k of m.keys()) if (entries.get(k)?.m) coverage.set(k, (coverage.get(k) ?? 0) + 1)
  const labels = new Map()
  const out = {}
  for (const [lang, m] of Object.entries(translations)) {
    const rows = new Map()
    for (const [k, list] of m) {
      if ((coverage.get(k) ?? 0) < TR_MIN_LANGS) continue
      let l = labels.get(k)
      if (!l) labels.set(k, l = [])
      rows.set(k, list.map(([sense, words]) => {
        if (!l.includes(sense)) l.push(sense)
        return [l.indexOf(sense), words]
      }))
    }
    out[lang] = { words: rows.size, bytes: writeLines(`tr-${lang}.jsonl.gz`, rows) }
  }
  out.labels = { words: labels.size, bytes: writeLines('tr-labels.jsonl.gz', labels) }
  return out
}
const redirects = [...entries.values()].filter(e => e.r).length
Object.assign(stats, {
  headwords: entries.size - redirects,
  redirects,
  enBytes: writeLines('en.jsonl.gz', entries),
  translations: writeTranslations(),
  bilingual: Object.fromEntries(Object.entries(bilingual).map(([lang, m]) => [lang, { words: m.size, bytes: writeLines(`bi-${lang}.jsonl.gz`, m) }])),
  seconds: Math.round((Date.now() - t0) / 1000),
})
fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify(stats, null, 2))
console.log(JSON.stringify(stats, null, 2))
