// "Flowing text" view of a PDF: the reflowable engine reading a book generated
// from the PDF's text. Locators stay in the page view's formats (`pdf:<page>@x,y`
// positions, `pdf:<page>` bookmarks and JSON page highlights), so switching views
// keeps the place, bookmarks and highlights.
import type { Annotation } from '../lib/db'
import { openPdf } from '../lib/pdfjs'
import type { FoliateRelocateDetail } from '../vendor/foliate-js/view.js'
import { EpubEngine } from './epub-engine'
import { FLOW_VERSION, PdfFlow } from './pdf-flow'
import { parsePdfLocator } from './pdf-locator'
import type { EngineCallbacks, Relocation, SelectionInfo } from './types'

/** `pdf:<page>[@<x>,<y>][|<version>:<cfi>]` */
const LOCATOR = /^pdf:(\d+)(?:@(-?[\d.]+),(-?[\d.]+))?(?:\|(\w+):(.+))?$/

export class PdfFlowEngine extends EpubEngine {
  #data: Uint8Array
  #title: string
  #flow?: PdfFlow
  #syncId = 0
  /**
   * The page position last jumped to. A page often starts mid-paragraph, so the
   * screen showing it begins with the previous page's text; while the start of the
   * requested page is on screen, that page is reported, so switching views back and
   * forth doesn't drift. Turning the page forgets it.
   */
  #intended: string | null = null

  constructor(data: Uint8Array, title: string, cb: EngineCallbacks) {
    super(null, title, cb)
    this.#data = data
    this.#title = title
  }

  protected async loadBook() {
    const doc = await openPdf(this.#data)
    try {
      this.#flow = await PdfFlow.create(doc, this.#title)
    } catch (e) {
      doc.loadingTask.destroy()
      throw e
    }
    return this.#flow.book
  }

  async open(container: HTMLElement, location?: string) {
    await super.open(container, location)
    const flow = this.#flow
    if (!flow) return
    const total = Math.max(1, flow.pageCount - 1)
    this.sectionFractions = flow.chapterStarts.map(p => (p - 1) / total)
  }

  destroy() {
    super.destroy()
    this.#flow?.destroy()
  }

  protected resolveTarget(target: string) {
    const m = target.match(LOCATOR)
    const loc = m ? null : parsePdfLocator(target)
    const href = m ? (m[3] != null ? `p${m[1]}y${m[3]}` : `p${m[1]}`) : loc ? `p${loc.p}t${loc.r[0]?.[1] ?? 0}` : /^p\d/.test(target) ? target : null
    this.#intended = href
    // a CFI saved by this view is exact; anything else goes to the page position
    if (m?.[4] === FLOW_VERSION && m[5]) return m[5]
    return href ?? target
  }

  next() {
    this.#intended = null
    super.next()
  }

  prev() {
    this.#intended = null
    super.prev()
  }

  async goToFraction(f: number) {
    const total = this.#flow?.pageCount ?? 1
    await this.goTo(`pdf:${Math.min(total, Math.max(1, Math.round(f * (total - 1)) + 1))}`)
  }

  protected decorateRelocation(r: Relocation, detail: FoliateRelocateDetail): Relocation {
    const flow = this.#flow
    if (!flow) return r
    const { range } = detail
    // relocations while a section is still laying out carry no text yet
    if (!range || !range.toString().trim()) return r
    const el = this.#intended ? flow.anchor(range.startContainer.ownerDocument!, this.#intended) : null
    const pos = el && range.comparePoint(el, 0) === 0 ? flow.placeOf(this.#intended!) : flow.positionOf(range)
    if (!pos) return r
    const { page, t } = pos
    const [x, y] = flow.toPdfPoint(page, t)
    const total = flow.pageCount
    const chapter = flow.minutesLeftInChapter(page, t)
    return {
      ...r,
      locator: `pdf:${page}@${Math.round(x)},${Math.round(y)}|${FLOW_VERSION}:${r.locator}`,
      fraction: total > 1 ? Math.min(1, (page - 1 + t) / (total - 1)) : 1,
      page: { current: page, total, label: flow.pageLabel(page) },
      timeLeft: { chapter, book: flow.minutesLeftInBook(page, t) },
    }
  }

  protected decorateSelection(s: SelectionInfo, _index: number | undefined, range: Range): SelectionInfo {
    const flow = this.#flow
    const loc = flow?.locatorFor(range)
    if (!flow || !loc) return { ...s, locator: null }
    return { ...s, locator: JSON.stringify(loc), page: loc.p, fraction: flow.pageCount > 1 ? (loc.p - 1) / (flow.pageCount - 1) : 1 }
  }

  protected onDocumentLoad(doc: Document, index: number) {
    this.#flow?.decorate(doc, index).catch(e => console.warn('Figures failed', e))
  }

  /** Highlights are stored as page rectangles; each is drawn at the text it covers here. */
  setAnnotations(list: Annotation[]) {
    const flow = this.#flow
    const id = ++this.#syncId
    if (!flow) return
    Promise.all(list.filter(a => a.kind === 'highlight').map(async a => {
      const cfi = await flow.cfiFor(a.locator, (i, range) => this.view.getCFI(i, range)).catch(() => null)
      return cfi ? { ...a, locator: cfi } : null
    })).then(mapped => {
      if (id === this.#syncId && !this.destroyed) super.setAnnotations(mapped.filter(a => a !== null))
    })
  }
}
