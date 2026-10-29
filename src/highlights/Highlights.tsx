import { ArrowUpRight, BookOpen, ClipboardCopy, CloudOff, Copy, Download, FileText, Highlighter, LibraryBig, NotebookPen, Palette, Search, Table, Trash, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { deleteAnnotation, getAllAnnotations, getBooks, putAnnotation, type Annotation, type BookRecord, type HighlightColor } from '../lib/db'
import { annotationsToMarkdown, highlightsToCsv, sortAnnotations } from '../lib/annotations'
import { useBackHandler } from '../lib/back'
import { formatRelative, percent, safeFileName } from '../lib/format'
import { exportFile } from '../lib/platform'
import { useSettings } from '../lib/settings'
import { toast, useApp } from '../lib/store'
import { getSyncedBooks } from '../lib/sync/local'
import { HIGHLIGHT_COLORS } from '../lib/themes'
import { Button, Empty, IconButton, Menu, Segmented, Spinner, type MenuItem } from '../components/ui'
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

export const Highlights = ({ bookId }: { bookId?: string }) => {
  const go = useApp(s => s.go)
  const group = useSettings(s => s.highlightsGroup)
  const set = useSettings(s => s.set)
  const [books, setBooks] = useState<Map<string, BookRecord> | null>(null)
  const [list, setList] = useState<Annotation[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [noteFor, setNoteFor] = useState<Annotation | null>(null)
  /** synced books that are not on this device */
  const [away, setAway] = useState<Set<string>>(new Set())
  const syncVersion = useApp(s => s.syncVersion)

  useEffect(() => {
    let alive = true
    Promise.all([getBooks(), getAllAnnotations(), getSyncedBooks()]).then(([b, anns, synced]) => {
      if (!alive) return
      const map = new Map(b.map(x => [x.id, x]))
      const missing = new Set<string>()
      for (const a of anns) {
        const s = !map.has(a.bookId) && synced.get(a.bookId)
        if (s) {
          map.set(a.bookId, s)
          missing.add(a.bookId)
        }
      }
      setList(anns.filter(a => a.kind === 'highlight' && map.has(a.bookId)))
      setBooks(map)
      setAway(missing)
    }).catch(() => alive && setBooks(new Map()))
    return () => {
      alive = false
    }
  }, [syncVersion])

  useLayoutEffect(() => {
    if (!books || !returnScroll) return
    const main = document.querySelector('.main')
    if (main) main.scrollTop = returnScroll
    returnScroll = 0
  }, [books])

  // books that have highlights, the most recently highlighted first
  const shelf = useMemo<ShelfBook[]>(() => {
    const n = new Map<string, { count: number; notes: number; latest: number }>()
    for (const a of list) {
      const e = n.get(a.bookId) ?? { count: 0, notes: 0, latest: 0 }
      e.count++
      if (a.note) e.notes++
      e.latest = Math.max(e.latest, a.createdAt)
      n.set(a.bookId, e)
    }
    return [...n].flatMap(([id, e]) => {
      const book = books?.get(id)
      return book ? [{ book, ...e }] : []
    }).sort((a, b) => b.latest - a.latest)
  }, [list, books])

  // the book picked may have lost its last highlight
  const current = shelf.find(o => o.book.id === bookId)
  const book = current?.book

  /** shows one book's highlights, or every book's */
  const pick = (id?: string) => {
    if (id === book?.id) return
    setFilter('all')
    document.querySelector('.main')?.scrollTo({ top: 0 })
    go({ name: 'highlights', bookId: id })
  }
  useBackHandler(() => pick(), !!book)

  // every filter but the color one, so the color counts show what picking a color leaves
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.filter(a => {
      if (book && a.bookId !== book.id) return false
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
    if (away.has(book.id)) {
      toast(`“${book.title}” isn’t on this device. Add the book to your library to open it here.`)
      return
    }
    returnScroll = document.querySelector('.main')?.scrollTop ?? 0
    go({ name: 'reader', bookId: book.id, target: a?.locator, from: { name: 'highlights', bookId } })
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
        // newer than the deletion, which may have synced already
        const back = { ...a, updatedAt: Date.now() }
        await putAnnotation(back)
        setList(l => [...l, back])
      },
    })
  }

  const copyText = (text: string, done = 'Copied to clipboard') =>
    navigator.clipboard?.writeText(text).then(() => toast(done), () => toast('Copy failed', 'error'))

  const copy = (a: Annotation, book: BookRecord) => {
    const source = [book.title, book.author].filter(Boolean).join(', ')
    copyText(`${a.text}\n— ${source}`)
  }

  /** exports what is shown: every book or the one picked, with the search and color filters */
  const exportItems: MenuItem[] = (() => {
    const name = book ? `${safeFileName(book.title)} - highlights` : 'Lumen highlights'
    const markdown = () => byBook.map(g => annotationsToMarkdown(g.book, g.items)).join('\n---\n\n')
    return [
      { label: 'Markdown file', icon: <FileText size={16} />, onSelect: () => exportFile(`${name}.md`, markdown(), 'text/markdown') },
      { label: 'CSV for spreadsheets and databases', icon: <Table size={16} />, onSelect: () => exportFile(`${name}.csv`, highlightsToCsv(byBook), 'text/csv') },
      { label: 'Copy as Markdown', icon: <ClipboardCopy size={16} />, onSelect: () => copyText(markdown(), `Copied ${plural(shown.length, 'highlight')}`) },
    ]
  })()

  const filtered = !!query.trim() || filter !== 'all'
  const clearFilters = () => {
    setQuery('')
    setFilter('all')
  }

  const card = (a: Annotation, showBook: boolean, showChapter: boolean) => {
    const book = books.get(a.bookId)!
    return (
      <HighlightCard key={a.id} annotation={a} book={showBook ? book : undefined} chapter={showChapter}
        onOpen={() => openBook(book, a)} onNote={() => setNoteFor(a)} onColor={color => update(a, { color })}
        onCopy={() => copy(a, book)} onDelete={() => remove(a)} />
    )
  }

  /** highlights in reading order, under their chapters */
  const inOrder = (items: Annotation[]) => {
    let chapter: string | undefined
    return (
      <div className="hl-list">
        {items.map(a => {
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
    )
  }

  return (
    <div className="screen highlights-page">
      <header className="page-head">
        <div className="page-title">
          <h1>Highlights</h1>
          {list.length > 0 && <span className="chip">{plural(current?.count ?? list.length, 'highlight')}</span>}
        </div>
        {list.length > 0 && (
          <div className="page-actions">
            <div className="search-field">
              <Search size={16} />
              <input type="search" placeholder={book ? 'Search this book' : 'Search highlights and notes'} value={query} onChange={e => setQuery(e.target.value)} />
              {query && <button className="clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}
            </div>
            <Menu items={exportItems} trigger={p => <Button {...p} disabled={!shown.length}><Download size={16} />Export</Button>} />
          </div>
        )}
      </header>

      {!list.length ? (
        <Empty icon={<Highlighter size={40} />} title="No highlights yet">
          <p>While reading, select a passage and pick a color to highlight it. Highlights and notes from all your books are collected here.</p>
        </Empty>
      ) : (
        <>
          {shelf.length > 1 && <Shelf shelf={shelf} total={list.length} current={book?.id} onPick={pick} />}

          {book && current && (
            <section className="hl-focus">
              <div className="hl-focus-cover"><BookCover book={book} /></div>
              <div className="hl-focus-info">
                <h2>{book.title}</h2>
                {book.author && <div className="muted">{book.author}</div>}
                <div className="muted small">
                  {plural(current.count, 'highlight')}{current.notes ? ` · ${plural(current.notes, 'note')}` : ''}
                  {!away.has(book.id) && ` · ${book.finished ? 'finished' : `${percent(book.progress)} read`}`}
                </div>
                <div className="row-gap">
                  {away.has(book.id)
                    ? <span className="hl-away muted small" title="Synced from another device. Add the book here to open it."><CloudOff size={15} />Not on this device</span>
                    : <Button variant="primary" onClick={() => openBook(book)}><BookOpen size={16} />{book.progress > 0 ? 'Continue reading' : 'Start reading'}</Button>}
                  <Button variant="ghost" onClick={() => pick()}><LibraryBig size={16} />All books</Button>
                </div>
              </div>
            </section>
          )}

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
              <Segmented value={group} onChange={v => set({ highlightsGroup: v })} options={[
                { value: 'book', label: book ? 'In book order' : 'By book' },
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

          {group === 'recent' ? (
            <div className="hl-days">
              {byDay.map(d => (
                <section key={d.label} className="hl-day">
                  <h3 className="hl-chapter">{d.label}</h3>
                  <div className="hl-list">{d.items.map(a => card(a, !book, true))}</div>
                </section>
              ))}
            </div>
          ) : book ? (
            byBook[0] && inOrder(byBook[0].items)
          ) : byBook.map(g => {
            const notes = g.items.filter(a => a.note).length
            return (
              <section key={g.book.id} className="hl-group">
                <aside className="hl-book">
                  <button className="hl-book-cover" onClick={() => pick(g.book.id)} tabIndex={-1} aria-hidden>
                    <BookCover book={g.book} />
                  </button>
                  <div className="hl-book-info">
                    <h2><button onClick={() => pick(g.book.id)} title="Show only this book">{g.book.title}</button></h2>
                    {g.book.author && <div className="muted small">{g.book.author}</div>}
                    <div className="muted small">{plural(g.items.length, 'highlight')}{notes ? ` · ${plural(notes, 'note')}` : ''}</div>
                    {away.has(g.book.id) && (
                      <div className="hl-away muted small" title="Synced from another device. Add the book here to open it.">
                        <CloudOff size={13} />Not on this device
                      </div>
                    )}
                  </div>
                  <div className="hl-book-actions">
                    {!away.has(g.book.id) && <Button onClick={() => openBook(g.book)}><BookOpen size={16} />{g.book.progress > 0 ? 'Continue' : 'Read'}</Button>}
                  </div>
                </aside>
                {inOrder(g.items)}
              </section>
            )
          })}
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

interface ShelfBook {
  book: BookRecord
  count: number
  notes: number
  latest: number
}

/** Covers of the books with highlights, to show one book's or all of them. */
const Shelf = ({ shelf, total, current, onPick }: {
  shelf: ShelfBook[]
  total: number
  current?: string
  onPick: (id?: string) => void
}) => {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-selected=true]')
    const strip = ref.current
    if (el && strip) strip.scrollLeft = Math.max(0, el.offsetLeft - strip.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2)
  }, [current])
  return (
    <div className="hl-shelf" ref={ref} role="tablist" aria-label="Show highlights from">
      <button type="button" role="tab" aria-selected={!current} className="hl-shelf-item all" onClick={() => onPick()}>
        <span className="hl-shelf-cover"><LibraryBig size={24} /></span>
        <span className="hl-shelf-title">All books</span>
        <small>{total}</small>
      </button>
      {shelf.map(o => (
        <button key={o.book.id} type="button" role="tab" aria-selected={current === o.book.id} className="hl-shelf-item"
          onClick={() => onPick(o.book.id)} title={`${o.book.title}${o.book.author ? ` — ${o.book.author}` : ''}`}>
          <span className="hl-shelf-cover"><BookCover book={o.book} /></span>
          <span className="hl-shelf-title">{o.book.title}</span>
          <small>{o.count}</small>
        </button>
      ))}
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
