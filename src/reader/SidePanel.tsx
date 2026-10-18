import { Bookmark, ChevronRight, Download, ListTree, NotebookPen, Search, Trash, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Annotation, BookRecord } from '../lib/db'
import { annotationsToMarkdown, sortAnnotations } from '../lib/annotations'
import { formatRelative, percent, safeFileName } from '../lib/format'
import { exportFile } from '../lib/platform'
import { HIGHLIGHT_COLORS } from '../lib/themes'
import { IconButton, Segmented, Spinner } from '../components/ui'
import { BookCover } from '../library/BookCover'
import type { ReaderEngine, Relocation, SearchHit, TocItem } from './types'

export type PanelTab = 'contents' | 'notes' | 'search'

interface Props {
  open: boolean
  tab: PanelTab
  onTab: (t: PanelTab) => void
  onClose: () => void
  book: BookRecord
  engine: ReaderEngine | null
  location: Relocation | null
  annotations: Annotation[]
  onNavigate: (target: string) => void
  onEditNote: (a: Annotation) => void
  onDelete: (a: Annotation) => void
  searchQuery: string
  onSearchQuery: (q: string) => void
}

export const SidePanel = (p: Props) => {
  const { open, tab, onTab, onClose, book, location } = p
  return (
    <>
      <div className={`panel-backdrop ${open ? 'show' : ''}`} onClick={onClose} />
      <aside className={`side-panel ${open ? 'open' : ''}`} aria-hidden={!open}>
        <div className="panel-head">
          <BookCover book={book} className="panel-cover" />
          <div className="panel-book">
            <div className="panel-title">{book.title}</div>
            <div className="muted small">{book.author}</div>
            <div className="muted small">{location ? `${percent(location.fraction)} read` : ''}</div>
          </div>
          <IconButton label="Close" onClick={onClose}><X size={20} /></IconButton>
        </div>
        <div className="panel-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'contents'} className={tab === 'contents' ? 'on' : ''} onClick={() => onTab('contents')}><ListTree size={16} />Contents</button>
          <button role="tab" aria-selected={tab === 'notes'} className={tab === 'notes' ? 'on' : ''} onClick={() => onTab('notes')}><NotebookPen size={16} />Notes{p.annotations.length ? <small>{p.annotations.length}</small> : null}</button>
          <button role="tab" aria-selected={tab === 'search'} className={tab === 'search' ? 'on' : ''} onClick={() => onTab('search')}><Search size={16} />Search</button>
        </div>
        <div className="panel-body">
          {open && tab === 'contents' && <Contents toc={p.engine?.toc ?? []} current={location?.chapterTarget} onNavigate={p.onNavigate} />}
          {open && tab === 'notes' && <Notes {...p} />}
          {tab === 'search' && <SearchTab engine={p.engine} onNavigate={p.onNavigate} query={p.searchQuery} onQuery={p.onSearchQuery} visible={open} />}
        </div>
      </aside>
    </>
  )
}

const Contents = ({ toc, current, onNavigate }: { toc: TocItem[]; current?: string; onNavigate: (t: string) => void }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector('.toc-item.current')?.scrollIntoView({ block: 'center' })
  }, [])
  if (!toc.length) return <p className="muted pad">This book has no table of contents.</p>
  return <div ref={ref} className="toc">{toc.map(item => <TocNode key={item.id} item={item} current={current} onNavigate={onNavigate} />)}</div>
}

const containsTarget = (item: TocItem, target?: string): boolean =>
  !!target && (item.target === target || !!item.children?.some(c => containsTarget(c, target)))

const TocNode = ({ item, current, onNavigate }: { item: TocItem; current?: string; onNavigate: (t: string) => void }) => {
  const [expanded, setExpanded] = useState(() => item.level < 1 || containsTarget(item, current))
  const isCurrent = item.target === current
  return (
    <div className="toc-node">
      <div className={`toc-item ${isCurrent ? 'current' : ''}`} style={{ paddingInlineStart: 14 + item.level * 16 }}>
        {item.children ? (
          <button className={`toc-toggle ${expanded ? 'open' : ''}`} aria-label={expanded ? 'Collapse' : 'Expand'} onClick={() => setExpanded(!expanded)}>
            <ChevronRight size={14} />
          </button>
        ) : <span className="toc-toggle-space" />}
        <button className="toc-label" onClick={() => onNavigate(item.target)}>{item.label}</button>
      </div>
      {expanded && item.children?.map(c => <TocNode key={c.id} item={c} current={current} onNavigate={onNavigate} />)}
    </div>
  )
}

const Notes = ({ book, annotations, onNavigate, onEditNote, onDelete }: Props) => {
  const [filter, setFilter] = useState<'all' | 'highlights' | 'notes' | 'bookmarks'>('all')
  const list = useMemo(() => sortAnnotations(annotations.filter(a =>
    filter === 'all' || (filter === 'bookmarks' ? a.kind === 'bookmark' : filter === 'notes' ? !!a.note : a.kind === 'highlight')), book.format), [annotations, filter, book.format])
  if (!annotations.length) {
    return (
      <div className="pad muted">
        <p>No highlights or bookmarks yet.</p>
        <p className="small">Select text to highlight it or add a note. Use the bookmark button (or press B) to bookmark a page.</p>
      </div>
    )
  }
  return (
    <div className="notes">
      <div className="notes-bar">
        <Segmented value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All' }, { value: 'highlights', label: 'Highlights' }, { value: 'notes', label: 'Notes' }, { value: 'bookmarks', label: 'Bookmarks' },
        ]} />
        <IconButton label="Export as Markdown" onClick={() => exportFile(`${safeFileName(book.title)} - highlights.md`, annotationsToMarkdown(book, annotations), 'text/markdown')}>
          <Download size={17} />
        </IconButton>
      </div>
      {list.map(a => (
        <div key={a.id} className={`note-item ${a.kind}`} style={{ '--c': HIGHLIGHT_COLORS[a.color ?? 'yellow'].light } as React.CSSProperties}>
          <button className="note-content" onClick={() => onNavigate(a.locator)}>
            {a.kind === 'bookmark'
              ? <div className="note-bm"><Bookmark size={15} fill="currentColor" />{a.text || 'Bookmark'}</div>
              : <div className="note-text">{a.text.length > 320 ? `${a.text.slice(0, 320)}…` : a.text}</div>}
            {a.note && <div className="note-note">{a.note}</div>}
            <div className="note-meta">
              {[a.chapter, a.page ? `p. ${a.page}` : a.fraction != null ? percent(a.fraction) : null, formatRelative(a.createdAt)].filter(Boolean).join(' · ')}
            </div>
          </button>
          <div className="note-actions">
            {a.kind === 'highlight' && <IconButton label={a.note ? 'Edit note' : 'Add note'} onClick={() => onEditNote(a)}><NotebookPen size={15} /></IconButton>}
            <IconButton label="Delete" onClick={() => onDelete(a)}><Trash size={15} /></IconButton>
          </div>
        </div>
      ))}
    </div>
  )
}

const SearchTab = ({ engine, onNavigate, query, onQuery, visible }: {
  engine: ReaderEngine | null
  onNavigate: (t: string) => void
  query: string
  onQuery: (q: string) => void
  visible: boolean
}) => {
  const [input, setInput] = useState(query)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [progress, setProgress] = useState(1)
  const [searched, setSearched] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const ctrl = useRef<AbortController | null>(null)

  useEffect(() => {
    if (visible) setTimeout(() => inputRef.current?.focus(), 50)
  }, [visible])

  const run = (q: string) => {
    ctrl.current?.abort()
    engine?.clearSearch()
    setHits([])
    setSearched(q)
    onQuery(q)
    if (!engine || q.trim().length < 2) {
      setProgress(1)
      return
    }
    const c = new AbortController()
    ctrl.current = c
    setProgress(0)
    const buf: SearchHit[] = []
    let flush = 0
    engine.search(q.trim(), hit => {
      buf.push(hit)
      if (!flush) flush = requestAnimationFrame(() => {
        flush = 0
        if (!c.signal.aborted) setHits([...buf])
      })
    }, setProgress, c.signal).then(() => {
      if (!c.signal.aborted) {
        setHits([...buf])
        setProgress(1)
      }
    }).catch(e => console.warn(e))
  }

  useEffect(() => {
    if (query && query !== searched) {
      setInput(query)
      run(query)
    }
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => ctrl.current?.abort(), [])

  let lastLabel: string | undefined
  return (
    <div className="search-tab">
      <form className="search-field" onSubmit={e => { e.preventDefault(); run(input) }}>
        <Search size={16} />
        <input ref={inputRef} type="search" placeholder="Search in book" value={input} onChange={e => setInput(e.target.value)} enterKeyHint="search" />
        {input && <button type="button" className="clear" aria-label="Clear" onClick={() => { setInput(''); run('') }}><X size={14} /></button>}
      </form>
      {progress < 1 && <div className="search-progress"><span style={{ width: percent(progress) }} /></div>}
      {searched && (
        <div className="muted small search-count">
          {progress < 1 ? <><Spinner size={12} /> Searching… {hits.length} found</> : `${hits.length}${hits.length >= 1000 ? '+' : ''} result${hits.length === 1 ? '' : 's'}`}
        </div>
      )}
      <div className="search-results">
        {hits.slice(0, 1000).map((h, i) => {
          const showLabel = h.label && h.label !== lastLabel
          lastLabel = h.label
          return (
            <div key={i}>
              {showLabel && <div className="search-group">{h.label}</div>}
              <button className="search-hit" onClick={() => onNavigate(h.locator)}>
                {h.excerpt.pre}<mark>{h.excerpt.match}</mark>{h.excerpt.post}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
