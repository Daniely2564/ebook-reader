// "Flowing text" for PDFs: pages are rebuilt as reflowable HTML sections that
// foliate-js paginates like an EPUB, so the text follows the reader's font, size
// and theme. Every text run keeps its position on the original page, which lets
// highlights and the reading position move between this view and the page view.
//
// The markup of a section depends only on the text and fonts of its pages (and of
// the pages either side of it, where a paragraph runs across a section boundary),
// so documents built for search and the one shown on screen always agree on CFIs.
// Figures are found afterwards and added to the live document as CSS decorations.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { FoliateBook, FoliateTocItem } from '../vendor/foliate-js/view.js'
import { pdfjsLib, resolveOutline, type PdfOutlineNode } from '../lib/pdfjs'
import type { Settings } from '../lib/settings'
import type { ReaderTheme } from '../lib/themes'
import { locatorParts, makePdfLocator, parsePdfLocator, type PdfLocator, type Rect4 } from './pdf-locator'

/** Part of every stored flowing-text CFI; bump it when the generated markup changes. */
export const FLOW_VERSION = 'f2'

export class FlowUnavailableError extends Error {
  name = 'FlowUnavailableError'
}

type Viewport = ReturnType<PDFPageProxy['getViewport']>

/** One text item, in page units (top-down, scale 1). */
interface Run {
  text: string
  x0: number
  x1: number
  top: number
  bottom: number
  size: number
  /** baseline */
  y: number
  /** pdf.js font id */
  font: string
  /** the font family the page view's text layer lays this run out in */
  family: string
}

interface Line {
  /** indices into PageText.runs, with the separator to put before each */
  runs: number[]
  seps: string[]
  x0: number
  x1: number
  top: number
  bottom: number
  base: number
  /** baseline of the line's main run */
  y: number
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
  kind: 'p' | 'h1' | 'h2' | 'h3' | 'h4'
  small: boolean
  center: boolean
  /** starts with a bullet or a number */
  list: boolean
  /** the last line runs to the right edge of its column */
  endsFull: boolean
}

/** Bold and italic flags of a page's fonts, by pdf.js font id. */
type FontStyles = Map<string, number>

/** What a page is measured against when it is split into blocks. */
interface Layout {
  bodySize: number
  /** usual width of a line of body text */
  measure: number
  styles?: FontStyles
}

const MAX_SECTION_PAGES = 12
const SAMPLE_PAGES = 16
const CHARS_PER_MINUTE = 1100
const BOLD = 1
const ITALIC = 2

const TERMINAL = /[.!?…:;"”’)\]]$/
/** a list marker; capital letters only with a bracket, as "E. Lindqvist" is a name */
const LIST_MARK = String.raw`(?:[•●○■□▪▫◦‣∙·*–—➢❖✓-]|\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[A-Z]\)|\([ivxIVX]{1,4}\))`
const BULLET = new RegExp(`^${LIST_MARK}\\s`)
/** a list marker standing alone in its own run */
const MARKER = new RegExp(`^${LIST_MARK}$`)
/** what a footnote starts with */
const NOTE_MARK = /^(?:[*†‡§¶‖]|\(?\d{1,3}\)?[.)]?(?=\s|\p{Lu}|$)|\p{No})/u
const PAGE_NUMBER = /^[\s\-–—([]*(?:page\s+|p\.\s*)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:of|\/)\s*\d{1,4})?[\s\-–—)\].]*$/i
const CJK = /[　-鿿가-힯豈-﫿]/
const HREF = /^p(\d+)(?:([ty])(-?[\d.]+))?$/
const BOLD_FONT = /bold|black|heavy|semibold|demi|^cmbx?\d|^sfbx|[-,]bd|-medi(?!um)/i
const ITALIC_FONT = /italic|oblique|ital|kursiv|^(?:cm|sf)(?:ti|sl|mi)\d|-\w*it$/i
/** bullets that Symbol and Wingdings fonts leave in the Private Use Area */
const PUA_BULLETS: Record<string, string> = { '': '•', '': '▪', '': '➢', '': '❖', '': '✓', '': '■', '': '●' }

const HEADINGS = ['h1', 'h2', 'h3', 'h4']
const FLOW_CSS = `
h1, h2, h3, h4 {
  line-height: 1.25; text-align: start; text-indent: 0; break-after: avoid; break-inside: avoid;
  -webkit-hyphens: manual; hyphens: manual; text-wrap: balance;
}
h1 { font-size: 1.75em; margin: 1.1em 0 .85em; letter-spacing: -.01em; }
h2 { font-size: 1.42em; margin: 1.5em 0 .6em; }
h3 { font-size: 1.18em; margin: 1.45em 0 .5em; }
h4 { font-size: 1em; margin: 1.35em 0 .4em; }
${HEADINGS.flatMap(a => HEADINGS.map(b => `${a} + ${b}`)).join(', ')} { margin-top: .3em; }
p.s { font-size: .88em; }
p.n { font-size: .82em; }
p.li { padding-inline-start: 1.4em; text-indent: -1.4em; text-align: start; }
p.li > .m:first-child { display: inline-block; min-width: 1.15em; text-indent: 0; }
.b { font-weight: bold; }
.i { font-style: italic; }
.sup, .sub { font-size: .7em; line-height: 0; }
.sup { vertical-align: super; }
.sub { vertical-align: sub; }
.pg-c, .pg-blank.fig-b {
  display: flex; flex-direction: column; justify-content: center; break-before: column; break-after: column;
}
.fig-b::before, .fig-a::after {
  content: ''; display: block; max-width: 100%; max-height: 82vh;
  margin: .9em auto; break-inside: avoid; text-indent: 0;
}
.fig-b::before { width: var(--fig-b-w); aspect-ratio: var(--fig-b-ar); background: var(--fig-b) center / contain no-repeat; }
.fig-a::after { width: var(--fig-a-w); aspect-ratio: var(--fig-a-ar); background: var(--fig-a) center / contain no-repeat; }
.fig-x { display: none !important; }
`

/**
 * Reading styles that depend on the reader's settings and theme; the rest are in
 * each section's own style sheet. `indented`: the PDF marks paragraphs with an indent.
 */
export const flowCss = (s: Settings, theme: ReaderTheme, indented: boolean) => {
  const book = s.paragraphSpacing < 0
  // without space between paragraphs, an indent is what shows where one starts
  const indent = s.paragraphSpacing === 0 || (book && indented)
  return `
${book ? `p { margin: ${indented ? '0' : '.75em 0'}; }` : ''}
${indent ? 'p + p:not([align]):not(.li):not(.s):not(.n) { text-indent: 1.5em; }' : ''}
p.n { color: ${theme.muted}; }
p:not(.n) + p.n { margin-top: 1.2em !important; padding-top: .6em; background: linear-gradient(${theme.border}, ${theme.border}) no-repeat left top / 30% 1px; }
${s.fontWeight !== 400 ? `.b { font-weight: ${Math.min(900, s.fontWeight + 300)} !important; }` : ''}
${s.flow === 'paginated' ? '.pg-c, .pg-blank.fig-b { min-height: calc(100vh - 2px); }' : '.pg-c { padding: 2.5em 0; }'}
`
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : NaN)
const sameSize = (a: Line, b: Line) => Math.abs(a.size - b.size) <= 0.12 * Math.max(a.size, b.size)
const overlapX = (a: Line, b: Line) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.3 * Math.min(a.x1 - a.x0, b.x1 - b.x0)
const edgeKey = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/[^\p{L}#]+/gu, ' ').trim()
/** a title as running heads print it: no numbers, case or punctuation */
const titleKey = (s: string) => edgeKey(s).replace(/#/g, ' ').replace(/\s+/g, ' ').trim()

const fontStyle = (font: { name?: string; bold?: boolean; black?: boolean; italic?: boolean } | undefined) => {
  if (!font) return 0
  const name = (font.name ?? '').replace(/^[A-Z]{6}\+/, '')
  return (font.bold || font.black || BOLD_FONT.test(name) ? BOLD : 0) | (font.italic || ITALIC_FONT.test(name) ? ITALIC : 0)
}

/** Share of the characters of some lines set in a bold font. */
const boldShare = (pt: PageText, lines: Line[], styles: FontStyles | undefined) => {
  let n = 0
  let b = 0
  for (const l of lines) for (const k of l.runs) {
    const r = pt.runs[k]
    n += r.text.length
    if ((styles?.get(r.font) ?? 0) & BOLD) b += r.text.length
  }
  return n ? b / n : 0
}

let measurer: CanvasRenderingContext2D | null = null
/** Width of a text in a font family, at 100px. */
const measureText = (family: string, text: string) => {
  measurer ??= document.createElement('canvas').getContext('2d')
  if (!measurer) return text.length
  const font = `100px ${family}`
  if (measurer.font !== font) measurer.font = font
  return measurer.measureText(text).width
}

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
  const families = pdfjsLib.TextLayer.fontFamilyMap
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
    const family = style?.fontFamily || 'sans-serif'
    runs.push({
      text: item.str.replace(/\s+/g, ' '), x0: tx[4], x1: tx[4] + item.width, top, bottom: top + size, size, y: tx[5],
      font: item.fontName, family: families.get(family) || family,
    })
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
    line = { runs: [i], seps: [''], x0: r.x0, x1: r.x1, top: r.top, bottom: r.bottom, base: r.bottom, y: r.y, size: r.size, text: r.text }
    lines.push(line)
  }
  for (const l of lines) {
    // a bullet drawn from a symbol font
    const first = runs[l.runs[0]]
    const bullet = PUA_BULLETS[first.text.trim()]
    if (bullet && l.runs.length > 1) {
      l.text = l.text.replace(first.text, bullet)
      first.text = bullet
    }
    // size and baseline come from the longest run, so superscripts don't count
    let main = first
    for (const k of l.runs) if (runs[k].text.length > main.text.length) main = runs[k]
    l.size = main.size
    l.base = main.bottom
    l.y = main.y
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

/** Splits a page's lines into paragraphs and headings, counting how paragraphs are set apart into `stats`. */
const segmentPage = (pt: PageText, lines: Line[], layout: Layout, stats?: { indent: number; gap: number }): Block[] => {
  if (!lines.length) return []
  const { bodySize, styles } = layout
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
  const isBody = (l: Line) => Math.abs(l.size - bodySize) <= 0.12 * bodySize
  const body = lines.filter(isBody)
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
      const gap = dy > (pitch * 1.4 + 0.1) * line.size
      const indent = !BULLET.test(group.lines[0].text) && indented(i)
      brk = !sameSize(line, prev)
        // moved up: a new column, which continues the paragraph only mid-sentence
        || (dy < -0.5 * line.size ? !(full[i - 1] && !TERMINAL.test(prev.text)) : gap)
        || BULLET.test(line.text)
        || endedBefore(i)
        || indent
      if (stats && dy > 0 && isBody(line) && isBody(prev) && !BULLET.test(line.text)) {
        if (gap) stats.gap++
        else if (indent) stats.indent++
      }
    }
    if (brk) groups.push({ lines: [line], last: i })
    else {
      group.lines.push(line)
      group.last = i
    }
  }

  // on a page set mostly in bold, bold doesn't stand out
  const boldPage = !styles || boldShare(pt, lines, styles) > 0.6
  const center = (bodyL + bodyR) / 2
  // on a title page there is no body text to measure against
  const span = Math.max(bodyR - bodyL, Math.min(layout.measure, pt.width))
  return groups.map(({ lines: ls, last }) => {
    const ratio = ls[0].size / bodySize
    const count = ls.reduce((n, l) => n + l.text.length, 0)
    const list = BULLET.test(ls[0].text)
    const bold = !boldPage && ls.every(l => boldShare(pt, [l], styles) > 0.85)
    let kind: Block['kind'] = 'p'
    if (!list && count < 200 && ls.length <= 4) {
      if (ratio >= 1.18 || (bold && ratio >= 1.05)) kind = ratio >= 1.75 ? 'h1' : ratio >= 1.4 ? 'h2' : 'h3'
      // a bold line at the size of the text is a heading, unless it reads like a sentence
      else if (bold && ratio > 0.9 && ls.length <= 2 && count <= 120 && !/[.,;:]$/.test(ls[ls.length - 1].text)) kind = 'h4'
    }
    return {
      lines: ls,
      kind,
      small: ratio <= 0.86,
      // every line centered, and one short enough to show it (full justified lines are centered too)
      center: ls.every(l => {
        const mid = (l.x0 + l.x1) / 2
        return Math.abs(mid - center) < 0.025 * pt.width || Math.abs(mid - pt.width / 2) < 0.025 * pt.width
      }) && ls.some(l => l.x1 - l.x0 < 0.8 * span),
      list,
      endsFull: full[last],
    }
  })
}

/** Whether a block at the top of a page carries on the paragraph that ended the previous page. */
const continues = (prev: Block, last: Line, next: Block) =>
  prev.kind === 'p' && next.kind === 'p' && prev.small === next.small && sameSize(last, next.lines[0]) && !next.list
  && ((prev.endsFull && !TERMINAL.test(last.text)) || /^\p{Ll}/u.test(next.lines[0].text))

/** Index of the first footnote among the small blocks at the foot of a page, or the number of blocks. */
const footnotesFrom = (pt: PageText, blocks: Block[]) => {
  let i = blocks.length
  while (i > 0 && blocks[i - 1].small && blocks[i - 1].kind === 'p' && blocks[i - 1].lines[0].top > 0.5 * pt.height) i--
  while (i < blocks.length && !NOTE_MARK.test(blocks[i].lines[0].text)) i++
  // small print filling the whole page (an index, references) isn't notes
  return i < blocks.length && blocks.slice(0, i).some(b => !b.small) ? i : blocks.length
}

/** A paragraph being assembled; it may continue onto the next page. */
interface OpenBlock {
  block: Block
  parts: ({ k: string; text: string; cls: string } | string)[]
  attrs: string
  last: Line
}

const render = (b: OpenBlock) => {
  const tag = b.block.kind
  const inner = b.parts.map(p => (typeof p === 'string' ? p : `<span data-k="${p.k}"${p.cls ? ` class="${p.cls}"` : ''}>${esc(p.text)}</span>`)).join('')
  return `<${tag}${b.attrs}>${inner}</${tag}>`
}

/**
 * Appends a line's runs to a paragraph, joining words split by a hyphen at the line
 * end. Runs keep their emphasis and raised or lowered position.
 */
const appendLine = (b: OpenBlock, pt: PageText, line: Line, first: boolean, styles: FontStyles | undefined, bold: boolean, hidden: Set<number>) => {
  line.runs.forEach((k, j) => {
    const run = pt.runs[k]
    let text = run.text
    if (j === 0) text = text.trimStart()
    if (j === line.runs.length - 1) text = text.trimEnd()
    if (!text) return
    if (j === 0 && !first) {
      const prev = [...b.parts].reverse().find(p => typeof p !== 'string') as { text: string } | undefined
      if (prev && /[-­]$/.test(prev.text) && /^\p{Ll}/u.test(text)) prev.text = prev.text.slice(0, -1)
      else if (!(prev && CJK.test(prev.text.slice(-1)) && CJK.test(text[0]))) b.parts.push(' ')
    } else if (line.seps[j]) b.parts.push(line.seps[j])
    const style = styles?.get(run.font) ?? 0
    const small = run.size < 0.85 * line.size
    const cls = [
      bold && style & BOLD && 'b',
      style & ITALIC && 'i',
      small && line.y - run.y > 0.2 * line.size && 'sup',
      small && run.y - line.y > 0.1 * line.size && 'sub',
      first && j === 0 && b.block.list && MARKER.test(text) && 'm',
      hidden.has(k) && 'fig-x',
    ].filter(Boolean).join(' ')
    b.parts.push({ k: `${pt.page}.${k}`, text, cls })
  })
  b.last = line
}

/** A figure drawn before or after a block, by the block's pseudo-element. */
interface Figure { block: number; where: 'before' | 'after'; box: Rect4 }

/**
 * Class and attributes that draw figures next to an element. Their space is in the
 * markup, so the page doesn't move when the image arrives (`decorate()` fills it in).
 */
const figureAttrs = (pt: PageText, figs: Figure[]) => {
  if (!figs.length) return { cls: '', attrs: '' }
  const colWidth = Math.max(...pt.lines.map(l => l.x1 - l.x0), pt.width * 0.5)
  const vars = figs.map(({ where, box }) => {
    const s = where === 'before' ? 'b' : 'a'
    return `--fig-${s}-ar: ${(box[2] * pt.width).toFixed(1)} / ${(box[3] * pt.height).toFixed(1)}; --fig-${s}-w: ${Math.min(100, box[2] * pt.width / colWidth * 100).toFixed(1)}%`
  })
  return {
    cls: figs.map(f => (f.where === 'before' ? 'fig-b' : 'fig-a')).join(' '),
    attrs: ` style="${vars.join('; ')}" data-fig="${figs.map(f => `${f.where[0]}${pt.page}:${f.box.map(v => v.toFixed(4)).join(',')}`).join(' ')}"`,
  }
}

/**
 * Places a page's figures: the text inside one (axis labels, legends) is hidden, and
 * each is drawn before the nearest block below it, or after the last block.
 */
const placeFigures = (pt: PageText, blocks: Block[], regions: Rect4[]) => {
  const hidden = new Set<number>()
  const figures: Figure[] = []
  if (!regions.length) return { hidden, figures }
  const inside = (run: Run, [x, y, w, h]: Rect4) => {
    const cx = (run.x0 + run.x1) / 2 / pt.width
    const cy = (run.top + run.bottom) / 2 / pt.height
    return cx >= x - 0.004 && cx <= x + w + 0.004 && cy >= y - 0.004 && cy <= y + h + 0.004
  }
  const spots: { block: number; top: number; x0: number; x1: number }[] = []
  blocks.forEach((b, block) => {
    let spot: (typeof spots)[number] | null = null
    for (const l of b.lines) for (const k of l.runs) {
      const run = pt.runs[k]
      if (regions.some(r => inside(run, r))) {
        hidden.add(k)
        continue
      }
      const [top, x0, x1] = [run.top / pt.height, run.x0 / pt.width, run.x1 / pt.width]
      if (!spot) spots.push(spot = { block, top, x0, x1 })
      else Object.assign(spot, { top: Math.min(spot.top, top), x0: Math.min(spot.x0, x0), x1: Math.max(spot.x1, x1) })
    }
  })
  for (const r of regions) {
    const below = spots.filter(b => b.top >= r[1] + r[3] - 0.01)
    const hit = below.find(b => b.x1 > r[0] && b.x0 < r[0] + r[2]) ?? below[0]
    // with no text left on the page, the figure goes before its first block (or its marker)
    const block = (hit ?? spots[spots.length - 1])?.block ?? 0
    const where = hit || !spots.length ? 'before' : 'after'
    const prev = figures.find(f => f.block === block && f.where === where)
    if (!prev) figures.push({ block, where, box: [...r] })
    else {
      // figures that land in the same place become one image
      const [x, y, w, h] = prev.box
      const x0 = Math.min(x, r[0])
      const y0 = Math.min(y, r[1])
      prev.box = [x0, y0, Math.max(x + w, r[0] + r[2]) - x0, Math.max(y + h, r[1] + r[3]) - y0]
    }
  }
  return { hidden, figures }
}

/** A page without text still gets a marker, so every page stays addressable. */
const blankPage = (n: number, fig = { cls: '', attrs: '' }) => `<div class="pg-blank${fig.cls ? ` ${fig.cls}` : ''}" id="p${n}" data-p="${n}" data-t="0"${fig.attrs}></div>`

export class PdfFlow {
  book!: FoliateBook
  readonly pageCount: number
  /** first pages of chapters, from the outline */
  chapterStarts: number[] = []
  /** the PDF sets paragraphs apart with a first-line indent rather than space */
  indented = false

  #doc: PDFDocumentProxy
  #title: string
  #labels: string[] | null = null
  #avgChars = 1500
  #bodySize = 10
  #measure = 300
  #sampleEdges = new Map<string, Set<number>>()
  #samplePages = new Set<number>()
  #titleKeys = new Set<string>()
  /** top of the first chapter heading on each chapter's first page, in PDF user space */
  #chapterTops = new Map<number, number>()
  #sections: { start: number; end: number; title: string }[] = []
  #pages = new Map<number, Promise<PageText>>()
  /** pages whose text has been extracted, for synchronous lookups */
  #ready = new Map<number, PageText>()
  #ops = new Map<number, Promise<{ styles: FontStyles; regions: Rect4[] }>>()
  #carries = new Map<number, Promise<Set<Line>>>()
  /** bottom (0…1) of the lines at the top of a section's first page that went to the section before */
  #carryEnds = new Map<number, number>()
  #html = new Map<number, Promise<string>>()
  #docs = new Map<number, Promise<Document>>()
  #urls = new Map<number, string>()
  #edges = new Map<string, Float64Array>()
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
    const bodyLines = texts.flatMap(t => t.lines.filter(l => Math.abs(l.size - this.#bodySize) <= 0.12 * this.#bodySize))
    this.#measure = median(bodyLines.map(l => l.x1 - l.x0)) || 0.7 * (texts[0]?.width ?? 600)
    for (const t of texts) {
      this.#samplePages.add(t.page)
      for (const l of edgeLines(t)) this.#countEdge(this.#sampleEdges, l, t.page)
    }
    const titles: string[] = [this.#title]
    const walk = (nodes: PdfOutlineNode[]) => nodes.forEach(o => {
      titles.push(o.title)
      walk(o.items)
    })
    walk(outline)
    this.#titleKeys = new Set(titles.map(titleKey).filter(k => k.length >= 4))
    // does the PDF set paragraphs apart with an indent or with space?
    const stats = { indent: 0, gap: 0 }
    for (const t of texts) segmentPage(t, t.lines.filter(l => !this.#isRunningHead(l)), this.#layout(), stats)
    this.indented = stats.indent > stats.gap

    const top = outline.filter(o => o.page)
    let chapterNodes = top
    if (new Set(top.map(o => o.page)).size < 3) chapterNodes = [...top, ...top.flatMap(o => o.items.filter(c => c.page))]
    this.chapterStarts = [...new Set(chapterNodes.map(o => o.page!))].sort((a, b) => a - b)
    // a chapter starting lower on a page: what is above its heading ends the chapter before
    const unknown = new Set<number>()
    for (const o of chapterNodes) {
      if (o.top == null) unknown.add(o.page!)
      else this.#chapterTops.set(o.page!, Math.max(o.top, this.#chapterTops.get(o.page!) ?? -Infinity))
    }
    for (const p of unknown) this.#chapterTops.delete(p)
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

  #layout(styles?: FontStyles): Layout {
    return { bodySize: this.#bodySize, measure: this.#measure, styles }
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

  /** Font styles and figures of a page, from its drawing operators. */
  #pageOps(n: number) {
    let p = this.#ops.get(n)
    if (!p) {
      p = this.#readOps(n).catch(() => ({ styles: new Map(), regions: [] as Rect4[] }))
      this.#ops.set(n, p)
    }
    return p
  }

  async #styles(n: number) {
    return (await this.#pageOps(n)).styles
  }

  sectionOf(page: number) {
    const i = this.#sections.findIndex(s => page <= s.end)
    return i < 0 ? this.#sections.length - 1 : i
  }

  /** The section holding a position: the top of a section's first page may have gone to the section before. */
  #sectionAt(page: number, t: number) {
    const i = this.sectionOf(page)
    return i > 0 && this.#sections[i].start === page && t < (this.#carryEnds.get(page) ?? 0) ? i - 1 : i
  }

  #sectionOfHref(href: string) {
    const m = href.match(HREF)
    if (!m) return 0
    // a bare page (a bookmark, a chapter without a position) opens with the page's own section
    const place = m[2] ? this.placeOf(href) : null
    return place ? this.#sectionAt(place.page, place.t) : this.sectionOf(Number(m[1]))
  }

  /** Readies what is needed to place a position exactly, before going to it. */
  async prepare(href: string) {
    const place = this.placeOf(href)
    if (!place) return
    await this.#page(place.page)
    const i = this.sectionOf(place.page)
    if (i > 0 && this.#sections[i].start === place.page) await this.#carry(place.page)
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

  /** Running heads that can be told from the line alone and the sample of pages. */
  #isRunningHead(l: Line) {
    if (PAGE_NUMBER.test(l.text) && l.size <= this.#bodySize * 1.3) return true
    const inSample = this.#sampleEdges.get(edgeKey(l.text))?.size ?? 0
    if (inSample >= 3 && inSample >= 0.25 * this.#samplePages.size) return true
    // the book's or a chapter's title in small print
    return l.size <= this.#bodySize * 0.95 && this.#titleKeys.has(titleKey(l.text))
  }

  /**
   * Lines at the top of a section's first page that belong to the section before: the
   * rest of a paragraph running on from the previous page, and whatever is above the
   * heading of a chapter that starts lower on the page. Both sections ask this, so
   * it depends only on the two pages.
   */
  #carry(p: number) {
    let c = this.#carries.get(p)
    if (!c) {
      c = this.#findCarry(p)
      this.#carries.set(p, c)
    }
    return c
  }

  async #findCarry(p: number) {
    const [prev, cur, prevStyles, curStyles] = await Promise.all([this.#page(p - 1), this.#page(p), this.#styles(p - 1), this.#styles(p)])
    const edges = new Map<string, Set<number>>()
    for (const pt of [prev, cur]) for (const l of edgeLines(pt)) this.#countEdge(edges, l, pt.page)
    const content = (pt: PageText) => {
      const heads = new Set(edgeLines(pt).filter(l => this.#isRunningHead(l) || (edges.get(edgeKey(l.text))?.size ?? 0) > 1))
      return pt.lines.filter(l => !heads.has(l))
    }
    const lines = content(cur)
    const carry = new Set<Line>()
    const top = this.#chapterTops.get(p)
    if (top != null) {
      const y = cur.viewport.convertToViewportPoint(0, top)[1]
      for (const l of lines) if (l.bottom <= y + 1) carry.add(l)
    }
    const before = segmentPage(prev, content(prev), this.#layout(prevStyles))
    const last = before[footnotesFrom(prev, before) - 1]
    const [first] = segmentPage(cur, lines.filter(l => !carry.has(l)), this.#layout(curStyles))
    if (last && first && continues(last, last.lines[last.lines.length - 1], first)) for (const l of first.lines) carry.add(l)
    if (carry.size) this.#carryEnds.set(p, Math.max(...[...carry].map(l => l.bottom / cur.height)))
    return carry
  }

  async #build(index: number) {
    const { start, end, title } = this.#sections[index]
    const next = index + 1 < this.#sections.length ? end + 1 : 0
    const [pages, pageOps, carryIn, carryOut, nextPage, nextStyles] = await Promise.all([
      Promise.all(Array.from({ length: end - start + 1 }, (_, i) => this.#page(start + i))),
      Promise.all(Array.from({ length: end - start + 1 }, (_, i) => this.#pageOps(start + i))),
      index > 0 ? this.#carry(start) : null,
      next ? this.#carry(next) : null,
      next ? this.#page(next) : null,
      next ? this.#styles(next) : null,
    ])
    // running heads repeat across the sample or across this section; nothing else is
    // considered, so the markup of a section never depends on what was built before
    const local = new Map<string, Set<number>>()
    for (const pt of pages) for (const l of edgeLines(pt)) this.#countEdge(local, l, pt.page)
    const isRunningHead = (l: Line) => {
      const inSection = local.get(edgeKey(l.text))?.size ?? 0
      return (inSection >= 2 && inSection >= 0.4 * pages.length) || this.#isRunningHead(l)
    }
    const parts = pages.map((pt, i) => {
      const heads = new Set(edgeLines(pt).filter(isRunningHead))
      const lines = pt.lines.filter(l => !heads.has(l) && !(i === 0 && carryIn?.has(l)))
      return { pt, styles: pageOps[i].styles, regions: pageOps[i].regions, lines, carried: false }
    })
    // the start of the next section's first page that finishes this one
    if (nextPage && carryOut?.size) parts.push({ pt: nextPage, styles: nextStyles!, regions: [], lines: nextPage.lines.filter(l => carryOut.has(l)), carried: true })

    const out: string[] = []
    let open: OpenBlock | null = null
    // footnotes wait for the paragraph that runs on past them to end
    let notes: string[] = []
    const close = () => {
      if (open) out.push(render(open))
      open = null
      out.push(...notes)
      notes = []
    }
    for (const { pt, styles, regions, lines, carried } of parts) {
      const blocks = segmentPage(pt, lines, this.#layout(styles))
      const { hidden, figures } = placeFigures(pt, blocks, regions)
      const figs = (i: number) => figureAttrs(pt, figures.filter(f => f.block === i))
      if (!blocks.length) {
        if (!carried) {
          close()
          out.push(blankPage(pt.page, figs(0)))
        }
        continue
      }
      const cur = open as OpenBlock | null
      const goesOn = !!cur && continues(cur.block, cur.last, blocks[0])
      // a page with a few lines to show off (a title page, a part title) gets a page to itself, centered
      const display = !carried && !goesOn && this.#isDisplayPage(blocks)
      if (display) {
        close()
        out.push('<div class="pg-c">')
      }
      const notesFrom = footnotesFrom(pt, blocks)
      // bold is kept where it stands out from the text around it
      const bold = boldShare(pt, lines, styles) <= 0.6
      blocks.forEach((block, i) => {
        const t = (block.lines[0].top / pt.height).toFixed(4)
        const cur = open as OpenBlock | null
        const fig = figs(i)
        if (cur && i === 0 && goesOn) {
          // a paragraph running on from the previous page: this page's figures go at its marker
          cur.parts.push(`<span class="pg${fig.cls ? ` ${fig.cls}` : ''}" id="p${pt.page}" data-p="${pt.page}" data-t="${t}"${fig.attrs}></span>`)
          block.lines.forEach(l => appendLine(cur, pt, l, false, styles, bold, hidden))
          cur.block = { ...cur.block, endsFull: block.endsFull }
          return
        }
        const note = i >= notesFrom
        const cls = [block.small && block.kind === 'p' && 's', note && 'n', block.list && !note && 'li', fig.cls].filter(Boolean).join(' ')
        const id = i === 0 ? ` id="p${pt.page}"` : ''
        const b: OpenBlock = { block, parts: [], attrs: `${id} data-p="${pt.page}" data-t="${t}"${cls ? ` class="${cls}"` : ''}${block.center ? ' align="center"' : ''}${fig.attrs}`, last: block.lines[0] }
        block.lines.forEach((l, j) => appendLine(b, pt, l, j === 0, styles, bold && block.kind === 'p', hidden))
        if (note && cur && cur.block.kind === 'p' && !cur.block.small) notes.push(render(b))
        else {
          close()
          open = b
        }
      })
      if (display) {
        close()
        out.push('</div>')
      }
    }
    close()
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${FLOW_CSS}</style></head><body>\n${out.join('\n')}\n</body></html>`
  }

  /** A page of a few lines, mostly centered, headings or small print: a title page, a part title, a copyright page. */
  #isDisplayPage(blocks: Block[]) {
    let chars = 0
    let shown = 0
    for (const b of blocks) {
      const n = b.lines.reduce((m, l) => m + l.text.length, 0)
      chars += n
      if (b.center || b.small || b.kind !== 'p') shown += n
    }
    return blocks.length <= 8 && chars < Math.min(600, 0.35 * this.#avgChars) && shown >= 0.6 * chars
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

  /**
   * The element at a position on a page: the run of text on the line at or below it,
   * so the screen shown starts where the reader was, not at the top of the paragraph
   * (or else the paragraph or page marker at or above it).
   */
  anchor(doc: Document, href: string): HTMLElement | null {
    const place = this.placeOf(href)
    if (!place) return null
    const pt = this.#ready.get(place.page)
    if (pt) for (const span of doc.querySelectorAll<HTMLElement>(`[data-k^="${place.page}."]`)) {
      const run = pt.runs[Number(span.dataset.k!.split('.')[1])]
      if (run && run.bottom / pt.height > place.t + 0.002 && !span.classList.contains('fig-x')) return span
    }
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

  /**
   * Where each character of a run starts and ends on the page, laid out the way the
   * page view's text layer lays it out (the run's width shared out in proportion to
   * the glyphs of its stand-in font), so a highlight lands on the same letters in
   * both views.
   */
  #runEdges(page: number, k: number) {
    const key = `${page}.${k}`
    let edges = this.#edges.get(key)
    if (!edges) {
      const run = this.#ready.get(page)!.runs[k]
      const { text } = run
      const total = measureText(run.family, text)
      edges = new Float64Array(text.length + 1)
      for (let i = 0; i <= text.length; i++)
        edges[i] = run.x0 + (run.x1 - run.x0) * (total > 0 ? measureText(run.family, text.slice(0, i)) / total : i / text.length)
      this.#edges.set(key, edges)
    }
    return edges
  }

  /** The run behind a span, and where the span's text starts in it (a line's first run loses its leading space). */
  #spanRun(span: HTMLElement) {
    const [page, k] = span.dataset.k!.split('.').map(Number)
    const pt = this.#ready.get(page)
    const run = pt?.runs[k]
    const text = span.firstChild
    if (!pt || !run || !text || text.nodeType !== Node.TEXT_NODE) return null
    const lead = /^\s/.test((text as Text).data) ? 0 : run.text.length - run.text.trimStart().length
    return { page, k, pt, run, text: text as Text, lead }
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
      const sr = this.#spanRun(span)
      if (!sr) continue
      const { page, k, pt, run, text, lead } = sr
      const a = range.startContainer === text ? range.startOffset : 0
      const b = range.endContainer === text ? range.endOffset : text.length
      if (b <= a) continue
      const edges = this.#runEdges(page, k)
      const x0 = edges[Math.min(run.text.length, a + lead)]
      const x1 = edges[Math.min(run.text.length, b + lead)]
      const list = byPage.get(page) ?? []
      list.push([x0 / pt.width, run.top / pt.height, (x1 - x0) / pt.width, run.size / pt.height])
      byPage.set(page, list)
    }
    return makePdfLocator(byPage)
  }

  /** The text a page locator covers, as a range in a section document. */
  rangeFor(doc: Document, loc: PdfLocator): Range | null {
    let start: [Text, number] | null = null
    let end: [Text, number] | null = null
    for (const { p, r } of locatorParts(loc)) {
      const pt = this.#ready.get(p)
      if (!pt) continue
      for (const span of doc.querySelectorAll<HTMLElement>(`[data-k^="${p}."]`)) {
        const sr = this.#spanRun(span)
        if (!sr) continue
        const { k, run, text, lead } = sr
        const cy = (run.top + run.bottom) / 2
        for (const [x, y, w, h] of r) {
          const rx0 = x * pt.width
          const rx1 = (x + w) * pt.width
          if (cy < y * pt.height || cy > (y + h) * pt.height || run.x1 <= rx0 || run.x0 >= rx1) continue
          // the characters whose middle is inside the rectangle
          const edges = this.#runEdges(p, k)
          let a = -1
          let b = -1
          for (let i = lead; i < Math.min(run.text.length, lead + text.length); i++) {
            const mid = (edges[i] + edges[i + 1]) / 2
            if (mid < rx0 || mid > rx1) continue
            if (a < 0) a = i - lead
            b = i + 1 - lead
          }
          if (a < 0) continue
          start ??= [text, a]
          end = [text, b]
          break
        }
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
    await this.#page(loc.p)
    const index = this.sectionOf(loc.p)
    // text at the top of a section's first page may be in the section before
    const tries = index > 0 && this.#sections[index].start === loc.p ? [index, index - 1] : [index]
    for (const i of tries) {
      const range = this.rangeFor(await this.document(i), loc)
      if (range) return getCFI(i, range)
    }
    return null
  }

  // ---------------------------------------------------------------- figures
  /**
   * Draws the images and drawings of a section's pages into the spaces its markup
   * keeps for them (see `figureAttrs()`).
   */
  async decorate(doc: Document) {
    for (const el of doc.querySelectorAll<HTMLElement>('[data-fig]')) {
      for (const fig of el.dataset.fig!.split(' ')) {
        if (this.#destroyed || !doc.defaultView) return
        const m = fig.match(/^([ba])(\d+):(.+)$/)
        if (!m) continue
        const url = await this.#crop(Number(m[2]), m[3].split(',').map(Number) as Rect4)
        if (url) el.style.setProperty(`--fig-${m[1]}`, `url("${url}")`)
      }
    }
  }

  /** Reads a page's drawing operators: the styles of its fonts and the areas covered by images or vector drawings. */
  async #readOps(n: number): Promise<{ styles: FontStyles; regions: Rect4[] }> {
    const [page, pt] = await Promise.all([this.#doc.getPage(n), this.#page(n)])
    const { fnArray, argsArray } = await page.getOperatorList()
    // fonts reach the page's shared objects along with its operators
    const styles: FontStyles = new Map()
    for (const id of new Set(pt.runs.map(r => r.font)))
      if (page.commonObjs.has(id)) styles.set(id, fontStyle(page.commonObjs.get(id)))
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
    if (!pt.runs.length) return { styles, regions: boxes.length ? [[0, 0, 1, 1]] : [] }

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
    const regions = groups.flatMap(({ box, images, paths }) => {
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
    return { styles, regions }
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
