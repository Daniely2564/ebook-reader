#!/usr/bin/env node
// End-to-end test of sending highlights to Dotion, against a fake of its REST API (/developers):
// connecting with an API token, sending a book to a database (a new page, then only the new
// highlight, then nothing), adding to a page the user already has with the same title without
// touching what's on it, and adding to an existing page found by search.
//
//   npm run test:e2e            (set CHROMIUM_PATH to use a specific Chromium)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { lookUpWord, makeEpub } from './helpers.mjs'

const TOKEN = 'dot_test_token'
const DOTION = 'https://dotion.test'

/** Rows and pages in memory, served the way the developer docs describe. */
const fakeDotion = () => {
  const notes = new Map()
  const requests = []
  let n = 0
  const note = (title, content, databaseId) => {
    const id = `note${String(++n).padStart(20, '0')}`
    notes.set(id, { id, title, content, databaseId, url: `/notes/${id}` })
    return notes.get(id)
  }
  const databases = [
    { id: 'db-books', name: '책', workspaceId: 'ws1', role: 'owner' },
    { id: 'db-summary', name: 'Book summary', workspaceId: 'ws1', role: 'owner' },
  ]
  note('Reading log', 'My reading log.\n\n> A quote I typed myself', null)
  note('Smoke Test Book', 'My own notes about this book.', 'db-summary')

  const handle = async route => {
    const req = route.request()
    const u = new URL(req.url())
    const headers = {
      'access-control-allow-origin': req.headers().origin ?? '*',
      'access-control-allow-headers': 'authorization,content-type,accept',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    }
    const json = (body, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) })
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (req.headers().authorization !== `Bearer ${TOKEN}`) return json({ error: { status: 401, message: 'Invalid token' } }, 401)
    const body = req.postData() ? JSON.parse(req.postData()) : undefined
    requests.push({ method: req.method(), path: u.pathname, body })
    const row = x => ({ id: x.id, title: x.title, url: x.url, tags: [], properties: {}, createdAt: '2026-10-29T00:00:00Z' })

    if (u.pathname === '/api/v1/me')
      return json({ user: { id: 'u1', name: 'Test Reader' }, workspaces: [{ id: 'ws1', name: 'Daily Routine' }], databases })
    if (u.pathname === '/api/v1/search') {
      const q = u.searchParams.get('q').toLowerCase()
      return json({ results: [...notes.values()].filter(x => x.title.toLowerCase().includes(q)).map(row) })
    }
    let m = /^\/api\/v1\/databases\/([^/]+)\/(query|rows)$/.exec(u.pathname)
    if (m && m[2] === 'query') {
      const title = body.filters?.find(f => f.property === 'title')?.value
      return json({ rows: [...notes.values()].filter(x => x.databaseId === m[1] && (!title || x.title === title)).map(row), total: 0 })
    }
    if (m && m[2] === 'rows') return json(row(note(body.title, body.content ?? '', m[1])))
    m = /^\/api\/v1\/notes\/([^/]+)$/.exec(u.pathname)
    const x = m && notes.get(m[1])
    if (!x) return json({ error: { status: 404, message: 'Not found' } }, 404)
    if (req.method() === 'GET') return json({ ...row(x), content: x.content })
    if (req.method() === 'PATCH') {
      x.content = body.append ? `${x.content}\n\n${body.content}` : body.content
      return json(row(x))
    }
    return json({ error: { status: 405, message: 'Not allowed' } }, 405)
  }
  return { handle, notes, requests, byTitle: (title, db) => [...notes.values()].find(x => x.title === title && (db === undefined || x.databaseId === db)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-dotion-'))
const bookPath = path.join(dir, 'smoke-test.epub')
fs.writeFileSync(bookPath, makeEpub())

const dotion = fakeDotion()
const server = await preview({ preview: { port: 0, strictPort: false }, logLevel: 'error' })
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
await context.route(`${DOTION}/**`, route => dotion.handle(route))
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))
const step = name => console.log(`✓ ${name}`)

const highlight = async word => {
  await lookUpWord(page, word)
  await page.locator('.dict-pop .dict-hl-row .swatch').first().click()
  await page.waitForSelector('.dict-pop', { state: 'detached' })
}

const openHighlights = async () => {
  await page.evaluate(() => document.querySelector('[aria-label="Back to library"], [aria-label="Back to highlights"]')?.click())
  await page.locator('.nav button', { hasText: 'Highlights' }).click()
  await page.waitForSelector('.hl-card')
}

/** Export → Send to Dotion, with `pickTarget` choosing where; returns the result lines. */
const send = async pickTarget => {
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Send to Dotion…' }).click()
  await page.waitForSelector('.dotion-sheet')
  await pickTarget?.()
  await page.locator('.dotion-sheet .btn-primary', { hasText: /^Send/ }).click()
  await page.waitForSelector('.dotion-results')
  const lines = await page.locator('.dotion-results li').allInnerTexts()
  await page.getByRole('button', { name: 'Done' }).click()
  return lines.map(l => l.replace(/\s+/g, ' ').trim())
}

try {
  await page.goto(server.resolvedUrls.local[0])
  await page.setInputFiles('input[type=file][multiple]', bookPath)
  await page.locator('.book').click()
  await page.waitForFunction(() => /Page \d+/.test(document.querySelector('.info-left')?.textContent ?? ''), null, { timeout: 20_000 })
  await page.waitForTimeout(1500)
  await highlight('lanterns')
  await openHighlights()
  await page.locator('.hl-card [aria-label="Add note"]').click()
  await page.locator('.note-input').fill('Light on the water')
  await page.getByRole('button', { name: 'Save' }).click()

  // the token is added in Settings and checked
  await page.locator('.nav button', { hasText: 'Settings' }).click()
  await page.locator('.settings-nav button', { hasText: 'Dotion' }).click()
  await page.getByPlaceholder('https://dotion-note.vercel.app').fill(DOTION)
  await page.getByPlaceholder('dot_…').fill('dot_wrong')
  await page.getByRole('button', { name: 'Connect' }).click()
  await page.locator('.sync-error', { hasText: 'didn’t accept this API token' }).waitFor()
  await page.getByPlaceholder('dot_…').fill(TOKEN)
  await page.getByRole('button', { name: 'Connect' }).click()
  await page.locator('.sync-card', { hasText: 'Connected as Test Reader' }).waitFor()
  await page.keyboard.press('Escape')
  step('connects with an API token (and rejects a wrong one)')

  // a database: a new page for the book, then only what's new, then nothing
  let lines = await send(() => page.getByRole('combobox', { name: 'Database' }).selectOption({ label: '책' }))
  assert.deepEqual(lines, ['Smoke Test Book New page with 1 highlight Open'])
  let row = dotion.byTitle('Smoke Test Book', 'db-books')
  assert.match(row.content, /^\*Lumen QA\*\n\n### Chapter 1\n\n> lanterns\n\n\*\*Note:\*\* Light on the water\n/)
  step('sends a book to a database as a new page, with its note')

  await page.locator('.hl-card .hl-where').click()
  await page.waitForSelector('foliate-view')
  await page.waitForTimeout(1500)
  await highlight('riverbank')
  await openHighlights()
  lines = await send()
  assert.deepEqual(lines, ['Smoke Test Book Added 1 highlight Open'])
  const patch = dotion.requests.findLast(r => r.method === 'PATCH')
  assert.equal(patch.body.append, true)
  assert.match(patch.body.content, /> riverbank/)
  assert.doesNotMatch(patch.body.content, /lanterns/)
  assert.equal((dotion.byTitle('Smoke Test Book', 'db-books').content.match(/> lanterns/g) ?? []).length, 1)
  lines = await send()
  assert.deepEqual(lines, ['Smoke Test Book Already there Open'])
  step('sending again adds only the new highlight, then nothing')

  // a database where the user already has a page for the book: added below their notes
  lines = await send(() => page.getByRole('combobox', { name: 'Database' }).selectOption({ label: 'Book summary' }))
  assert.deepEqual(lines, ['Smoke Test Book Added 2 highlights Open'])
  row = dotion.byTitle('Smoke Test Book', 'db-summary')
  assert.match(row.content, /^My own notes about this book\.\n\n## Highlights from Lumen Reader\n\n### Chapter 1\n\n> /)
  assert.match(row.content, /> lanterns[\s\S]*> riverbank|> riverbank[\s\S]*> lanterns/)
  step('adds to a page the user already has, below what is on it')

  // an existing page, found by search
  lines = await send(async () => {
    await page.getByRole('radio', { name: 'An existing page' }).click()
    await page.getByRole('searchbox', { name: 'Find a page' }).fill('reading')
    await page.locator('.dotion-pages button', { hasText: 'Reading log' }).click()
  })
  assert.deepEqual(lines, ['Smoke Test Book Added 2 highlights Open'])
  const log = dotion.byTitle('Reading log')
  assert.match(log.content, /^My reading log\.\n\n> A quote I typed myself\n\n## Smoke Test Book\n\n\*Lumen QA\*\n\n/)
  lines = await send()
  assert.deepEqual(lines, ['Smoke Test Book Already there Open'])
  step('adds to an existing page found by search, once')

  assert.deepEqual(errors, [])
  step('no page errors')
  console.log('\nDotion test passed')
} catch (e) {
  await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {})
  console.error(`\nDotion test failed: ${e.message}\nScreenshot: ${path.join(dir, 'failure.png')}`)
  if (errors.length) console.error('Page errors:\n' + errors.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  await new Promise(r => server.httpServer.close(r))
}
