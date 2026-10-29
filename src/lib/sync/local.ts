import { db, getMeta, type BookRecord } from '../db'
import { emptyData, stable, type SyncBook, type SyncData } from './data'

/** The last copy synced, with the Drive revision it came from. */
export interface Snapshot {
  fileId: string
  version: string
  data: SyncData
}

export const getSnapshot = () => getMeta<Snapshot>('sync')

/** A random id for this install, kept with the data it counts. */
export const getDeviceId = async () => {
  const d = await db()
  let id = await d.get('meta', 'deviceId') as string | undefined
  if (!id) {
    id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    await d.put('meta', id, 'deviceId')
  }
  return id
}

const toSyncBook = (b: BookRecord): SyncBook => ({
  id: b.id, title: b.title, author: b.author, format: b.format, fileName: b.fileName, size: b.size, addedAt: b.addedAt,
  language: b.language, pageCount: b.pageCount, progress: b.progress, location: b.location, locationLabel: b.locationLabel,
  positionAt: b.positionAt, finished: b.finished, finishedAt: b.finishedAt, lastReadAt: b.lastReadAt,
})

/** Books known from sync (including ones that are not on this device), as library records. */
export const getSyncedBooks = async (): Promise<Map<string, BookRecord>> => {
  const books = (await getSnapshot())?.data.books ?? {}
  return new Map(Object.values(books).map(b => [b.id, { ...b, readingTime: 0 }]))
}

/** Everything on this device that syncs. */
export const collectLocal = async (deviceId: string, deviceName: string): Promise<SyncData> => {
  const d = await db()
  const tx = d.transaction(['books', 'annotations', 'vocab', 'tombstones', 'stats'])
  const [books, annotations, vocab, tombstones, stats] = await Promise.all([
    tx.objectStore('books').getAll(),
    tx.objectStore('annotations').getAll(),
    tx.objectStore('vocab').getAll(),
    tx.objectStore('tombstones').getAll(),
    tx.objectStore('stats').getAll(),
  ])
  const data = emptyData()
  for (const b of books) data.books[b.id] = toSyncBook(b)
  for (const a of annotations) data.annotations[a.id] = a
  for (const v of vocab) data.vocab[v.id] = v
  for (const t of tombstones) data.deleted[t.id] = t.deletedAt
  data.devices[deviceId] = {
    name: deviceName,
    stats: Object.fromEntries(stats.filter(s => s.ms > 0).map(s => [s.date, s.ms])),
    books: Object.fromEntries(books.filter(b => b.readingTime > 0).map(b => [b.id, b.readingTime])),
  }
  return data
}

export interface Applied {
  /** books whose highlights or bookmarks changed */
  annotations: Set<string>
  books: boolean
  vocab: boolean
}

const positionOf = (b: Pick<BookRecord, 'location' | 'positionAt' | 'progress'>) => stable([b.location, b.positionAt, b.progress])
const finishOf = (b: Pick<BookRecord, 'finished' | 'finishedAt'>) => stable([!!b.finished, b.finishedAt])

/**
 * Writes the merged data to this device. `before` is what was collected for the merge: anything
 * edited here since then is left alone and goes up with the next sync.
 */
export const applyMerged = async (merged: SyncData, before: SyncData, deviceId: string): Promise<Applied> => {
  const applied: Applied = { annotations: new Set(), books: false, vocab: false }
  const d = await db()
  const tx = d.transaction(['books', 'annotations', 'vocab', 'tombstones', 'meta'], 'readwrite')

  const tombstones = tx.objectStore('tombstones')
  for (const [id, deletedAt] of Object.entries(merged.deleted)) {
    const cur = await tombstones.get(id)
    if (cur?.deletedAt !== deletedAt) await tombstones.put({ id, deletedAt })
  }

  const annotations = tx.objectStore('annotations')
  for (const a of Object.values(merged.annotations)) {
    const cur = await annotations.get(a.id)
    if (cur && cur.updatedAt > a.updatedAt) continue
    if (!cur || stable(cur) !== stable(a)) {
      await annotations.put(a)
      await tombstones.delete(`a:${a.id}`)
      applied.annotations.add(a.bookId)
    }
  }
  for (const cur of await annotations.getAll()) {
    if (merged.annotations[cur.id]) continue
    const del = merged.deleted[`a:${cur.id}`]
    if (del != null && del >= cur.updatedAt) {
      await annotations.delete(cur.id)
      applied.annotations.add(cur.bookId)
    }
  }

  const vocab = tx.objectStore('vocab')
  for (const v of Object.values(merged.vocab)) {
    const cur = await vocab.get(v.id)
    if (!cur || stable(cur) !== stable(v)) {
      await vocab.put(v)
      await tombstones.delete(`v:${v.id}`)
      applied.vocab = true
    }
  }
  for (const cur of await vocab.getAll()) {
    if (merged.vocab[cur.id]) continue
    const del = merged.deleted[`v:${cur.id}`]
    if (del != null && del >= cur.createdAt) {
      await vocab.delete(cur.id)
      applied.vocab = true
    }
  }

  const otherDevices = Object.entries(merged.devices).filter(([id]) => id !== deviceId).map(([, c]) => c)
  const books = tx.objectStore('books')
  for (const b of await books.getAll()) {
    const m = merged.books[b.id]
    if (!m) continue
    const was = before.books[b.id]
    const next: BookRecord = { ...b, lastReadAt: Math.max(b.lastReadAt ?? 0, m.lastReadAt ?? 0) || undefined }
    // moved or finished here during the sync: keep that
    if (!was || positionOf(b) === positionOf(was))
      Object.assign(next, { progress: m.progress, location: m.location, locationLabel: m.locationLabel, positionAt: m.positionAt })
    if (!was || finishOf(b) === finishOf(was)) Object.assign(next, { finished: m.finished, finishedAt: m.finishedAt })
    const other = otherDevices.reduce((n, c) => n + (c.books[b.id] ?? 0), 0)
    next.otherReadingTime = other || undefined
    if (stable({ ...b, cover: null }) !== stable({ ...next, cover: null })) {
      await books.put(next)
      applied.books = true
    }
  }

  const otherStats: Record<string, number> = {}
  for (const c of otherDevices)
    for (const [date, ms] of Object.entries(c.stats)) otherStats[date] = (otherStats[date] ?? 0) + ms
  const meta = tx.objectStore('meta')
  if (stable(await meta.get('otherStats') ?? {}) !== stable(otherStats)) {
    await meta.put(otherStats, 'otherStats')
    applied.books = true
  }

  await tx.done
  return applied
}
