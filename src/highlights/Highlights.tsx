import { ArrowUpRight, BookOpen, Copy, Download, Highlighter, NotebookPen, Palette, Search, Trash, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { deleteAnnotation, getAllAnnotations, getBooks, putAnnotation, type Annotation, type BookRecord, type HighlightColor } from '../lib/db'
import { annotationsToMarkdown, sortAnnotations } from '../lib/annotations'
import { formatRelative, percent, safeFileName } from '../lib/format'
import { exportFile } from '../lib/platform'
import { useSettings } from '../lib/settings'
import { toast, useApp } from '../lib/store'
import { HIGHLIGHT_COLORS } from '../lib/themes'
import { Button, Empty, IconButton, Menu, Segmented, Spinner } from '../components/ui'
import { BookCover } from '../library/BookCover'
import { NoteDialog } from '../reader/Popovers'

const COLORS = Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]
/** longer highlights are cut here until expanded */
const LONG = 560

type Filter = 'all' | 'notes' | HighlightColor

interface Group {
  book: BookRecord
  items: Annotation[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const colorOf = (a: Annotation) => a.color ?? 'yellow'
const whereOf = (a: Annotation) => a.page ? `p. ${a.page}` : a.fraction != null ? percent(a.fraction) : ''

const dayLabel = (t: number) => {
  const d = new Date(t)
  const now = new Date()
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

/** scroll position to come back to after opening a highlight in the reader */
let returnScroll = 0

export const Highlights = () => {
  const go = useApp(s => s.go)
  const group = useSettings(s => s.highlightsGroup)
  const set = useSettings(s => s.set)
  const [books, setBooks] = useState<Map<string, BookRecord> | null>(null)
  const [list, setList] = useState<Annotation[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [bookId, setBookId] = useState('all')
  const [noteFor, setNoteFor] = useState<Annotation | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([getBooks(), getAllAnnotations()]).then(([b, anns]) => {
      if (!alive) return
      const map = new Map(b.map(x => [x.id, x]))
      setList(anns.filter(a => a.kind === 'highlight' && map.has(a.bookId)))
      setBooks(map)
    }).catch(() => alive && setBooks(new Map()))
    return () => {
      alive = false
    }
  }, [])

  useLayoutEffect(() => {
    if (!books || !returnScroll) return
    const main = document.querySelector('.main')
    if (main) main.scrollTop = returnScroll
    returnScroll = 0
  }, [books])

  // books that have highlights, for the book filter
  const bookOptions = useMemo(() => {
    const n = new Map<string, number>()
    for (const a of list) n.set(a.bookId, (n.get(a.bookId) ?? 0) + 1)
    return [...n].map(([id, count]) => ({ book: books?.get(id), count }))
      .filter((o): o is { book: BookRecord; count: number } => !!o.book)
      .sort((a, b) => a.book.title.localeCompare(b.book.title))
  }, [list, books])

  // the book picked may have lost its last highlight
  const book = bookOptions.some(o => o.book.id === bookId) ? bookId : 'all'

  // every filter but the color one, so the color counts show what picking a color leaves
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.filter(a => {
      if (book !== 'all' && a.bookId !== book) return false
      if (!q) return true
      const b = books?.get(a.bookId)
      return [a.text, a.note, a.chapter, b?.title, b?.author].some(s => s?.toLowerCase().includes(q))
    })
  }, [list, books, query, book])

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: searched.length, notes: 0, yellow: 0, green: 0, blue: 0, pink: 0, purple: 0 }
    for (const a of searched) {
      c[colorOf(a)]++
      if (a.note) c.notes++
    }
    return c
  }, [searched])

  const shown = useMemo(() => searched.filter(a =>
    filter === 'all' || (filter === 'notes' ? !!a.note : colorOf(a) === filter)), [searched, filter])

  // books with the most recent highlight first, each in reading order
  const byBook = useMemo<Group[]>(() => {
    if (!books) return []
    const groups = new Map<string, Annotation[]>()
    for (const a of shown) groups.set(a.bookId, [...(groups.get(a.bookId) ?? []), a])
    const latest = (items: Annotation[]) => Math.max(...items.map(a => a.createdAt))
    return [...groups].map(([id, items]) => ({ book: books.get(id)!, items }))
      .sort((a, b) => latest(b.items) - latest(a.items))
      .map(g => ({ ...g, items: sortAnnotations(g.items, g.book.format) }))
  }, [shown, books])

  const byDay = useMemo(() => {
    const days: { label: string; items: Annotation[] }[] = []
    for (const a of [...shown].sort((x, y) => y.createdAt - x.createdAt)) {
      const label = dayLabel(a.createdAt)
      if (days[days.length - 1]?.label === label) days[days.length - 1].items.push(a)
      else days.push({ label, items: [a] })
    }
    return days
  }, [shown])

  if (!books) return <div className="page-center"><Spinner /></div>

  const openBook = (book: BookRecord, a?: Annotation) => {
    returnScroll = document.querySelector('.main')?.scrollTop ?? 0
    go({ name: 'reader', bookId: book.id, target: a?.locator, from: { name: 'highlights' } })
  }

  const update = async (a: Annotation, patch: Partial<Annotation>) => {
    const u = { ...a, ...patch, updatedAt: Date.now() }
    await putAnnotation(u)
    setList(l => l.map(x => (x.id === u.id ? u : x)))
  }

  const remove = async (a: Annotation) => {
    await deleteAnnotation(a.id)
    setList(l => l.filter(x => x.id !== a.id))
    toast('Highlight deleted', 'info', {
      label: 'Undo',
      run: async () => {
        await putAnnotation(a)
        setList(l => [...l, a])
      },
    })
  }

  const copy = (a: Annotation, book: BookRecord) => {
    const source = [book.title, book.author].filter(Boolean).join(', ')
    navigator.clipboard?.writeText(`${a.text}\n— ${source}`).then(() => toast('Copied to clipboard'), () => toast('Copy failed', 'error'))
  }

  const exportGroups = (groups: Group[]) => {
    if (!groups.length) return
    const name = groups.length === 1 ? `${safeFileName(groups[0].book.title)} - highlights.md` : 'Lumen highlights.md'
    exportFile(name, groups.map(g => annotationsToMarkdown(g.book, g.items)).join('\n---\n\n'), 'text/markdown')
  }

  const filtered = !!query.trim() || filter !== 'all' || book !== 'all'
  const clearFilters = () => {
    setQuery('')
    setFilter('all')
    setBookId('all')
  }

  const card = (a: Annotation, showBook: boolean, showChapter: boolean) => {
    const book = books.get(a.bookId)!
    return (
      <HighlightCard key={a.id} annotation={a} book={showBook ? book : undefined} chapter={showChapter}
        onOpen={() => openBook(book, a)} onNote={() => setNoteFor(a)} onColor={color => update(a, { color })}
        onCopy={() => copy(a, book)} onDelete={() => remove(a)} />
    )
  }

  return (
    <div className="screen highlights-page">
      <header className="page-head">
        <div className="page-title">
          <h1>Highlights</h1>
          {list.length > 0 && <span className="chip">{plural(list.length, 'highlight')}</span>}
        </div>
        {list.length > 0 && (
          <div className="page-actions">
            <div className="search-field">
              <Search size={16} />
              <input type="search" placeholder="Search highlights and notes" value={query} onChange={e => setQuery(e.target.value)} />
              {query && <button className="clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}
            </div>
            <Button onClick={() => exportGroups(byBook)} disabled={!shown.length}><Download size={16} />Export</Button>
          </div>
        )}
      </header>

      {!list.length ? (
        <Empty icon={<Highlighter size={40} />} title="No highlights yet">
          <p>While reading, select a passage and pick a color to highlight it. Highlights and notes from all your books are collected here.</p>
        </Empty>
      ) : (
        <>
          <div className="toolbar hl-toolbar">
            <div className="hl-filters" role="radiogroup" aria-label="Filter highlights">
              <FilterPill on={filter === 'all'} onClick={() => setFilter('all')} label="All" count={counts.all} />
              {COLORS.filter(c => counts[c] || filter === c).map(c => (
                <FilterPill key={c} on={filter === c} onClick={() => setFilter(filter === c ? 'all' : c)} count={counts[c]}
                  label={<span className="hl-dot" style={{ '--c': HIGHLIGHT_COLORS[c].light } as React.CSSProperties} />}
                  title={`${HIGHLIGHT_COLORS[c].label} highlights`} />
              ))}
              {(counts.notes > 0 || filter === 'notes') && (
                <FilterPill on={filter === 'notes'} onClick={() => setFilter(filter === 'notes' ? 'all' : 'notes')} count={counts.notes}
                  label={<><NotebookPen size={14} />Notes</>} title="Highlights with notes" />
              )}
            </div>
            <div className="toolbar-right">
              {bookOptions.length > 1 && (
                <select className="select hl-book-filter" aria-label="Book" value={book} onChange={e => setBookId(e.target.value)}>
                  <option value="all">All books</option>
                  {bookOptions.map(o => <option key={o.book.id} value={o.book.id}>{o.book.title} ({o.count})</option>)}
                </select>
              )}
              <Segmented value={group} onChange={v => set({ highlightsGroup: v })} options={[
                { value: 'book', label: 'By book' },
                { value: 'recent', label: 'Recent' },
              ]} />
            </div>
          </div>

          {!shown.length && (
            <div className="hl-none">
              <p className="muted">No highlights match.</p>
              {filtered && <Button variant="ghost" onClick={clearFilters}>Clear filters</Button>}
            </div>
          )}

          {group === 'book' ? byBook.map(g => {
            const notes = g.items.filter(a => a.note).length
            let chapter: string | undefined
            return (
              <section key={g.book.id} className="hl-group">
                <aside className="hl-book">
                  <button className="hl-book-cover" onClick={() => openBook(g.book)} tabIndex={-1} aria-hidden>
                    <BookCover book={g.book} />
                  </button>
                  <div className="hl-book-info">
                    <h2><button onClick={() => openBook(g.book)}>{g.book.title}</button></h2>
                    {g.book.author && <div className="muted small">{g.book.author}</div>}
                    <div className="muted small">{plural(g.items.length, 'highlight')}{notes ? ` · ${plural(notes, 'note')}` : ''}</div>
                  </div>
                  <div className="hl-book-actions">
                    <Button onClick={() => openBook(g.book)}><BookOpen size={16} />{g.book.progress > 0 ? 'Continue' : 'Read'}</Button>
                    <IconButton label="Export as Markdown" onClick={() => exportGroups([g])}><Download size={17} /></IconButton>
                  </div>
                </aside>
                <div className="hl-list">
                  {g.items.map(a => {
                    const heading = a.chapter && a.chapter !== chapter ? a.chapter : null
                    if (a.chapter) chapter = a.chapter
                    return (
                      <div key={a.id} className="hl-entry">
                        {heading && <h3 className="hl-chapter">{heading}</h3>}
                        {card(a, false, false)}
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          }) : (
            <div className="hl-days">
              {byDay.map(d => (
                <section key={d.label} className="hl-day">
                  <h3 className="hl-chapter">{d.label}</h3>
                  <div className="hl-list">{d.items.map(a => card(a, true, true))}</div>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <NoteDialog annotation={noteFor} onClose={() => setNoteFor(null)}
        onDelete={noteFor ? () => {
          remove(noteFor)
          setNoteFor(null)
        } : undefined}
        onSave={async note => {
          if (noteFor) await update(noteFor, { note: note || undefined })
          setNoteFor(null)
        }} />
    </div>
  )
}

const FilterPill = ({ on, onClick, label, count, title }: {
  on: boolean
  onClick: () => void
  label: React.ReactNode
  count: number
  title?: string
}) => (
  <button type="button" role="radio" aria-checked={on} className={`hl-pill ${on ? 'on' : ''}`} onClick={onClick} title={title} aria-label={title && `${title} (${count})`}>
    {label}<small>{count}</small>
  </button>
)

const HighlightCard = ({ annotation: a, book, chapter, onOpen, onNote, onColor, onCopy, onDelete }: {
  annotation: Annotation
  /** shown when highlights from several books are mixed */
  book?: BookRecord
  /** show the chapter (when there is no chapter heading above) */
  chapter: boolean
  onOpen: () => void
  onNote: () => void
  onColor: (c: HighlightColor) => void
  onCopy: () => void
  onDelete: () => void
}) => {
  const [expanded, setExpanded] = useState(false)
  const long = a.text.length > LONG + 80
  const text = long && !expanded ? `${a.text.slice(0, LONG).trimEnd()}…` : a.text
  const where = [book?.title, chapter ? a.chapter : null, whereOf(a)].filter(Boolean).join(' · ')
  return (
    <article className={`hl-card ${colorOf(a)}`} style={{ '--c': HIGHLIGHT_COLORS[colorOf(a)].light } as React.CSSProperties}>
      <blockquote className="hl-quote">
        <span className="hl-mark">{text}</span>
        {long && <button className="link-btn hl-more" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</button>}
      </blockquote>
      {a.note && <button className="hl-note" onClick={onNote} title="Edit note">{a.note}</button>}
      <footer className="hl-foot">
        <button className="hl-where" onClick={onOpen} title="Open in book">
          <span>{where || 'Open in book'}</span><ArrowUpRight size={14} />
        </button>
        {!book && <span className="hl-date">{formatRelative(a.createdAt)}</span>}
        <div className="hl-actions">
          <IconButton label={a.note ? 'Edit note' : 'Add note'} onClick={onNote}><NotebookPen size={16} /></IconButton>
          <Menu items={COLORS.map(c => ({
            label: HIGHLIGHT_COLORS[c].label,
            icon: <span className={`hl-dot ${c === colorOf(a) ? 'on' : ''}`} style={{ '--c': HIGHLIGHT_COLORS[c].light } as React.CSSProperties} />,
            onSelect: () => onColor(c),
          }))} trigger={p => <IconButton label="Change color" {...p}><Palette size={16} /></IconButton>} />
          <IconButton label="Copy" onClick={onCopy}><Copy size={16} /></IconButton>
          <IconButton label="Delete" onClick={onDelete}><Trash size={16} /></IconButton>
        </div>
      </footer>
    </article>
  )
}
