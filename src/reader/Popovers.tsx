import { BookA, Copy, Languages, NotebookPen, Search, Trash, Volume2, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Annotation, HighlightColor } from '../lib/db'
import { HIGHLIGHT_COLORS } from '../lib/themes'
import { isTouch } from '../lib/platform'
import { Button, IconButton, Sheet } from '../components/ui'
import { DictionaryView } from '../dictionary/DictionaryView'
import type { Rect } from './text'

const COLORS = Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]

/** A card positioned next to a viewport rectangle, flipping above/below to fit. */
export const Floating = ({ rect, prefer = 'above', className = '', children, gap = 12, keepSelection }: {
  rect: Rect
  prefer?: 'above' | 'below'
  className?: string
  children: ReactNode
  gap?: number
  /** don't let clicks on the card clear the text selection */
  keepSelection?: boolean
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const w = el.offsetWidth
      const h = el.offsetHeight
      const cx = (rect.left + rect.right) / 2
      const left = Math.max(8, Math.min(cx - w / 2, innerWidth - w - 8))
      const above = rect.top - gap - 8
      const below = innerHeight - rect.bottom - gap - 8
      const useBelow = prefer === 'below' ? below >= h || below >= above : !(above >= h || above >= below)
      const top = useBelow ? Math.min(innerHeight - h - 8, rect.bottom + gap) : Math.max(8, rect.top - gap - h)
      setPos({ left, top, below: useBelow })
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rect, prefer, gap])
  return (
    <div ref={ref} className={`floating ${className} ${pos?.below ? 'below' : 'above'}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onPointerDown={e => e.stopPropagation()} onMouseDown={keepSelection ? e => e.preventDefault() : undefined}>
      {children}
    </div>
  )
}

const Swatches = ({ value, onPick }: { value?: HighlightColor; onPick: (c: HighlightColor) => void }) => (
  <div className="swatches">
    {COLORS.map(c => (
      <button key={c} type="button" className={`swatch ${value === c ? 'on' : ''}`} aria-label={`${HIGHLIGHT_COLORS[c].label} highlight`}
        title={HIGHLIGHT_COLORS[c].label} style={{ '--c': HIGHLIGHT_COLORS[c].light } as React.CSSProperties} onClick={() => onPick(c)} />
    ))}
  </div>
)

export const SelectionMenu = ({ rect, canHighlight, onHighlight, onNote, onDefine, onCopy, onTranslate, onSearch, onSpeak }: {
  rect: Rect
  canHighlight: boolean
  onHighlight: (c: HighlightColor) => void
  onNote: () => void
  onDefine: () => void
  onCopy: () => void
  onTranslate: () => void
  onSearch: () => void
  onSpeak: () => void
}) => (
  <Floating rect={rect} prefer={isTouch ? 'below' : 'above'} className="sel-menu" keepSelection>
    {canHighlight && <><Swatches onPick={onHighlight} /><div className="sel-sep" /></>}
    <div className="sel-actions">
      {canHighlight && <button onClick={onNote}><NotebookPen size={17} /><span>Note</span></button>}
      <button onClick={onDefine}><BookA size={17} /><span>Define</span></button>
      <button onClick={onCopy}><Copy size={17} /><span>Copy</span></button>
      <button onClick={onTranslate}><Languages size={17} /><span>Translate</span></button>
      <button onClick={onSearch}><Search size={17} /><span>Search</span></button>
      <button onClick={onSpeak}><Volume2 size={17} /><span>Speak</span></button>
    </div>
  </Floating>
)

export const AnnotationMenu = ({ rect, annotation, onColor, onNote, onCopy, onDefine, onDelete }: {
  rect: Rect
  annotation: Annotation
  onColor: (c: HighlightColor) => void
  onNote: () => void
  onCopy: () => void
  onDefine: () => void
  onDelete: () => void
}) => (
  <Floating rect={rect} prefer="above" className="sel-menu" keepSelection>
    <Swatches value={annotation.color} onPick={onColor} />
    <div className="sel-sep" />
    {annotation.note && <div className="sel-note" onClick={onNote}>{annotation.note}</div>}
    <div className="sel-actions">
      <button onClick={onNote}><NotebookPen size={17} /><span>{annotation.note ? 'Edit note' : 'Note'}</span></button>
      <button onClick={onDefine}><BookA size={17} /><span>Define</span></button>
      <button onClick={onCopy}><Copy size={17} /><span>Copy</span></button>
      <button className="danger" onClick={onDelete}><Trash size={17} /><span>Delete</span></button>
    </div>
  </Floating>
)

export const DictionaryPopup = ({ word, rect, context, lang, bookId, bookTitle, canHighlight, onHighlight, onClose }: {
  word: string
  rect: Rect
  context?: string
  lang?: string
  bookId: string
  bookTitle: string
  canHighlight: boolean
  onHighlight: (c: HighlightColor) => void
  onClose: () => void
}) => {
  const body = (
    <>
      <DictionaryView word={word} context={context} lang={lang} bookId={bookId} bookTitle={bookTitle} compact />
      {canHighlight && (
        <div className="dict-hl-row">
          <span className="muted small">Highlight</span>
          <Swatches onPick={onHighlight} />
        </div>
      )}
    </>
  )
  if (innerWidth < 640) {
    return (
      <div className="dict-sheet-backdrop" onPointerDown={e => e.target === e.currentTarget && onClose()}>
        <div className="dict-sheet" onPointerDown={e => e.stopPropagation()}>
          <div className="sheet-grip" />
          <IconButton label="Close" className="dict-close" onClick={onClose}><X size={18} /></IconButton>
          {body}
        </div>
      </div>
    )
  }
  return <Floating rect={rect} prefer="below" className="dict-pop">{body}</Floating>
}

export const NoteDialog = ({ annotation, onSave, onDelete, onClose }: {
  annotation: Pick<Annotation, 'text' | 'note' | 'color'> | null
  onSave: (note: string) => void
  onDelete?: () => void
  onClose: () => void
}) => {
  const [text, setText] = useState(annotation?.note ?? '')
  const [prev, setPrev] = useState(annotation)
  if (prev !== annotation) {
    setPrev(annotation)
    setText(annotation?.note ?? '')
  }
  if (!annotation) return null
  return (
    <Sheet open onClose={onClose} title={annotation.note ? 'Edit note' : 'Add note'}>
      <blockquote className="note-quote" style={{ '--c': HIGHLIGHT_COLORS[annotation.color ?? 'yellow'].light } as React.CSSProperties}>
        {annotation.text.length > 400 ? `${annotation.text.slice(0, 400)}…` : annotation.text}
      </blockquote>
      <textarea className="note-input" autoFocus rows={5} placeholder="Write your thoughts…" value={text} onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave(text.trim())
        }} />
      <div className="sheet-actions">
        {onDelete && <Button variant="danger" onClick={onDelete}><Trash size={16} />Delete highlight</Button>}
        <span className="spacer" />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onSave(text.trim())}>Save</Button>
      </div>
    </Sheet>
  )
}
