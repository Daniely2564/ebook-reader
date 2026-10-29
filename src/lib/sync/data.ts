import type { Annotation, BookRecord, VocabEntry } from '../db'

export const SYNC_FORMAT = 1

/** A book as the sync file knows it: what identifies it and where you are in it, not the file or cover. */
export type SyncBook = Pick<BookRecord, 'id' | 'title' | 'author' | 'format' | 'fileName' | 'size' | 'addedAt' | 'language' | 'pageCount'
  | 'progress' | 'location' | 'locationLabel' | 'positionAt' | 'finished' | 'finishedAt' | 'lastReadAt'>

/** Counters only ever grow on the device that owns them, so each device keeps its own and the totals add up. */
export interface DeviceCounters {
  name: string
  /** reading time per day */
  stats: Record<string, number>
  /** reading time per book */
  books: Record<string, number>
}

export interface SyncData {
  app: 'lumen-reader-sync'
  format: number
  updatedAt: number
  books: Record<string, SyncBook>
  annotations: Record<string, Annotation>
  vocab: Record<string, VocabEntry>
  /** deletions: `a:<annotation id>` / `v:<vocabulary id>` → when */
  deleted: Record<string, number>
  devices: Record<string, DeviceCounters>
}

export const emptyData = (): SyncData => ({
  app: 'lumen-reader-sync', format: SYNC_FORMAT, updatedAt: 0, books: {}, annotations: {}, vocab: {}, deleted: {}, devices: {},
})

/** JSON with sorted keys, to compare copies that were built in a different order. */
export const stable = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  return `{${Object.keys(v).sort().filter(k => (v as any)[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(',')}}`
}

/** The copy changed last; on a tie, the same one on every device. */
const newer = <T>(a: T | undefined, b: T | undefined, time: (x: T) => number): T => {
  if (a === undefined) return b!
  if (b === undefined) return a
  const ta = time(a)
  const tb = time(b)
  if (ta !== tb) return ta > tb ? a : b
  return stable(a) >= stable(b) ? a : b
}

const maxOf = (a?: number, b?: number) => (a == null ? b : b == null ? a : Math.max(a, b))

/** Whichever changed `fields` last; on a tie, the same one on every device. */
const latest = (a: SyncBook, b: SyncBook, time: (x: SyncBook) => number, fields: (keyof SyncBook)[]) => {
  const ta = time(a)
  const tb = time(b)
  if (ta !== tb) return ta > tb ? a : b
  return stable(fields.map(f => a[f])) >= stable(fields.map(f => b[f])) ? a : b
}

/** Position and finished state each follow whichever device changed them last. */
const mergeBook = (remote: SyncBook | undefined, local: SyncBook | undefined): SyncBook => {
  if (!remote || !local) return (remote ?? local)!
  const posFields: (keyof SyncBook)[] = ['location', 'progress', 'locationLabel']
  // books read before sync existed have no positionAt: the one read last wins
  const pos = remote.positionAt != null || local.positionAt != null
    ? latest(remote, local, b => b.positionAt ?? -1, posFields)
    : latest(remote, local, b => b.lastReadAt ?? 0, posFields)
  const stampedFinish = remote.finishedAt != null || local.finishedAt != null
  const fin = latest(remote, local, b => b.finishedAt ?? -1, ['finished'])
  return {
    ...remote,
    ...local,
    progress: pos.progress,
    location: pos.location,
    locationLabel: pos.locationLabel,
    positionAt: pos.positionAt,
    finished: stampedFinish ? fin.finished : (remote.finished || local.finished || undefined),
    finishedAt: fin.finishedAt,
    lastReadAt: maxOf(remote.lastReadAt, local.lastReadAt),
  }
}

const maxEach = (a: Record<string, number> = {}, b: Record<string, number> = {}) => {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v)
  return out
}

/**
 * Combines two copies of the library data. Any order of merges ends in the same result, so devices
 * that sync at the same time still agree once each has synced again.
 */
export const merge = (remote: SyncData, local: SyncData): SyncData => {
  const out = emptyData()
  out.updatedAt = Math.max(remote.updatedAt, local.updatedAt)

  for (const [k, t] of [...Object.entries(remote.deleted), ...Object.entries(local.deleted)])
    out.deleted[k] = Math.max(out.deleted[k] ?? 0, t)

  for (const id of new Set([...Object.keys(remote.books), ...Object.keys(local.books)]))
    out.books[id] = mergeBook(remote.books[id], local.books[id])

  for (const id of new Set([...Object.keys(remote.annotations), ...Object.keys(local.annotations)])) {
    const a = newer(remote.annotations[id], local.annotations[id], x => x.updatedAt)
    const del = out.deleted[`a:${id}`]
    if (del != null && del >= a.updatedAt) continue
    // edited after it was deleted somewhere: it stays
    delete out.deleted[`a:${id}`]
    out.annotations[id] = a
  }

  const vocabTime = (v: VocabEntry) => v.createdAt
  const words = new Map<string, VocabEntry>()
  for (const id of new Set([...Object.keys(remote.vocab), ...Object.keys(local.vocab)])) {
    const v = newer(remote.vocab[id], local.vocab[id], vocabTime)
    const del = out.deleted[`v:${id}`]
    if (del != null && del >= vocabTime(v)) continue
    delete out.deleted[`v:${id}`]
    // the same word saved on two devices: keep the first one saved
    const key = v.word.toLowerCase()
    const other = words.get(key)
    if (other) {
      const [keep, drop] = other.createdAt < v.createdAt || (other.createdAt === v.createdAt && other.id < v.id) ? [other, v] : [v, other]
      words.set(key, keep)
      out.deleted[`v:${drop.id}`] = drop.createdAt
    } else words.set(key, v)
  }
  for (const v of words.values()) out.vocab[v.id] = v

  for (const id of new Set([...Object.keys(remote.devices), ...Object.keys(local.devices)])) {
    const r = remote.devices[id]
    const l = local.devices[id]
    out.devices[id] = {
      name: l?.name ?? r!.name,
      stats: maxEach(r?.stats, l?.stats),
      books: maxEach(r?.books, l?.books),
    }
  }
  return out
}

/** Whether two copies hold the same data (ignoring when they were written). */
export const sameData = (a: SyncData, b: SyncData) => stable({ ...a, updatedAt: 0 }) === stable({ ...b, updatedAt: 0 })

/** Reads a sync file, or throws if it isn't one this version understands. */
export const parseData = (text: string): SyncData => {
  const raw = JSON.parse(text)
  if (raw?.app !== 'lumen-reader-sync') throw new Error('The sync file in Google Drive is not a Lumen Reader file')
  if (raw.format > SYNC_FORMAT) throw new Error('Your synced data was saved by a newer version of Lumen Reader. Update the app on this device to keep syncing.')
  return { ...emptyData(), ...raw }
}
