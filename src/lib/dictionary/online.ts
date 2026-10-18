// Optional online sources, used only when enabled in settings.
import { sanitizeHtml, stripHtml } from './sanitize'
import type { DictEntry } from './types'

const LANG_NAMES = new Intl.DisplayNames(['en'], { type: 'language' })
const langName = (code: string) => {
  try {
    return LANG_NAMES.of(code) ?? code
  } catch {
    return code
  }
}

const getJson = async (url: string, signal?: AbortSignal) => {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

interface WiktionaryDef { definition: string; examples?: string[] }
interface WiktionaryUsage { partOfSpeech: string; language: string; definitions: WiktionaryDef[] }

/** Wiktionary definitions for any language; the book's language is listed first. */
export const lookupWiktionary = async (word: string, lang = 'en', signal?: AbortSignal): Promise<DictEntry[]> => {
  const tryWord = async (w: string) => {
    try {
      return await getJson(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w)}?redirect=true`, signal) as Record<string, WiktionaryUsage[]>
    } catch {
      return null
    }
  }
  let data = await tryWord(word)
  if (!data && word !== word.toLowerCase()) data = await tryWord(word.toLowerCase())
  if (!data) return []
  const langs = Object.keys(data).sort((a, b) =>
    (a === lang ? -2 : a === 'en' ? -1 : 0) - (b === lang ? -2 : b === 'en' ? -1 : 0))
  const html: string[] = []
  for (const code of langs.slice(0, 4)) {
    const usages = data[code]
    html.push(`<div class="dict-lang">${usages[0]?.language || langName(code)}</div>`)
    for (const u of usages) {
      const defs = u.definitions.filter(d => stripHtml(d.definition))
      if (!defs.length) continue
      html.push(`<div class="dict-pos">${u.partOfSpeech.toLowerCase()}</div><ol class="dict-senses">`)
      for (const d of defs.slice(0, 6)) {
        html.push(`<li>${sanitizeHtml(d.definition)}`)
        for (const ex of (d.examples ?? []).slice(0, 1)) html.push(`<div class="dict-ex">${sanitizeHtml(ex)}</div>`)
        html.push('</li>')
      }
      html.push('</ol>')
    }
  }
  return [{ word, html: html.join(''), url: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}` }]
}

/** English pronunciation audio + phonetics from the Free Dictionary API. */
export const lookupPronunciation = async (word: string, signal?: AbortSignal) => {
  try {
    const data = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`, signal)
    for (const entry of data) {
      for (const p of entry.phonetics ?? []) if (p.audio) return { audio: p.audio as string, text: (p.text ?? entry.phonetic) as string | undefined }
    }
  } catch { /* offline or not found */ }
  return null
}

export const lookupWikipedia = async (query: string, lang = 'en', signal?: AbortSignal): Promise<DictEntry[]> => {
  const tryLang = async (l: string) => {
    try {
      const d = await getJson(`https://${l}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query.replace(/ /g, '_'))}?redirect=true`, signal)
      if (d.type === 'disambiguation' && !d.extract) return null
      return d
    } catch {
      return null
    }
  }
  const d = (lang !== 'en' && await tryLang(lang)) || await tryLang('en')
  if (!d?.extract) return []
  const div = document.createElement('div')
  div.textContent = d.extract
  return [{
    word: d.title,
    html: `${d.description ? `<div class="dict-pos">${sanitizeHtml(d.description)}</div>` : ''}<p>${div.innerHTML}</p>`,
    url: d.content_urls?.desktop?.page,
    image: d.thumbnail?.source,
  }]
}
