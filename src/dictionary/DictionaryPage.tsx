import { BookA, Clock, Search, Settings2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { clearLookupHistory, getLookupHistory, getDictMeta, suggestWords } from '../lib/dictionary'
import { getUserDicts } from '../lib/db'
import { useApp } from '../lib/store'
import { Button } from '../components/ui'
import { DictionaryView } from './DictionaryView'

export const DictionaryPage = ({ initial }: { initial?: string }) => {
  const [input, setInput] = useState(initial ?? '')
  const [word, setWord] = useState(initial ?? '')
  const [sugs, setSugs] = useState<string[]>([])
  const [active, setActive] = useState(-1)
  const [history, setHistory] = useState(getLookupHistory)
  const [info, setInfo] = useState<{ words: number; user: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const openSettings = useApp(s => s.openSettings)

  useEffect(() => {
    if (initial) {
      setInput(initial)
      setWord(initial)
    }
  }, [initial])

  useEffect(() => {
    Promise.all([getDictMeta(), getUserDicts()]).then(([m, d]) => setInfo({ words: m?.words ?? 0, user: d.length }))
    if (!initial) inputRef.current?.focus()
  }, [initial])

  useEffect(() => {
    let alive = true
    if (!input.trim() || input === word) {
      setSugs([])
      return
    }
    suggestWords(input, 8).then(s => alive && setSugs(s))
    return () => {
      alive = false
    }
  }, [input, word])

  const submit = (w: string) => {
    const q = w.trim()
    if (!q) return
    setInput(q)
    setWord(q)
    setSugs([])
    setActive(-1)
    setTimeout(() => setHistory(getLookupHistory()), 500)
  }

  return (
    <div className="screen dictionary-page">
      <header className="page-head">
        <div className="page-title"><h1>Dictionary</h1></div>
      </header>
      <div className="dict-search">
        <div className="search-field big">
          <Search size={20} />
          <input ref={inputRef} type="search" placeholder="Look up a word" value={input} autoCapitalize="none" autoCorrect="off" spellCheck={false}
            onChange={e => {
              setInput(e.target.value)
              setActive(-1)
            }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive(a => Math.min(sugs.length - 1, a + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive(a => Math.max(-1, a - 1))
              } else if (e.key === 'Enter') submit(active >= 0 ? sugs[active] : input)
              else if (e.key === 'Escape') setSugs([])
            }} />
          {input && <button className="clear" aria-label="Clear" onClick={() => { setInput(''); setWord(''); inputRef.current?.focus() }}><X size={16} /></button>}
        </div>
        {sugs.length > 0 && (
          <ul className="suggestions" role="listbox">
            {sugs.map((s, i) => (
              <li key={s} role="option" aria-selected={i === active} className={i === active ? 'on' : ''} onPointerDown={e => { e.preventDefault(); submit(s) }}>{s}</li>
            ))}
          </ul>
        )}
      </div>

      {word ? (
        <div className="dict-page-result"><DictionaryView word={word} /></div>
      ) : (
        <div className="dict-home">
          <div className="dict-info card">
            <BookA size={28} />
            <div>
              <h3>Works offline</h3>
              <p className="muted">
                {info?.words ? `${info.words.toLocaleString()} English words` : 'English dictionary'} with definitions, examples, synonyms and pronunciations, built in.
                {info?.user ? ` Plus ${info.user} imported dictionar${info.user === 1 ? 'y' : 'ies'}.` : ' Import StarDict dictionaries for other languages.'}
              </p>
            </div>
            <Button variant="ghost" onClick={() => openSettings(true)}><Settings2 size={16} />Manage</Button>
          </div>
          {history.length > 0 && (
            <section>
              <div className="section-head">
                <h3><Clock size={16} />Recent lookups</h3>
                <button className="link-btn" onClick={() => { clearLookupHistory(); setHistory([]) }}>Clear</button>
              </div>
              <div className="dict-chips">
                {history.slice(0, 40).map(h => <button key={h} className="chip-btn" onClick={() => submit(h)}>{h}</button>)}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
