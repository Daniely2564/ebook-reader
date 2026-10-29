import { Download, GraduationCap, Search, Star, Trash, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { deleteVocab, getVocab, type VocabEntry } from '../lib/db'
import { formatRelative } from '../lib/format'
import { exportFile } from '../lib/platform'
import { useApp } from '../lib/store'
import { Button, Empty, IconButton, Sheet, Spinner } from '../components/ui'
import { invalidateSavedWords } from '../dictionary/DictionaryView'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const Context = ({ text, word }: { text: string; word: string }) => {
  const parts = text.split(new RegExp(`(${escapeRe(word)})`, 'i'))
  return <q>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</q>
}

export const Vocabulary = () => {
  const [list, setList] = useState<VocabEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [review, setReview] = useState(false)
  const go = useApp(s => s.go)
  const syncVersion = useApp(s => s.syncVersion)

  const load = () => getVocab().then(setList).catch(() => setList([]))
  useEffect(() => {
    load()
  }, [syncVersion])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (list ?? []).filter(v => !q || v.word.toLowerCase().includes(q) || v.definition.toLowerCase().includes(q))
  }, [list, query])

  const remove = async (v: VocabEntry) => {
    await deleteVocab(v.id)
    invalidateSavedWords()
    load()
  }

  const exportCsv = () => {
    const esc = (s = '') => `"${s.replace(/"/g, '""')}"`
    const rows = [['Word', 'Pronunciation', 'Definition', 'Context', 'Book', 'Added'].map(esc).join(',')]
    for (const v of list ?? []) rows.push([v.word, v.ipa ? `/${v.ipa}/` : '', v.definition, v.context, v.bookTitle, new Date(v.createdAt).toISOString().slice(0, 10)].map(esc).join(','))
    exportFile('lumen-vocabulary.csv', '﻿' + rows.join('\n'), 'text/csv')
  }

  if (!list) return <div className="page-center"><Spinner /></div>

  return (
    <div className="screen vocab-page">
      <header className="page-head">
        <div className="page-title">
          <h1>Vocabulary</h1>
          {list.length > 0 && <span className="chip">{list.length} word{list.length === 1 ? '' : 's'}</span>}
        </div>
        {list.length > 0 && (
          <div className="page-actions">
            <div className="search-field">
              <Search size={16} />
              <input type="search" placeholder="Search words" value={query} onChange={e => setQuery(e.target.value)} />
              {query && <button className="clear" aria-label="Clear" onClick={() => setQuery('')}><X size={14} /></button>}
            </div>
            <Button onClick={exportCsv}><Download size={16} />Export CSV</Button>
            <Button variant="primary" onClick={() => setReview(true)}><GraduationCap size={18} />Review</Button>
          </div>
        )}
      </header>

      {!list.length ? (
        <Empty icon={<Star size={40} />} title="No saved words yet">
          <p>While reading, double-click (or long-press) a word to look it up, then tap the star to save it here with the sentence you found it in.</p>
        </Empty>
      ) : (
        <ul className="vocab-list">
          {shown.map(v => (
            <li key={v.id} className="vocab-item card">
              <div className="vocab-main" onClick={() => go({ name: 'dictionary', word: v.word })} role="button" tabIndex={0}>
                <div className="vocab-word">
                  <strong>{v.word}</strong>
                  {v.ipa && <span className="dict-ipa">/{v.ipa}/</span>}
                </div>
                {v.definition && <p className="vocab-def">{v.definition}</p>}
                {v.context && <p className="vocab-context"><Context text={v.context} word={v.word} /></p>}
                <div className="muted small">{v.bookTitle ? `${v.bookTitle} · ` : ''}{formatRelative(v.createdAt)}</div>
              </div>
              <IconButton label="Delete" onClick={() => remove(v)}><Trash size={16} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <Review open={review} onClose={() => setReview(false)} words={list} />
    </div>
  )
}

const Review = ({ open, onClose, words }: { open: boolean; onClose: () => void; words: VocabEntry[] }) => {
  const [order, setOrder] = useState<VocabEntry[]>([])
  const [i, setI] = useState(0)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (open) {
      setOrder([...words].sort(() => Math.random() - 0.5))
      setI(0)
      setShown(false)
    }
  }, [open, words])
  const card = order[i]
  const next = () => {
    setShown(false)
    setI(n => n + 1)
  }
  return (
    <Sheet open={open} onClose={onClose} title={card ? `Review · ${i + 1} of ${order.length}` : 'Review'}>
      {card ? (
        <div className="flashcard" onClick={() => !shown && setShown(true)}>
          <div className="flash-word">{card.word}</div>
          {card.ipa && <div className="dict-ipa">/{card.ipa}/</div>}
          {shown ? (
            <>
              <p className="flash-def">{card.definition}</p>
              {card.context && <p className="vocab-context"><Context text={card.context} word={card.word} /></p>}
              <div className="sheet-actions center">
                <Button onClick={next}>Still learning</Button>
                <Button variant="primary" onClick={next}>Got it</Button>
              </div>
            </>
          ) : <p className="muted">Tap to reveal the definition</p>}
        </div>
      ) : (
        <div className="flashcard done">
          <div className="flash-word">All done</div>
          <p className="muted">You reviewed {order.length} word{order.length === 1 ? '' : 's'}.</p>
          <Button variant="primary" onClick={onClose}>Close</Button>
        </div>
      )}
    </Sheet>
  )
}
