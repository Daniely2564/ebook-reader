#!/usr/bin/env node
// End-to-end test of selecting and highlighting in a PDF's page view: a selection
// dragged past the end of a paragraph's last line (into the margin, or into the
// indent of the next paragraph) ends at that line instead of jumping elsewhere, and
// a highlight across a page break covers its text, not the two whole pages. The PDF
// is printed by Chromium from generated paragraphs.
//
//   npm run test:e2e            (set CHROMIUM_PATH to use a specific Chromium)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

const words = 'the travellers were walking along the riverbank while lanterns flickered over the water and every reader wondered what would happen next'.split(' ')
const sentence = i => {
  const n = 9 + (i * 7) % 13
  const w = Array.from({ length: n }, (_, k) => words[(i * 5 + k * 3) % words.length])
  return w[0][0].toUpperCase() + w.join(' ').slice(1) + '.'
}
const paragraphs = Array.from({ length: 40 }, (_, p) => `<p>${Array.from({ length: 3 + p % 4 }, (_, s) => sentence(p * 7 + s)).join(' ')}</p>`)
const html = `<html><head><style>
@page { size: A5; margin: 18mm 16mm; }
body { font: 10.5pt/1.4 serif; }
p { margin: 0; text-indent: 1.5em; text-align: justify; }
</style></head><body>${paragraphs.join('')}</body></html>`

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-pdf-'))
const bookPath = path.join(dir, 'pdf-test.pdf')
const server = await preview({ preview: { port: 0, strictPort: false }, logLevel: 'error' })
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const printer = await browser.newPage()
await printer.setContent(html)
fs.writeFileSync(bookPath, await printer.pdf({ preferCSSPageSize: true }))
await printer.close()

const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))
const step = name => console.log(`✓ ${name}`)
const clean = s => s.replace(/\s+/g, ' ').trim()
const selection = () => page.evaluate(() => getSelection().toString())

/** Lines of text on a page of the page view, from the text layer: text, edges and middle on screen. */
const linesOf = n => page.evaluate(n => {
  const layer = document.querySelector(`.page[data-page-number="${n}"] .textLayer`)
  const range = document.createRange()
  const lines = []
  for (const span of layer.querySelectorAll('span[role="presentation"]')) {
    if (!span.textContent.trim()) continue
    range.selectNodeContents(span)
    const r = range.getBoundingClientRect()
    const mid = (r.top + r.bottom) / 2
    const line = lines.find(l => Math.abs(l.mid - mid) < r.height / 2)
    if (line) {
      line.parts.push([r.left, span.textContent])
      line.left = Math.min(line.left, r.left)
      line.right = Math.max(line.right, r.right)
    } else lines.push({ mid, height: r.height, left: r.left, right: r.right, parts: [[r.left, span.textContent]] })
  }
  const page = layer.getBoundingClientRect()
  return lines.sort((a, b) => a.mid - b.mid).map(({ parts, ...l }) => ({
    ...l, pageRight: page.right, text: parts.sort((a, b) => a[0] - b[0]).map(p => p[1]).join('').replace(/\s+/g, ' ').trim(),
  }))
}, n)

const drag = async (...points) => {
  await page.evaluate(() => getSelection().removeAllRanges())
  await page.mouse.move(...points[0])
  await page.mouse.down()
  for (const p of points.slice(1)) await page.mouse.move(...p, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(300)
}

/** Highlights drawn on the pages: page number and height on screen. */
const highlights = () => page.evaluate(() => [...document.querySelectorAll('.lumen-hl')].map(el => ({
  page: Number(el.closest('.page').dataset.pageNumber), height: el.getBoundingClientRect().height,
})))

try {
  await page.goto(url)
  await page.setInputFiles('input[type=file][multiple]', bookPath)
  await page.waitForSelector('.book', { timeout: 30_000 })
  await page.locator('.book').click()
  await page.waitForSelector('.pdf-scroller .page .textLayer span', { timeout: 30_000 })
  await page.evaluate(() => document.querySelector('.page[data-page-number="2"]').scrollIntoView())
  await page.waitForSelector('.page[data-page-number="2"] .textLayer span', { timeout: 20_000 })
  await page.waitForTimeout(800)

  // the short last line of a paragraph, between two full lines
  const lines = (await linesOf(2)).filter(l => l.mid > 80 && l.mid < 700)
  const right = Math.max(...lines.map(l => l.right))
  const i = lines.findIndex((l, k) => k > 0 && k < lines.length - 1 && l.right < right - 120 && lines[k - 1].right > right - 2)
  assert.ok(i > 0, 'found the end of a paragraph on page 2')
  const [prev, last, next] = lines.slice(i - 1, i + 2)

  await drag([prev.left + 40, prev.mid], [last.right - 10, last.mid], [last.pageRight - 15, last.mid])
  assert.ok(clean(await selection()).endsWith(last.text), `selection ends with "${last.text}", not "${clean(await selection()).slice(-40)}"`)
  step('a selection dragged into the margin beside a paragraph\'s last line ends with that line')

  await drag([prev.left + 40, prev.mid], [last.right - 10, last.mid], [next.left - 8, next.mid])
  assert.ok(clean(await selection()).endsWith(last.text), `selection ends with "${last.text}", not "${clean(await selection()).slice(-40)}"`)
  step('a selection dragged into the next paragraph\'s indent ends with the paragraph before')

  await page.locator('.sel-menu .swatch').first().click()
  await page.waitForSelector('.lumen-hl')
  const own = await highlights()
  assert.ok(own.length >= 2 && own.every(h => h.height < 2 * last.height), `highlight is drawn line by line: ${JSON.stringify(own)}`)
  step('highlights the selected lines')

  // a selection running from the last line of page 2 to the first line of page 3
  await page.evaluate(() => {
    const p = document.querySelector('.page[data-page-number="3"]')
    document.querySelector('.pdf-scroller').scrollTop = p.offsetTop - 380
  })
  await page.waitForSelector('.page[data-page-number="3"] .textLayer span', { timeout: 20_000 })
  await page.waitForTimeout(800)
  const end2 = (await linesOf(2)).at(-1)
  const start3 = (await linesOf(3))[0]
  await drag([end2.left + 30, end2.mid], [start3.left + 60, start3.mid])
  assert.match(clean(await selection()), new RegExp(`${start3.text.slice(0, 3)}`))
  await page.locator('.sel-menu .swatch').nth(1).click()
  await page.waitForFunction(n => document.querySelectorAll('.lumen-hl').length > n, own.length)
  const across = (await highlights()).slice(own.length)
  assert.deepEqual([...new Set(across.map(h => h.page))].sort(), [2, 3])
  assert.ok(across.every(h => h.height < 2 * start3.height), `no whole page is highlighted: ${JSON.stringify(across)}`)
  step('a highlight across a page break covers its text, not the whole pages')

  await page.keyboard.press('v')
  await page.waitForSelector('foliate-view', { timeout: 20_000 })
  await page.waitForFunction(() => /Page \d+/.test(document.querySelector('.info-left')?.textContent ?? ''), null, { timeout: 20_000 })
  step('opens the highlighted PDF as flowing text')

  assert.deepEqual(errors, [])
  step('no page errors')
  console.log('\nPDF test passed')
} catch (e) {
  await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {})
  console.error(`\nPDF test failed: ${e.message}\nScreenshot: ${path.join(dir, 'failure.png')}`)
  if (errors.length) console.error('Page errors:\n' + errors.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  await new Promise(r => server.httpServer.close(r))
}
