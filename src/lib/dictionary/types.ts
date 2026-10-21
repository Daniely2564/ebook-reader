export interface Sense {
  def: string
  examples: string[]
  synonyms: string[]
  antonyms: string[]
  typeOf: string[]
  /** "transitive", "archaic", "botany" */
  label?: string
  /** headword this sense points at ("simple past of run" → "run") */
  formOf?: string
}

export interface Meaning {
  pos: string
  senses: Sense[]
  /** spelling when it differs from the headword ("RAN", "Nasa") */
  display?: string
  /** irregular forms ("geese", "went, gone") */
  forms?: string[]
  synonyms?: string[]
  antonyms?: string[]
}

export interface DictEntry {
  word: string
  ipa?: string
  /** British pronunciation when it differs */
  ipaAlt?: string
  /** "running" → "run" */
  formOf?: string
  /** how formOf relates to the word ("present participle") */
  relation?: string
  etymology?: string[]
  /** words in the reader's language, grouped by sense */
  translations?: { lang: string; senses: [string, string[]][] }
  meanings?: Meaning[]
  /** sanitized HTML (user dictionaries, Wiktionary, Wikipedia) */
  html?: string
  audio?: string
  url?: string
  image?: string
}

export interface DictSource {
  id: string
  name: string
  kind: 'offline' | 'user' | 'online'
}

export interface DictResult {
  source: DictSource
  entries: DictEntry[]
}

export const POS_LABEL: Record<string, string> = {
  n: 'noun', v: 'verb', a: 'adjective', s: 'adjective', r: 'adverb',
  article: 'article', pron: 'pronoun', prep: 'preposition', conj: 'conjunction', det: 'determiner',
  particle: 'particle', contraction: 'contraction', intj: 'interjection',
  noun: 'noun', verb: 'verb', adj: 'adjective', adv: 'adverb', num: 'numeral', abbrev: 'abbreviation',
  phrase: 'phrase', prep_phrase: 'prepositional phrase', adv_phrase: 'adverbial phrase', proverb: 'proverb',
  postp: 'postposition',
}
