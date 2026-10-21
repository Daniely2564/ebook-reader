// Reflowable books (EPUB, MOBI/AZW3, FB2, CBZ) rendered with foliate-js.
import '../vendor/foliate-js/view.js'
import type { FoliateRelocateDetail, FoliateTocItem, FoliateView } from '../vendor/foliate-js/view.js'
import { Overlayer } from '../vendor/foliate-js/overlayer.js'
import { FootnoteHandler } from '../vendor/foliate-js/footnotes.js'
import type { Annotation } from '../lib/db'
import type { Settings } from '../lib/settings'
import { fontById, fontFaceCss, HIGHLIGHT_COLORS, themeById, type ReaderTheme } from '../lib/themes'
import { isElision } from '../lib/dictionary/wordnet'
import { contextSentence, rectOf, splitSentences } from './text'
import type { EngineCallbacks, ReaderEngine, Relocation, SearchHit, SpeechChunk, TocItem } from './types'

const SENTENCE_BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, figcaption, td, th, pre, div, section, article, body'

const convertToc = (items: FoliateTocItem[] | undefined, level = 0): TocItem[] =>
  (items ?? []).map((item, i) => ({
    id: `${level}-${i}-${item.href}`,
    label: (item.label ?? '').trim() || 'Untitled',
    target: item.href,
    level,
    children: item.subitems?.length ? convertToc(item.subitems, level + 1) : undefined,
  }))

const bookCss = (s: Settings, theme: ReaderTheme) => {
  const font = fontById(s.font)
  const override = s.overrideColors === 'always' || (s.overrideColors === 'auto' && theme.dark)
  const textBlocks = 'p, li, blockquote, dd, dt'
  // @namespace must precede every other rule (including @font-face) or it is ignored
  return `@namespace epub "http://www.idpf.org/2007/ops";
${fontFaceCss(font)}
html {
  color-scheme: ${theme.dark ? 'dark' : 'light'};
  font-size: ${s.fontSize}px !important;
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
}
html, body {
  background: ${theme.bg} !important;
  color: ${theme.fg} !important;
}
body {
  font-size: 1rem !important;
  ${s.letterSpacing ? `letter-spacing: ${s.letterSpacing}em;` : ''}
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  font-kerning: normal;
  font-variant-ligatures: common-ligatures;
}
${font.family ? `
body, p, div, span, li, blockquote, dd, dt, td, th, a, em, i, b, strong, small, cite, label,
h1, h2, h3, h4, h5, h6, section, article, aside, figcaption, sup, sub, q, abbr, dfn, var, u, s, mark {
  font-family: ${font.family} !important;
}` : ''}
${s.fontWeight !== 400 ? `
${textBlocks}, div, span { font-weight: ${s.fontWeight} !important; }
b, strong, b *, strong *, h1, h2, h3, h4, h5, h6 { font-weight: ${Math.min(900, s.fontWeight + 300)} !important; }` : ''}
${textBlocks}, div {
  line-height: ${s.lineHeight} !important;
}
${textBlocks} {
  text-align: ${s.justify ? 'justify' : 'start'};
  -webkit-hyphens: ${s.hyphenate ? 'auto' : 'manual'};
  hyphens: ${s.hyphenate ? 'auto' : 'manual'};
  hyphenate-limit-chars: 6 3 2;
  hanging-punctuation: allow-end last;
  widows: 2;
  orphans: 2;
}
${s.paragraphSpacing >= 0 ? `p { margin-top: ${s.paragraphSpacing}em !important; margin-bottom: ${s.paragraphSpacing}em !important; }` : ''}
[align="left"] { text-align: left; }
[align="right"] { text-align: right; }
[align="center"] { text-align: center; }
pre { white-space: pre-wrap !important; }
a:link, a:visited { color: ${theme.link} !important; text-decoration-thickness: from-font; }
${override ? `
body *:not(a):not(a *):not(img):not(svg):not(svg *):not(video) {
  color: inherit !important;
  background-color: transparent !important;
  border-color: ${theme.border} !important;
}` : ''}
${theme.dark ? 'img, svg image, video { filter: brightness(.86) contrast(1.06); }' : ''}
::selection { background: ${theme.selection}; }
::highlight(lumen-tts) { background-color: ${theme.dark ? 'rgba(240,164,87,.32)' : 'rgba(255,196,0,.38)'}; }
aside[epub|type~="endnote"], aside[epub|type~="footnote"], aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
`
}

export class EpubEngine implements ReaderEngine {
  readonly kind = 'reflowable' as const
  toc: TocItem[] = []
  sectionFractions: number[] = []
  language?: string
  dir?: 'ltr' | 'rtl'

  #file: File
  #cb: EngineCallbacks
  #view!: FoliateView
  #container!: HTMLElement
  #settings?: Settings
  #theme: ReaderTheme = themeById('paper')
  #annotations = new Map<string, Annotation>()
  #location?: FoliateRelocateDetail
  #docIndex = new WeakMap<Document, number>()
  #annotationClickAt = 0
  #pointerType = 'mouse'
  #pendingTap: ReturnType<typeof setTimeout> | null = null
  #wheelActive = false
  #wheelTimer: ReturnType<typeof setTimeout> | null = null
  #selectionTimer: ReturnType<typeof setTimeout> | null = null
  #mouseDown = false
  /** last selection reported to the UI, so unchanged selections aren't re-reported */
  #lastSelection: string | null = null
  #speechFromStart = false
  #footnotes = new FootnoteHandler()
  #footnoteEl: HTMLElement | null = null
  #destroyed = false
  #bookTitle = ''

  constructor(file: File, title: string, cb: EngineCallbacks) {
    this.#file = file
    this.#bookTitle = title
    this.#cb = cb
  }

  async open(container: HTMLElement, location?: string) {
    this.#container = container
    const view = document.createElement('foliate-view') as FoliateView
    view.className = 'foliate'
    container.append(view)
    this.#view = view
    await view.open(this.#file)
    if (this.#destroyed) return
    const { book } = view
    const lang = book.metadata?.language
    this.language = (Array.isArray(lang) ? lang[0] : lang) || undefined
    this.dir = book.dir === 'rtl' ? 'rtl' : 'ltr'
    this.toc = convertToc(book.toc)

    view.addEventListener('load', e => this.#onLoad((e as CustomEvent).detail))
    view.addEventListener('relocate', e => this.#onRelocate((e as CustomEvent).detail))
    view.addEventListener('create-overlay', () => this.#redrawAnnotations())
    view.addEventListener('draw-annotation', e => this.#drawAnnotation((e as CustomEvent).detail))
    view.addEventListener('show-annotation', e => this.#onShowAnnotation((e as CustomEvent).detail))
    view.addEventListener('link', e => {
      const p = this.#footnotes.handle(view.book, e as CustomEvent)
      if (p) {
        const { a } = (e as CustomEvent).detail
        this.#footnoteAnchor = rectOf(a.getBoundingClientRect(), a.ownerDocument)
        p.catch(err => console.warn(err))
      }
    })
    this.#footnotes.addEventListener('before-render', e => this.#prepareFootnote((e as CustomEvent).detail.view))
    this.#footnotes.addEventListener('render', e => this.#showFootnote((e as CustomEvent).detail))
    container.addEventListener('wheel', this.#onWheel, { passive: false })

    if (this.#settings) this.applySettings(this.#settings)
    await view.init({ lastLocation: location || null, showTextStart: false })
    this.sectionFractions = view.getSectionFractions()
  }

  destroy() {
    this.#destroyed = true
    this.#hideFootnote()
    this.#container?.removeEventListener('wheel', this.#onWheel)
    try {
      this.#view?.close()
    } catch { /* already closed */ }
    this.#view?.remove()
  }

  // ---------------------------------------------------------------- navigation
  next() {
    if (this.#settings?.flow === 'scrolled') this.#view.next(this.#container.clientHeight * 0.85)
    else this.#view.next()
  }
  prev() {
    if (this.#settings?.flow === 'scrolled') this.#view.prev(this.#container.clientHeight * 0.85)
    else this.#view.prev()
  }
  async goTo(target: string) {
    await this.#view.goTo(target)
  }
  async goToFraction(f: number) {
    await this.#view.goToFraction(f)
  }
  canGoBack() {
    return this.#view?.history.canGoBack ?? false
  }
  back() {
    this.#view.history.back()
  }

  // ---------------------------------------------------------------- appearance
  applySettings(s: Settings) {
    const prevDark = this.#theme.dark
    this.#settings = s
    this.#theme = themeById(s.theme)
    const view = this.#view
    if (!view?.renderer) return
    const r = view.renderer
    const t = this.#theme
    view.style.setProperty('--lumen-page-bg', t.bg)
    view.style.setProperty('--lumen-page-fg', t.muted)
    view.style.setProperty('--overlayer-highlight-opacity', t.dark ? '.38' : '.45')
    view.style.setProperty('--overlayer-highlight-blend-mode', t.dark ? 'normal' : 'multiply')
    view.style.background = t.bg
    if (!view.isFixedLayout) {
      r.setAttribute('flow', s.flow)
      r.setAttribute('gap', `${s.margin}%`)
      r.setAttribute('margin', s.runningHeads && s.flow === 'paginated' ? '48px' : '20px')
      r.setAttribute('max-inline-size', `${s.maxWidth}px`)
      r.setAttribute('max-column-count', String(s.columns))
      r.toggleAttribute('animated', s.animated)
    }
    r.setStyles?.(bookCss(s, t))
    if (prevDark !== t.dark) this.#redrawAnnotations()
    this.#updateMarginals()
  }

  #updateMarginals() {
    const r = this.#view?.renderer
    if (!r) return
    const heads = r.heads ?? []
    const feet = r.feet ?? []
    const show = this.#settings?.runningHeads !== false
    const loc = this.#location
    const chapter = loc?.tocItem?.label?.trim() ?? ''
    const page = loc?.location ? `${loc.location.current + 1} / ${loc.location.total}` : ''
    const mins = loc?.time ? Math.round(loc.time.section) : null
    const left = mins == null ? '' : mins < 1 ? 'Less than a minute left in chapter' : `${mins} min left in chapter`
    if (heads.length > 1) {
      heads[0].textContent = show ? this.#bookTitle : ''
      heads[heads.length - 1].textContent = show ? chapter : ''
      feet[0].textContent = show ? page : ''
      feet[feet.length - 1].textContent = show ? left : ''
    } else if (heads.length) {
      heads[0].textContent = show ? chapter : ''
      feet[0].textContent = show ? [page, left].filter(Boolean).join('   ·   ') : ''
    }
  }

  // ---------------------------------------------------------------- events
  #onLoad({ doc, index }: { doc: Document; index: number }) {
    this.#docIndex.set(doc, index)
    const activity = () => this.#cb.onActivity()
    doc.addEventListener('keydown', e => this.#cb.onKey(e))
    doc.addEventListener('pointerdown', e => {
      this.#pointerType = e.pointerType
      if (e.pointerType !== 'touch') this.#mouseDown = true
      activity()
    })
    // dragging a selection (drag and drop) ends without a mouseup
    const released = () => (this.#mouseDown = false)
    doc.addEventListener('pointercancel', released)
    doc.addEventListener('dragend', released)
    // MouseEvent.detail carries the click count (PointerEvent.detail is always 0)
    doc.addEventListener('mouseup', e => {
      this.#mouseDown = false
      if (this.#pointerType !== 'touch') setTimeout(() => this.#checkSelection(doc, e.detail >= 2), 10)
    })
    doc.addEventListener('dblclick', () => {
      if (this.#pendingTap) clearTimeout(this.#pendingTap)
      this.#pendingTap = null
    })
    doc.addEventListener('selectionchange', () => {
      if (this.#selectionTimer) clearTimeout(this.#selectionTimer)
      const sel = doc.getSelection()
      if (!sel || sel.isCollapsed) {
        this.#lastSelection = null
        this.#cb.onSelection(null)
        return
      }
      // touch: wait for the long press / handle drag to settle. Mouse drags are
      // reported on mouseup; keyboard and shift-click extensions settle here.
      if (this.#pointerType === 'touch')
        this.#selectionTimer = setTimeout(() => this.#checkSelection(doc, true, true), 450)
      else if (!this.#mouseDown)
        this.#selectionTimer = setTimeout(() => this.#checkSelection(doc, false, true), 300)
    })
    doc.addEventListener('click', e => this.#onClick(doc, e))
    doc.addEventListener('wheel', this.#onWheel, { passive: false })
    doc.addEventListener('mousemove', activity, { passive: true })
  }

  #onClick(doc: Document, e: MouseEvent) {
    if (e.button !== 0) return
    const sel = doc.getSelection()
    if (sel && !sel.isCollapsed) return
    if ((e.target as Element)?.closest?.('a[href], button, input, select, textarea, video, audio, summary, label')) return
    const frame = doc.defaultView?.frameElement?.getBoundingClientRect()
    const host = this.#container.getBoundingClientRect()
    const x = (frame?.left ?? 0) + e.clientX
    const run = () => {
      this.#pendingTap = null
      if (performance.now() - this.#annotationClickAt < 400) return
      if (doc.getSelection()?.isCollapsed === false) return
      const rel = (x - host.left) / host.width
      this.#cb.onTap(rel < 0.3 ? 'left' : rel > 0.7 ? 'right' : 'center')
    }
    // with a mouse, wait briefly so a double-click (word lookup) doesn't turn the page
    if (this.#pointerType === 'mouse') this.#pendingTap = setTimeout(run, 260)
    else setTimeout(run, 0)
  }

  #onWheel = (e: WheelEvent) => {
    this.#cb.onActivity()
    if (this.#settings?.flow === 'scrolled' || e.ctrlKey || this.#view?.isFixedLayout) return
    e.preventDefault()
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
    if (Math.abs(d) < 2) return
    if (!this.#wheelActive) {
      this.#wheelActive = true
      if (d > 0) this.next()
      else this.prev()
    }
    if (this.#wheelTimer) clearTimeout(this.#wheelTimer)
    this.#wheelTimer = setTimeout(() => (this.#wheelActive = false), 160)
  }

  #checkSelection(doc: Document, fromWordGesture: boolean, onlyIfChanged = false) {
    const sel = doc.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    if (!text) return
    // a double-click on "’Tis" selects "Tis": look up the elided word (but not after
    // an opening quote, as in ‘Cause of death?’)
    let lookup: string | undefined
    if (fromWordGesture && range.startContainer.nodeType === Node.TEXT_NODE) {
      const before = range.startContainer.nodeValue!.slice(Math.max(0, range.startOffset - 2), range.startOffset)
      if (/(?:^|[^\p{L}])[’'ʼ]$/u.test(before) && isElision(`'${text}`)) lookup = `'${text}`
    }
    const index = this.#docIndex.get(doc)
    let locator: string | null = null
    try {
      if (index != null) locator = this.#view.getCFI(index, range)
    } catch { /* not addressable */ }
    const key = locator ?? text
    if (onlyIfChanged && key === this.#lastSelection) return
    this.#lastSelection = key
    const isSingleWord = !/\s/.test(text) && text.length <= 48
    this.#cb.onSelection({
      text,
      rect: rectOf(range.getBoundingClientRect(), doc),
      locator,
      context: contextSentence(range),
      chapter: this.#location?.tocItem?.label?.trim(),
      fraction: this.#location?.fraction,
      isWord: isSingleWord && fromWordGesture,
      lookup,
    })
  }

  clearSelection() {
    this.#lastSelection = null
    this.#view?.deselect()
  }

  #onRelocate(detail: FoliateRelocateDetail) {
    this.#location = detail
    this.#updateMarginals()
    let range: Relocation['range']
    const index = detail.section?.current
    if (detail.range && index != null) {
      try {
        const start = detail.range.cloneRange()
        start.collapse(true)
        const end = detail.range.cloneRange()
        end.collapse(false)
        range = { start: this.#view.getCFI(index, start), end: this.#view.getCFI(index, end) }
      } catch { /* ignore */ }
    }
    const page = detail.pageItem?.label
      ? { current: (detail.location?.current ?? 0) + 1, total: detail.location?.total ?? 0, label: detail.pageItem.label }
      : detail.location ? { current: detail.location.current + 1, total: detail.location.total } : undefined
    this.#cb.onRelocate({
      fraction: detail.fraction ?? 0,
      locator: detail.cfi,
      chapter: detail.tocItem?.label?.trim(),
      chapterTarget: detail.tocItem?.href,
      page,
      timeLeft: detail.time ? { chapter: detail.time.section, book: detail.time.total } : undefined,
      range,
      excerpt: detail.range?.toString().replace(/\s+/g, ' ').trim().slice(0, 140),
    })
  }

  // ---------------------------------------------------------------- annotations
  setAnnotations(list: Annotation[]) {
    const next = new Map(list.filter(a => a.kind === 'highlight' && a.locator).map(a => [a.locator, a]))
    if (!this.#view?.renderer) {
      this.#annotations = next
      return
    }
    for (const value of this.#annotations.keys())
      if (!next.has(value)) this.#view.deleteAnnotation({ value }).catch(() => {})
    const prev = this.#annotations
    this.#annotations = next
    for (const [value, a] of next) {
      const p = prev.get(value)
      if (!p || p.color !== a.color || !!p.note !== !!a.note) this.#view.addAnnotation({ value }).catch(() => {})
    }
  }

  #redrawAnnotations() {
    for (const value of this.#annotations.keys()) this.#view.addAnnotation({ value }).catch(() => {})
  }

  #drawAnnotation({ draw, annotation }: { draw: (f: unknown, o: unknown) => void; annotation: { value: string } }) {
    const a = this.#annotations.get(annotation.value)
    if (!a) return
    const c = HIGHLIGHT_COLORS[a.color ?? 'yellow']
    const color = this.#theme.dark ? c.dark : c.light
    const hasNote = !!a.note
    draw((rects: DOMRectList, opts: Record<string, unknown>) => {
      const g = Overlayer.highlight(rects, opts)
      if (hasNote && rects.length) {
        const last = rects[rects.length - 1]
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        dot.setAttribute('cx', String(last.right + 3))
        dot.setAttribute('cy', String(last.top + 3))
        dot.setAttribute('r', '3.5')
        dot.setAttribute('fill', color)
        dot.style.opacity = '1'
        const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        wrap.append(g, dot)
        return wrap
      }
      return g
    }, { color })
  }

  #onShowAnnotation({ value, range }: { value: string; range: Range }) {
    const a = this.#annotations.get(value)
    if (!a) return
    this.#annotationClickAt = performance.now()
    this.#cb.onAnnotationClick(a.id, rectOf(range.getBoundingClientRect(), range.startContainer.ownerDocument!))
  }

  // ---------------------------------------------------------------- footnotes
  #footnoteAnchor: ReturnType<typeof rectOf> | null = null
  #prepareFootnote(view: FoliateView) {
    this.#hideFootnote()
    const box = document.createElement('div')
    box.className = 'footnote-pop'
    box.addEventListener('pointerdown', e => e.stopPropagation())
    const inner = document.createElement('div')
    inner.className = 'footnote-body'
    box.append(inner)
    inner.append(view)
    this.#container.parentElement?.append(box)
    this.#footnoteEl = box
    const s = this.#settings
    view.addEventListener('link', e => {
      e.preventDefault()
      const { href } = (e as CustomEvent).detail
      this.#hideFootnote()
      this.#view.goTo(href)
    })
    view.renderer.setAttribute('flow', 'scrolled')
    view.renderer.setAttribute('margin', '12px')
    view.renderer.setAttribute('gap', '6%')
    if (s) view.renderer.setStyles?.(bookCss({ ...s, fontSize: Math.max(14, s.fontSize - 2), paragraphSpacing: 0.3 }, this.#theme))
    const close = (e: Event) => {
      if (!box.contains(e.target as Node)) this.#hideFootnote()
    }
    setTimeout(() => {
      document.addEventListener('pointerdown', close, { once: true })
      this.#view.renderer.getContents().forEach(({ doc }) => doc.addEventListener('pointerdown', () => this.#hideFootnote(), { once: true }))
    }, 0)
  }
  #showFootnote(detail: { view: FoliateView }) {
    const box = this.#footnoteEl
    if (!box) return
    // size the popup to the note (the inner view scrolls if it is long)
    const fit = () => {
      const doc = detail.view.renderer?.getContents()[0]?.doc
      const h = doc?.documentElement.getBoundingClientRect().height
      if (h) box.style.height = `${Math.min(h + 26, innerHeight * 0.45)}px`
    }
    fit()
    setTimeout(fit, 120)
    const host = this.#container.getBoundingClientRect()
    const a = this.#footnoteAnchor
    const below = !a || a.top < host.top + host.height / 2
    box.style.setProperty('--fn-bg', this.#theme.bg)
    box.style.setProperty('--fn-fg', this.#theme.fg)
    box.style.setProperty('--fn-border', this.#theme.border)
    const width = Math.min(460, host.width - 24)
    const left = a ? Math.min(Math.max(12, (a.left + a.right) / 2 - width / 2 - host.left), host.width - width - 12) : (host.width - width) / 2
    box.style.width = `${width}px`
    box.style.left = `${left}px`
    if (a && below) box.style.top = `${a.bottom - host.top + 10}px`
    else if (a) box.style.bottom = `${host.bottom - a.top + 10}px`
    box.classList.add('show')
  }
  #hideFootnote() {
    this.#footnoteEl?.remove()
    this.#footnoteEl = null
  }

  // ---------------------------------------------------------------- search
  async search(query: string, onHit: (hit: SearchHit) => void, onProgress: (p: number) => void, signal: AbortSignal) {
    const iter = this.#view.search({
      query, matchCase: false, matchDiacritics: false, matchWholeWords: false,
      drawOptions: { color: this.#theme.dark ? '#f0a35a' : '#c2621a', width: 2, radius: 3 },
    })
    for await (const result of iter) {
      if (signal.aborted) {
        await iter.return?.(undefined)
        return
      }
      if (result === 'done') break
      if (typeof result.progress === 'number') onProgress(result.progress)
      if (result.subitems) for (const item of result.subitems)
        onHit({ locator: item.cfi, label: result.label, excerpt: item.excerpt })
    }
    onProgress(1)
  }
  clearSearch() {
    this.#view?.clearSearch()
  }

  // ---------------------------------------------------------------- read aloud
  async speechChunks(): Promise<SpeechChunk[]> {
    const current = this.#view.renderer.getContents()[0]
    if (!current) return []
    const { doc } = current
    let start: Range | null = null
    if (!this.#speechFromStart && this.#location?.range) {
      start = this.#location.range.cloneRange()
      start.collapse(true)
    }
    this.#speechFromStart = false
    return splitSentences(doc, SENTENCE_BLOCKS, start).map(({ text, range }) => ({
      text,
      show: () => this.#showSpeech(doc, range),
    }))
  }

  #showSpeech(doc: Document, range: Range) {
    const win = doc.defaultView as (Window & { CSS?: typeof CSS; Highlight?: typeof Highlight }) | null
    if (win?.CSS?.highlights && win.Highlight) win.CSS.highlights.set('lumen-tts', new win.Highlight(range))
    const rect = range.getBoundingClientRect()
    const frame = win?.frameElement?.getBoundingClientRect()
    const host = this.#container.getBoundingClientRect()
    if (!frame) return
    const left = frame.left + rect.left
    const top = frame.top + rect.top
    const visible = this.#settings?.flow === 'scrolled'
      ? top >= host.top && top + rect.height <= host.bottom - 20
      : left >= host.left && left + Math.min(rect.width, 40) <= host.right
    if (!visible) this.#view.renderer.scrollToAnchor?.(range)
  }

  async speechAdvance() {
    const current = this.#view.renderer.getContents()[0]
    if (!current) return false
    const { sections } = this.#view.book
    const nextIndex = sections.findIndex((s, i) => i > current.index && s.linear !== 'no')
    if (nextIndex < 0) return false
    this.clearSpeech()
    this.#speechFromStart = true
    await this.#view.renderer.goTo({ index: nextIndex })
    return true
  }

  clearSpeech() {
    for (const { doc } of this.#view?.renderer?.getContents() ?? []) {
      const win = doc.defaultView as (Window & { CSS?: typeof CSS }) | null
      win?.CSS?.highlights?.delete('lumen-tts')
    }
  }
}
