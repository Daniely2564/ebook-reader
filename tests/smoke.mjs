#!/usr/bin/env node
// End-to-end smoke test: builds a tiny EPUB, imports it into the production
// build (served by `vite preview`), turns pages, looks up an inflected word
// in the offline dictionary, checks that the dictionary picked stays picked,
// that turning the page closes the dictionary popup, that reading progress is
// saved, and that a highlight shows up on the Highlights page and opens there.
//
//   npm run test:e2e            (set CHROMIUM_PATH to use a specific Chromium)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { lookUpWord, makeEpub } from './helpers.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-smoke-'))
const bookPath = path.join(dir, 'smoke-test.epub')
fs.writeFileSync(bookPath, makeEpub())

const server = await preview({ preview: { port: 0, strictPort: false }, logLevel: 'error' })
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))
const step = name => console.log(`✓ ${name}`)
const label = () => page.evaluate(() => document.querySelector('.info-left')?.textContent ?? '')
const activeTab = () => page.locator('.dict-pop .dict-tabs [aria-selected=true]').innerText()

const lookUp = word => lookUpWord(page, word)

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

  // turning the page with the wheel (not just the keyboard) closes popups about the old page
  const pop = await page.locator('.dict-pop').boundingBox()
  const beforeWheel = await label()
  await page.mouse.move(pop.x > 640 ? 200 : 1080, 420)
  await page.mouse.wheel(0, 300)
  await page.waitForFunction(prev => document.querySelector('.info-left')?.textContent !== prev, beforeWheel, { timeout: 10_000 })
  await page.waitForSelector('.dict-pop', { state: 'detached', timeout: 5_000 })
  step('closes the dictionary popup when the page turns')

  await page.waitForTimeout(600) // let the page-turn animation settle
  const saved = await label()
  await page.evaluate(() => document.querySelector('[aria-label="Back to library"]').click())
  await page.waitForSelector('.continue')
  await page.locator('.book').click()
  // the first relocation after opening can be reported before the layout settles
  await page.waitForFunction(s => document.querySelector('.info-left')?.textContent?.includes(s), saved, { timeout: 20_000 }).catch(() => {})
  assert.equal(await label(), saved)
  step('restores the reading position')

  // highlight a word, read on, then open the highlight from the Highlights page
  await page.waitForTimeout(600)
  await lookUp('lanterns')
  const highlightPage = await label()
  await page.locator('.dict-pop .dict-hl-row .swatch').nth(2).click()
  await page.waitForSelector('.dict-pop', { state: 'detached' })
  for (let i = 0; i < 3; i++) {
    const prev = await label()
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(p => document.querySelector('.info-left')?.textContent !== p, prev, { timeout: 10_000 })
    await page.waitForTimeout(400)
  }
  const readTo = await label()
  await page.evaluate(() => document.querySelector('[aria-label="Back to library"]').click())
  await page.locator('.nav button', { hasText: 'Highlights' }).click()
  await page.waitForSelector('.hl-card')
  assert.equal(await page.locator('.hl-card').count(), 1)
  assert.match(await page.locator('.hl-card .hl-quote').innerText(), /lanterns/)
  assert.match(await page.locator('.hl-book-info').innerText(), /Smoke Test Book[\s\S]*1 highlight/)
  step('lists the highlight on the Highlights page')

  await page.locator('.hl-card .hl-where').click()
  await page.waitForFunction(s => document.querySelector('.info-left')?.textContent === s, highlightPage, { timeout: 20_000 })
  assert.match(await page.locator('.return-chip').innerText(), new RegExp(`Back to ${readTo}`))
  await page.evaluate(() => document.querySelector('[aria-label="Back to highlights"]').click())
  await page.waitForSelector('.hl-card')
  step(`opens a highlight in the book (${highlightPage}, with a way back to ${readTo})`)

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
