import { addBook, getBook, type BookFormat, type BookRecord } from './db'
import { makeBook } from '../vendor/foliate-js/view.js'

const EXT: Record<string, BookFormat> = {
  epub: 'epub', pdf: 'pdf', mobi: 'mobi', azw: 'mobi', azw3: 'mobi', kf8: 'mobi', prc: 'mobi',
  fb2: 'fb2', fbz: 'fb2', cbz: 'cbz',
}
export const BOOK_ACCEPT = '.epub,.pdf,.mobi,.azw,.azw3,.kf8,.prc,.fb2,.fbz,.cbz,application/epub+zip,application/pdf'

export const formatOf = (name: string): BookFormat | null => {
  const lower = name.toLowerCase()
  if (lower.endsWith('.fb2.zip')) return 'fb2'
  return EXT[lower.split('.').pop() ?? ''] ?? null
}

const sniffFormat = async (file: Blob): Promise<BookFormat | null> => {
  const head = new Uint8Array(await file.slice(0, 68).arrayBuffer())
  const str = String.fromCharCode(...head)
  if (str.startsWith('%PDF-')) return 'pdf'
  if (str.slice(60, 68) === 'BOOKMOBI') return 'mobi'
  if (head[0] === 0x50 && head[1] === 0x4b) return 'epub'
  if (str.includes('<?xml') || str.includes('<FictionBook')) return 'fb2'
  return null
}

export const hashBlob = async (blob: Blob) => {
  const buf = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------- metadata helpers
type LangMap = string | Record<string, string> | undefined
export const formatLangMap = (x: LangMap): string => {
  if (!x) return ''
  if (typeof x === 'string') return x
  const keys = Object.keys(x)
  return x[keys[0]] ?? ''
}
const listFormat = new Intl.ListFormat('en', { style: 'short', type: 'conjunction' })
const formatContributor = (c: any): string => {
  if (!c) return ''
  if (Array.isArray(c)) return listFormat.format(c.map(formatContributor).filter(Boolean))
  return typeof c === 'string' ? c : formatLangMap(c?.name)
}
const plainText = (html?: string) => html
  ? new DOMParser().parseFromString(html, 'text/html').body.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  : ''

const titleFromFileName = (name: string) => {
  const t = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t === t.toLowerCase() ? t.replace(/\b\p{L}/gu, c => c.toUpperCase()) : t
}

/** PDF producers often leave placeholder titles behind. */
const cleanPdfTitle = (title: unknown) => {
  if (typeof title !== 'string') return ''
  const t = title.replace(/^Microsoft (Word|PowerPoint) - /i, '').replace(/\.(docx?|pptx?|odt|tex|pdf)$/i, '').trim()
  return t.length > 1 && !/^(about:blank|untitled|unknown|document\d*|title|\(anonymous\))$/i.test(t) ? t : ''
}

/** Downscales a cover image to keep the library light. */
export const shrinkCover = async (blob: Blob, maxH = 720): Promise<Blob | undefined> => {
  try {
    const bmp = await createImageBitmap(blob)
    const scale = Math.min(1, maxH / bmp.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    return await new Promise<Blob | undefined>(res => canvas.toBlob(b => res(b ?? undefined), 'image/jpeg', 0.86))
  } catch {
    return blob.size < 600_000 ? blob : undefined
  }
}

interface ExtractedMeta {
  title: string
  author: string
  language?: string
  publisher?: string
  description?: string
  cover?: Blob
  pageCount?: number
}

const extractPdf = async (file: File): Promise<ExtractedMeta> => {
  const { openPdf } = await import('./pdfjs')
  const doc = await openPdf(new Uint8Array(await file.arrayBuffer()))
  try {
    const { info } = await doc.getMetadata().catch(() => ({ info: {} as any })) as { info: any }
    const page = await doc.getPage(1)
    const vp = page.getViewport({ scale: 1 })
    const scale = 720 / vp.height
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
    const cover = await new Promise<Blob | undefined>(res => canvas.toBlob(b => res(b ?? undefined), 'image/jpeg', 0.85))
    const title = cleanPdfTitle(info?.Title)
    return {
      title: title || titleFromFileName(file.name),
      author: typeof info?.Author === 'string' ? info.Author.trim() : '',
      cover,
      pageCount: doc.numPages,
    }
  } finally {
    doc.loadingTask.destroy()
  }
}

const extractReflowable = async (file: File): Promise<ExtractedMeta> => {
  const book = await makeBook(file)
  const m = book.metadata ?? {}
  let cover: Blob | undefined
  try {
    const raw = await book.getCover?.()
    if (raw) cover = await shrinkCover(raw)
  } catch { /* no cover */ }
  const meta = {
    title: formatLangMap(m.title) || titleFromFileName(file.name),
    author: formatContributor(m.author),
    language: Array.isArray(m.language) ? m.language[0] : m.language,
    publisher: formatContributor(m.publisher),
    description: plainText(m.description).slice(0, 2000),
    cover,
  }
  book.destroy?.()
  return meta
}

export interface ImportResult {
  added: BookRecord[]
  duplicates: BookRecord[]
  failed: { name: string; error: string }[]
}

export const importBooks = async (files: File[], onProgress?: (done: number, total: number) => void): Promise<ImportResult> => {
  const result: ImportResult = { added: [], duplicates: [], failed: [] }
  let done = 0
  for (const f of files) {
    try {
      const format = formatOf(f.name) ?? await sniffFormat(f)
      if (!format) throw new Error('Unsupported file type')
      const file = formatOf(f.name) ? f : new File([f], `${f.name}.${format}`, { type: f.type })
      const id = await hashBlob(file)
      const existing = await getBook(id)
      if (existing) {
        result.duplicates.push(existing)
        continue
      }
      const meta = format === 'pdf' ? await extractPdf(file) : await extractReflowable(file)
      const record: BookRecord = {
        id,
        format,
        fileName: file.name,
        size: file.size,
        addedAt: Date.now(),
        progress: 0,
        readingTime: 0,
        ...meta,
      }
      await addBook(record, new Blob([file], { type: file.type }))
      result.added.push(record)
    } catch (e) {
      console.error('Import failed', f.name, e)
      result.failed.push({ name: f.name, error: e instanceof Error ? e.message : String(e) })
    } finally {
      onProgress?.(++done, files.length)
    }
  }
  return result
}
