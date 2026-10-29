#!/usr/bin/env node
// End-to-end sync test: two devices (separate browser profiles) share a fake Google Drive.
// Device A connects with the sign-in code flow, highlights a passage, saves a word and reads on;
// the highlight goes up on its own, with a Markdown copy. Device B connects, sees A's highlight
// and word before it has the book, then adds the book and opens it where A left off. A reads on
// while B has the book open: B offers that place and keeps it when closed. A highlight deleted on
// B disappears on A.
//
//   npm run test:e2e            (set CHROMIUM_PATH to use a specific Chromium)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { lookUpWord, makeEpub } from './helpers.mjs'

const CLIENT_ID = 'lumen-test.apps.googleusercontent.com'
const CLIENT_SECRET = 'test-secret'

/** Just enough of Google's OAuth and Drive v3 APIs for Lumen's sync. */
const fakeGoogle = () => {
  const files = new Map()
  const polled = new Set()
  let n = 0
  const cors = route => ({
    'access-control-allow-origin': route.request().headers().origin ?? '*',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  })
  const json = (route, body, status = 200) => route.fulfill({ status, headers: cors(route), contentType: 'application/json', body: JSON.stringify(body) })
  const meta = f => ({ id: f.id, name: f.name, mimeType: f.mimeType, version: String(f.version), createdTime: f.createdTime, appProperties: f.appProperties, parents: f.parents })
  const matches = (f, q) => {
    if (/trashed = false/.test(q) && f.trashed) return false
    for (const [, k, v] of q.matchAll(/appProperties has \{ key='([^']+)' and value='([^']+)' \}/g)) if (f.appProperties?.[k] !== v) return false
    for (const [, p] of q.matchAll(/'([^']+)' in parents/g)) if (!f.parents?.includes(p)) return false
    return true
  }
  const multipart = req => {
    const boundary = /boundary=(.+)$/.exec(req.headers()['content-type'])[1]
    const [head, body] = req.postData().split(`--${boundary}`).slice(1, 3)
      .map(part => part.replace(/^\r\n/, '').replace(/\r\n$/, '').split('\r\n\r\n').slice(1).join('\r\n\r\n'))
    return { meta: JSON.parse(head), content: body }
  }

  const handle = async route => {
    const req = route.request()
    const u = new URL(req.url())
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(route) })

    if (u.host === 'oauth2.googleapis.com') {
      const p = new URLSearchParams(req.postData() ?? '')
      if (u.pathname === '/device/code') {
        assert.equal(p.get('client_id'), CLIENT_ID)
        assert.equal(p.get('scope'), 'https://www.googleapis.com/auth/drive.file')
        return json(route, { device_code: `device-${++n}`, user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 1 })
      }
      if (u.pathname === '/token') {
        assert.equal(p.get('client_secret'), CLIENT_SECRET)
        if (p.get('grant_type') === 'refresh_token') return json(route, { access_token: `access-${++n}`, expires_in: 3599, token_type: 'Bearer' })
        // the user enters the code after the first poll
        const code = p.get('device_code')
        if (!polled.has(code)) {
          polled.add(code)
          return json(route, { error: 'authorization_pending' }, 428)
        }
        return json(route, { access_token: `access-${++n}`, refresh_token: `refresh-${n}`, expires_in: 3599, token_type: 'Bearer' })
      }
      return json(route, {})
    }

    if (!/^Bearer access-/.test(req.headers().authorization ?? '')) return json(route, { error: { code: 401, message: 'Invalid Credentials' } }, 401)
    if (u.pathname === '/drive/v3/about') return json(route, { user: { displayName: 'Test Reader', emailAddress: 'reader@example.com' } })
    const [, upload, id] = /^\/(upload\/)?drive\/v3\/files(?:\/([^/]+))?$/.exec(u.pathname) ?? []
    const method = req.method()
    if (!id && method === 'GET') {
      const q = u.searchParams.get('q') ?? ''
      return json(route, { files: [...files.values()].filter(f => matches(f, q)).map(meta) })
    }
    if (!id && method === 'POST') {
      const { meta: m, content } = upload ? multipart(req) : { meta: JSON.parse(req.postData()), content: '' }
      const f = { appProperties: {}, parents: [], ...m, id: `file-${++n}`, version: 1, createdTime: new Date(Date.now() + n).toISOString(), trashed: false, content }
      files.set(f.id, f)
      return json(route, meta(f))
    }
    const f = files.get(id)
    if (!f) return json(route, { error: { code: 404, message: `File not found: ${id}` } }, 404)
    if (method === 'GET') {
      if (u.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, headers: cors(route), contentType: 'application/json', body: f.content })
      return json(route, { ...meta(f), trashed: f.trashed })
    }
    if (method === 'PATCH') {
      if (u.searchParams.get('uploadType') === 'media') f.content = req.postData()
      else {
        const { meta: m, content } = upload ? multipart(req) : { meta: JSON.parse(req.postData()), content: f.content }
        Object.assign(f, m, { appProperties: { ...f.appProperties, ...m.appProperties }, content })
      }
      f.version++
      return json(route, meta(f))
    }
    return json(route, { error: { message: 'Unsupported' } }, 400)
  }

  const live = () => [...files.values()].filter(f => !f.trashed)
  return {
    handle,
    data: () => {
      const f = live().find(x => x.appProperties.lumen === 'sync')
      return f ? JSON.parse(f.content) : null
    },
    notes: () => live().filter(x => x.appProperties.lumen === 'book-notes'),
    byRole: role => live().filter(x => x.appProperties.lumen === role),
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sync-'))
const bookPath = path.join(dir, 'smoke-test.epub')
fs.writeFileSync(bookPath, makeEpub())

const google = fakeGoogle()
const server = await preview({ preview: { port: 0, strictPort: false }, logLevel: 'error' })
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const errors = []
const step = name => console.log(`✓ ${name}`)
const pages = []

/** A fresh profile: its own IndexedDB and settings, the same Google account. */
const device = async name => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.route(/^https:\/\/(oauth2|www)\.googleapis\.com\//, route => google.handle(route))
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`))
  await page.goto(url)
  pages.push([name, page])
  return page
}

const label = page => page.evaluate(() => document.querySelector('.info-left')?.textContent ?? '')
const until = async (what, check, timeout = 20_000) => {
  const end = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 200))
  }
}

const openSync = async page => {
  await page.locator('.nav button', { hasText: 'Settings' }).click()
  await page.locator('.settings-nav button', { hasText: 'Sync' }).click()
}

const connect = async page => {
  await openSync(page)
  await page.getByPlaceholder('1234…apps.googleusercontent.com').fill(CLIENT_ID)
  await page.getByPlaceholder('GOCSPX-…').fill(CLIENT_SECRET)
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Connect Google Drive' }).click()
  assert.equal(await page.locator('.sync-code-value').innerText(), 'ABCD-EFGH')
  await page.waitForFunction(() => /Last synced/.test(document.querySelector('.sync-card')?.textContent ?? ''), null, { timeout: 20_000 })
  assert.match(await page.locator('.sync-card').innerText(), /Connected as reader@example\.com/)
  await page.keyboard.press('Escape')
}

const lastSyncAt = page => page.evaluate(() => JSON.parse(localStorage.getItem('lumen-sync')).state.lastSyncAt)

/** Syncs the way coming back online does (works from any screen), and waits for it. */
const syncInBackground = async page => {
  const before = await lastSyncAt(page)
  await page.evaluate(() => dispatchEvent(new Event('online')))
  await until('a background sync', async () => (await lastSyncAt(page)) > before)
}

/** Presses "Sync now" and waits for that sync to finish. */
const syncNow = async page => {
  await openSync(page)
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('lumen-sync')).state.lastSyncAt)
  await page.getByRole('button', { name: 'Sync now' }).click()
  await page.waitForFunction(t => JSON.parse(localStorage.getItem('lumen-sync')).state.lastSyncAt > t, before, { timeout: 20_000 })
  await page.keyboard.press('Escape')
}

const turnPage = async page => {
  const prev = await label(page)
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(p => document.querySelector('.info-left')?.textContent !== p, prev, { timeout: 10_000 })
  await page.waitForTimeout(400)
}

try {
  // ---------------------------------------------------------------- device A
  const a = await device('A')
  await connect(a)
  assert.ok(google.data(), 'the sync file was created')
  assert.equal(google.byRole('root').length, 1)
  step('connects to Google Drive with a sign-in code and creates the sync file')

  await a.setInputFiles('input[type=file][multiple]', bookPath)
  await a.waitForSelector('.book', { timeout: 30_000 })
  await a.locator('.book').click()
  await a.waitForSelector('foliate-view')
  await a.waitForFunction(() => /Page \d+/.test(document.querySelector('.info-left')?.textContent ?? ''), null, { timeout: 20_000 })
  await a.waitForTimeout(1500)
  for (let i = 0; i < 2; i++) await turnPage(a)

  await lookUpWord(a, 'lanterns')
  await a.locator('.dict-pop .dict-hl-row .swatch').nth(2).click()
  await a.waitForSelector('.dict-pop', { state: 'detached' })
  await until('the highlight to reach Drive', () => Object.values(google.data()?.annotations ?? {}).some(x => /lanterns/.test(x.text)))
  step('uploads a new highlight on its own')

  await lookUpWord(a, 'wondered')
  await a.locator('.dict-pop [aria-label="Save to vocabulary"]').click()
  await a.keyboard.press('Escape')
  for (let i = 0; i < 2; i++) await turnPage(a)
  const readTo = await label(a)
  await a.evaluate(() => document.querySelector('[aria-label="Back to library"]').click())
  await a.waitForSelector('.continue')
  await syncNow(a)

  const data = google.data()
  const book = Object.values(data.books)[0]
  assert.equal(book.title, 'Smoke Test Book')
  assert.ok(book.positionAt && book.location, 'the reading position synced')
  assert.equal(Object.keys(data.vocab).length, 1)
  const notes = google.notes()
  assert.equal(notes.length, 1)
  assert.equal(notes[0].name, 'Smoke Test Book.md')
  assert.match(notes[0].content, /^# Smoke Test Book[\s\S]*> lanterns/)
  step(`syncs the word, the place (${readTo}) and a Markdown copy of the highlights`)

  // ---------------------------------------------------------------- device B
  const b = await device('B')
  await connect(b)
  await b.locator('.nav button', { hasText: 'Highlights' }).click()
  await b.waitForSelector('.hl-card')
  assert.match(await b.locator('.hl-card .hl-quote').innerText(), /lanterns/)
  assert.match(await b.locator('.hl-book-info').innerText(), /Smoke Test Book/)
  assert.match(await b.locator('.hl-away').innerText(), /Not on this device/)
  await b.locator('.nav button', { hasText: 'Vocabulary' }).click()
  await b.waitForSelector('.vocab-page .chip')
  assert.match(await b.locator('.vocab-page .chip').innerText(), /1 word/)
  step('another device gets the highlight and word before it has the book')

  await b.locator('.nav button', { hasText: 'Library' }).click()
  await b.setInputFiles('input[type=file][multiple]', bookPath)
  await b.waitForSelector('.book', { timeout: 30_000 })
  // the import syncs, which brings the place it was read to
  await b.waitForSelector('.book .badge', { state: 'detached', timeout: 20_000 })
  await b.locator('.book').click()
  await b.waitForSelector('foliate-view')
  await b.waitForFunction(s => document.querySelector('.info-left')?.textContent === s, readTo, { timeout: 20_000 })
  step(`opens the book where the other device left off (${readTo})`)

  // A reads on while the book is still open on B
  await a.locator('.book').click()
  await a.waitForFunction(s => document.querySelector('.info-left')?.textContent === s, readTo, { timeout: 20_000 })
  await a.waitForTimeout(800)
  for (let i = 0; i < 2; i++) await turnPage(a)
  const readOn = await label(a)
  await a.evaluate(() => document.querySelector('[aria-label="Back to library"]').click())
  await a.waitForSelector('.continue')
  await syncNow(a)
  const placeOnA = Object.values(google.data().books)[0].location
  await syncInBackground(b)
  await b.locator('.toast', { hasText: 'On another device you’re at' }).waitFor({ timeout: 10_000 })
  // leaving without reading must not put B's older place back
  await b.evaluate(() => document.querySelector('[aria-label="Back to library"]').click())
  await b.waitForSelector('.continue')
  await syncInBackground(b)
  assert.equal(Object.values(google.data().books)[0].location, placeOnA)
  await b.locator('.book').click()
  await b.waitForFunction(s => document.querySelector('.info-left')?.textContent === s, readOn, { timeout: 20_000 })
  step(`an open book offers the place read to on another device (${readOn}), and closing it keeps that place`)

  await b.evaluate(() => document.querySelector('[aria-label="Back to library"]').click())
  await b.locator('.nav button', { hasText: 'Highlights' }).click()
  await b.waitForSelector('.hl-card')
  await b.locator('.hl-card [aria-label="Delete"]').click()
  await until('the deletion to reach Drive', () => Object.keys(google.data().annotations).length === 0)
  await until('the Markdown copy to be removed', () => google.notes().length === 0)

  await a.locator('.nav button', { hasText: 'Highlights' }).click()
  await a.waitForSelector('.hl-card')
  await syncNow(a)
  await a.waitForSelector('.hl-card', { state: 'detached', timeout: 10_000 })
  step('a highlight deleted on one device is deleted on the other')

  assert.equal(google.byRole('sync').length, 1)
  assert.deepEqual(errors, [])
  step('no page errors')
  console.log('\nSync test passed')
} catch (e) {
  for (const [name, page] of pages) await page.screenshot({ path: path.join(dir, `failure-${name}.png`) }).catch(() => {})
  console.error(`\nSync test failed: ${e.message}\nScreenshots: ${dir}`)
  if (errors.length) console.error('Page errors:\n' + errors.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  await new Promise(r => server.httpServer.close(r))
}
