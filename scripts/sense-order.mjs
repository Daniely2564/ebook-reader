// Orders the senses of the built-in dictionaries for readers: the common meaning first.
//
// Wiktionary and Webster list senses roughly in historical order ("fair": "unblemished"
// before "just"; "light": the physics definition first), and WordNet lists nouns before
// verbs ("bear": the animal before "endure"). This uses the sense frequencies WordNet
// records from its tagged corpus (SemCor, in index.sense) to
//   - put the part of speech a word is mostly used as first ("bear" → verb, "still" → adverb),
//   - move senses that match a frequent WordNet sense up ("fair" → "just"),
// and moves obsolete, archaic, rare, slang, regional and specialist senses down.
// Senses refining the one before them ("by extension", "specifically") stay with it, and
// "past tense of …" senses keep their place, since lookups follow them to the lemma.

const POS_KEY = { noun: 'n', verb: 'v', adj: 'a', adv: 'r', n: 'n', v: 'v', a: 'a', r: 'r', s: 'a' }

// label → how far down it sorts (anything not listed is a topic: 1)
const TIERS = new Map()
const tier = (n, labels) => labels.split('|').forEach(l => TIERS.set(l, n))
tier(0, 'transitive|intransitive|ambitransitive|ditransitive|reflexive|ergative|stative|impersonal|countable|uncountable|' +
  'not comparable|comparable|attributive|predicative|in the plural|usually in the plural|chiefly in the plural|often in the plural|' +
  'collective|of a person|of people|of a thing|with infinitive|with to|usually|often|especially|informal|colloquial|formal|' +
  'idiomatic|humorous|literary|literally|emphatic|intensifier|sometimes derogatory|UK|US|British|American|chiefly UK|chiefly US|' +
  'chiefly British|Commonwealth|North America|plural|singular|auxiliary|modal|copulative|passive|usually passive|' +
  'in the singular|in the negative|chiefly in the negative|often in the negative|ironic|sarcastic|euphemistic|WordNet|' +
  // what an animal or plant is, not a specialist sense
  'zoology|botany|' +
  // Wiktionary's semantic classes of adverbs and the like
  'aspect|degree|manner|conjunctive|extensive|focus|frequency|time|temporal|location|place|evaluative|epistemic|' +
  'modal|sentence adverb|speech act|discourse marker|interrogative|relative|demonstrative|deictic|quantifier|' +
  'with a negative|as a modifier|ordinal|cardinal|definite|indefinite')
tier(2, 'slang|Internet slang|fandom slang|vulgar|derogatory|often derogatory|offensive|ethnic slur|dialect|dialectal|' +
  'UK dialectal|regional|Scotland|chiefly Scotland|Ireland|Northern England|India|Philippines|Singapore|South Africa|' +
  'New Zealand|Australia|Canada|African-American Vernacular|MLE|Southern US|Appalachia|Newfoundland|text messaging|' +
  'childish|cant|Scotland|western US|Latinism|recent|neologism|nonce word|jargon|vulgar slang|Multicultural London English')
tier(3, 'rare|very rare|now rare|uncommon|dated|now dated|poetic|nonstandard|proscribed|misspelling|eye dialect|' +
  'obsolescent|archaic or obsolete|rare or obsolete|chiefly poetic')
tier(4, 'obsolete|archaic|historical|now historical|obsolete or dialectal|now chiefly dialectal|archaic or dialectal|' +
  'now archaic|obsolete except in dialects|obsolete except dialectal')
// a sense that elaborates the one before it
const DERIVED = /^(?:by extension|specifically|loosely|broadly|by metonymy|metonymically|in particular|more generally|generally|by analogy|hence)$/

export const tierOf = labels => {
  let t = 0
  for (const l of (labels ?? '').split(/,\s*/)) {
    if (!l || DERIVED.test(l)) continue
    t = Math.max(t, TIERS.get(l) ?? (/^(?:now |chiefly |often |sometimes |usually )/.test(l) ? TIERS.get(l.replace(/^\S+ /, '')) ?? 1 : 1))
  }
  return t
}
const isDerived = labels => (labels ?? '').split(/,\s*/).some(l => DERIVED.test(l))
// "simple past of run", "plural of goose", "alternative form of colour"
const FORM_GLOSS = /\b(?:plural|past|participle|present|comparative|superlative|person|gerund|singular|inflection|spelling|form|preterit)\b[^.;]{0,40}\b(?:of|for)\b/i
const isForm = s => !!s?.f || FORM_GLOSS.test(s?.g ?? '')
const ALT_FORM = /^(?:(?:obsolete|archaic|rare|dated|nonstandard|eye[- ]dialect|alternative|alternate|variant|misspelling|less common)\b[^.;]{0,30}\b(?:form|spelling|of)\b)/i
// how much two glosses must share (sum of idf) to count as the same sense
const MATCH = 7

// ---------------------------------------------------------------- matching senses to WordNet
const STOP = new Set(('a an the of to in on at by for with from as or and but not no nor that this these those which who whom ' +
  'whose what when where how it its is are was were be been being has have had do does did so such than then there their ' +
  'they them one ones any some all each every other another into onto upon about over under out up down off very more most ' +
  'less least also especially usually often esp etc e g i ie eg used use using make made being something someone thing things ' +
  'person people way kind sort act state quality certain particular given various small large good').split(' '))
const stem = w => w.replace(/(?:ies)$/, 'y').replace(/(?:ing|ed|es|s|ly)$/, '').replace(/e$/, '')
const tokens = text => (text.toLowerCase().match(/[a-z]+/g) ?? []).filter(w => w.length > 2 && !STOP.has(w)).map(stem)

/**
 * @param wordnet   Map lemma → { m: [[pos, senses]] } with WordNet senses
 *                  [definition, examples, synonyms?, antonyms?, typeOf?] in WordNet order
 * @param counts    Map `${lemma}|${pos}` → tag count of each sense, in the same order
 */
export const createOrdering = (wordnet, counts) => {
  // inverse document frequency over WordNet's glosses
  const df = new Map()
  let docs = 0
  for (const entry of wordnet.values()) {
    for (const [, senses] of entry.m) {
      for (const [def, ex] of senses) {
        docs++
        for (const t of new Set(tokens(`${def} ${ex.join(' ')}`))) df.set(t, (df.get(t) ?? 0) + 1)
      }
    }
  }
  const idf = t => Math.log(docs / ((df.get(t) ?? 0) + 1))

  const posCounts = word => {
    const out = { n: 0, v: 0, a: 0, r: 0 }
    for (const p of 'nvar') for (const c of counts.get(`${word}|${p}`) ?? []) out[p] += c
    return out
  }

  /** A word's WordNet senses (of one part of speech) as bags of words, with their counts. */
  const wordnetSenses = (word, pos) => {
    const entry = wordnet.get(word)
    const list = counts.get(`${word}|${pos}`) ?? []
    const senses = entry?.m.filter(([p]) => POS_KEY[p] === pos).flatMap(([, s]) => s) ?? []
    // the word itself and words made from it ("lighten" for light) don't tell senses apart
    const self = stem(word)
    const own = t => t === self || (self.length >= 4 && t.startsWith(self))
    return senses.map(([def, ex, syn = [], , typeOf = []], i) => {
      const gloss = new Set(tokens(`${def} ${syn.join(' ')} ${typeOf.join(' ')}`).filter(t => !own(t)))
      const examples = new Set(tokens(ex.join(' ')).filter(t => !own(t) && !gloss.has(t)))
      return { count: list[i] ?? 0, gloss: def, ex, syn, words: gloss, examples }
    })
  }

  // words shared with the definition count fully, words shared with its examples half
  const similarity = (sense, text) => {
    let score = 0
    for (const t of new Set(tokens(text))) score += sense.words.has(t) ? idf(t) : sense.examples.has(t) ? idf(t) / 2 : 0
    return score
  }

  /**
   * Sorts one part of speech's senses: by tier, and within a tier the senses matching a
   * WordNet sense used more than any unmatched one first, the rest in their order. Returns
   * the senses, the highest count matched, and whether they are all slang, regional, rare
   * or obsolete. With `fill`, frequent WordNet meanings nothing resembles are added.
   */
  const orderSenses = (word, pos, senses, { fill = false } = {}) => {
    // clusters: a sense and the senses elaborating it
    const clusters = []
    senses.forEach((s, i) => {
      // "simple past of run" leading a group: lookups follow it to the lemma
      if (i === 0 && isForm(s)) clusters.push({ items: [s], fixed: true, tier: 0, score: 0, i })
      else if (ALT_FORM.test(s.g)) clusters.push({ items: [s], tier: 3, score: 0, i })
      else if (clusters.length && !clusters[clusters.length - 1].fixed && isDerived(s.l)) clusters[clusters.length - 1].items.push(s)
      else clusters.push({ items: [s], tier: tierOf(s.l), score: 0, i })
    })
    const wn = POS_KEY[pos] ? wordnetSenses(word, POS_KEY[pos]) : []
    const total = wn.reduce((n, f) => n + f.count, 0)
    if (total) {
      // each sense's clearly best WordNet match; a WordNet sense goes to the closest of the senses choosing it
      const claims = new Map()
      const closest = wn.map(() => 0)
      clusters.forEach((c, ci) => {
        const head = c.items[0]
        const sims = wn.map(f => similarity(f, `${head.g} ${(head.s ?? []).join(' ')}`))
        sims.forEach((v, fi) => (closest[fi] = Math.max(closest[fi], v)))
        if (c.fixed || c.tier > 1) return
        const order = sims.map((v, fi) => [v, fi]).sort((a, b) => b[0] - a[0])
        const [[best, fi], second = [0]] = order
        if (best < MATCH || best < 1.25 * second[0] || !wn[fi].count) return
        const prev = claims.get(fi)
        if (!prev || prev.sim < best) claims.set(fi, { ci, sim: best })
      })
      for (const [fi, { ci }] of claims) clusters[ci].score = wn[fi].count
      // a frequent meaning nothing here resembles was cut from a long entry: add WordNet's
      let added = 0
      if (fill) {
        wn.forEach((f, fi) => {
          // a gloss of a word or two ("have") is no evidence that the meaning is missing
          if (added >= 3 || claims.has(fi) || f.count < 5 || f.count < 0.1 * total || closest[fi] >= 4 || f.words.size < 3) return
          // "(mathematics) an abstract collection…"
          const topic = /^\(([^)]{2,30})\)\s*/.exec(f.gloss)
          const text = topic ? f.gloss.slice(topic[0].length) : f.gloss
          const g = `${text[0].toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`
          const sense = { g, l: topic ? `WordNet, ${topic[1]}` : 'WordNet' }
          if (f.ex.length) sense.x = f.ex.slice(0, 2)
          if (f.syn.length) sense.s = f.syn.slice(0, 5)
          clusters.push({ items: [sense], tier: topic ? 1 : 0, score: f.count, i: senses.length + added, filled: true })
          claims.set(fi, { ci: clusters.length - 1, sim: 0 })
          added++
        })
      }
      // a matched sense moves up only when it is used more than every meaning left unmatched
      // (those could be any of the other senses); a WordNet meaning that was added goes
      // where WordNet ranks it among the word's uses
      const unmatched = Math.max(0, ...wn.filter((_, fi) => !claims.has(fi)).map(f => f.count))
      for (const [, { ci }] of claims) if (clusters[ci].score > unmatched) clusters[ci].promoted = true
      for (const t of new Set(clusters.map(c => c.tier))) {
        const elsewhere = new Set([...claims].filter(([, c]) => clusters[c.ci].tier !== t).map(([fi]) => fi))
        const ranked = wn.map((f, fi) => [f.count, fi]).filter(([n, fi]) => n > 0 && !elsewhere.has(fi)).sort((a, b) => b[0] - a[0]).map(([, fi]) => fi)
        for (const [fi, { ci }] of claims) if (clusters[ci].filled && clusters[ci].tier === t) clusters[ci].rank = ranked.indexOf(fi)
      }
    }
    const ordered = []
    for (const t of [...new Set(clusters.filter(c => !c.fixed).map(c => c.tier))].sort((a, b) => a - b)) {
      const list = clusters.filter(c => !c.fixed && !c.filled && c.tier === t)
      const seq = [...list.filter(c => c.promoted).sort((a, b) => b.score - a.score), ...list.filter(c => !c.promoted)]
      for (const c of clusters.filter(c => c.filled && c.tier === t).sort((a, b) => a.rank - b.rank)) seq.splice(Math.min(c.rank, seq.length), 0, c)
      ordered.push(...seq)
    }
    let k = 0
    const out = clusters.map(c => (c.fixed ? c : ordered[k++]))
    return {
      senses: out.flatMap(c => c.items),
      best: Math.max(0, ...clusters.map(c => c.score)),
      minor: clusters.every(c => c.tier >= 2),
    }
  }

  /**
   * Orders the groups ({ p: pos, s: senses }) of a Wiktionary or Webster entry and the
   * senses in each. Groups of a WordNet part of speech trade places by how often the word
   * is used as each, then by their most frequent sense; other groups ("prep", "phrase",
   * unknown), and a first group leading with "past tense of …", stay where they are.
   * With `fill`, a long group missing one of the word's frequent meanings gets WordNet's.
   */
  const orderGroups = (word, groups, { fill = false } = {}) => {
    const pc = posCounts(word)
    const total = pc.n + pc.v + pc.a + pc.r
    const info = groups.map((g, i) => {
      // the distilled Wiktionary keeps 12 senses per part of speech
      const { senses, best, minor } = g.s.length > 1 ? orderSenses(word, g.p, g.s, { fill: fill && g.s.length >= 12 }) : { senses: g.s, best: 0, minor: g.s.every(s => tierOf(s.l) >= 2) }
      // only slang, regional, rare or obsolete senses: the app leaves it out of the short card
      return { g: { ...g, s: senses, ...(minor ? { lo: 1 } : {}) }, i, best, minor, pos: POS_KEY[g.p] }
    })
    const slots = info.filter(x => x.pos && !(x.i === 0 && isForm(x.g.s[0]))).map(x => x.i)
    const weight = x => (x.minor ? -1e9 : 0) + (total ? pc[x.pos] * 1000 : 0) + Math.min(x.best, 999)
    const sorted = slots.map(i => info[i]).sort((a, b) => weight(b) - weight(a) || a.i - b.i)
    const out = info.map(x => x.g)
    slots.forEach((slot, k) => (out[slot] = sorted[k].g))
    return out
  }

  /** WordNet entries: the part of speech the word is mostly used as first. */
  const orderWordNet = (word, m) => {
    const pc = posCounts(word)
    if (!(pc.n + pc.v + pc.a + pc.r)) return m
    return m.map((x, i) => [x, i]).sort((a, b) => pc[POS_KEY[b[0][0]]] - pc[POS_KEY[a[0][0]]] || a[1] - b[1]).map(([x]) => x)
  }

  return { orderGroups, orderWordNet, posCounts }
}
