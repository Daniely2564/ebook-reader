// PDF rendering with pdf.js' PDFViewer: continuous or paged scrolling, spreads,
// pinch / double-tap / ctrl-wheel zoom, "fit text" zoom that trims margins,
// selectable text, themed pages and highlights.
import 'pdfjs-dist/legacy/web/pdf_viewer.css'
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import type { Annotation } from '../lib/db'
import { loadPdfViewer, openPdf, pdfjsLib, resolveOutline } from '../lib/pdfjs'
import type { Settings } from '../lib/settings'
import { HIGHLIGHT_COLORS, themeById, type ReaderTheme } from '../lib/themes'
import { locatorParts, makePdfLocator, parsePdfLocator, type Rect4 } from './pdf-locator'
import { contextSentence, type Rect } from './text'
import type { EngineCallbacks, ReaderEngine, SearchHit, SpeechChunk, TocItem, ZoomAction } from './types'

// pdf.js ScrollMode / SpreadMode values
const ScrollMode = { VERTICAL: 0, PAGE: 3 }
const SpreadMode = { NONE: 0, ODD: 1 }
const PRESETS = ['auto', 'page-width', 'page-fit', 'page-actual']
const MIN_SCALE = 0.25
const MAX_SCALE = 10
/** room left beside the text column by "fit text" and double-tap zoom, in CSS pixels */
const TEXT_PAD = 10
/** in page-by-page mode, a page scrolled to within this many pixels of its end counts as read */
const PAGE_SLACK = 80

/** A place on a page; left / top are in PDF user space, as in `pdf:<page>@<left>,<top>` */
interface Place { page: number; left: number | null; top: number | null }

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]

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
  #viewerEl!: HTMLDivElement
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
  /** top left corner of the view, on the topmost page showing (which isn't always the current page) */
  #viewArea: { page: number; left: number; top: number } | null = null
  #outlinePages: { page: number; label: string; target: string }[] = []
  #dests = new Map<string, unknown>()
  #pageText = new Map<number, Promise<string>>()
  #pointerType = 'mouse'
  #pendingTap: ReturnType<typeof setTimeout> | null = null
  #lastTap: { t: number; x: number; y: number } | null = null
  #selectionTimer: ReturnType<typeof setTimeout> | null = null
  #wheelActive = false
  #wheelTimer: ReturnType<typeof setTimeout> | null = null
  #speechPage = 0
  #abort = new AbortController()
  #destroyed = false

  // zoom
  #initialZoom?: string
  #zoomMode = 'auto'
  /** the fit mode double-tap returns to */
  #restZoom = 'auto'
  #savedZoom?: string
  #saveZoomTimer: ReturnType<typeof setTimeout> | null = null
  /** left and right edge of the text, as fractions of the page width ("fit text") */
  #textBox: [number, number] | null = null
  #textBounds = new Map<number, Promise<[number, number] | null>>()
  #pinch: { d0: number; m0: [number, number]; m: [number, number]; factor: number } | null = null
  #swipe: { x: number; y: number; t: number; left: number } | null = null
  #hud: HTMLDivElement | null = null
  #hudTimer: ReturnType<typeof setTimeout> | null = null

  constructor(data: Uint8Array, cb: EngineCallbacks, opts: { zoom?: string } = {}) {
    this.#data = data
    this.#cb = cb
    this.#initialZoom = this.#savedZoom = opts.zoom
  }

  get zoomLabel() {
    return this.#ready ? `${Math.round(this.#viewer.currentScale * 100)}%` : ''
  }

  get zoomMode() {
    return this.#zoomMode
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
    this.#viewerEl = viewerEl

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
      this.#viewArea = { page: location.pageNumber, left: location.left, top: location.top }
      this.#emitRelocate()
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
      if (this.#pointerType !== 'mouse') return
      if (this.#pendingTap) clearTimeout(this.#pendingTap)
      this.#pendingTap = null
    }, sig)
    // Android only shows its floating text toolbar (Copy, Select all, Translate…) when
    // the context menu goes ahead; it would cover the reader's own menus and popups
    scroller.addEventListener('contextmenu', e => {
      if (this.#pointerType === 'touch') e.preventDefault()
    }, sig)
    scroller.addEventListener('click', e => this.#onClick(e), sig)
    scroller.addEventListener('wheel', this.#onWheel, { passive: false, signal: this.#abort.signal })
    scroller.addEventListener('scroll', () => this.#cb.onActivity(), { passive: true, signal: this.#abort.signal })
    scroller.addEventListener('touchstart', this.#onTouchStart, { passive: false, signal: this.#abort.signal })
    scroller.addEventListener('touchmove', this.#onTouchMove, { passive: false, signal: this.#abort.signal })
    scroller.addEventListener('touchend', this.#onTouchEnd, sig)
    scroller.addEventListener('touchcancel', this.#onTouchEnd, sig)
    document.addEventListener('selectionchange', () => {
      if (this.#selectionTimer) clearTimeout(this.#selectionTimer)
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed || !scroller.contains(sel.anchorNode)) {
        this.#cb.onSelection(null)
        return
      }
      if (this.#pointerType === 'touch') this.#selectionTimer = setTimeout(() => this.#checkSelection(true), 450)
    }, sig)
    this.#observeResize()

    const target = this.#parseLocation(location)
    if (target) this.#page = target.page
    if (this.#settings) this.applySettings(this.#settings)
    const preset = this.#settings?.pdfZoom ?? 'auto'
    this.#restZoom = Number(preset) > 0 ? 'auto' : preset
    await this.#applyZoom(this.#initialZoom ?? preset)
    if (this.#destroyed) return
    this.#restore(target)
    this.#loadOutline().catch(e => console.warn('Outline failed', e))
    this.#loadLanguage()
  }

  destroy() {
    this.#destroyed = true
    this.#abort.abort()
    if (this.#saveZoomTimer) clearTimeout(this.#saveZoomTimer)
    try {
      this.#viewer?.setDocument(null as unknown as PDFDocumentProxy)
      this.#linkService?.setDocument(null, null)
      this.#doc?.loadingTask.destroy()
    } catch { /* ignore */ }
    this.#scroller?.remove()
    this.#hud?.remove()
  }

  #parseLocation(location?: string): Place | null {
    const m = location?.match(/^pdf:(\d+)(?:@(-?[\d.]+),(-?[\d.]+))?/)
    if (!m) return null
    return { page: Math.min(Number(m[1]), this.#doc.numPages), left: m[2] == null ? null : Number(m[2]), top: m[3] == null ? null : Number(m[3]) }
  }

  #restore(target: Place | null) {
    if (!target) return
    const { page: pageNumber, left, top } = target
    if (top != null) {
      this.#viewer.scrollPageIntoView({
        pageNumber,
        destArray: [null, { name: 'XYZ' }, left, top, null],
        allowNegativeOffset: true,
        ignoreDestinationZoom: true,
      })
    } else this.#viewer.currentPageNumber = pageNumber
    this.#page = pageNumber
    if (this.#zoomMode === 'text-width') this.#alignText()
  }

  async #loadLanguage() {
    try {
      const meta = await this.#doc.getMetadata()
      const lang = (meta.info as { Language?: string })?.Language
      if (lang) this.language = lang
    } catch { /* ignore */ }
  }

  async #loadOutline() {
    const outline = await resolveOutline(this.#doc)
    if (!outline.length) return
    let n = 0
    const flat: { page: number; label: string; target: string }[] = []
    const convert = (nodes: typeof outline, level: number): TocItem[] => nodes.map(node => {
      const target = `outline:${n++}`
      this.#dests.set(target, node.url ? { url: node.url } : node.dest)
      if (node.page) flat.push({ page: node.page, label: node.title, target })
      return { id: target, label: node.title, target, level, children: node.items.length ? convert(node.items, level + 1) : undefined }
    })
    this.toc = convert(outline, 0)
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
      // the place is where the view starts, which may be on the page above the current one
      locator: va ? `pdf:${va.page}@${Math.round(va.left)},${Math.round(va.top)}` : `pdf:${page}`,
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
    const s = this.#scroller
    // in page-by-page mode a page taller than the screen is read to its end first
    if (!this.#isPaged() || s.scrollHeight - s.scrollTop - s.clientHeight > PAGE_SLACK) s.scrollBy({ top: s.clientHeight * 0.9, behavior: 'smooth' })
    else this.#turn(1)
  }
  prev() {
    if (!this.#ready) return
    const s = this.#scroller
    if (!this.#isPaged() || s.scrollTop > PAGE_SLACK) s.scrollBy({ top: -s.clientHeight * 0.9, behavior: 'smooth' })
    else this.#turn(-1)
  }
  /** Turns a page in page-by-page mode, keeping the zoom and the horizontal position. */
  #turn(dir: 1 | -1) {
    const s = this.#scroller
    const left = s.scrollLeft
    if (!(dir > 0 ? this.#viewer.nextPage() : this.#viewer.previousPage())) return
    this.#restoreLeft(left)
    // going back continues from the end of the previous page
    if (dir < 0) s.scrollTop = s.scrollHeight
  }
  /** pdf.js scrolls to the left edge of a page when jumping; keep the column being read in view instead. */
  #restoreLeft(left: number) {
    if (this.#zoomMode === 'text-width') this.#alignText()
    else this.#scroller.scrollLeft = left
  }
  async #keepLeft(navigate: () => unknown) {
    const left = this.#scroller.scrollLeft
    await navigate()
    this.#restoreLeft(left)
  }
  #showPage(n: number) {
    return this.#keepLeft(() => {
      this.#viewer.currentPageNumber = n
    })
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
      if (dest) await this.#keepLeft(() => this.#linkService.goToDestination(dest as string))
      return
    }
    const loc = parsePdfLocator(target)
    if (loc) {
      const [, y] = loc.r[0] ?? [0, 0]
      const view = this.#viewer.getPageView(loc.p - 1)
      const height = (view?.viewport?.viewBox?.[3] ?? 792)
      await this.#keepLeft(() => this.#viewer.scrollPageIntoView({ pageNumber: loc.p, destArray: [null, { name: 'XYZ' }, null, height * (1 - y) + 24, null] }))
      return
    }
    const where = this.#parseLocation(target)
    if (where?.top != null) this.#restore(where)
    else if (where) await this.#showPage(where.page)
  }
  async goToFraction(f: number) {
    if (!this.#ready) return
    await this.#showPage(Math.min(this.#doc.numPages, Math.max(1, Math.round(f * (this.#doc.numPages - 1)) + 1)))
  }
  canGoBack() {
    return this.#history.length > 0
  }
  back() {
    const p = this.#history.pop()
    if (p) this.#showPage(p)
  }

  // ---------------------------------------------------------------- zoom
  zoom(action: ZoomAction) {
    if (!this.#ready) return
    if (action === 'in' || action === 'out') {
      const r = this.#scroller.getBoundingClientRect()
      this.#viewer.updateScale({ steps: action === 'in' ? 1 : -1, origin: [r.left + r.width / 2, r.top + r.height / 2] })
      this.#setZoomMode(String(this.#viewer.currentScale))
      this.#showZoom()
      return
    }
    const mode = action === 'fit-width' ? 'page-width' : action === 'fit-page' ? 'page-fit' : action === 'fit-text' ? 'text-width' : 'auto'
    this.#applyZoom(mode).then(() => this.#showZoom())
  }

  async #applyZoom(mode: string) {
    const viewer = this.#viewer
    if (mode === 'text-width') {
      const box = viewer.spreadMode === SpreadMode.NONE ? await this.#findTextBox() : null
      const width = viewer.getPageView(this.#page - 1)?.viewport?.width
      if (this.#destroyed) return
      if (box && width) {
        this.#textBox = box
        viewer.currentScale = clampScale(viewer.currentScale * (this.#scroller.clientWidth - 2 * TEXT_PAD) / ((box[1] - box[0]) * width))
        this.#alignText()
      } else viewer.currentScaleValue = 'page-width'
    } else if (PRESETS.includes(mode)) viewer.currentScaleValue = mode
    else if (Number(mode) > 0) viewer.currentScale = clampScale(Number(mode))
    else {
      mode = 'auto'
      viewer.currentScaleValue = mode
    }
    if (!(Number(mode) > 0)) this.#restZoom = mode
    this.#setZoomMode(mode)
  }

  #setZoomMode(mode: string) {
    this.#zoomMode = mode
    if (this.#saveZoomTimer) clearTimeout(this.#saveZoomTimer)
    if (mode === this.#savedZoom) return
    this.#saveZoomTimer = setTimeout(() => {
      this.#savedZoom = mode
      this.#cb.onViewChange?.({ pdfZoom: mode })
    }, 500)
  }

  /** Scrolls so the text column starts at the left edge ("fit text"). */
  #alignText() {
    const box = this.#textBox
    const view = this.#viewer.getPageView(this.#page - 1)
    if (!box || !view?.div) return
    this.#scroller.scrollLeft = view.div.offsetLeft + box[0] * view.viewport.width - TEXT_PAD
  }

  /** Edges of the text on the current page and its neighbours. */
  async #findTextBox(): Promise<[number, number] | null> {
    const n = this.#doc.numPages
    const pages = [0, 1, -1, 2, -2].map(d => this.#page + d).filter(p => p >= 1 && p <= n)
    const boxes = (await Promise.all(pages.map(p => this.#pageTextBounds(p)))).filter(b => b !== null)
    if (!boxes.length) return null
    return [Math.min(...boxes.map(b => b[0])), Math.max(...boxes.map(b => b[1]))]
  }

  #pageTextBounds(p: number) {
    let bounds = this.#textBounds.get(p)
    if (!bounds) {
      bounds = this.#doc.getPage(p).then(async page => {
        const vp = page.getViewport({ scale: 1 })
        const { items } = await page.getTextContent()
        const lefts: number[] = []
        const rights: number[] = []
        for (const it of items) {
          if (!('str' in it) || !it.str.trim()) continue
          const tx = pdfjsLib.Util.transform(vp.transform, it.transform)
          if (Math.abs(Math.atan2(tx[1], tx[0])) > 0.02) continue
          lefts.push(tx[4] / vp.width)
          rights.push((tx[4] + it.width) / vp.width)
        }
        if (lefts.length < 3) return null
        // ignore a stray item or two far out in the margin
        const l = percentile(lefts, 0.02)
        const r = percentile(rights, 0.98)
        return r - l > 0.2 ? [Math.max(0, l), Math.min(1, r)] as [number, number] : null
      }).catch(() => null)
      this.#textBounds.set(p, bounds)
    }
    return bounds
  }

  #showZoom(scale = this.#viewer.currentScale) {
    const hud = this.#hud ??= Object.assign(document.createElement('div'), { className: 'pdf-zoom-hud' })
    if (!hud.isConnected) this.#container.append(hud)
    hud.textContent = `${Math.round(scale * 100)}%`
    hud.classList.add('show')
    if (this.#hudTimer) clearTimeout(this.#hudTimer)
    this.#hudTimer = setTimeout(() => hud.classList.remove('show'), 900)
  }

  /** Re-fits fit-to-width / page / text zoom when the window or screen orientation changes. */
  #observeResize() {
    let { clientWidth: w, clientHeight: h } = this.#scroller
    let timer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const { clientWidth, clientHeight } = this.#scroller
        const mode = this.#zoomMode
        // showing or hiding the system bars only changes the height
        const changed = clientWidth !== w || (mode === 'page-fit' && clientHeight !== h)
        w = clientWidth
        h = clientHeight
        if (changed && !(Number(mode) > 0) && !this.#destroyed) this.#applyZoom(mode)
      }, 150)
    })
    ro.observe(this.#scroller)
    this.#abort.signal.addEventListener('abort', () => ro.disconnect())
  }

  // ---------------------------------------------------------------- touch gestures
  #onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      const t = e.touches[0]
      this.#swipe = { x: t.clientX, y: t.clientY, t: performance.now(), left: this.#scroller.scrollLeft }
      return
    }
    this.#swipe = null
    if (e.touches.length !== 2 || !this.#ready) return
    // two fingers: pinch zoom, previewed with a transform and rendered once at the end
    e.preventDefault()
    const [a, b] = [e.touches[0], e.touches[1]]
    const m0: [number, number] = [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2]
    const box = this.#viewerEl.getBoundingClientRect()
    this.#viewerEl.style.transformOrigin = `${m0[0] - box.left}px ${m0[1] - box.top}px`
    this.#pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, m0, m: m0, factor: 1 }
  }

  #onTouchMove = (e: TouchEvent) => {
    const p = this.#pinch
    if (!p || e.touches.length !== 2) return
    e.preventDefault()
    const [a, b] = [e.touches[0], e.touches[1]]
    const scale = this.#viewer.currentScale
    p.factor = Math.min(MAX_SCALE / scale, Math.max(MIN_SCALE / scale, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / p.d0))
    p.m = [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2]
    this.#viewerEl.style.transform = `translate(${p.m[0] - p.m0[0]}px, ${p.m[1] - p.m0[1]}px) scale(${p.factor})`
    this.#showZoom(scale * p.factor)
  }

  #onTouchEnd = (e: TouchEvent) => {
    const p = this.#pinch
    if (p) {
      if (e.touches.length >= 2) return
      this.#pinch = null
      this.#viewerEl.style.transform = ''
      this.#viewerEl.style.transformOrigin = ''
      const pan: [number, number] = [p.m[0] - p.m0[0], p.m[1] - p.m0[1]]
      if (Math.abs(p.factor - 1) < 0.01) this.#scroller.scrollBy(-pan[0], -pan[1])
      else {
        this.#viewer.updateScale({ scaleFactor: p.factor, origin: p.m0, pan })
        this.#setZoomMode(String(this.#viewer.currentScale))
        this.#showZoom()
      }
      return
    }
    const s = this.#swipe
    this.#swipe = null
    const t = e.changedTouches[0]
    if (!s || !t || e.touches.length || !this.#isPaged()) return
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (performance.now() - s.t > 700 || Math.abs(dx) < 50 || Math.abs(dx) < 1.8 * Math.abs(dy)) return
    if (document.getSelection()?.isCollapsed === false) return
    // a zoomed page scrolls sideways first; the page turns once it can't scroll further
    const max = this.#scroller.scrollWidth - this.#scroller.clientWidth
    if ((dx < 0 && s.left < max - 1) || (dx > 0 && s.left > 1)) return
    this.#turn(dx < 0 ? 1 : -1)
  }

  /** Double tap: zoom into the text column under the finger, or back out to the fit mode. */
  #doubleTapZoom(x: number, y: number) {
    const viewer = this.#viewer
    const scale = viewer.currentScale
    const width = viewer.getPageView(this.#page - 1)?.viewport?.width
    const fitWidth = width ? scale * this.#scroller.clientWidth / width : scale
    if (Number(this.#zoomMode) > 0 && scale > fitWidth * 1.15) {
      this.#applyZoom(this.#restZoom).then(() => this.#showZoom())
      return
    }
    const col = this.#columnAt(x, y)
    let factor = col ? (this.#scroller.clientWidth - 2 * TEXT_PAD) / (col.right - col.left) : 2
    if (factor < 1.15) factor = 1.6
    factor = clampScale(scale * factor) / scale
    viewer.updateScale({ scaleFactor: factor, origin: [x, y] })
    if (col) {
      // a point p on screen moved to x + (p - x) * f; line the column up with the left edge
      const f = viewer.currentScale / scale
      this.#scroller.scrollLeft += x + (col.left - x) * f - (this.#scroller.getBoundingClientRect().left + TEXT_PAD)
    }
    this.#setZoomMode(String(viewer.currentScale))
    this.#showZoom()
  }

  /** Horizontal extent (client coordinates) of the text column at a point, from the text layer. */
  #columnAt(x: number, y: number) {
    const hit = this.#pageAt(x, y)
    if (!hit) return null
    const rects = Array.from(hit.el.querySelectorAll('.textLayer span[role="presentation"]'), s => s.getBoundingClientRect())
      .filter(r => r.width > 1 && r.height > 1)
      .sort((a, b) => a.top - b.top)
    // runs on one line, split where the gap is wide enough to be a column gutter
    const segments: { left: number; right: number; mid: number }[] = []
    let row: DOMRect[] = []
    const flush = () => {
      row.sort((a, b) => a.left - b.left)
      let seg: { left: number; right: number; mid: number } | null = null
      for (const r of row) {
        if (seg && r.left - seg.right < 1.5 * r.height) seg.right = Math.max(seg.right, r.right)
        else segments.push(seg = { left: r.left, right: r.right, mid: (r.top + r.bottom) / 2 })
      }
      row = []
    }
    for (const r of rects) {
      if (row.length && Math.abs((r.top + r.bottom) / 2 - (row[0].top + row[0].bottom) / 2) > row[0].height * 0.5) flush()
      row.push(r)
    }
    flush()
    let near = segments.filter(s => s.left - 4 <= x && s.right + 4 >= x && Math.abs(s.mid - y) < hit.r.height * 0.3)
    if (!near.length) near = segments.filter(s => Math.abs(s.mid - y) < hit.r.height * 0.1)
    if (!near.length) return null
    const left = percentile(near.map(s => s.left), 0.1)
    const right = percentile(near.map(s => s.right), 0.9)
    return right - left > 40 ? { left, right } : null
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
    if (this.#viewer.spreadMode !== spread) {
      this.#viewer.spreadMode = spread
      if (this.#zoomMode === 'text-width') this.#applyZoom('text-width')
    }
    // the default zoom changed in the Appearance panel (or was reset)
    if (prev && prev !== s && prev.pdfZoom !== s.pdfZoom) this.#applyZoom(s.pdfZoom)
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
    if (this.#pendingTap) clearTimeout(this.#pendingTap)
    // with a mouse, wait briefly so a double-click (word lookup) doesn't turn the page
    if (this.#pointerType === 'mouse') {
      this.#pendingTap = setTimeout(run, 260)
      return
    }
    // with a finger, a second tap right after zooms
    const now = performance.now()
    const last = this.#lastTap
    if (last && now - last.t < 320 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40) {
      this.#pendingTap = null
      this.#lastTap = null
      this.#doubleTapZoom(e.clientX, e.clientY)
      return
    }
    this.#lastTap = { t: now, x: e.clientX, y: e.clientY }
    this.#pendingTap = setTimeout(run, 280)
  }

  #onWheel = (e: WheelEvent) => {
    this.#cb.onActivity()
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025))
      this.#viewer.updateScale({ scaleFactor: factor, origin: [e.clientX, e.clientY], drawingDelay: 300 })
      this.#setZoomMode(String(this.#viewer.currentScale))
      this.#showZoom()
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
      this.#turn(e.deltaY > 0 ? 1 : -1)
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
    const byPage = new Map<number, Rect4[]>()
    for (const cr of Array.from(range.getClientRects())) {
      if (cr.width < 1 || cr.height < 1) continue
      const hit = this.#pageAt(cr.left + cr.width / 2, cr.top + cr.height / 2)
      if (!hit) continue
      const list = byPage.get(hit.page) ?? []
      list.push([(cr.left - hit.r.left) / hit.r.width, (cr.top - hit.r.top) / hit.r.height, cr.width / hit.r.width, cr.height / hit.r.height])
      byPage.set(hit.page, list)
    }
    // a selection running across a page break keeps every page it covers
    const loc = makePdfLocator(byPage)
    const page = loc?.p ?? this.#page
    const r = range.getBoundingClientRect()
    this.#cb.onSelection({
      text,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      locator: loc ? JSON.stringify(loc) : null,
      context: contextSentence(range),
      chapter: [...this.#outlinePages].reverse().find(o => o.page <= page)?.label,
      page,
      fraction: this.#doc.numPages > 1 ? (page - 1) / (this.#doc.numPages - 1) : 1,
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
    const items = this.#highlights.flatMap(a => {
      const loc = parsePdfLocator(a.locator)
      const parts = loc ? locatorParts(loc) : []
      const part = parts.find(x => x.p === pageNumber)
      return part ? [{ a, rects: part.r, last: part === parts[parts.length - 1] }] : []
    })
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
    for (const { a, rects, last } of items) {
      const c = HIGHLIGHT_COLORS[a.color ?? 'yellow']
      for (const [x, y, w, h] of rects) {
        const el = document.createElement('div')
        el.className = 'lumen-hl'
        Object.assign(el.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`, background: dark ? c.dark : c.light })
        layer.append(el)
      }
      if (a.note && last && rects.length) {
        const [x, y, w] = rects[rects.length - 1]
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
      const part = loc && locatorParts(loc).find(x => x.p === hit.page)
      if (!part) continue
      for (const [rx, ry, rw, rh] of part.r) {
        if (px >= rx && px <= rx + rw && py >= ry && py <= ry + rh) {
          const [fx, fy, fw, fh] = part.r[0]
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
          if (this.#page !== p) this.#showPage(p)
        },
      }))
  }

  async speechAdvance() {
    if (!this.#speechPage) this.#speechPage = this.#page
    if (this.#speechPage >= this.#doc.numPages) return false
    this.#speechPage++
    await this.#showPage(this.#speechPage)
    return true
  }

  clearSpeech() {
    this.#speechPage = 0
  }
}
