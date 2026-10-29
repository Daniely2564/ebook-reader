// Sends highlights to Dotion (a Notion-style notes app) through its REST API, documented at
// <address>/developers. The API sends no CORS headers, so requests go through Electron's main
// process or Android's native HTTP; a browser can only reach a Dotion server that allows its origin.
import { CapacitorHttp } from '@capacitor/core'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Annotation, BookRecord } from './db'
import { electron, isNative } from './platform'

export const DOTION_URL = 'https://dotion-note.vercel.app'

/** Where highlights go: a database (one row per book) or one existing page. */
export interface DotionTarget {
  kind: 'database' | 'page'
  id: string
  name: string
}

interface DotionState {
  url: string
  token: string
  /** who the token belongs to, once it has been checked */
  user: string | null
  target: DotionTarget | null
}

export const useDotion = create<DotionState>()(persist((): DotionState => ({
  url: DOTION_URL,
  token: '',
  user: null,
  target: null,
}), {
  name: 'lumen-dotion',
  storage: createJSONStorage(() => localStorage),
}))

export class DotionError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const base = () => useDotion.getState().url.trim().replace(/\/+$/, '') || DOTION_URL

const request = async (method: string, path: string, body?: unknown): Promise<any> => {
  const { token } = useDotion.getState()
  if (!token) throw new DotionError(401, 'Add your Dotion API token in Settings → Dotion')
  const url = base() + path
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let status: number
  let text: string
  try {
    if (electron?.dotionRequest) {
      ({ status, body: text } = await electron.dotionRequest({ url, method, headers, body: body === undefined ? undefined : JSON.stringify(body) }))
    } else if (isNative) {
      const res = await CapacitorHttp.request({ url, method, headers, data: body })
      status = res.status
      text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? null)
    } else {
      const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      status = res.status
      text = await res.text()
    }
  } catch (e) {
    throw new DotionError(0, electron || isNative
      ? `Can’t reach Dotion (${e instanceof Error ? e.message : e}). Check the address and your connection.`
      : 'This browser can’t reach Dotion directly. Send highlights from the desktop or Android app.')
  }
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch { /* not JSON */ }
  if (status >= 400) {
    const message = json?.error?.message
    throw new DotionError(status, status === 401 ? 'Dotion didn’t accept this API token.' : message || `Dotion answered with error ${status}`)
  }
  return json
}

// responses are read loosely: ids may be `id` or `_id`, lists may come bare or wrapped
const idOf = (x: any) => String(x?.id ?? x?._id ?? '')
const titleOf = (x: any) => String(x?.title ?? x?.name ?? '').trim()
const listIn = (r: any, ...keys: string[]): any[] => Array.isArray(r) ? r : keys.map(k => r?.[k]).find(Array.isArray) ?? []

export interface DotionDatabase {
  id: string
  name: string
  workspace: string
}

/** Checks the token: whose it is, and the databases it can add rows to. */
export const loadAccount = async () => {
  const me = await request('GET', '/api/v1/me')
  const u = me?.user ?? me
  const user = String(u?.name || u?.username || u?.email || 'your account')
  const workspaces = listIn(me, 'workspaces')
  const names = new Map(workspaces.map(w => [idOf(w), titleOf(w)]))
  let found = [...listIn(me, 'databases'), ...workspaces.flatMap(w => listIn(w, 'databases').map(d => ({ workspaceName: titleOf(w), ...d })))]
  if (!found.length) {
    const all = listIn(await request('GET', '/api/v1/databases'), 'databases', 'results', 'data')
    found = all.filter(d => !/^(viewer|reader|comment(er)?)$/i.test(String(d.role ?? '')))
  }
  const databases = new Map<string, DotionDatabase>()
  for (const d of found) {
    const id = idOf(d)
    if (!id || databases.has(id)) continue
    const workspace = titleOf(d.workspace) || String(d.workspaceName ?? '') || names.get(String(d.workspaceId ?? d.workspace ?? '')) || ''
    databases.set(id, { id, name: titleOf(d) || 'Untitled database', workspace })
  }
  useDotion.setState({ user })
  return { user, databases: [...databases.values()] }
}

export interface DotionPage {
  id: string
  title: string
  where: string
}

export const searchPages = async (q: string): Promise<DotionPage[]> => {
  const r = await request('GET', `/api/v1/search?q=${encodeURIComponent(q)}&limit=20`)
  return listIn(r, 'results', 'notes', 'pages', 'items', 'data').map(x => ({
    id: idOf(x),
    title: titleOf(x) || 'Untitled',
    where: titleOf(x.database) || String(x.databaseName ?? '') || titleOf(x.workspace) || String(x.workspaceName ?? ''),
  })).filter(p => p.id)
}

/** A page's id in a pasted Dotion link (or the id itself). */
export const pageIdIn = (text: string) =>
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{24}\b/i.exec(text)?.[0] ?? null

export const getPage = async (id: string) => {
  const r = await request('GET', `/api/v1/notes/${encodeURIComponent(id)}`)
  const n = r?.note ?? r
  return { id: idOf(n) || id, title: titleOf(n), markdown: String(n?.content ?? n?.markdown ?? n?.body ?? ''), url: n?.url as string | undefined }
}

// ---------------------------------------------------------------- what gets sent

type Book = Pick<BookRecord, 'title' | 'author'>

const where = (a: Annotation) => a.page ? `p. ${a.page}` : a.fraction != null ? `${Math.round(a.fraction * 100)}%` : ''

/** Highlights as quotes under their chapters, each followed by its note and place. */
export const highlightsMarkdown = (items: Annotation[], { heading, author }: { heading?: string; author?: string } = {}) => {
  const lines: string[] = []
  if (heading) lines.push(`## ${heading}`, '')
  if (author) lines.push(`*${author}*`, '')
  let chapter: string | undefined
  for (const a of items) {
    if (a.chapter && a.chapter !== chapter) {
      chapter = a.chapter
      lines.push(`### ${chapter}`, '')
    }
    lines.push(...a.text.trim().split('\n').map(l => `> ${l}`), '')
    if (a.note) lines.push(`**Note:** ${a.note.trim()}`, '')
    // keeps quotes apart, so each one reads back as its own
    lines.push(`*— ${where(a) || new Date(a.createdAt).toLocaleDateString()}*`, '')
  }
  return lines.join('\n')
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** The text of every quote on a page, to tell which highlights are there already. */
const quotesIn = (markdown: string) => {
  const quotes: string[] = []
  let block: string[] | null = null
  for (const line of [...markdown.split('\n'), '']) {
    const m = /^\s*>\s?(.*)$/.exec(line)
    if (m) (block ??= []).push(m[1])
    else if (block) {
      quotes.push(norm(block.join(' ')))
      block = null
    }
  }
  return quotes
}

const isOn = (a: Annotation, quotes: string[]) => {
  const t = norm(a.text)
  // a long highlight may come back inside a longer quote; short ones must match a whole quote
  return quotes.some(q => q === t || (t.length >= 24 && q.includes(t)))
}

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export interface SendResult {
  book: string
  status: 'created' | 'added' | 'unchanged' | 'failed'
  count: number
  url?: string
  error?: string
}

/**
 * Sends each book's highlights. Nothing in Dotion is replaced or removed: a book's page is
 * created, or only the highlights it doesn't have yet are added at its end.
 */
export const sendToDotion = async (groups: { book: Book; items: Annotation[] }[], target: DotionTarget,
  onProgress?: (done: number, total: number) => void): Promise<SendResult[]> => {
  const results: SendResult[] = []
  onProgress?.(0, groups.length)

  if (target.kind === 'page') {
    const page = await getPage(target.id)
    const quotes = quotesIn(page.markdown)
    const parts: string[] = []
    for (const { book, items } of groups) {
      const fresh = items.filter(a => !isOn(a, quotes))
      if (!fresh.length) results.push({ book: book.title, status: 'unchanged', count: 0, url: page.url })
      else {
        const own = sameTitle(page.title, book.title)
        const first = fresh.length === items.length
        parts.push(highlightsMarkdown(fresh, {
          heading: own ? (first ? 'Highlights from Lumen Reader' : undefined) : book.title,
          author: !own && first ? book.author : undefined,
        }))
        results.push({ book: book.title, status: 'added', count: fresh.length, url: page.url })
      }
    }
    if (parts.length) await request('PATCH', `/api/v1/notes/${encodeURIComponent(page.id)}`, { content: parts.join('\n'), append: true })
    onProgress?.(groups.length, groups.length)
    return results
  }

  for (const [i, { book, items }] of groups.entries()) {
    try {
      const found = listIn(await request('POST', `/api/v1/databases/${encodeURIComponent(target.id)}/query`, {
        filters: [{ property: 'title', op: 'is', value: book.title }], includeDone: true, limit: 10,
      }), 'rows', 'results', 'items', 'data')
      const row = found.find(r => sameTitle(titleOf(r), book.title))
      if (!row) {
        const r = await request('POST', `/api/v1/databases/${encodeURIComponent(target.id)}/rows`, {
          title: book.title, content: highlightsMarkdown(items, { author: book.author }),
        })
        results.push({ book: book.title, status: 'created', count: items.length, url: (r?.row ?? r)?.url })
      } else {
        const page = await getPage(idOf(row))
        const quotes = quotesIn(page.markdown)
        const fresh = items.filter(a => !isOn(a, quotes))
        if (fresh.length) {
          const heading = fresh.length === items.length ? 'Highlights from Lumen Reader' : undefined
          await request('PATCH', `/api/v1/notes/${encodeURIComponent(page.id)}`, { content: highlightsMarkdown(fresh, { heading }), append: true })
        }
        results.push({ book: book.title, status: fresh.length ? 'added' : 'unchanged', count: fresh.length, url: row.url ?? page.url })
      }
    } catch (e) {
      // a bad token or address fails every book alike
      if (e instanceof DotionError && (e.status === 0 || e.status === 401)) throw e
      results.push({ book: book.title, status: 'failed', count: 0, error: e instanceof Error ? e.message : String(e) })
    }
    onProgress?.(i + 1, groups.length)
  }
  return results
}
