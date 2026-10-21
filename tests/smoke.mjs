#!/usr/bin/env node
// End-to-end smoke test: builds a tiny EPUB, imports it into the production
// build (served by `vite preview`), turns pages, looks up an inflected word
// in the offline dictionary, checks that the dictionary picked stays picked,
// and that reading progress is saved.
//
//   npm run test:e2e            (set CHROMIUM_PATH to use a specific Chromium)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

const para = i => `<p>Paragraph ${i}. The travellers were running along the riverbank while the ` +
  'lanterns flickered over the water, and every reader wondered what would happen next in the story. '.repeat(3) + '</p>'
const chapter = (n, body) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>Chapter ${n}</title></head>
<body><h1>Chapter ${n}</h1>${body}</body></html>`

const epub = zipSync({
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-smoke-'))
const bookPath = path.join(dir, 'smoke-test.epub')
fs.writeFileSync(bookPath, epub)

const server = await preview({ preview: { port: 0, strictPort: false }, logLevel: 'error' })
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))
const step = name => console.log(`✓ ${name}`)
const label = () => page.evaluate(() => document.querySelector('.info-left')?.textContent ?? '')
const activeTab = () => page.locator('.dict-pop .dict-tabs [aria-selected=true]').innerText()

/** Double-clicks a word on the visible page (inside the book's iframe) and waits for the dictionary. */
const lookUp = async word => {
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

try {
  await page.goto(url)
  await page.setInputFiles('input[type=file][multiple]', bookPath)
  await page.waitForSelector('.book', { timeout: 30_000 })
  assert.equal(await page.locator('.book-title').innerText(), 'Smoke Test Book')
  step('imports an EPUB with its metadata')

  await page.locator('.book').click()
  await page.waitForSelector('foliate-view')
  await page.waitForFunction(() => /Page \d+/.test(document.querySelector('.info-left')?.textContent ?? ''), null, { timeout: 20_000 })
  await page.waitForTimeout(1500) // let the opening page animation settle
  const first = await label()
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(prev => document.querySelector('.info-left')?.textContent !== prev, first, { timeout: 10_000 })
  step(`turns pages (${first} → ${await label()})`)

  // double-click "running" inside the book iframe → offline dictionary shows "run"
  await lookUp('running')
  await page.waitForSelector('.dict-pop .dict-entry', { timeout: 10_000 })
  const form = await page.locator('.dict-pop .dict-form').first().innerText()
  assert.match(form, /running\s*→\s*run/)
  step('looks up an inflected word offline (running → run)')

  // the dictionary picked stays picked, even for a word it doesn't have
  await page.locator('.dict-pop .dict-tabs button', { hasText: 'WordNet' }).click()
  assert.equal(await activeTab(), 'WordNet')
  await page.keyboard.press('Escape')
  await lookUp('lanterns')
  assert.equal(await activeTab(), 'WordNet')
  assert.match(await page.locator('.dict-pop .dict-body').innerText(), /lantern/i)
  await page.keyboard.press('Escape')
  await lookUp('the')
  assert.equal(await activeTab(), 'WordNet')
  assert.match(await page.locator('.dict-pop .dict-none').innerText(), /No entry for the in WordNet[\s\S]*From Wiktionary/i)
  step('keeps the dictionary picked, showing another one\'s entry when it has none')

  await page.locator('.dict-pop .dict-tabs button', { hasText: "Webster's 1913" }).click()
  await page.keyboard.press('Escape')
  await lookUp('wondered')
  assert.equal(await activeTab(), "Webster's 1913")
  assert.match(await page.locator('.dict-pop .dict-body').innerText(), /wonder/i)
  step("looks up in Webster's 1913 (wondered → wonder)")

  await page.keyboard.press('Escape')
  const saved = await label()
  await page.evaluate(() => document.querySelector('[aria-label="Back to library"]').click())
  await page.waitForSelector('.continue')
  await page.locator('.book').click()
  // the first relocation after opening can be reported before the layout settles
  await page.waitForFunction(s => document.querySelector('.info-left')?.textContent?.includes(s), saved, { timeout: 20_000 }).catch(() => {})
  assert.equal(await label(), saved)
  step('restores the reading position')

  assert.deepEqual(errors, [])
  step('no page errors')
  console.log('\nSmoke test passed')
} catch (e) {
  await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {})
  console.error(`\nSmoke test failed: ${e.message}\nScreenshot: ${path.join(dir, 'failure.png')}`)
  if (errors.length) console.error('Page errors:\n' + errors.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  await new Promise(r => server.httpServer.close(r))
}
