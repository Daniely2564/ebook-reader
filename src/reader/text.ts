export interface Rect { left: number; top: number; right: number; bottom: number }

/** Maps a rect from inside a (same-origin) iframe to the top window's viewport. */
export const rectOf = (r: DOMRect | Rect, doc: Document): Rect => {
  const frame = doc.defaultView?.frameElement?.getBoundingClientRect()
  const dx = frame?.left ?? 0
  const dy = frame?.top ?? 0
  return { left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy }
}

const segmenters = new Map<string, Intl.Segmenter>()
const sentenceSegmenter = (lang?: string) => {
  const key = lang || 'en'
  let s = segmenters.get(key)
  if (!s) {
    try {
      s = new Intl.Segmenter(key, { granularity: 'sentence' })
    } catch {
      s = new Intl.Segmenter('en', { granularity: 'sentence' })
    }
    segmenters.set(key, s)
  }
  return s
}

/** ICU treats line feeds as hard sentence breaks; source files wrap lines arbitrarily.
 * Replaced one-for-one so offsets into DOM text stay valid. */
const flattenBreaks = (s: string) => s.replace(/[\n\r\t\f\v\u2028\u2029]/g, ' ')

const BLOCK = 'p, li, blockquote, dd, dt, td, th, h1, h2, h3, h4, h5, h6, figcaption, pre, div, section, body'

/** The sentence around a selection — saved with vocabulary words. */
export const contextSentence = (range: Range) => {
  try {
    const startEl = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement
    const block = startEl?.closest(BLOCK)
    if (!block) return range.toString()
    const pre = block.ownerDocument.createRange()
    pre.setStart(block, 0)
    pre.setEnd(range.startContainer, range.startOffset)
    const offset = pre.toString().length
    const text = flattenBreaks(block.textContent ?? '')
    const lang = (block.closest('[lang]') as HTMLElement | null)?.lang
    for (const { segment, index } of sentenceSegmenter(lang).segment(text)) {
      if (offset >= index && offset < index + segment.length) return segment.replace(/\s+/g, ' ').trim().slice(0, 500)
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 500)
  } catch {
    return range.toString()
  }
}

/** Splits a document into sentence ranges, starting at `start` (a collapsed range) if given. */
export const splitSentences = (doc: Document, blockSelector: string, start: Range | null) => {
  const out: { text: string; range: Range }[] = []
  const lang = doc.documentElement.lang
  const seg = sentenceSegmenter(lang)
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  let group: Text[] = []
  let groupBlock: Element | null = null

  const flush = () => {
    const nodes = group
    group = []
    if (!nodes.length) return
    const el = nodes[0].parentElement as (Element & { checkVisibility?: (o?: object) => boolean }) | null
    if (el?.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return
    const cum = [0]
    for (const n of nodes) cum.push(cum[cum.length - 1] + (n.nodeValue?.length ?? 0))
    const text = flattenBreaks(nodes.map(n => n.nodeValue ?? '').join(''))
    const locate = (pos: number, isEnd: boolean): [Text, number] => {
      let i = 0
      while (i < nodes.length - 1 && (isEnd ? cum[i + 1] < pos : cum[i + 1] <= pos)) i++
      return [nodes[i], pos - cum[i]]
    }
    for (const { segment, index } of seg.segment(text)) {
      const trimmed = segment.trim()
      if (!trimmed || !/[\p{L}\p{N}]/u.test(trimmed)) continue
      const s = index + (segment.length - segment.trimStart().length)
      const e = index + segment.trimEnd().length
      const [sn, so] = locate(s, false)
      const [en, eo] = locate(e, true)
      try {
        if (start && start.comparePoint(en, eo) <= 0) continue
        const range = doc.createRange()
        range.setStart(sn, so)
        range.setEnd(en, eo)
        out.push({ text: trimmed.replace(/\s+/g, ' '), range })
      } catch { /* detached */ }
    }
  }

  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const parent = node.parentElement
    if (!parent || !node.nodeValue?.trim() && !group.length) continue
    if (parent.closest('script, style, rt, rp, noscript')) continue
    const block = parent.closest(blockSelector)
    if (block !== groupBlock) {
      flush()
      groupBlock = block
    }
    group.push(node)
  }
  flush()
  return out
}
