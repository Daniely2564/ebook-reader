import { ArrowUpDown, BookOpen, Check, Clock, Ellipsis, Flame, Highlighter, Info, LayoutGrid, LayoutList, Play, Plus, Search, Trash, Undo2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { deleteBook, getAnnotations, updateBook, type BookRecord } from '../lib/db'
import { formatDuration, formatRelative, formatSize, percent, safeFileName } from '../lib/format'
import { useSettings, type Settings } from '../lib/settings'
import { toast, useApp } from '../lib/store'
import { annotationsToMarkdown } from '../lib/annotations'
import { exportFile } from '../lib/platform'
import { isSyncOn } from '../lib/sync'
import { Button, Empty, IconButton, Menu, Segmented, Sheet, Spinner } from '../components/ui'
import { BookCover, forgetCover } from './BookCover'
import { useBooks, useReadingStats } from './useLibrary'

const SORTS: { value: Settings['librarySort']; label: string }[] = [
  { value: 'recent', label: 'Recently read' },
  { value: 'added', label: 'Recently added' },
  { value: 'title', label: 'Title' },
  { value: 'author', label: 'Author' },
  { value: 'progress', label: 'Progress' },
]

/** time read on this device and your other ones */
const readTime = (b: BookRecord) => b.readingTime + (b.otherReadingTime ?? 0)

const statusOf = (b: BookRecord) => b.finished ? 'finished' : b.progress > 0.001 || b.lastReadAt ? 'reading' : 'unread'

export const Library = ({ onImport }: { onImport: () => void }) => {
  const books = useBooks()
  const stats = useReadingStats()
  const { librarySort, libraryView, libraryFilter, set } = useSettings()
  const go = useApp(s => s.go)
  const refresh = useApp(s => s.refreshLibrary)
  const importing = useApp(s => s.importing)
  const [query, setQuery] = useState('')
  const [details, setDetails] = useState<BookRecord | null>(null)

  const counts = useMemo(() => {
    const c = { all: 0, reading: 0, unread: 0, finished: 0 }
    for (const b of books ?? []) {
      c.all++
      c[statusOf(b)]++
    }
    return c
  }, [books])

  const shown = useMemo(() => {
    if (!books) return []
    const q = query.trim().toLowerCase()
    const list = books.filter(b =>
      (libraryFilter === 'all' || statusOf(b) === libraryFilter) &&
      (!q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)))
    const by: Record<Settings['librarySort'], (a: BookRecord, b: BookRecord) => number> = {
      recent: (a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt),
      added: (a, b) => b.addedAt - a.addedAt,
      title: (a, b) => a.title.localeCompare(b.title),
      author: (a, b) => (a.author || '￿').localeCompare(b.author || '￿') || a.title.localeCompare(b.title),
      progress: (a, b) => b.progress - a.progress,
    }
    return list.sort(by[librarySort])
  }, [books, query, libraryFilter, librarySort])

  const current = useMemo(() => books
    ?.filter(b => b.lastReadAt && !b.finished && b.progress < 0.995)
    .sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))[0], [books])

  const open = (b: BookRecord) => go({ name: 'reader', bookId: b.id })

  const remove = async (b: BookRecord) => {
    // with sync on, the book's highlights stay: they're still on your other devices and come back with the book
    const keepNotes = isSyncOn()
    if (!confirm(keepNotes
      ? `Remove “${b.title}” from this device? Its highlights and notes stay in sync and come back if you add the book again.`
      : `Remove “${b.title}” from your library? Highlights and notes for this book will be deleted too.`)) return
    await deleteBook(b.id, keepNotes)
    forgetCover(b.id)
    setDetails(null)
    refresh()
    toast(`Removed “${b.title}”`)
  }

  const setFinished = async (b: BookRecord, finished: boolean) => {
    await updateBook(b.id, { finished, ...(finished ? {} : { progress: b.progress >= 0.995 ? 0 : b.progress }) })
    refresh()
  }

  const bookMenu = (b: BookRecord) => [
    { label: 'Open', icon: <BookOpen size={16} />, onSelect: () => open(b) },
    { label: 'Details', icon: <Info size={16} />, onSelect: () => setDetails(b) },
    { label: 'Highlights', icon: <Highlighter size={16} />, onSelect: () => go({ name: 'highlights', bookId: b.id }) },
    b.finished
      ? { label: 'Mark as unread', icon: <Undo2 size={16} />, onSelect: () => setFinished(b, false) }
      : { label: 'Mark as finished', icon: <Check size={16} />, onSelect: () => setFinished(b, true) },
    'sep' as const,
    { label: 'Remove', icon: <Trash size={16} />, danger: true, onSelect: () => remove(b) },
  ]

  if (!books) return <div className="page-center"><Spinner /></div>

  return (
    <div className="library screen">
      <header className="page-head">
        <div className="page-title">
          <h1>Library</h1>
          {stats && (
            <div className="stat-chips">
              <span className="chip" title="Reading time today"><Clock size={14} />{formatDuration(stats.todayMs)} today</span>
              {stats.streak > 0 && <span className="chip chip-warm" title="Days in a row with reading"><Flame size={14} />{stats.streak}-day streak</span>}
            </div>
          )}
        </div>
        <div className="page-actions">
          <div className="search-field">
            <Search size={16} />
            <input type="search" placeholder="Search title or author" value={query} onChange={e => setQuery(e.target.value)} />
            {query && <button className="clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}
          </div>
          <Button variant="primary" onClick={onImport} disabled={!!importing}>
            {importing ? <Spinner size={16} /> : <Plus size={18} />}
            <span>{importing ? `Importing ${importing.done}/${importing.total}` : 'Add books'}</span>
          </Button>
        </div>
      </header>

      {!books.length ? (
        <Empty icon={<BookOpen size={40} />} title="Your library is empty">
          <p>Add EPUB, PDF, MOBI/AZW3, FB2 or CBZ files. Everything stays on this device, and the dictionary works offline.</p>
          <Button variant="primary" onClick={onImport}><Plus size={18} />Add books</Button>
          <p className="hint">Tip: you can also drag and drop files anywhere in this window.</p>
        </Empty>
      ) : (
        <>
          {current && !query && libraryFilter === 'all' && (
            <section className="continue" onClick={() => open(current)} role="button" tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && open(current)}>
              <BookCover book={current} className="continue-cover" />
              <div className="continue-info">
                <div className="eyebrow">Continue reading</div>
                <h2>{current.title}</h2>
                {current.author && <div className="muted">{current.author}</div>}
                <div className="continue-progress">
                  <div className="bar"><span style={{ width: percent(current.progress) }} /></div>
                  <span>{percent(current.progress)}</span>
                </div>
                <div className="muted small">
                  {current.locationLabel && <>{current.locationLabel} · </>}
                  {formatRelative(current.lastReadAt)}
                  {readTime(current) > 60000 && <> · read for {formatDuration(readTime(current))}</>}
                </div>
              </div>
              <Button variant="primary" className="continue-btn" tabIndex={-1}><Play size={16} />Resume</Button>
            </section>
          )}

          <div className="toolbar">
            <Segmented value={libraryFilter} onChange={v => set({ libraryFilter: v })} options={[
              { value: 'all', label: <>All <small>{counts.all}</small></> },
              { value: 'reading', label: <>Reading <small>{counts.reading}</small></> },
              { value: 'unread', label: <>Unread <small>{counts.unread}</small></> },
              { value: 'finished', label: <>Finished <small>{counts.finished}</small></> },
            ]} />
            <div className="toolbar-right">
              <Menu items={SORTS.map(s => ({ label: (s.value === librarySort ? '✓ ' : ' ') + s.label, onSelect: () => set({ librarySort: s.value }) }))}
                trigger={p => <Button variant="ghost" {...p}><ArrowUpDown size={16} />{SORTS.find(s => s.value === librarySort)?.label}</Button>} />
              <IconButton label={libraryView === 'grid' ? 'List view' : 'Grid view'} onClick={() => set({ libraryView: libraryView === 'grid' ? 'list' : 'grid' })}>
                {libraryView === 'grid' ? <LayoutList size={18} /> : <LayoutGrid size={18} />}
              </IconButton>
            </div>
          </div>

          {!shown.length && <p className="muted center pad">No books match.</p>}

          <div className={libraryView === 'grid' ? 'book-grid' : 'book-list'}>
            {shown.map(b => (
              <article key={b.id} className="book" onClick={() => open(b)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && open(b)}>
                <div className="book-cover-wrap">
                  <BookCover book={b} />
                  {b.finished ? <span className="badge badge-done"><Check size={12} />Finished</span>
                    : !b.lastReadAt ? <span className="badge">New</span> : null}
                  {!b.finished && b.progress > 0 && <div className="cover-progress"><span style={{ width: percent(b.progress) }} /></div>}
                </div>
                <div className="book-meta">
                  <div className="book-title" title={b.title}>{b.title}</div>
                  <div className="book-author">{b.author || 'Unknown author'}</div>
                  {libraryView === 'list' && (
                    <div className="book-extra">
                      <span>{b.format.toUpperCase()}</span>
                      <span>{b.finished ? 'Finished' : b.progress > 0 ? percent(b.progress) : 'Not started'}</span>
                      {b.lastReadAt && <span>{formatRelative(b.lastReadAt)}</span>}
                    </div>
                  )}
                </div>
                <Menu items={bookMenu(b)} trigger={p => (
                  <IconButton label="Book options" className="book-menu" {...p}><Ellipsis size={18} /></IconButton>
                )} />
              </article>
            ))}
          </div>
        </>
      )}
      <BookDetails book={details} onClose={() => setDetails(null)} onRemove={remove} onOpen={open} />
    </div>
  )
}

const BookDetails = ({ book, onClose, onRemove, onOpen }: {
  book: BookRecord | null
  onClose: () => void
  onRemove: (b: BookRecord) => void
  onOpen: (b: BookRecord) => void
}) => {
  if (!book) return null
  const exportNotes = async () => {
    const list = await getAnnotations(book.id)
    if (!list.length) {
      toast('No highlights or bookmarks in this book yet')
      return
    }
    await exportFile(`${safeFileName(book.title)} - highlights.md`, annotationsToMarkdown(book, list), 'text/markdown')
  }
  const rows: [string, string | undefined][] = [
    ['Author', book.author],
    ['Publisher', book.publisher],
    ['Language', book.language],
    ['Format', `${book.format.toUpperCase()} · ${formatSize(book.size)}${book.pageCount ? ` · ${book.pageCount} pages` : ''}`],
    ['Added', new Date(book.addedAt).toLocaleDateString()],
    ['Last read', book.lastReadAt ? formatRelative(book.lastReadAt) : 'Never'],
    ['Progress', book.finished ? 'Finished' : percent(book.progress)],
    ['Reading time', formatDuration(readTime(book))],
  ]
  return (
    <Sheet open onClose={onClose} title="Book details">
      <div className="details">
        <BookCover book={book} className="details-cover" />
        <div className="details-main">
          <h3>{book.title}</h3>
          <dl>
            {rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        </div>
      </div>
      {book.description && <p className="details-desc">{book.description}</p>}
      <div className="sheet-actions">
        <Button variant="danger" onClick={() => onRemove(book)}><Trash size={16} />Remove</Button>
        <span className="spacer" />
        <Button onClick={exportNotes}>Export highlights</Button>
        <Button variant="primary" onClick={() => onOpen(book)}><BookOpen size={16} />{book.progress > 0 ? 'Continue' : 'Read'}</Button>
      </div>
    </Sheet>
  )
}

