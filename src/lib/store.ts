import { create } from 'zustand'

export type Route =
  | { name: 'library' }
  | { name: 'highlights' }
  | { name: 'vocab' }
  | { name: 'dictionary'; word?: string }
  /** `target`: a place to show instead of the reading position; `from`: the page to go back to */
  | { name: 'reader'; bookId: string; target?: string; from?: Exclude<Route, { name: 'reader' }> }

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'success' | 'error'
  action?: { label: string; run: () => void }
}

interface AppStore {
  route: Route
  settingsOpen: boolean
  settingsSection: string
  toasts: Toast[]
  libraryVersion: number
  importing: { done: number; total: number } | null
  /** bumped when a sync brought changes from another device */
  syncVersion: number
  /** books whose highlights or bookmarks the last sync changed */
  syncedBooks: string[]
  go: (route: Route) => void
  openSettings: (open: boolean, section?: string) => void
  toast: (message: string, kind?: Toast['kind'], action?: Toast['action']) => void
  dismiss: (id: number) => void
  refreshLibrary: () => void
  setImporting: (v: AppStore['importing']) => void
  synced: (books: string[]) => void
}

let toastId = 0

export const useApp = create<AppStore>(set => ({
  route: { name: 'library' },
  settingsOpen: false,
  settingsSection: 'general',
  toasts: [],
  libraryVersion: 0,
  importing: null,
  syncVersion: 0,
  syncedBooks: [],
  go: route => set({ route }),
  openSettings: (settingsOpen, section) => set(section ? { settingsOpen, settingsSection: section } : { settingsOpen }),
  toast: (message, kind = 'info', action) => {
    const id = ++toastId
    set(s => ({ toasts: [...s.toasts.slice(-3), { id, message, kind, action }] }))
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), action ? 6000 : 3800)
  },
  dismiss: id => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
  refreshLibrary: () => set(s => ({ libraryVersion: s.libraryVersion + 1 })),
  setImporting: importing => set({ importing }),
  synced: syncedBooks => set(s => ({ syncVersion: s.syncVersion + 1, syncedBooks })),
}))

export const toast = (...args: Parameters<AppStore['toast']>) => useApp.getState().toast(...args)
