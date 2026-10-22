// "Flowing text" for PDFs: pages are rebuilt as reflowable HTML sections that
// foliate-js paginates like an EPUB, so the text follows the reader's font, size
// and theme. Every text run keeps its position on the original page, which lets
// highlights and the reading position move between this view and the page view.
//
// The markup of a section depends only on the text of its pages, so documents
// built for search and the one shown on screen always agree on CFIs. Figures
// are found afterwards and added to the live document as CSS decorations.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { FoliateBook, FoliateTocItem } from '../vendor/foliate-js/view.js'
import { pdfjsLib, resolveOutline, type PdfOutlineNode } from '../lib/pdfjs'
import { mergeRects, parsePdfLocator, type PdfLocator, type Rect4 } from './pdf-locator'

/** Part of every stored flowing-text CFI; bump it when the generated markup changes. */
export const FLOW_VERSION = 'f1'

export class FlowUnavailableError extends Error {
  name = 'FlowUnavailableError'
}

type Viewport = ReturnType<PDFPageProxy['getViewport']>

/** One text item, in page units (top-down, scale 1). */
interface Run { text: string; x0: number; x1: number; top: number; bottom: number; size: number }

interface Line {
  /** indices into PageText.runs, with the separator to put before each */
  runs: number[]
  seps: string[]
  x0: number
  x1: number
  top: number
  bottom: number
  base: number
  size: number
  text: string
}

interface PageText {
  page: number
  width: number
  height: number
  viewport: Viewport
  runs: Run[]
  lines: Line[]
  chars: number
}

interface Block {
  lines: Line[]
  kind: 'p' | 'h2' | 'h3'
  small: boolean
  center: boolean
  /** the last line runs to the right edge of its column */
  endsFull: boolean
}

const MAX_SECTION_PAGES = 12
const SAMPLE_PAGES = 16
const CHARS_PER_MINUTE = 1100

const TERMINAL = /[.!?…:;"”’)\]]$/
const BULLET = /^(?:[•●○■□▪▫◦‣∙·*–—-]|\(?\d{1,3}[.)]|\(?[a-z][.)]|\([ivx]{1,4}\))\s/i
const PAGE_NUMBER = /^[\s\-–—([]*(?:page\s+|p\.\s*)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:of|\/)\s*\d{1,4})?[\s\-–—)\].]*$/i
const CJK = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/
const HREF = /^p(\d+)(?:([ty])(-?[\d.]+))?$/

const FLOW_CSS = `
h2, h3 { line-height: 1.25; margin: 1.3em 0 .55em; text-align: start; break-after: avoid; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.15em; }
p.s { font-size: .86em; }
.fig-b::before, .fig-a::after {
  content: ''; display: block; width: var(--fig-w); max-width: 100%; max-height: 82vh; aspect-ratio: var(--fig-ar);
  margin: .9em auto; background: var(--fig) center / contain no-repeat; break-inside: avoid; text-indent: 0;
}
.fig-x { display: none !important; }
`

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : NaN)
const sameSize = (a: Line, b: Line) => Math.abs(a.size - b.size) <= 0.12 * Math.max(a.size, b.size)
const overlapX = (a: Line, b: Line) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.3 * Math.min(a.x1 - a.x0, b.x1 - b.x0)
const edgeKey = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/[^\p{L}#]+/gu, ' ').trim()

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'it', 'was', 'for'],
  fr: ['le', 'la', 'les', 'et', 'des', 'est', 'une', 'du', 'que', 'dans'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'ein', 'zu', 'den', 'mit'],
  es: ['el', 'la', 'de', 'que', 'y', 'los', 'en', 'las', 'por', 'una'],
  it: ['il', 'di', 'che', 'e', 'la', 'per', 'non', 'un', 'del', 'gli'],
  pt: ['de', 'que', 'o', 'a', 'e', 'do', 'da', 'em', 'um', 'não'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'op', 'te'],
}

/**
 * Guesses the language from the commonest words, for PDFs that don't declare one.
 * Hyphenation (and so justified text on a phone) only works when it is known.
 */
const guessLanguage = (text: string) => {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
  if (words.length < 50) return undefined
  const counts = new Map<string, number>()
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  let best: string | undefined
  let score = 0
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const s = list.reduce((n, w) => n + (counts.get(w) ?? 0), 0) / words.length
    if (s > score) [best, score] = [lang, s]
  }
  return score > 0.12 ? best : undefined
}

const extractPage = async (page: PDFPageProxy): Promise<PageText> => {
  const viewport = page.getViewport({ scale: 1 })
  const { items, styles } = await page.getTextContent()
  const runs: Run[] = []
  for (const item of items) {
    if (!('str' in item) || !item.str.trim() || !(item.width > 0)) continue
    const style = styles[item.fontName]
    if (style?.vertical) continue
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform)
    // rotated text (margin stamps, axis labels) isn't part of the flow
    if (Math.abs(Math.atan2(tx[1], tx[0])) > 0.02) continue
    const size = Math.hypot(tx[2], tx[3])
    if (size < 1) continue
    const ascent = style && style.ascent > 0 ? Math.min(1, style.ascent) : style && style.descent < 0 ? 1 + style.descent : 0.8
    const top = tx[5] - size * ascent
    runs.push({ text: item.str.replace(/\s+/g, ' '), x0: tx[4], x1: tx[4] + item.width, top, bottom: top + size, size })
  }
  const lines = buildLines(runs, viewport.width)
  return { page: page.pageNumber, width: viewport.width, height: viewport.height, viewport, runs, lines, chars: lines.reduce((n, l) => n + l.text.length, 0) }
}

/**
 * Groups runs into lines, following the content order of the page. Justified text in
 * narrow columns stretches word gaps to several ems, so only a gap of a third of the
 * page splits a line.
 */
const buildLines = (runs: Run[], pageWidth: number) => {
  const lines: Line[] = []
  let line: Line | null = null
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    if (line) {
      const overlap = Math.min(r.bottom, line.bottom) - Math.max(r.top, line.top)
      const gap = r.x0 - line.x1
      const em = Math.max(r.size, line.size)
      if (overlap > 0.5 * Math.min(r.size, line.bottom - line.top) && gap > -0.6 * em && gap < pageWidth / 3) {
        const prev = runs[line.runs[line.runs.length - 1]].text
        const sep = gap > 0.18 * em && !prev.endsWith(' ') && !r.text.startsWith(' ') ? ' ' : ''
        line.runs.push(i)
        line.seps.push(sep)
        line.text += sep + r.text
        line.x0 = Math.min(line.x0, r.x0)
        line.x1 = Math.max(line.x1, r.x1)
        line.top = Math.min(line.top, r.top)
        line.bottom = Math.max(line.bottom, r.bottom)
        continue
      }
    }
    line = { runs: [i], seps: [''], x0: r.x0, x1: r.x1, top: r.top, bottom: r.bottom, base: r.bottom, size: r.size, text: r.text }
    lines.push(line)
  }
  for (const l of lines) {
    // size and baseline come from the longest run, so superscripts don't count
    let main = runs[l.runs[0]]
    for (const k of l.runs) if (runs[k].text.length > main.text.length) main = runs[k]
    l.size = main.size
    l.base = main.bottom
    l.text = l.text.trim()
  }
  return lines.filter(l => l.text)
}

/** Lines at the very top or bottom of a page: candidates for running heads, feet and page numbers. */
const edgeLines = (pt: PageText) => {
  const byTop = [...pt.lines].sort((a, b) => a.top - b.top)
  const out = new Set<Line>()
  for (const l of byTop.slice(0, 2)) if (l.bottom < pt.height * 0.13) out.add(l)
  for (const l of byTop.slice(-2)) if (l.top > pt.height * 0.87) out.add(l)
  return [...out]
}

/** Splits a page's lines into paragraphs and headings. */
const segmentPage = (pt: PageText, lines: Line[], bodySize: number): Block[] => {
  if (!lines.length) return []
  const ratios: number[] = []
  for (let i = 1; i < lines.length; i++) {
    const dy = lines[i].base - lines[i - 1].base
    if (sameSize(lines[i], lines[i - 1]) && dy > 0.8 * lines[i].size && dy < 2.5 * lines[i].size) ratios.push(dy / lines[i].size)
  }
  const pitch = median(ratios) || 1.25
  // right edge of the column each line belongs to
  const right = lines.map((l, i) => {
    let r = l.x1
    for (let j = Math.max(0, i - 5); j <= Math.min(lines.length - 1, i + 5); j++)
      if (sameSize(l, lines[j]) && overlapX(l, lines[j])) r = Math.max(r, lines[j].x1)
    return r
  })
  const body = lines.filter(l => Math.abs(l.size - bodySize) <= 0.12 * bodySize)
  const ref = body.length ? body : lines
  const bodyL = Math.min(...ref.map(l => l.x0))
  const bodyR = Math.max(...ref.map(l => l.x1))
  // a line reaching its column's right edge (a lone short line, like a label, doesn't count)
  const full = lines.map((l, i) => right[i] - l.x1 < Math.max(1.5 * l.size, 0.03 * pt.width) && l.x1 - l.x0 > 0.35 * (bodyR - bodyL))
  // the previous line stopped short although this line's first word would have fit on it
  const endedBefore = (i: number) => {
    const line = lines[i]
    const word = line.text.split(' ')[0]
    const charWidth = (line.x1 - line.x0) / Math.max(1, line.text.length)
    return right[i - 1] - lines[i - 1].x1 > Math.max(1.2 * line.size, (word.length + 1) * charWidth)
  }
  // a first-line indent: the line after it returns to the margin
  const indented = (i: number) => {
    const d = lines[i].x0 - lines[i - 1].x0
    if (d < 0.8 * lines[i].size || d > 8 * lines[i].size) return false
    const next = lines[i + 1]
    return !next || !sameSize(next, lines[i]) || Math.abs(next.x0 - lines[i - 1].x0) < 0.6 * lines[i].size
  }

  const groups: { lines: Line[]; last: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const group = groups[groups.length - 1]
    let brk = !group
    if (group) {
      const prev = lines[i - 1]
      const dy = line.base - prev.base
      brk = !sameSize(line, prev)
        // moved up: a new column, which continues the paragraph only mid-sentence
        || (dy < -0.5 * line.size ? !(full[i - 1] && !TERMINAL.test(prev.text)) : dy > (pitch * 1.4 + 0.1) * line.size)
        || BULLET.test(line.text)
        || endedBefore(i)
        || (!BULLET.test(group.lines[0].text) && indented(i))
    }
    if (brk) groups.push({ lines: [line], last: i })
    else {
      group.lines.push(line)
      group.last = i
    }
  }

  const center = (bodyL + bodyR) / 2
  return groups.map(({ lines: ls, last }) => {
    const ratio = ls[0].size / bodySize
    const chars = ls.reduce((n, l) => n + l.text.length, 0)
    const heading = ratio >= 1.18 && chars < 200 && ls.length <= 4
    return {
      lines: ls,
      kind: heading ? (ratio >= 1.5 ? 'h2' : 'h3') : 'p',
      small: ratio <= 0.86,
      center: ls.every(l => Math.abs((l.x0 + l.x1) / 2 - center) < 0.025 * pt.width && l.x1 - l.x0 < 0.8 * (bodyR - bodyL)),
      endsFull: full[last],
    }
  })
}

/** A paragraph being assembled; it may continue onto the next page. */
interface OpenBlock {
  block: Block
  parts: ({ k: string; text: string } | string)[]
  attrs: string
  last: Line
}

const render = (b: OpenBlock) => {
  const tag = b.block.kind
  const inner = b.parts.map(p => (typeof p === 'string' ? p : `<span data-k="${p.k}">${esc(p.text)}</span>`)).join('')
  return `<${tag}${b.attrs}>${inner}</${tag}>`
}

/** Appends a line's runs to a paragraph, joining words split by a hyphen at the line end. */
const appendLine = (b: OpenBlock, pt: PageText, line: Line, first: boolean) => {
  line.runs.forEach((k, j) => {
    let text = pt.runs[k].text
    if (j === 0) text = text.trimStart()
    if (j === line.runs.length - 1) text = text.trimEnd()
    if (!text) return
    if (j === 0 && !first) {
      const prev = [...b.parts].reverse().find(p => typeof p !== 'string') as { text: string } | undefined
      if (prev && /[-\u00ad]$/.test(prev.text) && /^\p{Ll}/u.test(text)) prev.text = prev.text.slice(0, -1)
      else if (!(prev && CJK.test(prev.text.slice(-1)) && CJK.test(text[0]))) b.parts.push(' ')
    } else if (line.seps[j]) b.parts.push(line.seps[j])
    b.parts.push({ k: `${pt.page}.${k}`, text })
  })
  b.last = line
}

/** A page without text still gets a marker, so every page stays addressable. */
const blankPage = (n: number) => `<div class="pg-blank" id="p${n}" data-p="${n}" data-t="0"></div>`

export class PdfFlow {
  book!: FoliateBook
  readonly pageCount: number
  /** first pages of chapters, from the outline */
  chapterStarts: number[] = []

  #doc: PDFDocumentProxy
  #title: string
  #labels: string[] | null = null
  #avgChars = 1500
  #bodySize = 10
  #sampleEdges = new Map<string, Set<number>>()
  #samplePages = new Set<number>()
  #sections: { start: number; end: number; title: string }[] = []
  #pages = new Map<number, Promise<PageText>>()
  /** pages whose text has been extracted, for synchronous lookups */
  #ready = new Map<number, PageText>()
  #html = new Map<number, Promise<string>>()
  #docs = new Map<number, Promise<Document>>()
  #urls = new Map<number, string>()
  #regions = new Map<number, Promise<Rect4[]>>()
  #crops = new Map<string, Promise<string | null>>()
  #blobUrls: string[] = []
  #destroyed = false

  private constructor(doc: PDFDocumentProxy, title: string) {
    this.#doc = doc
    this.#title = title
    this.pageCount = doc.numPages
  }

  /** Reads the outline and a sample of pages; throws FlowUnavailableError for PDFs without text. */
  static async create(doc: PDFDocumentProxy, title: string) {
    const flow = new PdfFlow(doc, title)
    await flow.#init()
    return flow
  }

  async #init() {
    const n = this.pageCount
    const [outline, labels, meta] = await Promise.all([
      resolveOutline(this.#doc).catch(() => [] as PdfOutlineNode[]),
      this.#doc.getPageLabels().catch(() => null),
      this.#doc.getMetadata().catch(() => null),
    ])
    this.#labels = labels

    const count = Math.min(n, SAMPLE_PAGES)
    const sample = [...new Set(Array.from({ length: count }, (_, i) => 1 + Math.round(i * (n - 1) / Math.max(1, count - 1))))]
    const texts = await Promise.all(sample.map(p => this.#page(p)))
    const chars = texts.reduce((s, t) => s + t.chars, 0)
    if (chars < 30 * texts.length) throw new FlowUnavailableError('This PDF has no selectable text (it is probably scanned), so it can’t be shown as flowing text.')
    this.#avgChars = chars / texts.length
    // body text size: the median size, weighted by characters
    const sizes = texts.flatMap(t => t.lines.map(l => [l.size, l.text.length] as const)).sort((a, b) => a[0] - b[0])
    let acc = 0
    for (const [size, c] of sizes) {
      acc += c
      if (acc >= chars / 2) {
        this.#bodySize = size
        break
      }
    }
    for (const t of texts) {
      this.#samplePages.add(t.page)
      for (const l of edgeLines(t)) this.#countEdge(this.#sampleEdges, l, t.page)
    }

    const top = outline.filter(o => o.page)
    let chapterNodes = top
    if (new Set(top.map(o => o.page)).size < 3) chapterNodes = [...top, ...top.flatMap(o => o.items.filter(c => c.page))]
    this.chapterStarts = [...new Set(chapterNodes.map(o => o.page!))].sort((a, b) => a - b)
    this.#sections = this.#partition(outline)
    this.book = {
      metadata: {
        title: this.#title,
        language: (meta?.info as { Language?: string } | undefined)?.Language || guessLanguage(texts.flatMap(t => t.lines.map(l => l.text)).join(' ')),
      },
      toc: this.#convertToc(outline),
      pageList: Array.from({ length: n }, (_, i) => ({ label: labels?.[i] || String(i + 1), href: `p${i + 1}` })),
      sections: this.#sections.map((s, i) => ({
        id: i,
        size: (s.end - s.start + 1) * Math.max(400, this.#avgChars),
        load: () => this.#url(i),
        createDocument: () => this.document(i),
      })),
      resolveHref: href => ({ index: this.#sectionOfHref(href), anchor: doc => this.anchor(doc, href) }),
      splitTOCHref: href => [this.#sectionOfHref(href), href],
      getTOCFragment: (doc, href) => this.anchor(doc, href),
      isExternal: () => false,
    }
  }

  #partition(outline: PdfOutlineNode[]) {
    const titled = new Map<number, string>()
    const walk = (nodes: PdfOutlineNode[]) => nodes.forEach(o => {
      if (o.page && !titled.has(o.page)) titled.set(o.page, o.title)
      walk(o.items)
    })
    walk(outline)
    const bounds = [...new Set([1, ...this.chapterStarts.filter(p => p > 1 && p <= this.pageCount)])].sort((a, b) => a - b)
    const out: { start: number; end: number; title: string }[] = []
    bounds.forEach((start, i) => {
      const end = (bounds[i + 1] ?? this.pageCount + 1) - 1
      // long chapters are split so every section stays quick to build
      const parts = Math.ceil((end - start + 1) / MAX_SECTION_PAGES)
      const size = Math.ceil((end - start + 1) / parts)
      for (let a = start; a <= end; a += size) out.push({ start: a, end: Math.min(end, a + size - 1), title: titled.get(start) ?? this.#title })
    })
    return out
  }

  #convertToc(nodes: PdfOutlineNode[]): FoliateTocItem[] {
    return nodes.flatMap(o => {
      const subitems = this.#convertToc(o.items)
      // entries without a page (web links, broken destinations) keep their children
      if (!o.page) return subitems
      return [{ label: o.title, href: o.top != null ? `p${o.page}y${Math.round(o.top)}` : `p${o.page}`, subitems: subitems.length ? subitems : null }]
    })
  }

  destroy() {
    this.#destroyed = true
    for (const url of [...this.#urls.values(), ...this.#blobUrls]) URL.revokeObjectURL(url)
    this.#doc.loadingTask.destroy().catch(() => {})
  }

  // ---------------------------------------------------------------- pages and sections
  #page(n: number) {
    let p = this.#pages.get(n)
    if (!p) {
      p = this.#doc.getPage(n).then(extractPage).then(t => {
        this.#ready.set(n, t)
        return t
      })
      this.#pages.set(n, p)
    }
    return p
  }

  sectionOf(page: number) {
    const i = this.#sections.findIndex(s => page <= s.end)
    return i < 0 ? this.#sections.length - 1 : i
  }

  #sectionOfHref(href: string) {
    const m = href.match(HREF)
    return m ? this.sectionOf(Number(m[1])) : 0
  }

  pageLabel(page: number) {
    const label = this.#labels?.[page - 1]
    return label && label !== String(page) ? label : undefined
  }

  /** Builds (once) the markup of a section and the following one in the background. */
  #section(i: number): Promise<string> {
    let html = this.#html.get(i)
    if (!html) {
      html = this.#build(i)
      this.#html.set(i, html)
    }
    return html
  }

  async #url(i: number) {
    const html = await this.#section(i)
    if (i + 1 < this.#sections.length) this.#section(i + 1).catch(() => {})
    let url = this.#urls.get(i)
    if (!url) {
      url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
      this.#urls.set(i, url)
    }
    return url
  }

  document(i: number) {
    let doc = this.#docs.get(i)
    if (!doc) {
      doc = this.#section(i).then(html => new DOMParser().parseFromString(html, 'text/html'))
      this.#docs.set(i, doc)
    }
    return doc
  }

  #countEdge(map: Map<string, Set<number>>, line: Line, page: number) {
    const key = edgeKey(line.text)
    if (!key) return
    let set = map.get(key)
    if (!set) map.set(key, set = new Set())
    set.add(page)
  }

  async #build(index: number) {
    const { start, end, title } = this.#sections[index]
    const pages = await Promise.all(Array.from({ length: end - start + 1 }, (_, i) => this.#page(start + i)))
    // running heads repeat across the sample or across this section; nothing else is
    // considered, so the markup of a section never depends on what was built before
    const local = new Map<string, Set<number>>()
    for (const pt of pages) for (const l of edgeLines(pt)) this.#countEdge(local, l, pt.page)
    const isRunningHead = (l: Line) => {
      if (PAGE_NUMBER.test(l.text) && l.size <= this.#bodySize * 1.3) return true
      const key = edgeKey(l.text)
      const inSection = local.get(key)?.size ?? 0
      const inSample = this.#sampleEdges.get(key)?.size ?? 0
      return (inSection >= 2 && inSection >= 0.4 * pages.length) || (inSample >= 3 && inSample >= 0.25 * this.#samplePages.size)
    }

    const out: string[] = []
    let open: OpenBlock | null = null
    const close = () => {
      if (open) out.push(render(open))
      open = null
    }
    for (const pt of pages) {
      const heads = new Set(edgeLines(pt).filter(isRunningHead))
      const blocks = segmentPage(pt, pt.lines.filter(l => !heads.has(l)), this.#bodySize)
      if (!blocks.length) {
        close()
        out.push(blankPage(pt.page))
        continue
      }
      blocks.forEach((block, i) => {
        const t = (block.lines[0].top / pt.height).toFixed(4)
        const cur = open as OpenBlock | null
        const continues = i === 0 && cur && cur.block.kind === 'p' && block.kind === 'p' && cur.block.small === block.small
          && sameSize(cur.last, block.lines[0]) && !BULLET.test(block.lines[0].text)
          && ((cur.block.endsFull && !TERMINAL.test(cur.last.text)) || /^\p{Ll}/u.test(block.lines[0].text))
        if (cur && continues) {
          cur.parts.push(`<span class="pg" id="p${pt.page}" data-p="${pt.page}" data-t="${t}"></span>`)
          block.lines.forEach(l => appendLine(cur, pt, l, false))
          cur.block = { ...cur.block, endsFull: block.endsFull }
          return
        }
        close()
        const cls = block.small && block.kind === 'p' ? ' class="s"' : ''
        const id = i === 0 ? ` id="p${pt.page}"` : ''
        const b: OpenBlock = { block, parts: [], attrs: `${id} data-p="${pt.page}" data-t="${t}"${cls}${block.center ? ' align="center"' : ''}`, last: block.lines[0] }
        block.lines.forEach((l, j) => appendLine(b, pt, l, j === 0))
        open = b
      })
    }
    close()
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${FLOW_CSS}</style></head><body>\n${out.join('\n')}\n</body></html>`
  }

  // ---------------------------------------------------------------- positions
  /** Page and position of a `p<page>[t<0…1> | y<user space y>]` href. */
  placeOf(href: string): { page: number; t: number } | null {
    const m = href.match(HREF)
    if (!m) return null
    const page = Number(m[1])
    let t = 0
    if (m[2] === 't') t = Number(m[3])
    else if (m[2] === 'y') {
      const pt = this.#ready.get(page)
      if (pt) t = Math.max(0, pt.viewport.convertToViewportPoint(0, Number(m[3]))[1] / pt.height)
    }
    return { page, t }
  }

  /** The element at a position on a page (the paragraph or page marker at or above it). */
  anchor(doc: Document, href: string): HTMLElement | null {
    const place = this.placeOf(href)
    if (!place) return null
    let best: HTMLElement | null = null
    for (const el of doc.querySelectorAll<HTMLElement>(`[data-p="${place.page}"]`)) {
      // stop at the first element below the position (later ones may be in the next column)
      if (best && Number(el.dataset.t) > place.t + 0.004) break
      best = el
    }
    // a page that starts mid-paragraph is marked by an empty span, which has no box to
    // scroll to; its first run of text does
    if (best?.classList.contains('pg')) {
      let next = best.nextElementSibling as HTMLElement | null
      while (next && !next.dataset.k) next = next.nextElementSibling as HTMLElement | null
      return next ?? best
    }
    return best
  }

  /** Page and vertical position (0…1) of the first text at or after a range's start. */
  positionOf(range: Range | undefined): { page: number; t: number } | null {
    if (!range) return null
    const doc = range.startContainer.ownerDocument
    if (!doc) return null
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement
    let el: Element | null = start?.closest('[data-k]') ?? null
    if (!el) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT)
      walker.currentNode = range.startContainer
      while (walker.nextNode()) {
        const node = walker.currentNode as HTMLElement
        if (node.dataset.k || node.classList.contains('pg') || node.classList.contains('pg-blank')) {
          el = node
          break
        }
      }
    }
    const k = (el as HTMLElement | null)?.dataset.k
    if (k) {
      const [page, i] = k.split('.').map(Number)
      const pt = this.#ready.get(page)
      return { page, t: pt?.runs[i] ? pt.runs[i].top / pt.height : 0 }
    }
    const p = Number((el as HTMLElement | null)?.dataset.p)
    return p ? { page: p, t: Number((el as HTMLElement).dataset.t) || 0 } : null
  }

  /** A position in PDF user space, for the page view (`pdf:<page>@<x>,<y>`). */
  toPdfPoint(page: number, t: number): [number, number] {
    const pt = this.#ready.get(page)
    if (!pt) return [0, 0]
    const [x, y] = pt.viewport.convertToPdfPoint(0, t * pt.height)
    return [x, y]
  }

  minutesLeftInChapter(page: number, t: number) {
    if (!this.chapterStarts.length) return undefined
    const next = this.chapterStarts.find(p => p > page) ?? this.pageCount + 1
    return Math.max(0, next - page - t) * this.#avgChars / CHARS_PER_MINUTE
  }

  minutesLeftInBook(page: number, t: number) {
    return Math.max(0, this.pageCount + 1 - page - t) * this.#avgChars / CHARS_PER_MINUTE
  }

  /** Maps a selection to page rectangles, the same locator the page view stores. */
  locatorFor(range: Range): PdfLocator | null {
    const root = range.commonAncestorContainer
    const scope = root.nodeType === Node.ELEMENT_NODE ? root as Element : root.parentElement
    if (!scope) return null
    const own = scope.closest('[data-k]')
    const spans = own ? [own as HTMLElement] : [...scope.querySelectorAll<HTMLElement>('[data-k]')].filter(s => range.intersectsNode(s))
    const byPage = new Map<number, Rect4[]>()
    for (const span of spans) {
      const text = span.firstChild
      if (!text || text.nodeType !== Node.TEXT_NODE) continue
      const len = (text as Text).length
      const a = range.startContainer === text ? range.startOffset : 0
      const b = range.endContainer === text ? range.endOffset : len
      const [page, k] = span.dataset.k!.split('.').map(Number)
      const pt = this.#ready.get(page)
      const run = pt?.runs[k]
      if (!pt || !run || b <= a || !len) continue
      const w = run.x1 - run.x0
      const list = byPage.get(page) ?? []
      list.push([(run.x0 + w * a / len) / pt.width, run.top / pt.height, w * (b - a) / len / pt.width, run.size / pt.height])
      byPage.set(page, list)
    }
    if (!byPage.size) return null
    const first = Math.min(...byPage.keys())
    return { p: first, r: mergeRects(byPage.get(first)!) }
  }

  /** The text a page locator covers, as a range in a section document. */
  rangeFor(doc: Document, loc: PdfLocator): Range | null {
    const pt = this.#ready.get(loc.p)
    if (!pt) return null
    let start: [Text, number] | null = null
    let end: [Text, number] | null = null
    for (const span of doc.querySelectorAll<HTMLElement>(`[data-k^="${loc.p}."]`)) {
      const run = pt.runs[Number(span.dataset.k!.split('.')[1])]
      const text = span.firstChild as Text | null
      if (!run || !text || text.nodeType !== Node.TEXT_NODE) continue
      const cy = (run.top + run.bottom) / 2
      for (const [x, y, w, h] of loc.r) {
        const rx0 = x * pt.width
        const rx1 = (x + w) * pt.width
        if (cy < y * pt.height || cy > (y + h) * pt.height || run.x1 <= rx0 || run.x0 >= rx1) continue
        const len = text.length
        const rw = run.x1 - run.x0
        const a = Math.max(0, Math.min(len, Math.round((rx0 - run.x0) / rw * len)))
        const b = Math.max(a, Math.min(len, Math.round((rx1 - run.x0) / rw * len)))
        if (b <= a) continue
        start ??= [text, a]
        end = [text, b]
        break
      }
    }
    if (!start || !end) return null
    const range = doc.createRange()
    range.setStart(...start)
    range.setEnd(...end)
    return range
  }

  /** CFI of a stored page locator in this view, or null if it can't be placed. */
  async cfiFor(locator: string, getCFI: (index: number, range: Range) => string) {
    const loc = parsePdfLocator(locator)
    if (!loc) return null
    const index = this.sectionOf(loc.p)
    const range = this.rangeFor(await this.document(index), loc)
    return range ? getCFI(index, range) : null
  }

  // ---------------------------------------------------------------- figures
  /**
   * Adds the images and drawings of a section's pages to its live document. The
   * text that belongs to a figure (axis labels, legends) is hidden, and each figure
   * is drawn by a pseudo-element of the nearest paragraph, so the DOM (and every
   * CFI) stays the same.
   */
  async decorate(doc: Document, index: number) {
    const { start, end } = this.#sections[index]
    for (let p = start; p <= end; p++) {
      if (this.#destroyed || !doc.defaultView) return
      const [pt, regions] = await Promise.all([this.#page(p), this.#figureRegions(p).catch(() => [] as Rect4[])])
      if (!regions.length || !doc.defaultView) continue
      const placed = this.#place(doc, pt, regions)
      const figures = await Promise.all(placed.map(async f => ({ ...f, url: await this.#crop(p, f.box) })))
      if (!doc.defaultView) return
      for (const { el, where, box, url } of figures) {
        if (!url) continue
        const colWidth = Math.max(...pt.lines.map(l => l.x1 - l.x0), pt.width * 0.5)
        el.classList.add(where === 'before' ? 'fig-b' : 'fig-a')
        el.style.setProperty('--fig', `url("${url}")`)
        el.style.setProperty('--fig-ar', `${(box[2] * pt.width).toFixed(1)} / ${(box[3] * pt.height).toFixed(1)}`)
        el.style.setProperty('--fig-w', `${Math.min(100, box[2] * pt.width / colWidth * 100).toFixed(1)}%`)
      }
    }
  }

  /** Hides text inside figures and picks the element each figure is drawn next to. */
  #place(doc: Document, pt: PageText, regions: Rect4[]) {
    const inside = (run: Run, [x, y, w, h]: Rect4) => {
      const cx = (run.x0 + run.x1) / 2 / pt.width
      const cy = (run.top + run.bottom) / 2 / pt.height
      return cx >= x - 0.004 && cx <= x + w + 0.004 && cy >= y - 0.004 && cy <= y + h + 0.004
    }
    const blocks = new Map<HTMLElement, { top: number; x0: number; x1: number }>()
    for (const span of doc.querySelectorAll<HTMLElement>(`[data-k^="${pt.page}."]`)) {
      const run = pt.runs[Number(span.dataset.k!.split('.')[1])]
      if (!run) continue
      if (regions.some(r => inside(run, r))) {
        span.classList.add('fig-x')
        continue
      }
      // a paragraph continued from the previous page: figures go at this page's marker
      const block = span.closest<HTMLElement>('body > *')
      const marker = block?.querySelector<HTMLElement>(`#p${pt.page}.pg`)
      const el = marker && block?.getAttribute('data-p') !== String(pt.page) ? marker : block
      if (!el) continue
      const b = blocks.get(el)
      const top = run.top / pt.height
      if (!b) blocks.set(el, { top, x0: run.x0 / pt.width, x1: run.x1 / pt.width })
      else Object.assign(b, { top: Math.min(b.top, top), x0: Math.min(b.x0, run.x0 / pt.width), x1: Math.max(b.x1, run.x1 / pt.width) })
    }
    const list = [...blocks.entries()]
    const placed = new Map<string, { el: HTMLElement; where: 'before' | 'after'; box: Rect4 }>()
    for (const r of regions) {
      const bottom = r[1] + r[3] - 0.01
      const below = list.filter(([, b]) => b.top >= bottom)
      const hit = below.find(([, b]) => b.x1 > r[0] && b.x0 < r[0] + r[2]) ?? below[0]
      const el = hit?.[0] ?? list[list.length - 1]?.[0] ?? doc.getElementById(`p${pt.page}`)
      if (!el) continue
      const where = hit || !list.length ? 'before' : 'after'
      const key = `${list.findIndex(([e]) => e === el)}:${where}`
      const prev = placed.get(key)
      if (!prev) placed.set(key, { el, where, box: r })
      else {
        // figures that land in the same place become one image
        const [x, y, w, h] = prev.box
        const x0 = Math.min(x, r[0])
        const y0 = Math.min(y, r[1])
        prev.box = [x0, y0, Math.max(x + w, r[0] + r[2]) - x0, Math.max(y + h, r[1] + r[3]) - y0]
      }
    }
    return [...placed.values()]
  }

  /** Areas of a page covered by images or vector drawings, found in its operator list. */
  #figureRegions(n: number) {
    let p = this.#regions.get(n)
    if (!p) {
      p = this.#findRegions(n)
      this.#regions.set(n, p)
    }
    return p
  }

  async #findRegions(n: number): Promise<Rect4[]> {
    const [page, pt] = await Promise.all([this.#doc.getPage(n), this.#page(n)])
    const { fnArray, argsArray } = await page.getOperatorList()
    const { OPS, Util } = pdfjsLib
    const W = pt.width
    const H = pt.height
    const boxes: { r: Rect4; image: boolean }[] = []
    let ctm = [1, 0, 0, 1, 0, 0]
    const stack: number[][] = []
    const add = ([x0, y0, x1, y1]: number[], image: boolean) => {
      const m = Util.transform(pt.viewport.transform, ctm)
      const xs: number[] = []
      const ys: number[] = []
      for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
        xs.push(m[0] * x + m[2] * y + m[4])
        ys.push(m[1] * x + m[3] * y + m[5])
      }
      const l = Math.max(0, Math.min(...xs) / W)
      const t = Math.max(0, Math.min(...ys) / H)
      const r = Math.min(1, Math.max(...xs) / W)
      const b = Math.min(1, Math.max(...ys) / H)
      if (r > l && b > t) boxes.push({ r: [l, t, r - l, b - t], image })
    }
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i]
      const args = argsArray[i]
      if (fn === OPS.save) stack.push(ctm)
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
      else if (fn === OPS.transform) ctm = Util.transform(ctm, args)
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm)
        if (args?.[0]) ctm = Util.transform(ctm, args[0])
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) add([0, 0, 1, 1], true)
      else if (fn === OPS.constructPath && args?.[0] !== OPS.endPath && args?.[2]) add(Array.from(args[2] as ArrayLike<number>), false)
    }
    page.cleanup()
    if (!pt.runs.length) return boxes.length ? [[0, 0, 1, 1]] : []

    // cluster on a coarse grid; full-page backgrounds and thin rules don't count
    const GX = 60
    const GY = 80
    const cells = new Int32Array(GX * GY).fill(-1)
    const kept = boxes.filter(({ r: [, , w, h], image }) => w * h < 0.6 && (image || (w > 0.004 && h > 0.004)))
    kept.forEach(({ r: [x, y, w, h] }, i) => {
      for (let gy = Math.max(0, Math.floor(y * GY) - 1); gy <= Math.min(GY - 1, Math.floor((y + h) * GY) + 1); gy++)
        for (let gx = Math.max(0, Math.floor(x * GX) - 1); gx <= Math.min(GX - 1, Math.floor((x + w) * GX) + 1); gx++)
          cells[gy * GX + gx] = i
    })
    const component = new Int32Array(GX * GY).fill(-1)
    const groups: { box: Rect4 | null; images: number; paths: number }[] = []
    for (let c = 0; c < cells.length; c++) {
      if (cells[c] < 0 || component[c] >= 0) continue
      const id = groups.length
      groups.push({ box: null, images: 0, paths: 0 })
      const queue = [c]
      component[c] = id
      while (queue.length) {
        const cur = queue.pop()!
        const cx = cur % GX
        const cy = (cur - cx) / GX
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx
          const ny = cy + dy
          const nc = ny * GX + nx
          if (nx < 0 || ny < 0 || nx >= GX || ny >= GY || cells[nc] < 0 || component[nc] >= 0) continue
          component[nc] = id
          queue.push(nc)
        }
      }
    }
    kept.forEach(({ r, image }) => {
      const g = groups[component[Math.min(GY - 1, Math.floor(r[1] * GY)) * GX + Math.min(GX - 1, Math.floor(r[0] * GX))]]
      if (!g) return
      if (image) g.images++
      else g.paths++
      if (!g.box) g.box = [...r]
      else {
        const [x, y, w, h] = g.box
        const x0 = Math.min(x, r[0])
        const y0 = Math.min(y, r[1])
        g.box = [x0, y0, Math.max(x + w, r[0] + r[2]) - x0, Math.max(y + h, r[1] + r[3]) - y0]
      }
    })
    return groups.flatMap(({ box, images, paths }) => {
      if (!box || (!images && paths < 3) || box[2] < 0.06 || box[3] < 0.03) return []
      if (box[1] + box[3] < 0.07 || box[1] > 0.93) return []
      // boxes full of text are shaded paragraphs or tables, not figures
      let chars = 0
      let area = 0
      for (const run of pt.runs) {
        const cx = (run.x0 + run.x1) / 2 / W
        const cy = (run.top + run.bottom) / 2 / H
        if (cx < box[0] || cx > box[0] + box[2] || cy < box[1] || cy > box[1] + box[3]) continue
        chars += run.text.length
        area += (run.x1 - run.x0) * run.size / (W * H)
      }
      if (chars > 300 || area > 0.3 * box[2] * box[3]) return []
      // take in labels just outside the drawing, such as axis ticks: short lines beside
      // it, or above / below it in a smaller size than the text
      let [x0, y0, x1, y1] = [box[0], box[1], box[0] + box[2], box[1] + box[3]]
      for (const l of pt.lines) {
        // a label, or a row of them (all short runs)
        if (l.text.length > 12 && !l.runs.every(k => pt.runs[k].text.trim().length <= 5)) continue
        const lx0 = l.x0 / W
        const lx1 = l.x1 / W
        const ly0 = l.top / H
        const ly1 = l.bottom / H
        const beside = ly1 > y0 && ly0 < y1 && ((lx1 <= x0 + 0.01 && lx1 > x0 - 0.06) || (lx0 >= x1 - 0.01 && lx0 < x1 + 0.06))
        const near = lx1 > x0 && lx0 < x1 && ly1 > y0 - 0.025 && ly0 < y1 + 0.025 && l.size < 0.95 * this.#bodySize
        if (!beside && !near) continue
        x0 = Math.min(x0, lx0)
        x1 = Math.max(x1, lx1)
        y0 = Math.min(y0, ly0)
        y1 = Math.max(y1, ly1)
      }
      const pad = 0.006
      return [[Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(1, x1 - x0 + 2 * pad), Math.min(1, y1 - y0 + 2 * pad)] as Rect4]
    })
  }

  /** Renders part of a page to an image URL. */
  #crop(n: number, box: Rect4) {
    const key = `${n}:${box.map(v => v.toFixed(3)).join(',')}`
    let p = this.#crops.get(key)
    if (!p) {
      p = (async () => {
        const page = await this.#doc.getPage(n)
        const base = page.getViewport({ scale: 1 })
        const scale = Math.max(1, Math.min(4, 1400 / (box[2] * base.width), Math.sqrt(16e6 / (base.width * base.height))))
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const ctx = canvas.getContext('2d')
        if (!ctx) return null
        await page.render({ canvas, canvasContext: ctx, viewport, background: '#fff' }).promise
        const out = document.createElement('canvas')
        out.width = Math.max(1, Math.round(box[2] * canvas.width))
        out.height = Math.max(1, Math.round(box[3] * canvas.height))
        out.getContext('2d')!.drawImage(canvas, Math.round(box[0] * canvas.width), Math.round(box[1] * canvas.height), out.width, out.height, 0, 0, out.width, out.height)
        canvas.width = canvas.height = 0
        const blob = await new Promise<Blob | null>(res => out.toBlob(res, 'image/webp', 0.9))
        out.width = out.height = 0
        if (!blob || this.#destroyed) return null
        const url = URL.createObjectURL(blob)
        this.#blobUrls.push(url)
        return url
      })().catch(() => null)
      this.#crops.set(key, p)
    }
    return p
  }
}
