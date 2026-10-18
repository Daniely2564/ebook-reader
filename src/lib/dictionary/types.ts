export interface Sense {
  def: string
  examples: string[]
  synonyms: string[]
  antonyms: string[]
  typeOf: string[]
}

export interface Meaning {
  pos: string
  senses: Sense[]
}

export interface DictEntry {
  word: string
  ipa?: string
  /** "running" → "run" */
  formOf?: string
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
}
