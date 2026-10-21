// Parses Webster's Revised Unabridged Dictionary (1913, public domain), as packaged by
// the `websters-english-dictionary` npm module, into the entry format the app uses for
// Wiktionary (see distill-wiktionary.mjs):
//
//   { m: [{ p: pos, s: [{ g: definition, l?: labels, x?: examples, f?: form of, n?: note }], sy?: synonyms }] }
//
// The source is plain text: homographs separated by blank lines, numbered senses
// ("1. … 2. …"), lettered sub-senses ("(a) …"), labels like "[Obs.]" and "(Bot.)",
// quotations followed by their author ("Shak."), "Syn. --" lists, notes, and phrases
// ("To bear down. (a) …  -- To bear a hand …"). Parts of speech were dropped by the
// packager, so they are inferred from the wording of the definitions where that is clear.

const REGISTER = {
  'Obs.': 'obsolete', 'Obsoles.': 'obsolescent', 'R.': 'rare', 'R': 'rare', 'Archaic': 'archaic', 'Archaic.': 'archaic',
  'Colloq.': 'colloquial', 'Collog.': 'colloquial', 'Slang': 'slang', 'Slang.': 'slang', 'Old Slang': 'slang', 'Cant': 'cant',
  'Low': 'vulgar', 'Poetic': 'poetic', 'Humorous': 'humorous', 'Jocose': 'humorous', 'Jocular': 'humorous',
  'Prov. Eng.': 'dialectal', 'Prov.Eng.': 'dialectal', 'Eng.': 'British', 'Scot.': 'Scotland', 'U.S.': 'US', 'U. S.': 'US',
  'Local': 'regional', 'Western U.S.': 'western US', 'Western U. S.': 'western US', 'Ireland': 'Ireland', 'India': 'India',
  'South Africa': 'South Africa', 'Recent': 'recent', 'A Latinism': 'Latinism', 'Familiar': 'informal', 'Vulgar': 'vulgar',
  'Contemptuous': 'derogatory', 'Ludicrous': 'humorous', 'Burlesque': 'humorous', 'Rhetorical': 'rhetorical',
}
const DOMAIN = {
  'Zoöl.': 'zoology', 'Zoöl': 'zoology', 'Bot.': 'botany', 'Law': 'law', 'Naut.': 'nautical', 'Med.': 'medicine', 'Anat.': 'anatomy',
  'Mus.': 'music', 'Arch.': 'architecture', 'Chem.': 'chemistry', 'Biol.': 'biology', 'Mil.': 'military', 'Astron.': 'astronomy',
  'Math.': 'mathematics', 'Mining': 'mining', 'Her.': 'heraldry', 'Mach.': 'machinery', 'Geom.': 'geometry', 'Gram.': 'grammar',
  'Mech.': 'mechanics', 'Physiol.': 'physiology', 'Eccl.': 'church', 'Min.': 'mineralogy', 'Geol.': 'geology', 'Print.': 'printing',
  'Physics': 'physics', 'Logic': 'logic', 'Theol.': 'theology', 'R. C. Ch.': 'Roman Catholic Church', 'Surg.': 'surgery',
  'Fort.': 'fortification', 'Com.': 'commerce', 'Rhet.': 'rhetoric', 'Fine Arts': 'fine arts', 'Far.': 'farriery',
  'Rom. Antiq.': 'Roman history', 'Eng. Law': 'English law', 'Metaph.': 'metaphysics', 'Carp.': 'carpentry', 'Opt.': 'optics',
  'Scots Law': 'Scots law', 'Paint.': 'painting', 'Metal.': 'metallurgy', 'Crystallog.': 'crystallography', 'Shipbuilding': 'shipbuilding',
  'Script.': 'Scripture', 'Founding': 'founding', 'Elec.': 'electricity', 'Gun.': 'gunnery', 'Astrol.': 'astrology',
  'Cookery': 'cooking', 'Class. Myth.': 'classical mythology', 'Nat. Hist.': 'natural history', 'Eccl. Hist.': 'church history',
  'Engin.': 'engineering', 'O. Eng. Law': 'Old English law', 'Phon.': 'phonetics', 'Masonry': 'masonry', 'Ethnol.': 'ethnology',
  'Old Chem.': 'old chemistry', 'Card Playing': 'card games', 'Agric.': 'agriculture', 'Man.': 'horsemanship', 'Steam Engine': 'steam engines',
  'Photog.': 'photography', 'Pros.': 'prosody', 'Weaving': 'weaving', 'Arith.': 'arithmetic', 'Phonetics': 'phonetics',
  'Philos.': 'philosophy', 'Antiq.': 'antiquity', 'Railroad': 'railways', 'Alg.': 'algebra', 'Myth.': 'mythology', 'Falconry': 'falconry',
  'Baseball': 'baseball', 'Hort.': 'horticulture', 'Geog.': 'geography', 'Civil Law': 'civil law', 'Mar.': 'maritime',
  'Mar. Law': 'maritime law', 'Canon Law': 'canon law', 'Bot. & Zoöl.': 'biology', 'Pharm.': 'pharmacy', 'Zool.': 'zoology',
  'Theat.': 'theater', 'Sport.': 'sports', 'Hunting': 'hunting', 'Fishing': 'fishing', 'Teleg.': 'telegraphy', 'Gram': 'grammar',
  'Pyrotech.': 'pyrotechnics', 'Hydraul.': 'hydraulics', 'Bookbinding': 'bookbinding', 'Dyeing': 'dyeing', 'Brewing': 'brewing',
  'Electricity': 'electricity', 'Zoöl. & Bot.': 'biology', 'Mus. & Pros.': 'music', 'Naut. & Mil.': 'military',
}
// "[He]" and "[L.]" in brackets are not labels
const NOT_LABEL = new Set(['He', 'She', 'They', 'I', 'It', 'We', 'You', 'Him', 'Her', 'Them', 'God', 'L', 'F', 'NL', 'Gr', 'LL', 'OF', 'AS', 'Sic'])
// "imp. & p. p. of Run." → past tense and past participle
const FORM_NAMES = [
  [/^imp\. & p\. ?p\./, 'past tense and past participle'], [/^imp\./, 'past tense'], [/^p\. ?p\./, 'past participle'],
  [/^p\. pr\./, 'present participle'], [/^pl\./, 'plural'], [/^compar\./, 'comparative'], [/^superl\./, 'superlative'],
  [/^3d pers\. sing\./, 'third-person singular'], [/^2d pers\. sing\./, 'second-person singular'],
  [/^(?:the )?preterit/, 'past tense'],
]

// words that end in a period without ending a sentence
const ABBREV = /(?:^|[\s(])(?:[A-Za-z]|etc|viz|cf|Cf|e\.g|i\.e|vs|No|St|Mr|Mrs|Dr|Fig|fig|sq|ft|lb|oz|vol|pp|esp|Esp|Ch|Lat|Gr|Fr|Ger|OE|AS|Sp|It|Heb|Gen|Ex|Is|Ps|Matt)$/
// "Shak.", "Milton.", "Sir M. Hale.", "Gen. iv. 13.", "Book of Common Prayer."
const CITATION = /^(?:(?:[A-Z][\w'’-]*|[IVXLC]+|[ivxlc]+|\d+|of|the|de|von|van|and|&)\.?,? ){0,5}(?:[A-Z][\w'’-]*|[ivxlc]+|\d+)\.(?=\s|$)/

const clean = s => s.replace(/\s+([,;:.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim()
const unquote = s => s.trim().replace(/^["“]\s*|\s*["”]$/g, '').trim()
// "… any good Ps. iv." (the verse number follows as its own sentence)
const BIBLE_REF = /\s+(?:(?:[1-3]|I{1,3}) )?[A-Z][a-z]{0,6}\.?\s+[ivxlc]+\.\s?(?:\d+\.)?$/

/** Splits text into sentences, not breaking after abbreviations and initials. */
const sentences = text => {
  const out = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c !== '.' && c !== '!' && c !== '?') continue
    const next = text.slice(i + 1, i + 3)
    // a closing quote belongs to the sentence
    let end = i + 1
    if (next[0] === '"' || next[0] === '”') end++
    if (end < text.length && text[end] !== ' ') continue
    const after = text.slice(end).trimStart()
    if (after && !/^["“'‘(\[\dA-Z]/.test(after)) continue
    // not after an abbreviation or initial ("Sir M. Hale"), unless a quotation closes there
    if (c === '.' && end === i + 1 && ABBREV.test(text.slice(start, i)) && !(/etc$/.test(text.slice(start, i)) && /^[A-Z]/.test(after))) continue
    out.push(text.slice(start, end).trim())
    start = end
  }
  if (text.slice(start).trim()) out.push(text.slice(start).trim())
  return out
}

// run-together entries ("WOOD'S METAL Wood's" met"al.") and syllable marks
const DEBRIS = /\b[A-Z]{2,}['’]?S? [A-Z]{2,}\b|\w"\w|\w\*\w/

/** Quotations after a definition, without their authors, and any description that follows them. */
const quotations = rest => {
  const quotes = []
  let more = ''
  let cur = ''
  for (const s of sentences(rest)) {
    if (CITATION.test(s) && CITATION.exec(s)[0].length === s.length && s.split(' ').length <= 6) {
      if (cur.trim()) quotes.push(unquote(cur))
      cur = ''
    } else if (/^\d+\.$/.test(s)) {
      // verse number after "Ps. iv."
    } else if (BIBLE_REF.test(s)) {
      quotes.push(unquote(`${cur}${s.replace(BIBLE_REF, '')}`))
      cur = ''
    } else cur += `${s} `
  }
  // a quotation has an author; longer text without one describes the thing further
  if (cur.trim()) {
    if (cur.length <= 90 || /^["“]/.test(cur.trim())) quotes.push(unquote(cur))
    else more = clean(cur)
  }
  return {
    quotes: quotes.map(clean).filter(q => q.length > 3 && q.length < 300 && !/^(?:See|Cf)\b/.test(q) && !DEBRIS.test(q)),
    more: DEBRIS.test(more) ? '' : more,
  }
}

const labelsOf = text => {
  const labels = []
  let t = text
    .replace(/Etym:\s*\[[^\]]*\]\s*/g, '')
    .replace(/\[WordNet[^\]]*\]/g, '')
  // "(Mar. Law)" at the start of a sense
  t = t.replace(/^\(([^)]{1,30})\)\s*/, (m, d) => {
    const name = DOMAIN[d] ?? DOMAIN[`${d}.`] ?? (/^[A-Z][a-zö]{2,}\.?$/.test(d) ? d.replace(/\.$/, '').toLowerCase() : undefined)
    if (!name) return m
    labels.push(name)
    return ''
  })
  // "[Obs.]", "[Obs. or Prov. Eng.]", "[Colloq. U.S.]"
  t = t.replace(/\s*\[([A-Z][^\]]{0,30})\]\.?/g, (m, inner) => {
    const parts = inner.split(/\s*(?:,|&| or |\band\b)\s*/).map(p => p.trim()).filter(Boolean)
    const names = parts.map(p => REGISTER[p] ?? REGISTER[p.replace(/\.$/, '')] ?? REGISTER[p.replace(/ (?:U\. ?S\.|Eng\.)$/, '')])
    // "[Familiar]", "[Prep. phrase.]"
    if (names.some(n => !n) && /^[A-Z][a-z]+\.?(?: [a-z]+\.?)?$/.test(inner) && !NOT_LABEL.has(inner.replace(/\.$/, ''))) {
      names.length = 0
      names.push(inner.replace(/\.$/, '').toLowerCase())
    }
    if (!names.length || names.some(n => !n)) {
      // "[Colloq. U.S.]" → colloquial, US
      const words = inner.match(/Obs\.|Obsoles\.|R\.|Colloq\.|Slang|Archaic|Poetic|Prov\. ?Eng\.|Scot\.|U\. ?S\.|Eng\.|Local|Cant|Low/g)
      if (!words) return m
      names.length = 0
      names.push(...words.map(w => REGISTER[w] ?? REGISTER[w.replace(' ', '')]))
    }
    for (const n of names) if (n && !labels.includes(n)) labels.push(n)
    return ''
  })
  return { text: t.trim(), labels }
}

/** One sense: definition, "as, …" examples and quotations. */
const parseSense = (raw, extraLabels = []) => {
  let text = raw.trim()
  const extra = [...extraLabels]
  // "pl. Wares; commodities", "Metaphorically: A brutal person"
  text = text.replace(/^pl\.\s+/, () => {
    extra.push('plural')
    return ''
  }).replace(/^(?:Metaphorically|Figuratively|Fig\.)\s*:\s*/, () => {
    extra.push('figuratively')
    return ''
  })
  let note
  const n = text.search(/\bNote:/)
  if (n >= 0) {
    note = clean(text.slice(n + 5)).replace(/\s*(?:[A-Z][\w'’-]*\.\s*){1,3}$/, '')
    text = text.slice(0, n)
  }
  const { text: t, labels } = labelsOf(text)
  const parts = sentences(t)
  if (!parts.length) return []
  let def = parts[0]
  let rest = parts.slice(1)
  // "Hence: To behave; to conduct." is a meaning of its own
  const more = []
  const hence = rest.findIndex(s => /^Hence[,:]/.test(s))
  if (hence >= 0) {
    more.push(...parseSense(rest.slice(hence).join(' '), extraLabels))
    rest = rest.slice(0, hence)
  }
  const examples = []
  def = def.replace(/(?:[;,]\s*|\s+)as,\s+(.+?)\.?$/, (_, ex) => {
    for (const e of ex.split(/;\s*/)) if (e.trim().length > 2) examples.push(clean(e.replace(/^(?:to|as)\s+(?=\w)/, m => m)))
    return '.'
  })
  def = clean(def.replace(/\s*--\s*$/, '').replace(/[;,]\s*\.$/, '.')).replace(/\.\.$/, '.').replace(/\s*--\s*/g, ' — ')
  if (!/[.!?]$/.test(def)) def += '.'
  const { quotes, more: description } = quotations(rest.join(' '))
  examples.push(...quotes)
  if (description && !note) note = description
  const sense = { g: def }
  const l = [...extra, ...labels]
  if (l.length) sense.l = l.join(', ')
  if (examples.length) sense.x = examples.slice(0, 4)
  // "See Thee." and "Has." point at another headword
  const see = /^(?:See|Same as|Like|Cf\.)\s+([A-Z][\w'-]*(?: [\w'-]+)?)\.$/.exec(def)
  if (see) sense.f = see[1].toLowerCase()
  if (note && note.length > 20) sense.n = note.length > 420 ? `${note.slice(0, 400).replace(/\s+\S*$/, '')}…` : note
  if (def.length < 3) return more
  return [sense, ...more]
}

/** A numbered sense, split into its lettered sub-senses when it has them. */
const parseNumbered = raw => {
  const letters = [...raw.matchAll(/(?:^|\s)\(([a-h])\)\s/g)]
  if (letters.length < 2 || letters[0][1] !== 'a') return parseSense(raw)
  const lead = raw.slice(0, letters[0].index).trim()
  const out = []
  let label = []
  if (lead) {
    const short = lead.replace(/\s*(?:Specifically)?:?\s*--\s*$|:\s*$/, '').trim()
    if (/:\s*(?:--)?\s*$/.test(lead) && short.length <= 48 && !short.includes('.')) label = short ? [short.replace(/^./, c => c.toLowerCase())] : []
    else out.push(...parseSense(lead.replace(/\s*(?:Specifically)?:?\s*--\s*$/, '')))
  }
  for (let i = 0; i < letters.length; i++) {
    const from = letters[i].index + letters[i][0].length
    const to = i + 1 < letters.length ? letters[i + 1].index : raw.length
    out.push(...parseSense(raw.slice(from, to), label))
  }
  return out
}

// ---------------------------------------------------------------- parts of speech
const VERB = /^(?:Hence[,:]\s*)?(?:Reflexively\s*:\s*)?To\s/
const NOUN = /^(?:Hence[,:]\s*)?(?:A|An|The (?:act|art|state|quality|condition|science|practice|process|place|time|person|one)|One who|One that|That which|Any one|Anything|Something|Act of|Art of|State of|Quality of|Condition of|Science of|Practice of|Process of)\b/
const ADJ = /^(?:Hence[,:]\s*)?(?:Of or pertaining to|Of,? or pertaining to|Pertaining to|Relating to|Of,? or relating to|Belonging to|Having|Possessing|Full of|Characterized by|Free from|Like|Resembling|Capable of|Consisting of|Made of|Without|Destitute of|Abounding in|Inclined to|Tending to|Not\s)/
const ADV = /^(?:Hence[,:]\s*)?In an? (?:[\w-]+ ){1,4}(?:manner|way|degree)\b/

/**
 * A sense's part of speech, from how the definition starts and from the one-word synonyms
 * it lists ("Depressed in spirits; dejected; gloomy" reads as an adjective).
 */
const sensePos = (g, posOf) => {
  const votes = { noun: 0, verb: 0, adj: 0, adv: 0 }
  if (VERB.test(g)) votes.verb += 3
  else if (ADV.test(g)) votes.adv += 3
  else if (ADJ.test(g)) votes.adj += 2
  else if (NOUN.test(g)) votes.noun += 2
  for (const raw of g.replace(/\s*--.*$|\.$/g, '').split(/\s*[;,]\s*/)) {
    const item = raw.trim().replace(/^Hence[,:]\s*/i, '').replace(/^[A-Z](?=[a-z-]+$)/, c => c.toLowerCase())
    if (/^(?:a|an|the)\s+\w/i.test(item) && item.split(' ').length <= 4) votes.noun++
    else if (/^to\s+\w/i.test(item)) votes.verb++
    else if (/^[a-z][a-z-]+$/.test(item)) {
      const pos = posOf?.(item)
      if (pos?.size === 1) votes[[...pos][0]]++
      else if (/ly$/.test(item) && pos?.has('adv')) votes.adv++
    }
  }
  const [best, n] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]
  return n > 0 && Object.values(votes).filter(v => v === n).length === 1 ? best : ''
}

const guessPos = (senses, posOf) => {
  const counts = {}
  let decided = 0
  for (const s of senses) {
    if (s.f) continue
    const pos = sensePos(s.g, posOf)
    if (!pos) continue
    counts[pos] = (counts[pos] ?? 0) + 1
    decided++
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? []
  return best && n >= 0.6 * decided && decided >= Math.max(1, senses.length / 3) ? best : ''
}

// ---------------------------------------------------------------- phrases and synonyms
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// "To bear down. (a)", "Fair ball. (Baseball)", "Bear garden, a place…", "As good as. See under As."
const phraseHead = word => new RegExp(`^(?:(?:To|A|An|The|As|In|For|From|Of|On|At|By|With|Not|No|All|Be|Of a) )?(?:[\\w'-]+ )?${escape(word)}\\w{0,3}(?: [\\w'-]+){0,4}?(?:,| \\([^)]{1,25}\\),|\\. (?:\\(a\\)|\\([^)]{1,25}\\)|See )|\\.$)`, 'i')

/** Where "… To bear down. (a) …  -- To bear a hand. …" starts at the end of a sense, or -1. */
const phraseStart = (word, text) => {
  const head = phraseHead(word)
  for (const m of text.matchAll(/(?:[.!?"”]|\s--)\s+(?=\S)/g)) {
    const at = m.index + m[0].length
    const tail = text.slice(at)
    if (!head.test(tail.slice(0, 120))) continue
    // a list of phrases, or a lone "To bear down. (a) …"
    if (/\s--\s/.test(tail) || /^[^.]{1,60}\. (?:\([^)]{1,25}\) )?\(a\)/.test(tail)) return at
  }
  return -1
}

const parsePhrases = (word, text) => {
  const phrases = []
  for (let item of text.split(/\s+--\s+/)) {
    item = item.trim().replace(/^--\s*/, '')
    const head = /^[^,.(]{1,60}/.exec(item)?.[0].trim()
    if (!head || head.split(' ').length > 6 || !new RegExp(`\\b${escape(word)}`, 'i').test(head)) continue
    let rest = item.slice(item.indexOf(head) + head.length)
    let label = head.replace(/^./, c => c.toLowerCase())
    rest = rest.replace(/^\.?\s*\(([^)]{1,25})\)\s*/, (m, d) => {
      if (DOMAIN[d]) label += ` (${DOMAIN[d]})`
      return ''
    }).replace(/^[.,]\s*/, '')
    // "For good, or For good and all, completely and finally"
    rest = rest.replace(/^or ([^,]{1,40}),\s*/, (_, alt) => {
      label += `, ${alt.replace(/^./, c => c.toLowerCase())}`
      return ''
    })
    rest = rest.replace(/^\(a\)\s*/, '').replace(/\s\([b-h]\)\s.*$/, '')
    if (!rest) continue
    const see = /^See (?:under )?([A-Z][\w'-]*)/.exec(rest)
    for (const s of parseSense(rest.replace(/^./, c => c.toUpperCase())).slice(0, 1))
      phrases.push({ ...s, l: s.l ? `${label}, ${s.l}` : label, ...(see ? { f: see[1].toLowerCase() } : {}) })
  }
  return phrases
}

const synonymsOf = (word, text) => {
  const first = sentences(text.replace(/^Syn[.,]\s*--\s*/, ''))[0] ?? ''
  return first.replace(/\.$/, '').split(/\s*[;,]\s*/)
    .map(w => w.replace(/^(?:To|to)\s+/, '').replace(/\s*\[.*$/, '').trim())
    .filter(w => w && w.split(' ').length <= 3 && /^[\p{L}' -]+$/u.test(w) && !/^See\b/.test(w))
    .map(w => (/^[A-Z][a-z]/.test(w) && !/ [A-Z]/.test(w) ? w.toLowerCase() : w))
    .filter(w => w.toLowerCase() !== word)
    .slice(0, 12)
}

/** Sense numbers in sequence: "1. … 2. …", not the verse in "Is. liii. 11." */
const senseMarks = body => {
  const marks = []
  const re = /(?:^|\s)(\d{1,2})\.\s+(?=["“(\[A-Z]|Etym|pl\.)/g
  let m
  let expect = 1
  while ((m = re.exec(body))) {
    if (+m[1] !== expect) continue
    if (/\s[ivxlc]+\.$/.test(body.slice(Math.max(0, m.index - 8), m.index))) continue
    marks.push({ at: m.index, from: m.index + m[0].length })
    expect++
  }
  return marks
}

/** One homograph ("1. To support … 16. To bring forth …  Syn. -- …"). */
const parseHomograph = (word, block, posOf) => {
  let text = block
    // derived words: -- Beau"ti*ful*ly, adv.
    .replace(/\s*--\s*[\w'-]*["*][\w"*'-]*,\s*(?:[a-z]{1,4}\.\s*)+/g, ' ')
    .replace(/- -/g, '--')
    .replace(/^To To /, 'To ')
    .replace(/\s+/g, ' ')
    .trim()
  // every abbreviation ends with a period, so this can't backtrack over ordinary words
  const form = /^((?:the )?preterit|(?:[a-z0-9]{1,6}\.\s?(?:&\s)?){1,6})\s*of (?:\d(?:st|d) (?:& \d(?:st|d) )?)?([A-Z][\w'-]*)\.?(?:\s*\[([^\]]+)\])?$/.exec(text)
  if (form) {
    const rel = FORM_NAMES.find(([re]) => re.test(form[1]))?.[1]
    const l = form[3] && labelsOf(`[${form[3]}]`).labels.join(', ')
    if (rel) return { form: { g: `${rel[0].toUpperCase()}${rel.slice(1)} of ${form[2].toLowerCase()}.`, f: form[2].toLowerCase(), ...(l ? { l } : {}) } }
  }
  let synonyms = []
  const syn = text.search(/\bSyn[.,]\s*--/)
  if (syn >= 0) {
    synonyms = synonymsOf(word, text.slice(syn))
    text = text.slice(0, syn).trim()
  }
  const marks = senseMarks(text)
  // phrases follow the last sense
  const last = marks.length ? marks[marks.length - 1].from : 0
  const p = phraseStart(word, text.slice(last))
  const phrases = p >= 0 ? parsePhrases(word, text.slice(last + p)) : []
  const body = p >= 0 ? text.slice(0, last + p) : text
  const senses = []
  if (marks.length < 2) senses.push(...parseNumbered(marks.length ? body.slice(marks[0].from) : body))
  else {
    const pre = body.slice(0, marks[0].at).trim()
    if (pre.length > 10) senses.push(...parseSense(pre.replace(/;\s*as:?$/, '.')))
    marks.forEach((mk, i) => senses.push(...parseNumbered(body.slice(mk.from, i + 1 < marks.length ? marks[i + 1].at : body.length))))
  }
  const group = { p: guessPos(senses, posOf), s: senses }
  if (synonyms.length) group.sy = synonyms
  return { group, phrases }
}

/**
 * Parses one Webster entry into { m: groups }, or null when nothing usable is left.
 * `posOf(word)` gives the parts of speech a word has ("noun", "verb", "adj", "adv"), used to
 * read one-word synonyms; `knownPos` is the set the headword itself is known to have.
 */
export const parseWebster = (word, text, { posOf, knownPos } = {}) => {
  const groups = []
  const phrases = []
  const forms = []
  for (const block of text.split(/\n\s*\n/)) {
    if (!block.trim()) continue
    const r = parseHomograph(word, block, posOf)
    if (r.form) {
      forms.push(r.form)
      continue
    }
    if (r.group.s.length) {
      // only claim a part of speech the word is known to have
      if (r.group.p && knownPos && !knownPos.has(r.group.p)) r.group.p = ''
      // "To run" (intransitive) and "To run" (transitive) read as one verb
      const prev = groups[groups.length - 1]
      if (prev && prev.p && prev.p === r.group.p) {
        prev.s.push(...r.group.s)
        if (r.group.sy) prev.sy = [...new Set([...(prev.sy ?? []), ...r.group.sy])].slice(0, 12)
      } else groups.push(r.group)
    }
    phrases.push(...r.phrases)
  }
  // "imp. of Run." leads: "ran" is mostly the past of run
  if (forms.length) groups.unshift({ p: '', s: forms })
  if (phrases.length) groups.push({ p: 'phrase', s: phrases.slice(0, 40) })
  return groups.length ? { m: groups } : null
}
