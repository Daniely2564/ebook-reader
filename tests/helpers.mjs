// Shared by the end-to-end tests: a small two-chapter EPUB, and looking up a word in the reader.
import assert from 'node:assert/strict'
import { strToU8, zipSync } from 'fflate'

const para = i => `<p>Paragraph ${i}. The travellers were running along the riverbank while the ` +
  'lanterns flickered over the water, and every reader wondered what would happen next in the story. '.repeat(3) + '</p>'
const chapter = (n, body) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>Chapter ${n}</title></head>
<body><h1>Chapter ${n}</h1>${body}</body></html>`

export const makeEpub = () => zipSync({
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
  'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">lumen-smoke</dc:identifier>
<dc:title>Smoke Test Book</dc:title><dc:creator>Lumen QA</dc:creator><dc:language>en</dc:language>
<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
  'OEBPS/nav.xhtml': strToU8(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter 1</a></li><li><a href="c2.xhtml">Chapter 2</a></li></ol></nav></body></html>`),
  'OEBPS/c1.xhtml': strToU8(chapter(1, Array.from({ length: 30 }, (_, i) => para(i + 1)).join(''))),
  'OEBPS/c2.xhtml': strToU8(chapter(2, Array.from({ length: 30 }, (_, i) => para(i + 31)).join(''))),
})

/** Double-clicks a word on the visible page (inside the book's iframe) and waits for the dictionary. */
export const lookUpWord = async (page, word) => {
  let pos = null
  for (const frame of page.frames()) {
    if (!frame.url().startsWith('blob:')) continue
    const fb = await (await frame.frameElement()).boundingBox()
    const r = await frame.evaluate(({ word, fx, vw }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const n = walker.currentNode
        for (const m of n.nodeValue.matchAll(new RegExp(`\\b${word}\\b`, 'g'))) {
          const range = document.createRange()
          range.setStart(n, m.index)
          range.setEnd(n, m.index + m[0].length)
          const b = range.getBoundingClientRect()
          if (b.width && fx + b.x > 0 && fx + b.right < vw) return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
        }
      }
      return null
    }, { word, fx: fb.x, vw: 1280 })
    if (r) pos = { x: fb.x + r.x, y: fb.y + r.y }
  }
  assert.ok(pos, `found the word "${word}" on screen`)
  await page.mouse.dblclick(pos.x, pos.y)
  await page.waitForSelector('.dict-pop .dict-word h2', { timeout: 10_000 })
  await page.waitForFunction(() => document.querySelector('.dict-pop .dict-entry, .dict-pop .dict-none') && !document.querySelector('.dict-pop .dict-loading'), null, { timeout: 10_000 })
}
