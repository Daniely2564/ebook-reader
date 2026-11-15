#!/usr/bin/env node
// End-to-end test of a locked PDF view: zoomed in and locked, the next page command
// reads down the page a screen at a time, then down the next column of a two-column
// page, then opens the next page at the same place and zoom; going back retraces the
// steps. It works page by page and in continuous scrolling, from a tap on the right
// edge, and the lock is kept when the book is opened again. The PDFs are printed by
// Chromium from generated paragraphs.
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
const paragraphs = Array.from({ length: 60 }, (_, p) => `<p>${Array.from({ length: 3 + p % 4 }, (_, s) => sentence(p * 7 + s)).join(' ')}</p>`)
// two-column pages are laid out one by one: Chromium doesn't break columns across pages
const book = columns => `<html><head><style>
@page { size: A4; margin: 20mm 18mm; }
body { font: 11pt/1.45 serif; margin: 0; }
section { columns: 2; column-gap: 8mm; column-fill: auto; height: 255mm; overflow: hidden; break-after: page; }
p { margin: 0; text-indent: 1.5em; text-align: justify; }
</style></head><body>${columns > 1
    ? Array.from({ length: 3 }, (_, i) => `<section>${paragraphs.slice(i * 20, i * 20 + 20).join('')}</section>`).join('')
    : paragraphs.join('')}</body></html>`

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-pdf-lock-'))
const server = await preview({ preview: { port: 0, strictPort: false }, logLevel: 'error' })
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const printer = await browser.newPage()
const files = {}
for (const [name, columns] of [['one-column', 1], ['two-columns', 2]]) {
  await printer.setContent(book(columns))
  files[name] = path.join(dir, `${name}.pdf`)
  fs.writeFileSync(files[name], await printer.pdf({ preferCSSPageSize: true }))
}
await printer.close()

const page = await (await browser.newContext({ viewport: { width: 480, height: 820 } })).newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))
const step = name => console.log(`✓ ${name}`)
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`)

/** The page in the middle of the screen, and where the view's top left corner is on it (fractions of its size). */
const place = () => page.evaluate(() => {
  const s = document.querySelector('.pdf-scroller')
  const sr = s.getBoundingClientRect()
  const x = sr.left + s.clientWidth / 2
  const y = sr.top + s.clientHeight / 2
  let best = null
  for (const el of s.querySelectorAll('.page[data-page-number]')) {
    const r = el.getBoundingClientRect()
    if (!r.height) continue
    const d = Math.max(0, r.left - x, x - r.right) + Math.max(0, r.top - y, y - r.bottom)
    if (!best || d < best.d) best = { d, r, n: Number(el.dataset.pageNumber) }
  }
  return {
    page: best.n,
    left: (sr.left - best.r.left) / best.r.width,
    top: (sr.top - best.r.top) / best.r.height,
    width: best.r.width,
    zoom: document.querySelector('.zoom-label')?.textContent,
  }
})

/** Next (1) or previous (-1) page command, waiting for the view to settle. */
const turn = async dir => {
  await page.keyboard.press(dir > 0 ? 'ArrowRight' : 'ArrowLeft')
  await page.waitForTimeout(900)
  return place()
}

const openBook = async title => {
  await page.locator('.book', { hasText: title }).click()
  await page.waitForSelector('.pdf-scroller .page .textLayer span', { timeout: 30_000 })
  await page.waitForTimeout(800)
}
const leaveBook = async () => {
  await page.evaluate(() => document.querySelector('[aria-label="Back to library"]').click())
  await page.waitForSelector('.book', { timeout: 10_000 })
}
const lockButton = () => page.locator('.reader-bar.top [aria-label*="(Z)"]')

/** Zooms in and frames the view on page 1, `left` / `top` along the page. */
const frame = async (zoomSteps, left, top, until = null) => {
  await page.locator('.pdf-scroller').click({ position: { x: 240, y: 300 } })
  await page.waitForTimeout(400)
  for (let i = 0; i < zoomSteps || (until && i < 12 && !(await until())); i++) {
    await page.keyboard.press('Control+Equal')
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(600)
  await page.evaluate(([left, top]) => {
    const s = document.querySelector('.pdf-scroller')
    const p = document.querySelector('.page[data-page-number="1"]')
    s.scrollLeft = p.offsetLeft + left * p.offsetWidth
    s.scrollTop = p.offsetTop + top * p.offsetHeight
  }, [left, top])
  await page.waitForTimeout(400)
}

try {
  await page.goto(url)
  await page.setInputFiles('input[type=file][multiple]', [files['one-column'], files['two-columns']])
  await page.waitForFunction(() => document.querySelectorAll('.book').length === 2, null, { timeout: 30_000 })

  // ---------------------------------------------------------------- one column, page by page
  await openBook('One Column')
  await page.keyboard.press('a')
  await page.locator('.typo-panel .segmented button', { hasText: 'Page by page' }).click()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await frame(3, 0.09, 0.06)
  await page.keyboard.press('z')
  await page.waitForSelector('.toast >> text=View locked')
  const start = await place()
  assert.equal(start.page, 1)
  step(`locks the view at ${start.zoom}, ${(start.left * 100).toFixed(1)}% / ${(start.top * 100).toFixed(1)}% into page 1`)

  const stops = [start]
  for (let i = 0; i < 12; i++) {
    const p = await turn(1)
    stops.push(p)
    if (p.page === 2) break
  }
  const onFirst = stops.filter(p => p.page === 1)
  const second = stops.at(-1)
  assert.ok(onFirst.length >= 2, `reads down page 1 in more than one screen: ${JSON.stringify(stops)}`)
  for (let i = 1; i < onFirst.length; i++) {
    near(onFirst[i].left, start.left, 0.002, 'stays in the column')
    assert.ok(onFirst[i].top > onFirst[i - 1].top, 'moves down the page')
  }
  assert.ok(onFirst.at(-1).top < 0.95, 'stops before the page ends')
  step(`reads down page 1 in ${onFirst.length} screens, keeping the column`)

  assert.equal(second.page, 2)
  near(second.left, start.left, 0.002, 'page 2 opens at the locked left edge')
  near(second.top, start.top, 0.002, 'page 2 opens at the locked top')
  assert.equal(second.zoom, start.zoom)
  step('opens page 2 at the same place and zoom')

  const back = await turn(-1)
  assert.equal(back.page, 1)
  near(back.top, onFirst.at(-1).top, 0.002, 'going back shows the end of page 1')
  near(back.left, start.left, 0.002, 'going back keeps the column')
  await turn(1)
  step('going back from the top of page 2 shows the end of page 1')

  // a tap on the right edge (with a mouse, after the double-click delay)
  await page.mouse.click(470, 410)
  await page.waitForTimeout(1200)
  const tapped = await place()
  assert.equal(tapped.page, 2)
  assert.ok(tapped.top > second.top, 'a tap on the right edge steps down')
  near(tapped.left, start.left, 0.002, 'the tap keeps the column')
  step('a tap on the right edge steps down the page')

  // reopening keeps the lock, and the place
  await leaveBook()
  await openBook('One Column')
  assert.equal(await lockButton().getAttribute('aria-pressed'), 'true')
  const reopened = await place()
  assert.equal(reopened.zoom, start.zoom)
  for (let i = 0; i < 12 && (await place()).page === 2; i++) await turn(1)
  const third = await place()
  assert.equal(third.page, 3)
  near(third.left, start.left, 0.002, 'page 3 opens at the locked left edge')
  near(third.top, start.top, 0.002, 'page 3 opens at the locked top')
  step('reopening the book keeps the lock')

  // unlocking turns pages as before
  await page.keyboard.press('z')
  await page.waitForSelector('.toast >> text=View unlocked')
  assert.equal(await lockButton().getAttribute('aria-pressed'), 'false')
  step('unlocks')
  await page.keyboard.press('a')
  await page.locator('.typo-panel .segmented button', { hasText: 'Continuous' }).click()
  await page.keyboard.press('Escape')
  await leaveBook()

  // ---------------------------------------------------------------- two columns, continuous
  await openBook('Two Columns')
  // the left column, about half the text's width
  const share = async () => {
    const w = await page.evaluate(() => document.querySelector('.pdf-scroller').clientWidth)
    return w / (await place()).width
  }
  await frame(0, 0.075, 0.06, async () => (await share()) < 0.48)
  const ratio = await share()
  assert.ok(ratio > 0.36 && ratio < 0.5, `the screen shows about one column: ${ratio}`)
  await page.keyboard.press('z')
  await page.waitForSelector('.toast >> text=View locked')
  const c0 = await place()
  const path2 = [c0]
  for (let i = 0; i < 20; i++) {
    const p = await turn(1)
    path2.push(p)
    if (p.page === 2) break
  }
  const lefts = [...new Set(path2.filter(p => p.page === 1).map(p => p.left.toFixed(3)))]
  assert.equal(lefts.length, 2, `reads two columns on page 1: ${JSON.stringify(path2)}`)
  const right = path2.find(p => p.page === 1 && p.left > c0.left + 0.2)
  near(right.top, c0.top, 0.002, 'the right column starts at the top')
  const p2 = path2.at(-1)
  assert.equal(p2.page, 2)
  near(p2.left, c0.left, 0.002, 'page 2 opens in its left column')
  near(p2.top, c0.top, 0.002, 'page 2 opens at the locked top')
  step(`reads down the left column, then the right one (${path2.length - 1} steps), then page 2 from the top left`)

  const backCol = await turn(-1)
  assert.equal(backCol.page, 1)
  assert.ok(backCol.left > c0.left + 0.2, 'going back shows the end of the right column')
  step('going back from page 2 shows the end of the right column of page 1')

  // zooming a locked view keeps it locked, at the new zoom
  await turn(1)
  await page.keyboard.press('Control+Minus')
  await page.waitForTimeout(800)
  const zoomed = await place()
  assert.notEqual(zoomed.zoom, p2.zoom)
  for (let i = 0; i < 20 && (await place()).page === 2; i++) await turn(1)
  const p3 = await place()
  assert.equal(p3.page, 3)
  assert.equal(p3.zoom, zoomed.zoom)
  near(p3.left, zoomed.left, 0.002, 'page 3 opens at the left edge after zooming')
  near(p3.top, zoomed.top, 0.002, 'page 3 opens at the top after zooming')
  step(`zooming the locked view (to ${zoomed.zoom}) moves the lock along`)

  assert.deepEqual(errors, [])
  step('no page errors')
  console.log('\nPDF lock test passed')
} catch (e) {
  await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {})
  console.error(`\nPDF lock test failed: ${e.message}\nScreenshot: ${path.join(dir, 'failure.png')}`)
  if (errors.length) console.error('Page errors:\n' + errors.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  await new Promise(r => server.httpServer.close(r))
}
