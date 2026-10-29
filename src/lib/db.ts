import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export type BookFormat = 'epub' | 'pdf' | 'mobi' | 'fb2' | 'cbz'

export interface BookRecord {
  id: string
  title: string
  author: string
  format: BookFormat
  fileName: string
  size: number
  addedAt: number
  lastReadAt?: number
  /** 0…1 */
  progress: number
  /** CFI for reflowable books, `pdf:<page>` for PDFs */
  location?: string
  locationLabel?: string
  /** when the reader last moved the position (not just reopened at it); the newest one wins across devices */
  positionAt?: number
  finished?: boolean
  /** when `finished` was last set or cleared */
  finishedAt?: number
  cover?: Blob
  language?: string
  publisher?: string
  description?: string
  pageCount?: number
  /** reading time on this device */
  readingTime: number
  /** reading time on your other devices, from sync */
  otherReadingTime?: number
  /** Per-book view state (PDF zoom etc.) */
  view?: Record<string, unknown>
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

export interface Annotation {
  id: string
  bookId: string
  kind: 'highlight' | 'bookmark'
  /** CFI (reflowable) or JSON PDF locator */
  locator: string
  text: string
  note?: string
  color?: HighlightColor
  chapter?: string
  fraction?: number
  /** page number for PDFs, used for sorting */
  page?: number
  createdAt: number
  updatedAt: number
}

export interface VocabEntry {
  id: string
  word: string
  definition: string
  ipa?: string
  context?: string
  bookId?: string
  bookTitle?: string
  createdAt: number
}

export interface UserDictRecord {
  id: string
  name: string
  wordCount: number
  enabled: boolean
  order: number
  ifo: Record<string, string>
  idx: Blob
  dict: Blob
  dictZipped: boolean
  syn?: Blob
  size: number
  addedAt: number
}

interface LumenDB extends DBSchema {
  books: { key: string; value: BookRecord }
  files: { key: string; value: { id: string; blob: Blob } }
  annotations: { key: string; value: Annotation; indexes: { 'by-book': string } }
  vocab: { key: string; value: VocabEntry; indexes: { 'by-date': number } }
  dicts: { key: string; value: UserDictRecord }
  /** reading time per day on this device */
  stats: { key: string; value: { date: string; ms: number } }
  /** deleted annotations (`a:<id>`) and vocabulary (`v:<id>`), so deletions reach other devices */
  tombstones: { key: string; value: { id: string; deletedAt: number } }
  /** sync state */
  meta: { key: string; value: any }
}

let dbPromise: Promise<IDBPDatabase<LumenDB>> | null = null

export const db = () => dbPromise ??= openDB<LumenDB>('lumen-reader', 2, {
  upgrade(d, oldVersion) {
    if (oldVersion < 1) {
      d.createObjectStore('books', { keyPath: 'id' })
      d.createObjectStore('files', { keyPath: 'id' })
      d.createObjectStore('annotations', { keyPath: 'id' }).createIndex('by-book', 'bookId')
      d.createObjectStore('vocab', { keyPath: 'id' }).createIndex('by-date', 'createdAt')
      d.createObjectStore('dicts', { keyPath: 'id' })
      d.createObjectStore('stats', { keyPath: 'date' })
    }
    if (oldVersion < 2) {
      d.createObjectStore('tombstones', { keyPath: 'id' })
      d.createObjectStore('meta')
    }
  },
})

export const uid = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

// ---------------------------------------------------------------- change notifications
/** `edit`: highlights, notes, vocabulary or books changed; `position`: a reading position moved */
export type LocalChange = 'edit' | 'position'
const changeListeners = new Set<(kind: LocalChange) => void>()
export const onLocalChange = (cb: (kind: LocalChange) => void) => {
  changeListeners.add(cb)
  return () => {
    changeListeners.delete(cb)
  }
}
const changed = (kind: LocalChange) => changeListeners.forEach(cb => cb(kind))

export const getMeta = async <T>(key: string): Promise<T | undefined> => (await db()).get('meta', key)
export const setMeta = async (key: string, value: unknown) => { await (await db()).put('meta', value, key) }

// ---------------------------------------------------------------- books
export const getBooks = async () => (await db()).getAll('books')
export const getBook = async (id: string) => (await db()).get('books', id)
export const putBook = async (book: BookRecord) => { await (await db()).put('books', book) }
export const getBookFile = async (id: string) => (await (await db()).get('files', id))?.blob

/** Pass `positionAt` with a location the reader moved to; `finishedAt` is set when `finished` changes. */
export const updateBook = async (id: string, patch: Partial<BookRecord> | ((b: BookRecord) => Partial<BookRecord>)) => {
  const d = await db()
  const tx = d.transaction('books', 'readwrite')
  const book = await tx.store.get(id)
  let synced = false
  if (book) {
    const p = typeof patch === 'function' ? patch(book) : patch
    const finishedAt = 'finished' in p && !!p.finished !== !!book.finished ? { finishedAt: Date.now() } : {}
    await tx.store.put({ ...book, ...p, ...finishedAt })
    synced = 'location' in p || 'progress' in p || 'finished' in p
  }
  await tx.done
  if (synced) changed('position')
}

export const addBook = async (book: BookRecord, blob: Blob) => {
  const d = await db()
  const tx = d.transaction(['books', 'files'], 'readwrite')
  await tx.objectStore('files').put({ id: book.id, blob })
  await tx.objectStore('books').put(book)
  await tx.done
  changed('edit')
}

/** `keepNotes`: leave the book's highlights and bookmarks (synced ones come back anyway). */
export const deleteBook = async (id: string, keepNotes = false) => {
  const d = await db()
  const tx = d.transaction(['books', 'files', 'annotations'], 'readwrite')
  await tx.objectStore('books').delete(id)
  await tx.objectStore('files').delete(id)
  if (!keepNotes) {
    const idx = tx.objectStore('annotations').index('by-book')
    for (const key of await idx.getAllKeys(id)) await tx.objectStore('annotations').delete(key)
  }
  await tx.done
}

// ---------------------------------------------------------------- annotations
export const getAnnotations = async (bookId: string) =>
  (await db()).getAllFromIndex('annotations', 'by-book', bookId)
export const getAllAnnotations = async () => (await db()).getAll('annotations')
export const putAnnotation = async (a: Annotation) => {
  const tx = (await db()).transaction(['annotations', 'tombstones'], 'readwrite')
  await tx.objectStore('annotations').put(a)
  await tx.objectStore('tombstones').delete(`a:${a.id}`)
  await tx.done
  changed('edit')
}
export const deleteAnnotation = async (id: string) => {
  const tx = (await db()).transaction(['annotations', 'tombstones'], 'readwrite')
  await tx.objectStore('annotations').delete(id)
  await tx.objectStore('tombstones').put({ id: `a:${id}`, deletedAt: Date.now() })
  await tx.done
  changed('edit')
}

// ---------------------------------------------------------------- vocabulary
export const getVocab = async () => (await (await db()).getAllFromIndex('vocab', 'by-date')).reverse()
export const putVocab = async (v: VocabEntry) => {
  const tx = (await db()).transaction(['vocab', 'tombstones'], 'readwrite')
  await tx.objectStore('vocab').put(v)
  await tx.objectStore('tombstones').delete(`v:${v.id}`)
  await tx.done
  changed('edit')
}
export const deleteVocab = async (id: string) => {
  const tx = (await db()).transaction(['vocab', 'tombstones'], 'readwrite')
  await tx.objectStore('vocab').delete(id)
  await tx.objectStore('tombstones').put({ id: `v:${id}`, deletedAt: Date.now() })
  await tx.done
  changed('edit')
}

// ---------------------------------------------------------------- user dictionaries
export const getUserDicts = async () => (await (await db()).getAll('dicts')).sort((a, b) => a.order - b.order)
export const putUserDict = async (d: UserDictRecord) => { await (await db()).put('dicts', d) }
export const deleteUserDict = async (id: string) => { await (await db()).delete('dicts', id) }

// ---------------------------------------------------------------- stats
export const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const addReadingTime = async (bookId: string, ms: number) => {
  const d = await db()
  const tx = d.transaction(['books', 'stats'], 'readwrite')
  const book = await tx.objectStore('books').get(bookId)
  if (book) await tx.objectStore('books').put({ ...book, readingTime: (book.readingTime ?? 0) + ms })
  const date = todayKey()
  const day = await tx.objectStore('stats').get(date)
  await tx.objectStore('stats').put({ date, ms: (day?.ms ?? 0) + ms })
  await tx.done
}

/** Reading time per day, on this device and (from sync) your other ones. */
export const getStats = async () => {
  const own = await (await db()).getAll('stats')
  const others = await getMeta<Record<string, number>>('otherStats') ?? {}
  const all = new Map(Object.entries(others))
  for (const s of own) all.set(s.date, (all.get(s.date) ?? 0) + s.ms)
  return [...all].map(([date, ms]) => ({ date, ms }))
}

// ---------------------------------------------------------------- backup
export interface Backup {
  app: 'lumen-reader'
  version: 1
  exportedAt: string
  books: Omit<BookRecord, 'cover'>[]
  annotations: Annotation[]
  vocab: VocabEntry[]
  stats: { date: string; ms: number }[]
}

export const exportBackup = async (): Promise<Backup> => {
  const d = await db()
  const books = (await d.getAll('books')).map(({ cover: _cover, ...rest }) => rest)
  return {
    app: 'lumen-reader',
    version: 1,
    exportedAt: new Date().toISOString(),
    books,
    annotations: await d.getAll('annotations'),
    vocab: await d.getAll('vocab'),
    stats: await d.getAll('stats'),
  }
}

/** Restores reading progress, annotations, vocabulary and stats (book files are not part of backups). */
export const importBackup = async (data: Backup) => {
  if (data?.app !== 'lumen-reader') throw new Error('Not a Lumen Reader backup file')
  const d = await db()
  const tx = d.transaction(['books', 'annotations', 'vocab', 'stats'], 'readwrite')
  let restored = 0
  for (const b of data.books ?? []) {
    const existing = await tx.objectStore('books').get(b.id)
    if (existing) {
      await tx.objectStore('books').put({ ...existing, ...b, cover: existing.cover })
      restored++
    }
  }
  for (const a of data.annotations ?? []) await tx.objectStore('annotations').put(a)
  for (const v of data.vocab ?? []) await tx.objectStore('vocab').put(v)
  for (const s of data.stats ?? []) {
    const cur = await tx.objectStore('stats').get(s.date)
    await tx.objectStore('stats').put({ date: s.date, ms: Math.max(cur?.ms ?? 0, s.ms) })
  }
  await tx.done
  changed('edit')
  return restored
}
