// Whitelist-based HTML sanitizer for dictionary content (StarDict, Wiktionary).
// Links are rewritten to `data-lookup` so the popup can follow them in place.

const ALLOWED = new Set([
  'a', 'abbr', 'b', 'big', 'blockquote', 'br', 'cite', 'code', 'dd', 'del', 'dfn', 'div', 'dl', 'dt',
  'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'ins', 'kbd', 'li', 'mark', 'ol', 'p',
  'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var',
])
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'img', 'video', 'audio', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'noscript', 'template'])

// XDXF (StarDict 'x' type) → HTML
const XDXF: Record<string, [string, string?]> = {
  k: ['strong', 'dict-head'], tr: ['span', 'dict-ipa'], ex: ['span', 'dict-ex'], abr: ['abbr'],
  dtrn: ['span'], co: ['span', 'dict-comment'], c: ['span'], pos: ['em', 'dict-pos'],
  blockquote: ['div', 'dict-block'], def: ['div', 'dict-block'], gr: ['em', 'dict-pos'],
}

const sanitizeNode = (node: Node, out: Document): Node | null => {
  if (node.nodeType === Node.TEXT_NODE) return out.createTextNode(node.textContent ?? '')
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const el = node as Element
  let tag = el.localName.toLowerCase()
  if (DROP.has(tag)) return null

  let cls: string | undefined
  if (XDXF[tag]) [tag, cls] = XDXF[tag]
  else if (tag === 'kref' || tag === 'iref') tag = 'a'

  const frag = out.createDocumentFragment()
  const children = () => {
    for (const child of Array.from(el.childNodes)) {
      const c = sanitizeNode(child, out)
      if (c) frag.append(c)
    }
  }
  if (!ALLOWED.has(tag)) {
    children()
    return frag
  }
  const clean = out.createElement(tag === 'font' ? 'span' : tag)
  if (cls) clean.className = cls
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? ''
    const word = href.startsWith('bword://') ? decodeURIComponent(href.slice(8))
      : /^\/?wiki\//.test(href) ? decodeURIComponent(href.replace(/^\/?wiki\//, '').split('#')[0]).replace(/_/g, ' ')
      : el.localName === 'kref' ? el.textContent ?? ''
      : ''
    if (word && !word.includes(':')) clean.setAttribute('data-lookup', word)
    else if (/^https?:\/\//.test(href)) {
      clean.setAttribute('href', href)
      clean.setAttribute('target', '_blank')
      clean.setAttribute('rel', 'noopener')
    }
  }
  const color = el.getAttribute('color') || el.getAttribute('c')
  if (color && /^#?[\w]+$/.test(color)) (clean as HTMLElement).style.color = color
  for (const child of Array.from(el.childNodes)) {
    const c = sanitizeNode(child, out)
    if (c) clean.append(c)
  }
  return clean
}

export const sanitizeHtml = (html: string) => {
  const src = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const out = document.implementation.createHTMLDocument('')
  const container = out.createElement('div')
  for (const child of Array.from(src.body.childNodes)) {
    const c = sanitizeNode(child, out)
    if (c) container.append(c)
  }
  return container.innerHTML
}

export const textToHtml = (text: string) => {
  const div = document.createElement('div')
  div.textContent = text.trim()
  return div.innerHTML.replace(/\n/g, '<br>')
}

export const stripHtml = (html: string) =>
  new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() ?? ''
