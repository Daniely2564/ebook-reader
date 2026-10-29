import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { annotationsToMarkdown } from '../annotations'
import { getMeta, onLocalChange, setMeta, type Annotation } from '../db'
import { safeFileName } from '../format'
import { electron, isAndroid } from '../platform'
import { toast, useApp } from '../store'
import { emptyData, merge, parseData, sameData, stable, type SyncData } from './data'
import { builtInClient, Drive, SignedOutError, revoke, type DriveFile, type GoogleClient, type Tokens } from './google'
import { applyMerged, collectLocal, getDeviceId, getSnapshot } from './local'

interface SyncState {
  /** an OAuth client entered in Settings, for builds without one */
  clientId: string
  clientSecret: string
  refreshToken: string | null
  account: string | null
  /** also keep one Markdown file of highlights per book in Drive */
  exportNotes: boolean
  lastSyncAt: number | null
  folderId: string | null
  // not saved
  status: 'idle' | 'syncing' | 'offline' | 'error'
  error: string | null
}

export const useSync = create<SyncState>()(persist((): SyncState => ({
  clientId: '',
  clientSecret: '',
  refreshToken: null,
  account: null,
  exportNotes: true,
  lastSyncAt: null,
  folderId: null,
  status: 'idle',
  error: null,
}), {
  name: 'lumen-sync',
  storage: createJSONStorage(() => localStorage),
  partialize: ({ status: _s, error: _e, ...rest }) => rest,
}))

export const googleClient = (): GoogleClient | null => {
  if (builtInClient) return builtInClient
  const { clientId, clientSecret } = useSync.getState()
  return clientId ? { id: clientId, secret: clientSecret } : null
}

export const isSyncOn = () => !!useSync.getState().refreshToken && !!googleClient()

const deviceName = () => isAndroid ? 'Android'
  : electron ? ({ darwin: 'Mac', win32: 'Windows PC', linux: 'Linux PC' } as Record<string, string>)[electron.platform] ?? 'Computer'
    : 'Web browser'

let drive: Drive | null = null
const getDrive = () => {
  const client = googleClient()
  const { refreshToken } = useSync.getState()
  if (!client || !refreshToken) return null
  return drive ??= new Drive(client, refreshToken)
}

// ---------------------------------------------------------------- connecting

export const connect = async (client: GoogleClient, tokens: Tokens) => {
  drive = new Drive(client, tokens.refreshToken, tokens)
  useSync.setState({ refreshToken: tokens.refreshToken, status: 'idle', error: null, lastSyncAt: null })
  // maybe another account: check its Markdown files
  await setMeta('notesExported', null)
  const user = await drive.user().catch(() => null)
  useSync.setState({ account: user?.emailAddress ?? user?.displayName ?? null })
  await syncNow()
}

/** Stops syncing on this device. Data stays here and in Drive. */
export const disconnect = async () => {
  const { refreshToken } = useSync.getState()
  drive = null
  useSync.setState({ refreshToken: null, account: null, status: 'idle', error: null, lastSyncAt: null, folderId: null })
  if (refreshToken) await revoke(refreshToken)
}

// ---------------------------------------------------------------- syncing

let running: Promise<void> | null = null
let again = false
let warnedSignedOut = false

/** Syncs now (or right after the sync in progress). */
export const syncNow = (): Promise<void> => {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    try {
      do {
        again = false
        await syncOnce()
      } while (again)
    } finally {
      running = null
    }
  })()
  return running
}

const syncOnce = async () => {
  const d = getDrive()
  if (!d) return
  useSync.setState({ status: 'syncing' })
  try {
    const deviceId = await getDeviceId()
    const local = await collectLocal(deviceId, deviceName())
    const snap = await getSnapshot()

    // the sync file: the one used last time, or the oldest one found (two devices may have made one each)
    let file = snap?.fileId ? await d.get(snap.fileId) : null
    let extra: DriveFile[] = []
    if (!file) [file = null, ...extra] = await d.byRole('sync')
    let remote = !file ? emptyData()
      : snap?.fileId === file.id && snap.version === file.version ? snap.data
        : parseData(await d.read(file.id))
    for (const f of extra) remote = merge(remote, parseData(await d.read(f.id)))

    const merged = merge(remote, local)
    const applied = await applyMerged(merged, local, deviceId)

    if (!file || extra.length || !sameData(merged, remote)) {
      merged.updatedAt = Date.now()
      const text = JSON.stringify(merged)
      if (file) file = await d.update(file.id, text, 'application/json')
      else file = await d.create({ name: 'lumen-sync.json', parents: [await rootFolder(d)], appProperties: { lumen: 'sync' } }, text, 'application/json')
      for (const f of extra) await d.trash(f.id)
    }
    await setMeta('sync', { fileId: file.id, version: file.version ?? '', data: merged })
    if (!useSync.getState().folderId) await rootFolder(d)
    if (useSync.getState().exportNotes) await exportNotes(d, merged).catch(e => console.warn('Saving highlights to Drive failed', e))

    useSync.setState({ status: 'idle', error: null, lastSyncAt: Date.now() })
    warnedSignedOut = false
    if (applied.books || applied.annotations.size || applied.vocab) {
      useApp.getState().refreshLibrary()
      useApp.getState().synced([...applied.annotations])
    }
  } catch (e) {
    console.warn('Sync failed', e)
    if (e instanceof SignedOutError) {
      drive = null
      useSync.setState({ status: 'error', error: e.message, refreshToken: null })
      if (!warnedSignedOut) toast(e.message, 'error', { label: 'Settings', run: () => useApp.getState().openSettings(true, 'sync') })
      warnedSignedOut = true
    } else if (e instanceof TypeError || !navigator.onLine) useSync.setState({ status: 'offline', error: null })
    else useSync.setState({ status: 'error', error: e instanceof Error ? e.message : String(e) })
  }
}

const rootFolder = async (d: Drive) => {
  const id = await d.folder('root', 'Lumen Reader')
  useSync.setState({ folderId: id })
  return id
}

const shortHash = async (text: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest).slice(0, 12), b => b.toString(16).padStart(2, '0')).join('')
}

/** One Markdown file per book in "Lumen Reader/Highlights", for reading notes in Drive or other apps. */
const exportNotes = async (d: Drive, data: SyncData) => {
  const groups = new Map<string, Annotation[]>()
  for (const a of Object.values(data.annotations))
    if (a.kind === 'highlight' && data.books[a.bookId]) groups.set(a.bookId, [...(groups.get(a.bookId) ?? []), a])
  const docs = new Map([...groups].map(([id, list]) => {
    const book = data.books[id]
    return [id, { name: `${safeFileName(book.title)}.md`, text: annotationsToMarkdown(book, list) }]
  }))
  const key = await shortHash(stable([...docs].sort(([a], [b]) => (a < b ? -1 : 1))))
  if (key === await getMeta('notesExported')) return

  const files = new Map((await d.byRole('book-notes')).map(f => [f.appProperties?.book ?? '', f]))
  let folder = ''
  for (const [bookId, doc] of docs) {
    const hash = await shortHash(doc.text)
    const f = files.get(bookId)
    if (!f) {
      folder ||= await d.folder('notes', 'Highlights', await rootFolder(d))
      await d.create({ name: doc.name, parents: [folder], appProperties: { lumen: 'book-notes', book: bookId, hash } }, doc.text, 'text/markdown')
    } else if (f.appProperties?.hash !== hash || f.name !== doc.name)
      await d.update(f.id, doc.text, 'text/markdown', { name: doc.name, appProperties: { hash } })
  }
  for (const [bookId, f] of files) if (!docs.has(bookId)) await d.trash(f.id)
  await setMeta('notesExported', key)
}

// ---------------------------------------------------------------- when to sync

let timer: ReturnType<typeof setTimeout> | null = null
let due = Infinity

/** Syncs in `delay` ms, unless one is already due sooner. */
export const requestSync = (delay = 0) => {
  if (!isSyncOn()) return
  const at = Date.now() + delay
  if (timer && at >= due) return
  if (timer) clearTimeout(timer)
  due = at
  timer = setTimeout(() => {
    timer = null
    due = Infinity
    syncNow()
  }, delay)
}

let started = false

/** Syncs on start, a few seconds after changes, when the app comes back and every few minutes. */
export const startSync = () => {
  if (started) return
  started = true
  // highlights and notes go up quickly; page turns are batched
  onLocalChange(kind => requestSync(kind === 'edit' ? 2_000 : 30_000))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (timer) requestSync(0)
    } else if (Date.now() - (useSync.getState().lastSyncAt ?? 0) > 60_000) requestSync(300)
  })
  addEventListener('online', () => requestSync(1_000))
  setInterval(() => document.visibilityState === 'visible' && requestSync(0), 5 * 60_000)
  requestSync(800)
}
