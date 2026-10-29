import { ArrowLeft, Check, Copy, ExternalLink, Globe, Languages, Star, Volume2, WifiOff } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { addLookupHistory, didYouMean, isOnlineSource, languageName, listSources, lookupOffline, lookupOnline, normalizeQuery, ONLINE_SOURCES, type DictEntry, type DictResult, type DictSource, type Meaning, type OnlineSourceId, type Sense } from '../lib/dictionary'
import { lookupPronunciation } from '../lib/dictionary/online'
import { stripHtml } from '../lib/dictionary/sanitize'
import { deleteVocab, getVocab, putVocab, uid } from '../lib/db'
import { openExternal } from '../lib/platform'
import { useSettings } from '../lib/settings'
import { toast, useApp } from '../lib/store'
import { getVoices, sayWord } from '../lib/tts'
import { IconButton, Spinner } from '../components/ui'

let savedWords: Promise<Map<string, string>> | null = null
const loadSaved = () => savedWords ??= getVocab()
  .then(list => new Map(list.map(v => [v.word.toLowerCase(), v.id])))
  .catch(() => new Map())
export const invalidateSavedWords = () => {
  savedWords = null
}
// words saved or removed on another device
useApp.subscribe((s, prev) => {
  if (s.syncVersion !== prev.syncVersion) invalidateSavedWords()
})

const firstDefinition = (r: DictResult | undefined) => {
  // the word's own meaning ("better"), not its lemma's ("good") when it has one
  const e = r?.entries.find(x => !x.formOf) ?? r?.entries[0]
  if (!e) return ''
  const via = e.formOf ? `${e.relation ? `${e.relation} of ` : '→ '}${e.word}: ` : ''
  if (e.meanings?.[0]?.senses[0]) return `${via}(${e.meanings[0].pos}) ${e.meanings[0].senses[0].def}`
  return e.html ? via + stripHtml(e.html).slice(0, 240) : ''
}

interface Props {
  word: string
  context?: string
  lang?: string
  bookId?: string
  bookTitle?: string
  compact?: boolean
}

/** An online lookup: its entry, null when the source has none, or 'error' when it couldn't be reached. */
type OnlineState = DictResult | null | 'loading' | 'error'

// one tap to the big dictionaries' own pages
const WEB_DICTIONARIES: { name: string; url: (w: string) => string }[] = [
  { name: 'Merriam-Webster', url: w => `https://www.merriam-webster.com/dictionary/${encodeURIComponent(w)}` },
  { name: 'Cambridge', url: w => `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(w.replace(/ /g, '-'))}` },
  { name: 'Oxford Learner’s', url: w => `https://www.oxfordlearnersdictionaries.com/search/english/?q=${encodeURIComponent(w)}` },
  { name: 'Collins', url: w => `https://www.collinsdictionary.com/dictionary/english/${encodeURIComponent(w.replace(/ /g, '-'))}` },
  { name: 'Longman', url: w => `https://www.ldoceonline.com/search/english/direct/?q=${encodeURIComponent(w)}` },
  { name: 'Dictionary.com', url: w => `https://www.dictionary.com/browse/${encodeURIComponent(w)}` },
  { name: 'Vocabulary.com', url: w => `https://www.vocabulary.com/dictionary/${encodeURIComponent(w)}` },
  { name: 'Etymonline', url: w => `https://www.etymonline.com/search?q=${encodeURIComponent(w)}` },
  { name: 'Google', url: w => `https://www.google.com/search?q=${encodeURIComponent(`define ${w}`)}` },
]

export const DictionaryView = ({ word: initial, context, lang, bookId, bookTitle, compact }: Props) => {
  const [stack, setStack] = useState([normalizeQuery(initial)])
  useEffect(() => setStack([normalizeQuery(initial)]), [initial])
  const word = stack[stack.length - 1]
  const onlineEnabled = useSettings(s => s.onlineLookup)
  const translateTo = useSettings(s => s.translateTo)
  const ttsVoice = useSettings(s => s.ttsVoice)
  const dictDisabled = useSettings(s => s.dictDisabled)
  const isEnglish = !lang || lang.toLowerCase().startsWith('en')
  // the dictionary picked last is remembered per book language
  const langKey = isEnglish ? 'en' : lang!.slice(0, 2).toLowerCase()
  const preferred = useSettings(s => s.dictTabs[langKey])
  const setSettings = useSettings(s => s.set)

  const [sources, setSources] = useState<DictSource[]>([])
  const [offline, setOffline] = useState<DictResult[] | null>(null)
  const [online, setOnline] = useState<Record<string, OnlineState>>({})
  const [retry, setRetry] = useState(0)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [savedId, setSavedId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [webOpen, setWebOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setOffline(null)
    setOnline({})
    setSuggestions([])
    setExpanded(false)
    const offlineLookup = lookupOffline(word).catch(e => {
      console.warn('Lookup failed', e)
      return [] as DictResult[]
    })
    Promise.all([listSources().catch(() => [] as DictSource[]), offlineLookup]).then(([list, res]) => {
      if (!alive) return
      setSources(list)
      setOffline(res)
      if (res.length) addLookupHistory(word)
      else if (isEnglish) didYouMean(word).then(s => alive && setSuggestions(s.filter(x => x !== word.toLowerCase())))
    })
    loadSaved().then(m => alive && setSavedId(m.get(word.toLowerCase()) ?? null))
    return () => {
      alive = false
    }
  }, [word, onlineEnabled, isEnglish, dictDisabled, translateTo])

  // The dictionary picked last, as long as it is still available; otherwise the first one
  // with an entry (an imported dictionary first for books in other languages). It never
  // changes on its own: when the chosen dictionary has nothing, that is said below it.
  const tab = useMemo(() => {
    if (!offline) return ''
    if (preferred && sources.some(s => s.id === preferred)) return preferred
    const first = (!isEnglish ? offline.find(r => r.source.kind === 'user') : undefined) ?? offline[0]
    return first?.source.id ?? (onlineEnabled ? ONLINE_SOURCES[0].id : sources[0]?.id ?? '')
  }, [offline, sources, preferred, isEnglish, onlineEnabled])

  useEffect(() => {
    if (!isOnlineSource(tab) || offline === null) return
    if (online[tab] !== undefined && online[tab] !== 'error') return
    const ctrl = new AbortController()
    const source: OnlineSourceId = tab
    setOnline(o => ({ ...o, [source]: 'loading' }))
    const done = (r: OnlineState) => {
      if (ctrl.signal.aborted) return
      setOnline(o => ({ ...o, [source]: r }))
      if (r && r !== 'error' && r !== 'loading') addLookupHistory(word)
    }
    lookupOnline(word, source, lang?.slice(0, 2), ctrl.signal).then(done, e => {
      if (!ctrl.signal.aborted) console.warn(`${source} lookup failed`, e)
      done('error')
    })
    return () => {
      ctrl.abort()
      // an interrupted lookup is retried when its tab is opened again
      setOnline(o => {
        if (o[source] !== 'loading') return o
        const { [source]: _, ...rest } = o
        return rest
      })
    }
  }, [tab, word, lang, offline, retry]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [tab, word])

  // keep the chosen dictionary's tab in view when the tabs scroll
  useEffect(() => {
    const row = tabsRef.current
    const on = row?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (row && on && (on.offsetLeft < row.scrollLeft || on.offsetLeft + on.offsetWidth > row.scrollLeft + row.clientWidth))
      row.scrollTo({ left: on.offsetLeft - 18 })
  }, [tab, sources])

  const push = (w: string) => setStack(s => [...s, normalizeQuery(w)])
  const pickTab = (id: string) => {
    if (id === tab && online[id] === 'error') setRetry(n => n + 1)
    if (id !== preferred) setSettings({ dictTabs: { ...useSettings.getState().dictTabs, [langKey]: id } })
  }

  const state: OnlineState | undefined = isOnlineSource(tab) ? online[tab] : offline?.find(r => r.source.id === tab) ?? null
  const current = state && typeof state === 'object' ? state : null
  const loading = offline === null || state === 'loading' || (isOnlineSource(tab) && state === undefined)
  // the chosen dictionary has nothing: show the first offline one that does, under it
  const fallback = !loading && !current ? offline?.find(r => r.source.id !== tab) : undefined
  const shown = current ?? fallback
  const tabName = sources.find(s => s.id === tab)?.name ?? ONLINE_SOURCES.find(s => s.id === tab)?.name ?? ''
  const isEmpty = (id: string) => (isOnlineSource(id) ? online[id] === null || online[id] === 'error' : !!offline && !offline.some(r => r.source.id === id))

  const head = offline?.[0]?.entries[0]
  const headword = head && !head.formOf ? head.word : word
  // pronunciation of the word itself, not of the lemma it was found under; the built-in
  // dictionaries are English, so for other books only imported dictionaries count
  const own = offline
    ?.filter(r => isEnglish || r.source.kind === 'user')
    .flatMap(r => r.entries)
    .filter(e => !e.formOf && e.word.toLowerCase() === headword.toLowerCase())
  const sounds = own?.find(e => e.ipa)
  const ipa = sounds?.ipa
  const ipaAlt = sounds?.ipaAlt
  const recording = own?.find(e => e.audio)?.audio

  const speak = async () => {
    if (onlineEnabled && recording) {
      // a recorded pronunciation from Wikimedia Commons beats synthetic speech, unless
      // it fails or doesn't start soon (slow or captive network)
      const audio = new Audio(recording)
      const played = await Promise.race([
        audio.play().then(() => true, () => false),
        new Promise<boolean>(r => setTimeout(() => r(false), 2500)),
      ])
      if (played) return
      audio.pause()
      audio.removeAttribute('src')
    }
    const voices = await getVoices()
    if (voices.length) {
      sayWord(headword, lang?.startsWith('en') || !lang ? 'en-US' : lang, ttsVoice)
      return
    }
    if (onlineEnabled) {
      const p = await lookupPronunciation(headword)
      if (p?.audio) {
        new Audio(p.audio).play().catch(() => {})
        return
      }
    }
    toast('No text-to-speech voice is available on this device')
  }

  const toggleSave = async () => {
    if (savedId) {
      await deleteVocab(savedId)
      setSavedId(null)
      invalidateSavedWords()
      toast(`Removed “${headword}” from vocabulary`)
      return
    }
    const definition = firstDefinition(shown?.source.kind === 'online' ? undefined : shown) || firstDefinition(offline?.[0]) || firstDefinition(current ?? undefined)
    const id = uid()
    await putVocab({ id, word: headword, definition, ipa, context, bookId, bookTitle, createdAt: Date.now() })
    setSavedId(id)
    invalidateSavedWords()
    toast(`Saved “${headword}” to vocabulary`, 'success')
  }

  const onHtmlClick = (e: React.MouseEvent) => {
    const el = (e.target as Element).closest('[data-lookup]')
    if (el) {
      e.preventDefault()
      push(el.getAttribute('data-lookup')!)
    }
  }

  const translateText = context && context.length < 400 && !compact ? context : word

  return (
    <div className={`dict ${compact ? 'compact' : ''}`}>
      <div className="dict-head">
        {stack.length > 1 && (
          <IconButton label="Back" onClick={() => setStack(s => s.slice(0, -1))}><ArrowLeft size={18} /></IconButton>
        )}
        <div className="dict-word">
          <h2 lang={lang}>{headword}</h2>
          {ipa && <span className="dict-ipa">/{ipa}/{ipaAlt && <span className="dict-ipa-alt"> · UK /{ipaAlt}/</span>}</span>}
        </div>
        <div className="dict-head-actions">
          <IconButton label="Pronounce" onClick={speak}><Volume2 size={18} /></IconButton>
          <IconButton label={savedId ? 'Remove from vocabulary' : 'Save to vocabulary'} active={!!savedId} onClick={toggleSave}>
            <Star size={18} fill={savedId ? 'currentColor' : 'none'} />
          </IconButton>
        </div>
      </div>

      {sources.length > 1 && (
        <div className="dict-tabs" role="tablist" ref={tabsRef}>
          {sources.map(s => (
            <button key={s.id} role="tab" aria-selected={s.id === tab} className={`${s.id === tab ? 'on' : ''} ${isEmpty(s.id) ? 'empty' : ''}`}
              title={isEmpty(s.id) ? `No entry in ${s.name}` : undefined} onClick={() => pickTab(s.id)}>
              {s.kind === 'online' && <Globe size={12} />}{s.name}
            </button>
          ))}
        </div>
      )}

      <div className="dict-body" ref={bodyRef}>
        {loading && <div className="dict-loading"><Spinner size={18} /></div>}
        {!loading && !current && (
          <div className="dict-none">
            {state === 'error'
              ? (
                <p className={fallback ? 'dict-miss' : undefined}>
                  <WifiOff size={13} /> Couldn’t reach {tabName}.{' '}
                  <button className="link-btn" onClick={() => setRetry(n => n + 1)}>Try again</button>
                </p>
              )
              : (
                <p className={fallback ? 'dict-miss' : undefined}>
                  {tab ? <>No entry for <b>{word}</b> in {tabName}.</> : <>No definition found for <b>{word}</b>.</>}
                </p>
              )}
            {!fallback && suggestions.length > 0 && (
              <div className="dict-chips">
                <span className="muted">Did you mean</span>
                {suggestions.map(s => <button key={s} className="chip-btn" onClick={() => push(s)}>{s}</button>)}
              </div>
            )}
            {!fallback && !onlineEnabled && <p className="muted small"><WifiOff size={13} /> Online sources are turned off in Settings.</p>}
            {!isEnglish && !offline?.length && <p className="muted small">Tip: import a StarDict dictionary for this language in Settings → Dictionaries.</p>}
            {fallback && <div className="dict-from">From {fallback.source.name}</div>}
          </div>
        )}
        {!loading && shown?.entries.map((e, i) => (
          <EntryView key={`${shown.source.id}-${i}`} entry={e} compact={compact && !expanded} onLookup={push} onHtmlClick={onHtmlClick} showWord={i > 0 || !!e.formOf || shown.source.kind !== 'offline'} />
        ))}
        {!loading && compact && !expanded && shown && shown.source.kind !== 'online' && hasMore(shown.entries) && (
          <button className="link-btn" onClick={() => setExpanded(true)}>
            {countSenses(shown.entries) > 4 ? `Show all ${countSenses(shown.entries)} definitions` : 'Show more'}
          </button>
        )}
      </div>

      {webOpen && (
        <div className="dict-web" aria-label="Look up on the web">
          {WEB_DICTIONARIES.map(d => (
            <button key={d.name} className="chip-btn" onClick={() => openExternal(d.url(headword))}>{d.name}</button>
          ))}
        </div>
      )}
      <div className="dict-foot">
        <button className="link-btn" onClick={() => openExternal(`https://translate.google.com/?sl=auto&tl=${translateTo}&text=${encodeURIComponent(translateText)}&op=translate`)}>
          <Languages size={14} />Translate
        </button>
        <button className={`link-btn ${webOpen ? 'on' : ''}`} aria-expanded={webOpen} onClick={() => setWebOpen(o => !o)}>
          <ExternalLink size={14} />Web
        </button>
        <CopyButton text={headword} />
        {shown && shown.source.kind !== 'online' && (
          <span className="dict-source"><Check size={12} />Offline</span>
        )}
      </div>
    </div>
  )
}

const countSenses = (entries: DictEntry[]) => entries.reduce((n, e) => n + (e.meanings?.reduce((m, x) => m + x.senses.length, 0) ?? 0), 0)

/**
 * What the short card shows of an entry: the first senses of the main part of speech and
 * the first sense of up to two others ("bear": endure, carry… and the animal), leaving out
 * phrases and parts of speech that are only slang, regional, rare or obsolete.
 */
const compactPlan = (meanings: Meaning[] = []) => {
  const main = meanings.filter(m => !m.minor && m.pos !== 'phrase')
  const list = (main.length ? main : meanings).slice(0, 3)
  return list.map((m, i) => ({ meaning: m, senses: m.senses.slice(0, i ? 1 : list.length > 1 ? 3 : 4) }))
}

// whether the compact card (EntryView with compact) leaves anything out
const hasMore = (entries: DictEntry[]) => entries.some(e =>
  compactPlan(e.meanings).reduce((n, p) => n + p.senses.length, 0) < countSenses([e])
  || !!e.etymology?.length || (e.translations?.senses.length ?? 0) > 3
  || e.meanings?.some(m => m.synonyms?.length || m.antonyms?.length
    || m.senses.some(s => s.examples.length > 1 || s.synonyms.length > 4 || s.antonyms.length > 4 || s.note)))

const Chips = ({ synonyms = [], antonyms = [], max, onLookup }: { synonyms?: string[]; antonyms?: string[]; max: number; onLookup: (w: string) => void }) => {
  if (!synonyms.length && !antonyms.length) return null
  return (
    <div className="dict-rel">
      {synonyms.length > 0 && <span className="dict-rel-label">Similar</span>}
      {synonyms.slice(0, max).map(w => <button key={w} className="chip-btn" onClick={() => onLookup(w)}>{w}</button>)}
      {antonyms.length > 0 && <span className="dict-rel-label">Opposite</span>}
      {antonyms.slice(0, max).map(w => <button key={w} className="chip-btn chip-anti" onClick={() => onLookup(w)}>{w}</button>)}
    </div>
  )
}

/** A definition, with the word it refers to ("simple past of run") as a link. */
const Definition = ({ sense, onLookup }: { sense: Sense; onLookup: (w: string) => void }) => {
  const label = sense.label && <span className="dict-label">{sense.label}</span>
  const target = sense.formOf
  if (!target) return <span className="dict-def">{label}{sense.def}</span>
  const link = (text: string) => <button className="inline-link" onClick={() => onLookup(target)}>{text}</button>
  // the last whole-word occurrence: "someone who drinks" must not link "drink" inside "drinks"
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...sense.def.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'))]
  const i = matches.length ? matches[matches.length - 1].index! : -1
  if (i < 0) return <span className="dict-def">{label}{sense.def} → {link(target)}</span>
  // keep closing punctuation on the link's line
  const after = sense.def.slice(i + target.length)
  const punct = /^[.,;:!?)\]”’"']*/.exec(after)![0]
  return (
    <span className="dict-def">
      {label}{sense.def.slice(0, i)}
      <span className="nowrap">{link(sense.def.slice(i, i + target.length))}{punct}</span>
      {after.slice(punct.length)}
    </span>
  )
}

const CopyButton = ({ text }: { text: string }) => {
  const [done, setDone] = useState(false)
  return (
    <button className="link-btn" onClick={() => navigator.clipboard?.writeText(text).then(() => {
      setDone(true)
      setTimeout(() => setDone(false), 1200)
    })}>
      {done ? <Check size={14} /> : <Copy size={14} />}{done ? 'Copied' : 'Copy'}
    </button>
  )
}

const EntryView = ({ entry, compact, onLookup, onHtmlClick, showWord }: {
  entry: DictEntry
  compact?: boolean
  onLookup: (w: string) => void
  onHtmlClick: (e: React.MouseEvent) => void
  showWord: boolean
}) => {
  const plan = compact ? compactPlan(entry.meanings) : (entry.meanings ?? []).map(meaning => ({ meaning, senses: meaning.senses }))
  const translations = entry.translations?.senses.slice(0, compact ? 3 : 8)
  return (
    <div className="dict-entry">
      {entry.formOf
        ? (
          <div className="dict-form">
            <span>{entry.formOf}</span> → <button className="inline-link" onClick={() => onLookup(entry.word)}>{entry.word}</button>
            {entry.relation && <em className="dict-relation">{entry.relation}</em>}
          </div>
        )
        : showWord && entry.meanings && <div className="dict-subword">{entry.word}</div>}
      {entry.image && <img className="dict-image" src={entry.image} alt="" />}
      {translations && (
        <div className="dict-trans" lang={entry.translations!.lang}>
          <span className="dict-rel-label">{languageName(entry.translations!.lang)}</span>
          {translations.map(([sense, words], i) => (
            <span key={i} className="dict-trans-item" title={sense}>{words.join(', ')}</span>
          ))}
        </div>
      )}
      {plan.map(({ meaning: m, senses }, mi) => (
        <section key={mi}>
          {(m.pos || m.display || !!m.forms?.length) && (
            <div className="dict-pos">
              {m.pos}
              {m.display && m.display.toLowerCase() !== m.pos && <span className="dict-display">{m.display}</span>}
              {!!m.forms?.length && <span className="dict-forms">{m.forms.join(', ')}</span>}
            </div>
          )}
          <ol className="dict-senses">
            {senses.map((s, si) => (
              <li key={si}>
                <Definition sense={s} onLookup={onLookup} />
                {s.examples.slice(0, compact ? 1 : 3).map((ex, ei) => <div key={ei} className="dict-ex">{ex}</div>)}
                {!compact && s.note && <div className="dict-note">{s.note}</div>}
                <Chips synonyms={s.synonyms} antonyms={s.antonyms} max={compact ? 4 : 8} onLookup={onLookup} />
              </li>
            ))}
          </ol>
          {!compact && <Chips synonyms={m.synonyms} antonyms={m.antonyms} max={12} onLookup={onLookup} />}
        </section>
      ))}
      {!compact && !!entry.etymology?.length && (
        <div className="dict-etym">
          <div className="dict-pos">Origin</div>
          {entry.etymology.map((p, i) => <p key={i}>{p}</p>)}
        </div>
      )}
      {entry.html && <div className="dict-html" onClick={onHtmlClick} dangerouslySetInnerHTML={{ __html: entry.html }} />}
      {entry.url && <button className="link-btn small" onClick={() => openExternal(entry.url!)}><ExternalLink size={13} />Open full article</button>}
    </div>
  )
}
