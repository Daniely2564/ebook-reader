import { App as CapApp } from '@capacitor/app'
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core'
import { BookA, CircleCheck, CircleAlert, Info, Library as LibraryIcon, Settings, Star, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BOOK_ACCEPT, formatOf, importBooks } from './lib/books'
import { runBack } from './lib/back'
import { electron, isNative } from './lib/platform'
import { useSettings } from './lib/settings'
import { toast, useApp } from './lib/store'
import { DictionaryPage } from './dictionary/DictionaryPage'
import { Library } from './library/Library'
import { Reader } from './reader/Reader'
import { SettingsModal } from './settings/SettingsModal'
import { Vocabulary } from './vocab/Vocabulary'

const useResolvedTheme = () => {
  const appTheme = useSettings(s => s.appTheme)
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => setSystemDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return appTheme === 'system' ? (systemDark ? 'dark' : 'light') : appTheme
}

export const App = () => {
  const route = useApp(s => s.route)
  const go = useApp(s => s.go)
  const openSettings = useApp(s => s.openSettings)
  const refreshLibrary = useApp(s => s.refreshLibrary)
  const setImporting = useApp(s => s.setImporting)
  const theme = useResolvedTheme()
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#141417' : '#f6f1e7')
    if (isNative && route.name !== 'reader')
      SystemBars.setStyle({ style: theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {})
  }, [theme, route.name])

  const handleFiles = useCallback(async (files: File[], openFirst = false) => {
    const books = files.filter(f => formatOf(f.name) || /pdf|epub|mobipocket|fictionbook|comicbook/.test(f.type) || !f.name.includes('.'))
    if (!books.length) {
      toast('No supported books found. Lumen opens EPUB, PDF, MOBI/AZW3, FB2 and CBZ files.', 'error')
      return
    }
    setImporting({ done: 0, total: books.length })
    const res = await importBooks(books, (done, total) => setImporting({ done, total }))
    setImporting(null)
    refreshLibrary()
    if (res.added.length) toast(res.added.length === 1 ? `Added “${res.added[0].title}”` : `Added ${res.added.length} books`, 'success')
    if (res.duplicates.length && !openFirst) toast(res.duplicates.length === 1 ? `“${res.duplicates[0].title}” is already in your library` : `${res.duplicates.length} books were already in your library`)
    for (const f of res.failed) toast(`Couldn’t add ${f.name}: ${f.error}`, 'error')
    if (openFirst) {
      const b = res.added[0] ?? res.duplicates[0]
      if (b) go({ name: 'reader', bookId: b.id })
    }
  }, [go, refreshLibrary, setImporting])

  const openImport = () => fileInput.current?.click()

  // drag & drop anywhere
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length) handleFiles(files, files.length === 1)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [handleFiles])

  // desktop: files opened with the app, menu commands
  useEffect(() => {
    if (!electron) return
    const offFiles = electron.onOpenFiles(files => handleFiles(files.map(f => new File([f.data as Uint8Array<ArrayBuffer>], f.name)), true))
    const offMenu = electron.onMenu(action => {
      if (action === 'import') fileInput.current?.click()
      else if (action === 'library') go({ name: 'library' })
      else if (action === 'settings') openSettings(true)
    })
    return () => {
      offFiles()
      offMenu()
    }
  }, [handleFiles, go, openSettings])

  // web: Ctrl/Cmd+O to import
  useEffect(() => {
    if (electron) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        fileInput.current?.click()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Android: "Open with Lumen", back button
  useEffect(() => {
    if (!isNative) return
    const openUrl = async (url?: string) => {
      if (!url || !/^(content|file):/.test(url)) return
      try {
        const res = await fetch(Capacitor.convertFileSrc(url))
        const blob = await res.blob()
        const raw = decodeURIComponent(url.split('/').pop() ?? '')
        const name = formatOf(raw) ? raw.split(/[:/]/).pop()! : 'Shared book'
        handleFiles([new File([blob], name, { type: blob.type })], true)
      } catch (e) {
        toast(`Couldn’t open the file: ${e instanceof Error ? e.message : e}`, 'error')
      }
    }
    CapApp.getLaunchUrl().then(r => openUrl(r?.url)).catch(() => {})
    const subs = [
      CapApp.addListener('appUrlOpen', ({ url }) => openUrl(url)),
      CapApp.addListener('backButton', () => {
        if (document.querySelector('.sheet-backdrop')) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
          return
        }
        if (runBack()) return
        if (useApp.getState().route.name !== 'library') go({ name: 'library' })
        else CapApp.minimizeApp()
      }),
    ]
    return () => {
      subs.forEach(p => p.then(s => s.remove()))
    }
  }, [handleFiles, go])

  return (
    <div className="app">
      {route.name === 'reader' ? (
        <Reader key={route.bookId} bookId={route.bookId} target={route.target} />
      ) : (
        <div className="shell">
          <nav className="nav">
            <div className="brand">
              <img src="./icon.svg" alt="" width={30} height={30} />
              <span>Lumen</span>
            </div>
            <button className={route.name === 'library' ? 'on' : ''} onClick={() => go({ name: 'library' })}><LibraryIcon size={20} /><span>Library</span></button>
            <button className={route.name === 'vocab' ? 'on' : ''} onClick={() => go({ name: 'vocab' })}><Star size={20} /><span>Vocabulary</span></button>
            <button className={route.name === 'dictionary' ? 'on' : ''} onClick={() => go({ name: 'dictionary' })}><BookA size={20} /><span>Dictionary</span></button>
            <span className="nav-spacer" />
            <button onClick={() => openSettings(true)}><Settings size={20} /><span>Settings</span></button>
          </nav>
          <main className="main">
            {route.name === 'library' && <Library onImport={openImport} />}
            {route.name === 'vocab' && <Vocabulary />}
            {route.name === 'dictionary' && <DictionaryPage initial={route.word} />}
          </main>
        </div>
      )}
      <SettingsModal />
      <Toasts />
      <input ref={fileInput} type="file" multiple hidden accept={isNative ? undefined : BOOK_ACCEPT}
        onChange={e => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) handleFiles(files, files.length === 1 && route.name !== 'library')
        }} />
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card"><Upload size={36} /><h2>Drop to add to your library</h2><p>EPUB · PDF · MOBI · AZW3 · FB2 · CBZ</p></div>
        </div>
      )}
    </div>
  )
}

const Toasts = () => {
  const toasts = useApp(s => s.toasts)
  const dismiss = useApp(s => s.dismiss)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'success' ? <CircleCheck size={18} /> : t.kind === 'error' ? <CircleAlert size={18} /> : <Info size={18} />}
          <span>{t.message}</span>
          {t.action && <button className="toast-action" onClick={() => { t.action!.run(); dismiss(t.id) }}>{t.action.label}</button>}
          <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}><X size={15} /></button>
        </div>
      ))}
    </div>
  )
}
