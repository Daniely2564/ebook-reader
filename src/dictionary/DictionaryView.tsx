import { ArrowLeft, Check, Copy, ExternalLink, Globe, Languages, Star, Volume2, WifiOff } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { addLookupHistory, didYouMean, isOnlineSource, languageName, lookupOffline, lookupOnline, normalizeQuery, ONLINE_SOURCES, type DictEntry, type DictResult, type OnlineSourceId, type Sense } from '../lib/dictionary'
import { lookupPronunciation } from '../lib/dictionary/online'
import { stripHtml } from '../lib/dictionary/sanitize'
import { deleteVocab, getVocab, putVocab, uid } from '../lib/db'
import { openExternal } from '../lib/platform'
import { useSettings } from '../lib/settings'
import { toast } from '../lib/store'
import { getVoices, sayWord } from '../lib/tts'
import { IconButton, Spinner } from '../components/ui'

let savedWords: Promise<Map<string, string>> | null = null
const loadSaved = () => savedWords ??= getVocab()
  .then(list => new Map(list.map(v => [v.word.toLowerCase(), v.id])))
  .catch(() => new Map())
export const invalidateSavedWords = () => {
  savedWords = null
}

const firstDefinition = (r: DictResult | undefined) => {
  const e = r?.entries[0]
  if (!e) return ''
  if (e.meanings?.[0]?.senses[0]) return `(${e.meanings[0].pos}) ${e.meanings[0].senses[0].def}`
  return e.html ? stripHtml(e.html).slice(0, 240) : ''
}

interface Props {
  word: string
  context?: string
  lang?: string
  bookId?: string
  bookTitle?: string
  compact?: boolean
}

export const DictionaryView = ({ word: initial, context, lang, bookId, bookTitle, compact }: Props) => {
  const [stack, setStack] = useState([normalizeQuery(initial)])
  useEffect(() => setStack([normalizeQuery(initial)]), [initial])
  const word = stack[stack.length - 1]
  const onlineEnabled = useSettings(s => s.onlineLookup)
  const translateTo = useSettings(s => s.translateTo)
  const ttsVoice = useSettings(s => s.ttsVoice)
  const dictDisabled = useSettings(s => s.dictDisabled)
  const isEnglish = !lang || lang.toLowerCase().startsWith('en')
  // the last tab picked is remembered per book language
  const langKey = isEnglish ? 'en' : lang!.slice(0, 2).toLowerCase()
  const preferred = useSettings(s => s.dictTabs[langKey])
  const setSettings = useSettings(s => s.set)

  const [offline, setOffline] = useState<DictResult[] | null>(null)
  const [online, setOnline] = useState<Record<string, DictResult | null | 'loading'>>({})
  const [tab, setTab] = useState('')
  // the first offline tab, shown if the remembered online tab has nothing
  const fallbackTab = useRef('')
  const autoPicked = useRef(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [savedId, setSavedId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setOffline(null)
    setOnline({})
    setSuggestions([])
    setExpanded(false)
    lookupOffline(word).then(res => {
      if (!alive) return
      setOffline(res)
      // prefer a user dictionary matching a non-English book
      const first = (!isEnglish ? res.find(r => r.source.kind === 'user') : undefined) ?? res[0]
      fallbackTab.current = first?.source.id ?? ''
      const remembered = preferred && (res.some(r => r.source.id === preferred) || (onlineEnabled && isOnlineSource(preferred)))
      autoPicked.current = !!remembered
      if (remembered) setTab(preferred)
      else setTab(first?.source.id ?? (onlineEnabled ? 'wiktionary-web' : ''))
      if (res.length) addLookupHistory(word)
      else if (isEnglish) didYouMean(word).then(s => alive && setSuggestions(s.filter(x => x !== word.toLowerCase())))
    })
    loadSaved().then(m => alive && setSavedId(m.get(word.toLowerCase()) ?? null))
    return () => {
      alive = false
    }
  }, [word, onlineEnabled, isEnglish, dictDisabled, translateTo]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isOnlineSource(tab) || offline === null) return
    if (online[tab] !== undefined) return
    const ctrl = new AbortController()
    const source: OnlineSourceId = tab
    setOnline(o => ({ ...o, [source]: 'loading' }))
    const done = (r: DictResult | null) => {
      if (ctrl.signal.aborted) return
      setOnline(o => ({ ...o, [source]: r }))
      if (r) addLookupHistory(word)
      // offline, or nothing there: show what we have offline, keeping the remembered tab
      else if (autoPicked.current && fallbackTab.current) {
        autoPicked.current = false
        setTab(fallbackTab.current)
      }
    }
    lookupOnline(word, source, lang?.slice(0, 2), ctrl.signal).then(done, () => done(null))
    return () => {
      ctrl.abort()
      // an interrupted lookup is retried when its tab is opened again
      setOnline(o => {
        if (o[source] !== 'loading') return o
        const { [source]: _, ...rest } = o
        return rest
      })
    }
  }, [tab, word, lang, offline]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [tab, word])

  const push = (w: string) => setStack(s => [...s, normalizeQuery(w)])
  const pickTab = (id: string) => {
    autoPicked.current = false
    setTab(id)
    if (id !== preferred) setSettings({ dictTabs: { ...useSettings.getState().dictTabs, [langKey]: id } })
  }

  const tabs = useMemo(() => {
    const t = (offline ?? []).map(r => ({ id: r.source.id, name: r.source.name, offline: true }))
    if (onlineEnabled) for (const s of ONLINE_SOURCES) t.push({ id: s.id, name: s.name, offline: false })
    return t
  }, [offline, onlineEnabled])

  const current: DictResult | null | 'loading' | undefined = isOnlineSource(tab)
    ? online[tab]
    : offline?.find(r => r.source.id === tab)
  const head = offline?.[0]?.entries[0]
  const headword = head && !head.formOf ? head.word : word
  // pronunciation of the word itself, not of the lemma it was found under
  const own = offline?.flatMap(r => r.entries).filter(e => !e.formOf && e.word === headword.toLowerCase())
  const sounds = own?.find(e => e.ipa)
  const ipa = sounds?.ipa
  const ipaAlt = sounds?.ipaAlt
  const recording = own?.find(e => e.audio)?.audio

  const speak = async () => {
    if (onlineEnabled && recording) {
      // a recorded pronunciation from Wikimedia Commons beats synthetic speech
      const played = await new Audio(recording).play().then(() => true, () => false)
      if (played) return
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
    const definition = firstDefinition(offline?.[0]) || firstDefinition(typeof current === 'object' && current ? current : undefined)
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
  const loading = offline === null || current === 'loading'

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

      {tabs.length > 1 && (
        <div className="dict-tabs" role="tablist">
          {tabs.map(t => (
            <button key={t.id} role="tab" aria-selected={t.id === tab} className={t.id === tab ? 'on' : ''} onClick={() => pickTab(t.id)}>
              {t.offline ? null : <Globe size={12} />}{t.name}
            </button>
          ))}
        </div>
      )}

      <div className="dict-body" ref={bodyRef}>
        {loading && <div className="dict-loading"><Spinner size={18} /></div>}
        {!loading && current && typeof current === 'object' && current.entries.map((e, i) => (
          <EntryView key={`${tab}-${i}`} entry={e} compact={compact && !expanded} onLookup={push} onHtmlClick={onHtmlClick} showWord={i > 0 || !!e.formOf || current.source.kind !== 'offline'} />
        ))}
        {!loading && compact && !expanded && current && typeof current === 'object' && current.source.kind !== 'online' && hasMore(current.entries) && (
          <button className="link-btn" onClick={() => setExpanded(true)}>
            {countSenses(current.entries) > 4 ? `Show all ${countSenses(current.entries)} definitions` : 'Show more'}
          </button>
        )}
        {!loading && !current && (
          <div className="dict-none">
            <p>No definition found for <b>{word}</b>{isOnlineSource(tab) ? ` on ${ONLINE_SOURCES.find(s => s.id === tab)!.name}` : ' offline'}.</p>
            {suggestions.length > 0 && (
              <div className="dict-chips">
                <span className="muted">Did you mean</span>
                {suggestions.map(s => <button key={s} className="chip-btn" onClick={() => push(s)}>{s}</button>)}
              </div>
            )}
            {!onlineEnabled && <p className="muted small"><WifiOff size={13} /> Online sources are turned off in Settings.</p>}
            {!isEnglish && !offline?.length && <p className="muted small">Tip: import a StarDict dictionary for this language in Settings → Dictionaries.</p>}
          </div>
        )}
      </div>

      <div className="dict-foot">
        <button className="link-btn" onClick={() => openExternal(`https://translate.google.com/?sl=auto&tl=${translateTo}&text=${encodeURIComponent(translateText)}&op=translate`)}>
          <Languages size={14} />Translate
        </button>
        <button className="link-btn" onClick={() => openExternal(`https://www.google.com/search?q=${encodeURIComponent(`define ${headword}`)}`)}>
          <ExternalLink size={14} />Web
        </button>
        <CopyButton text={headword} />
        {current && typeof current === 'object' && current.source.kind !== 'online' && (
          <span className="dict-source"><Check size={12} />Offline</span>
        )}
      </div>
    </div>
  )
}

const countSenses = (entries: DictEntry[]) => entries.reduce((n, e) => n + (e.meanings?.reduce((m, x) => m + x.senses.length, 0) ?? 0), 0)
const hasMore = (entries: DictEntry[]) => countSenses(entries) > 4 * entries.length || entries.some(e => e.etymology?.length)

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
  const i = sense.def.toLowerCase().lastIndexOf(target.toLowerCase())
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
  let budget = compact ? 4 : Infinity
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
      {entry.meanings?.map((m, mi) => {
        if (budget <= 0) return null
        const senses = m.senses.slice(0, budget)
        budget -= senses.length
        return (
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
                  <Chips synonyms={s.synonyms} antonyms={s.antonyms} max={compact ? 4 : 8} onLookup={onLookup} />
                </li>
              ))}
            </ol>
            {!compact && <Chips synonyms={m.synonyms} antonyms={m.antonyms} max={12} onLookup={onLookup} />}
          </section>
        )
      })}
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
