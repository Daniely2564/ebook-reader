// PDF rendering with pdf.js' PDFViewer: continuous or paged scrolling,
// spreads, pinch/ctrl-wheel zoom, selectable text, themed pages and highlights.
import 'pdfjs-dist/legacy/web/pdf_viewer.css'
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import type { Annotation } from '../lib/db'
import { loadPdfViewer, openPdf, pdfjsLib } from '../lib/pdfjs'
import type { Settings } from '../lib/settings'
import { HIGHLIGHT_COLORS, themeById, type ReaderTheme } from '../lib/themes'
import { contextSentence, type Rect } from './text'
import type { EngineCallbacks, ReaderEngine, SearchHit, SpeechChunk, TocItem } from './types'

interface PdfLocator { p: number; r: [number, number, number, number][] }

// pdf.js ScrollMode / SpreadMode values
const ScrollMode = { VERTICAL: 0, PAGE: 3 }
const SpreadMode = { NONE: 0, ODD: 1 }

export const parsePdfLocator = (s: string): PdfLocator | null => {
  try {
    const v = JSON.parse(s)
    return typeof v?.p === 'number' ? v : null
  } catch {
    return null
  }
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export class PdfEngine implements ReaderEngine {
  readonly kind = 'pdf' as const
  toc: TocItem[] = []
  sectionFractions: number[] = []
  language?: string
  dir: 'ltr' = 'ltr'

  #data: Uint8Array
  #cb: EngineCallbacks
  #container!: HTMLElement
  #scroller!: HTMLDivElement
  #viewer!: PDFViewer
  #eventBus!: EventBus
  #linkService!: PDFLinkService
  #doc!: PDFDocumentProxy
  #ready = false
  #settings?: Settings
  #theme: ReaderTheme = themeById('paper')
  #highlights: Annotation[] = []
  #history: number[] = []
  #page = 1
  #viewArea: { left: number; top: number } | null = null
  #outlinePages: { page: number; label: string; target: string }[] = []
  #dests = new Map<string, unknown>()
  #pageText = new Map<number, Promise<string>>()
  #pointerType = 'mouse'
  #pendingTap: ReturnType<typeof setTimeout> | null = null
  #selectionTimer: ReturnType<typeof setTimeout> | null = null
  #wheelActive = false
  #wheelTimer: ReturnType<typeof setTimeout> | null = null
  #speechPage = 0
  #abort = new AbortController()
  #destroyed = false

  constructor(data: Uint8Array, cb: EngineCallbacks) {
    this.#data = data
    this.#cb = cb
  }

  get zoomLabel() {
    return this.#ready ? `${Math.round(this.#viewer.currentScale * 100)}%` : ''
  }

  get pageCount() {
    return this.#doc?.numPages ?? 0
  }

  async open(container: HTMLElement, location?: string) {
    this.#container = container
    const { EventBus, PDFLinkService, PDFViewer, PDFFindController, LinkTarget } = await loadPdfViewer()
    const scroller = document.createElement('div')
    scroller.className = 'pdf-scroller'
    scroller.tabIndex = 0
    const viewerEl = document.createElement('div')
    viewerEl.className = 'pdfViewer'
    scroller.append(viewerEl)
    container.append(scroller)
    this.#scroller = scroller

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer' })
    const findController = new PDFFindController({ eventBus, linkService })
    const viewer = new PDFViewer({
      container: scroller,
      viewer: viewerEl,
      eventBus,
      linkService,
      findController,
      removePageBorders: true,
      textLayerMode: 1,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
      supportsPinchToZoom: true,
      enableAutoLinking: true,
      maxCanvasPixels: 2 ** 25,
    })
    linkService.setViewer(viewer)
    this.#eventBus = eventBus
    this.#linkService = linkService
    this.#viewer = viewer

    this.#doc = await openPdf(this.#data)
    if (this.#destroyed) {
      this.#doc.loadingTask.destroy()
      return
    }
    const pagesInit = new Promise<void>(res => eventBus.on('pagesinit', () => res(), { once: true }))
    viewer.setDocument(this.#doc)
    linkService.setDocument(this.#doc, null)
    await pagesInit
    this.#ready = true

    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      this.#page = pageNumber
      this.#emitRelocate()
    })
    eventBus.on('updateviewarea', ({ location }: { location: { pageNumber: number; left: number; top: number } }) => {
      this.#viewArea = { left: location.left, top: location.top }
      if (location.pageNumber === this.#page) this.#emitRelocate()
    })
    eventBus.on('scalechanging', () => this.#emitRelocate())
    eventBus.on('pagerendered', ({ pageNumber }: { pageNumber: number }) => this.#drawPage(pageNumber))
    eventBus.on('textlayerrendered', ({ pageNumber }: { pageNumber: number }) => this.#drawPage(pageNumber))

    const sig = { signal: this.#abort.signal }
    scroller.addEventListener('pointerdown', e => {
      this.#pointerType = e.pointerType
      this.#cb.onActivity()
    }, sig)
    // MouseEvent.detail carries the click count (PointerEvent.detail is always 0)
    scroller.addEventListener('mouseup', e => {
      if (this.#pointerType !== 'touch') setTimeout(() => this.#checkSelection(e.detail >= 2), 10)
    }, sig)
    scroller.addEventListener('dblclick', () => {
      if (this.#pendingTap) clearTimeout(this.#pendingTap)
      this.#pendingTap = null
    }, sig)
    scroller.addEventListener('click', e => this.#onClick(e), sig)
    scroller.addEventListener('wheel', this.#onWheel, { passive: false, signal: this.#abort.signal })
    scroller.addEventListener('scroll', () => this.#cb.onActivity(), { passive: true, signal: this.#abort.signal })
    document.addEventListener('selectionchange', () => {
      if (this.#selectionTimer) clearTimeout(this.#selectionTimer)
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed || !scroller.contains(sel.anchorNode)) {
        this.#cb.onSelection(null)
        return
      }
      if (this.#pointerType === 'touch') this.#selectionTimer = setTimeout(() => this.#checkSelection(true), 450)
    }, sig)

    if (this.#settings) this.applySettings(this.#settings)
    else viewer.currentScaleValue = 'auto'
    this.#restore(location)
    this.#loadOutline().catch(e => console.warn('Outline failed', e))
    this.#loadLanguage()
  }

  destroy() {
    this.#destroyed = true
    this.#abort.abort()
    try {
      this.#viewer?.setDocument(null as unknown as PDFDocumentProxy)
      this.#linkService?.setDocument(null, null)
      this.#doc?.loadingTask.destroy()
    } catch { /* ignore */ }
    this.#scroller?.remove()
  }

  #restore(location?: string) {
    const m = location?.match(/^pdf:(\d+)(?:@(-?[\d.]+),(-?[\d.]+))?/)
    if (!m) return
    const pageNumber = Math.min(Number(m[1]), this.#doc.numPages)
    if (m[2] != null) {
      this.#viewer.scrollPageIntoView({
        pageNumber,
        destArray: [null, { name: 'XYZ' }, Number(m[2]), Number(m[3]), null],
        allowNegativeOffset: true,
        ignoreDestinationZoom: true,
      })
    } else this.#viewer.currentPageNumber = pageNumber
    this.#page = pageNumber
  }

  async #loadLanguage() {
    try {
      const meta = await this.#doc.getMetadata()
      const lang = (meta.info as { Language?: string })?.Language
      if (lang) this.language = lang
    } catch { /* ignore */ }
  }

  async #loadOutline() {
    const outline = await this.#doc.getOutline()
    if (!outline?.length) return
    let n = 0
    const flat: { page: number; label: string; target: string }[] = []
    const convert = async (items: typeof outline, level: number): Promise<TocItem[]> => {
      const out: TocItem[] = []
      for (const item of items) {
        const target = `outline:${n++}`
        if (item.url) this.#dests.set(target, { url: item.url })
        else this.#dests.set(target, item.dest)
        try {
          const dest = typeof item.dest === 'string' ? await this.#doc.getDestination(item.dest) : item.dest
          const ref = Array.isArray(dest) ? dest[0] : null
          const page = ref == null ? null : typeof ref === 'number' ? ref + 1 : (await this.#doc.getPageIndex(ref)) + 1
          if (page) flat.push({ page, label: item.title, target })
        } catch { /* unresolved destination */ }
        out.push({
          id: target,
          label: item.title?.trim() || 'Untitled',
          target,
          level,
          children: item.items?.length ? await convert(item.items, level + 1) : undefined,
        })
      }
      return out
    }
    this.toc = await convert(outline, 0)
    this.#outlinePages = flat.sort((a, b) => a.page - b.page)
    const total = Math.max(1, this.#doc.numPages - 1)
    this.sectionFractions = [...new Set(this.#outlinePages.filter((_, i, a) => i === 0 || a[i - 1].page !== a[i].page)
      .map(o => (o.page - 1) / total))]
    this.#emitRelocate()
  }

  #emitRelocate() {
    if (!this.#ready) return
    const total = this.#doc.numPages
    const page = this.#page
    const chapter = [...this.#outlinePages].reverse().find(o => o.page <= page)
    const label = this.#viewer.currentPageLabel
    const va = this.#viewArea
    this.#cb.onRelocate({
      fraction: total > 1 ? (page - 1) / (total - 1) : 1,
      locator: va ? `pdf:${page}@${Math.round(va.left)},${Math.round(va.top)}` : `pdf:${page}`,
      chapter: chapter?.label,
      chapterTarget: chapter?.target,
      page: { current: page, total, label: label && label !== String(page) ? label : undefined },
      range: { start: `pdf:${page}`, end: `pdf:${page}` },
    })
  }

  // ---------------------------------------------------------------- navigation
  #isPaged() {
    return this.#settings?.pdfScroll === 'paged'
  }
  next() {
    if (!this.#ready) return
    if (this.#isPaged()) this.#viewer.nextPage()
    else this.#scroller.scrollBy({ top: this.#scroller.clientHeight * 0.9, behavior: 'smooth' })
  }
  prev() {
    if (!this.#ready) return
    if (this.#isPaged()) this.#viewer.previousPage()
    else this.#scroller.scrollBy({ top: -this.#scroller.clientHeight * 0.9, behavior: 'smooth' })
  }
  async goTo(target: string) {
    if (!this.#ready) return
    this.#history.push(this.#page)
    if (target.startsWith('outline:')) {
      const dest = this.#dests.get(target) as { url?: string } | unknown
      if (dest && typeof dest === 'object' && 'url' in (dest as object)) {
        window.open((dest as { url: string }).url, '_blank', 'noopener')
        return
      }
      if (dest) await this.#linkService.goToDestination(dest as string)
      return
    }
    const loc = parsePdfLocator(target)
    if (loc) {
      const [, y] = loc.r[0] ?? [0, 0]
      const view = this.#viewer.getPageView(loc.p - 1)
      const height = (view?.viewport?.viewBox?.[3] ?? 792)
      this.#viewer.scrollPageIntoView({ pageNumber: loc.p, destArray: [null, { name: 'XYZ' }, null, height * (1 - y) + 24, null] })
      return
    }
    const m = target.match(/^pdf:(\d+)/)
    if (m) this.#viewer.currentPageNumber = Math.min(Number(m[1]), this.#doc.numPages)
  }
  async goToFraction(f: number) {
    if (!this.#ready) return
    this.#viewer.currentPageNumber = Math.min(this.#doc.numPages, Math.max(1, Math.round(f * (this.#doc.numPages - 1)) + 1))
  }
  canGoBack() {
    return this.#history.length > 0
  }
  back() {
    const p = this.#history.pop()
    if (p) this.#viewer.currentPageNumber = p
  }

  zoom(action: 'in' | 'out' | 'fit-width' | 'fit-page' | 'reset') {
    if (!this.#ready) return
    if (action === 'in') this.#viewer.increaseScale()
    else if (action === 'out') this.#viewer.decreaseScale()
    else this.#viewer.currentScaleValue = action === 'fit-width' ? 'page-width' : action === 'fit-page' ? 'page-fit' : 'auto'
  }

  // ---------------------------------------------------------------- appearance
  applySettings(s: Settings) {
    const prev = this.#settings
    this.#settings = s
    this.#theme = themeById(s.theme)
    const t = this.#theme
    const el = this.#container
    if (el) {
      el.style.setProperty('--pdf-filter', s.pdfThemed ? t.pdfFilter : 'none')
      el.style.setProperty('--pdf-gutter', t.dark ? t.bg : t.surface)
      el.classList.toggle('pdf-dark', t.dark && s.pdfThemed)
    }
    if (!this.#ready) return
    const scrollMode = s.pdfScroll === 'paged' ? ScrollMode.PAGE : ScrollMode.VERTICAL
    if (this.#viewer.scrollMode !== scrollMode) this.#viewer.scrollMode = scrollMode
    const spread = s.pdfSpread === 'odd' ? SpreadMode.ODD : SpreadMode.NONE
    if (this.#viewer.spreadMode !== spread) this.#viewer.spreadMode = spread
    if (!prev || prev.pdfZoom !== s.pdfZoom) {
      const z = s.pdfZoom
      if (['auto', 'page-width', 'page-fit', 'page-actual'].includes(z)) this.#viewer.currentScaleValue = z
      else if (Number(z) > 0) this.#viewer.currentScale = Number(z)
      else this.#viewer.currentScaleValue = 'auto'
    }
    if (prev && prev.theme !== s.theme) this.#drawAll()
  }

  // ---------------------------------------------------------------- input
  #onClick(e: MouseEvent) {
    if (e.button !== 0) return
    const sel = document.getSelection()
    if (sel && !sel.isCollapsed) return
    const target = e.target as Element
    if (target.closest('a, .annotationLayer section, input, textarea, select, button')) return
    const hit = this.#hitTest(e.clientX, e.clientY)
    if (hit) {
      this.#cb.onAnnotationClick(hit.id, hit.rect)
      return
    }
    const host = this.#container.getBoundingClientRect()
    const rel = (e.clientX - host.left) / host.width
    const run = () => {
      this.#pendingTap = null
      if (document.getSelection()?.isCollapsed === false) return
      this.#cb.onTap(rel < 0.25 ? 'left' : rel > 0.75 ? 'right' : 'center')
    }
    if (this.#pointerType === 'mouse') this.#pendingTap = setTimeout(run, 260)
    else run()
  }

  #onWheel = (e: WheelEvent) => {
    this.#cb.onActivity()
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025))
      this.#viewer.updateScale({ scaleFactor: factor, origin: [e.clientX, e.clientY], drawingDelay: 300 })
      return
    }
    if (!this.#isPaged()) return
    const s = this.#scroller
    const atTop = s.scrollTop <= 0
    const atBottom = s.scrollTop + s.clientHeight >= s.scrollHeight - 2
    if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return
    e.preventDefault()
    if (!this.#wheelActive) {
      this.#wheelActive = true
      if (e.deltaY > 0) this.#viewer.nextPage()
      else this.#viewer.previousPage()
    }
    if (this.#wheelTimer) clearTimeout(this.#wheelTimer)
    this.#wheelTimer = setTimeout(() => (this.#wheelActive = false), 200)
  }

  #pageAt(x: number, y: number) {
    for (const el of this.#scroller.querySelectorAll<HTMLElement>('.page[data-page-number]')) {
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { el, r, page: Number(el.dataset.pageNumber) }
    }
    return null
  }

  #checkSelection(fromWordGesture: boolean) {
    const sel = document.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount || !this.#scroller.contains(sel.anchorNode)) return
    const range = sel.getRangeAt(0)
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    if (!text) return
    // collect selection rectangles per page, normalized to the page size
    const byPage = new Map<number, [number, number, number, number][]>()
    for (const cr of Array.from(range.getClientRects())) {
      if (cr.width < 1 || cr.height < 1) continue
      const hit = this.#pageAt(cr.left + cr.width / 2, cr.top + cr.height / 2)
      if (!hit) continue
      const list = byPage.get(hit.page) ?? []
      list.push([(cr.left - hit.r.left) / hit.r.width, (cr.top - hit.r.top) / hit.r.height, cr.width / hit.r.width, cr.height / hit.r.height])
      byPage.set(hit.page, list)
    }
    const first = [...byPage.entries()].sort((a, b) => a[0] - b[0])[0]
    const locator = first ? JSON.stringify({ p: first[0], r: mergeRects(first[1]) } satisfies PdfLocator) : null
    const r = range.getBoundingClientRect()
    this.#cb.onSelection({
      text,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      locator,
      context: contextSentence(range),
      chapter: [...this.#outlinePages].reverse().find(o => o.page <= (first?.[0] ?? this.#page))?.label,
      page: first?.[0] ?? this.#page,
      fraction: this.#doc.numPages > 1 ? ((first?.[0] ?? this.#page) - 1) / (this.#doc.numPages - 1) : 1,
      isWord: fromWordGesture && !/\s/.test(text) && text.length <= 48,
    })
  }

  clearSelection() {
    document.getSelection()?.removeAllRanges()
  }

  // ---------------------------------------------------------------- highlights
  setAnnotations(list: Annotation[]) {
    this.#highlights = list.filter(a => a.kind === 'highlight')
    this.#drawAll()
  }

  #drawAll() {
    if (!this.#ready) return
    for (let i = 1; i <= this.#doc.numPages; i++) this.#drawPage(i)
  }

  #drawPage(pageNumber: number) {
    const view = this.#viewer?.getPageView(pageNumber - 1)
    const div: HTMLElement | undefined = view?.div
    if (!div) return
    let layer = div.querySelector<HTMLElement>(':scope > .lumen-hl-layer')
    const items = this.#highlights.map(a => ({ a, loc: parsePdfLocator(a.locator) })).filter(x => x.loc?.p === pageNumber)
    if (!items.length) {
      layer?.remove()
      return
    }
    if (!layer) {
      layer = document.createElement('div')
      layer.className = 'lumen-hl-layer'
    }
    // keep the layer right above the canvas, below the text layer
    const textLayer = div.querySelector(':scope > .textLayer')
    if (textLayer) div.insertBefore(layer, textLayer)
    else div.append(layer)
    layer.replaceChildren()
    const dark = this.#theme.dark && this.#settings?.pdfThemed !== false
    layer.classList.toggle('dark', dark)
    for (const { a, loc } of items) {
      const c = HIGHLIGHT_COLORS[a.color ?? 'yellow']
      for (const [x, y, w, h] of loc!.r) {
        const el = document.createElement('div')
        el.className = 'lumen-hl'
        Object.assign(el.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`, background: dark ? c.dark : c.light })
        layer.append(el)
      }
      if (a.note) {
        const [x, y, w] = loc!.r[loc!.r.length - 1]
        const dot = document.createElement('div')
        dot.className = 'lumen-hl-note'
        Object.assign(dot.style, { left: `${(x + w) * 100}%`, top: `${y * 100}%`, background: dark ? c.dark : c.light })
        layer.append(dot)
      }
    }
  }

  #hitTest(x: number, y: number): { id: string; rect: Rect } | null {
    const hit = this.#pageAt(x, y)
    if (!hit) return null
    const px = (x - hit.r.left) / hit.r.width
    const py = (y - hit.r.top) / hit.r.height
    for (const a of [...this.#highlights].reverse()) {
      const loc = parsePdfLocator(a.locator)
      if (loc?.p !== hit.page) continue
      for (const [rx, ry, rw, rh] of loc.r) {
        if (px >= rx && px <= rx + rw && py >= ry && py <= ry + rh) {
          const [fx, fy, fw, fh] = loc.r[0]
          const left = hit.r.left + fx * hit.r.width
          const top = hit.r.top + fy * hit.r.height
          return { id: a.id, rect: { left, top, right: left + fw * hit.r.width, bottom: top + fh * hit.r.height } }
        }
      }
    }
    return null
  }

  // ---------------------------------------------------------------- search
  #getPageText(p: number) {
    let t = this.#pageText.get(p)
    if (!t) {
      t = this.#doc.getPage(p)
        .then(page => page.getTextContent())
        .then(tc => tc.items.map(i => ('str' in i ? i.str + (i.hasEOL ? '\n' : '') : '')).join(''))
        .catch(() => '')
      this.#pageText.set(p, t)
    }
    return t
  }

  async search(query: string, onHit: (hit: SearchHit) => void, onProgress: (p: number) => void, signal: AbortSignal) {
    if (!this.#ready) return
    this.#eventBus.dispatch('find', {
      source: this, type: '', query, caseSensitive: false, entireWord: false,
      highlightAll: true, findPrevious: false, matchDiacritics: false,
    })
    const q = normalize(query)
    const total = this.#doc.numPages
    for (let p = 1; p <= total; p++) {
      if (signal.aborted) return
      const raw = (await this.#getPageText(p)).replace(/-\n/g, '').replace(/\s+/g, ' ')
      const text = normalize(raw)
      let i = text.indexOf(q)
      let count = 0
      while (i >= 0 && count < 50) {
        onHit({
          locator: `pdf:${p}`,
          label: `Page ${p}`,
          excerpt: {
            pre: (i > 50 ? '…' : '') + raw.slice(Math.max(0, i - 50), i),
            match: raw.slice(i, i + query.length),
            post: raw.slice(i + query.length, i + query.length + 60) + (i + query.length + 60 < raw.length ? '…' : ''),
          },
        })
        i = text.indexOf(q, i + q.length)
        count++
      }
      if (p % 5 === 0 || p === total) onProgress(p / total)
    }
  }

  clearSearch() {
    this.#eventBus?.dispatch('findbarclose', { source: this })
  }

  // ---------------------------------------------------------------- read aloud
  async speechChunks(): Promise<SpeechChunk[]> {
    if (!this.#speechPage) this.#speechPage = this.#page
    const p = this.#speechPage
    const text = (await this.#getPageText(p)).replace(/-\n(?=\p{Ll})/gu, '').replace(/\s+/g, ' ').trim()
    if (!text) return []
    const seg = new Intl.Segmenter(this.language || 'en', { granularity: 'sentence' })
    return Array.from(seg.segment(text), s => s.segment.trim())
      .filter(s => /[\p{L}\p{N}]/u.test(s))
      .map(s => ({
        text: s,
        show: () => {
          if (this.#page !== p) this.#viewer.currentPageNumber = p
        },
      }))
  }

  async speechAdvance() {
    if (!this.#speechPage) this.#speechPage = this.#page
    if (this.#speechPage >= this.#doc.numPages) return false
    this.#speechPage++
    this.#viewer.currentPageNumber = this.#speechPage
    return true
  }

  clearSpeech() {
    this.#speechPage = 0
  }
}

/** Merges per-glyph-run rectangles into one rectangle per line. */
const mergeRects = (rects: [number, number, number, number][]) => {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const out: [number, number, number, number][] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[1] - r[1]) < Math.min(last[3], r[3]) * 0.5 && r[0] <= last[0] + last[2] + 0.02) {
      const right = Math.max(last[0] + last[2], r[0] + r[2])
      const top = Math.min(last[1], r[1])
      const bottom = Math.max(last[1] + last[3], r[1] + r[3])
      last[0] = Math.min(last[0], r[0])
      last[2] = right - last[0]
      last[1] = top
      last[3] = bottom - top
    } else out.push([...r])
  }
  return out.map(r => r.map(v => Math.round(v * 10000) / 10000) as [number, number, number, number])
}
