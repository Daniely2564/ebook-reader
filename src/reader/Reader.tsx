import { ArrowLeft, Bookmark, Ellipsis, Expand, FileText, Headphones, Keyboard, ListTree, Maximize, Minimize, Minus, NotebookPen, Plus, Search, Settings2, Shrink, TextWrap, Type, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SystemBars, SystemBarsStyle } from '@capacitor/core'
import { compare as compareCFI } from '../vendor/foliate-js/epubcfi.js'
import { addReadingTime, deleteAnnotation, getAnnotations, getBook, getBookFile, putAnnotation, uid, updateBook, type Annotation, type BookRecord, type HighlightColor } from '../lib/db'
import { formatMinutesLeft, percent } from '../lib/format'
import { electron, isNative, modKey, openExternal, toggleFullscreen } from '../lib/platform'
import { getSettings, useSettings, type Settings } from '../lib/settings'
import { toast, useApp, type Route } from '../lib/store'
import { themeById } from '../lib/themes'
import { speak, stopSpeaking, ttsAvailable } from '../lib/tts'
import { useBackHandler } from '../lib/back'
import { Button, IconButton, Menu, Sheet, Spinner } from '../components/ui'
import { AnnotationMenu, DictionaryPopup, NoteDialog, SelectionMenu } from './Popovers'
import { ReadAloud, type ReadAloudState } from './read-aloud'
import { ReadAloudBar } from './ReadAloudBar'
import { SidePanel, type PanelTab } from './SidePanel'
import type { Rect } from './text'
import { TypographyPanel } from './TypographyPanel'
import type { EngineCallbacks, ReaderEngine, Relocation, SelectionInfo, TapZone } from './types'

const VIEW_KEYS: (keyof Settings)[] = ['theme', 'font', 'fontSize', 'fontWeight', 'lineHeight', 'paragraphSpacing', 'letterSpacing', 'justify', 'hyphenate',
  'overrideColors', 'margin', 'maxWidth', 'flow', 'columns', 'animated', 'runningHeads', 'pdfThemed', 'pdfScroll', 'pdfSpread', 'pdfZoom']

const isOnPage = (a: Annotation, loc: Relocation) => {
  // PDF bookmarks name a page, in both the page view and flowing text
  if (a.locator.startsWith('pdf:')) return a.locator === `pdf:${loc.page?.current}`
  if (!loc.range) return false
  try {
    return compareCFI(a.locator, loc.range.start) >= 0 && compareCFI(a.locator, loc.range.end) <= 0
  } catch {
    return false
  }
}

const locationText = (loc: Relocation | null, kind?: ReaderEngine['kind']) => {
  if (!loc?.page) return ''
  if (kind === 'pdf') return `Page ${loc.page.label ? `${loc.page.label} (${loc.page.current})` : loc.page.current} of ${loc.page.total}`
  return loc.page.label ? `Page ${loc.page.label}` : `Page ${loc.page.current} of ${loc.page.total}`
}

type NoteTarget = { annotation: Annotation } | { draft: SelectionInfo; color: HighlightColor }

/**
 * Insets of the page area that stay put while the system bars come and go (on Android
 * they hide and show with the reader's bars, which overlay the page): the largest
 * insets seen in the current orientation. Following the live insets would lay the
 * whole book out again, and move the text, every time the bars toggle.
 */
const useSteadyInsets = () => {
  const [insets, setInsets] = useState<number[] | null>(null)
  useEffect(() => {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding:var(--sat) var(--sar) var(--sab) var(--sal)'
    document.body.append(probe)
    let landscape: boolean | null = null
    let max = [0, 0, 0, 0]
    const read = () => {
      const cs = getComputedStyle(probe)
      const now = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(v => parseFloat(v) || 0)
      const wide = innerWidth > innerHeight
      max = wide === landscape ? max.map((m, i) => Math.max(m, now[i])) : now
      landscape = wide
      setInsets(prev => (prev?.every((v, i) => v === max[i]) ? prev : max))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(probe, { box: 'border-box' })
    addEventListener('resize', read)
    return () => {
      ro.disconnect()
      removeEventListener('resize', read)
      probe.remove()
    }
  }, [])
  return insets
}

export const Reader = ({ bookId, target, from }: { bookId: string; target?: string; from?: Exclude<Route, { name: 'reader' }> }) => {
  const settings = useSettings()
  const go = useApp(s => s.go)
  const refreshLibrary = useApp(s => s.refreshLibrary)
  const openSettings = useApp(s => s.openSettings)
  const stageRef = useRef<HTMLDivElement>(null)
  const insets = useSteadyInsets()

  const [book, setBook] = useState<BookRecord | null>(null)
  const [engine, setEngine] = useState<ReaderEngine | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loc, setLoc] = useState<Relocation | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [bars, setBars] = useState(true)
  const [panel, setPanel] = useState<{ open: boolean; tab: PanelTab }>({ open: false, tab: 'contents' })
  const [typo, setTypo] = useState(false)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [lookup, setLookup] = useState<{ word: string; rect: Rect; context?: string; sel: SelectionInfo | null } | null>(null)
  const [activeAnn, setActiveAnn] = useState<{ id: string; rect: Rect } | null>(null)
  const [noteFor, setNoteFor] = useState<NoteTarget | null>(null)
  const [tts, setTts] = useState<ReadAloudState>('idle')
  const [searchQuery, setSearchQuery] = useState('')
  const [returnTo, setReturnTo] = useState<{ locator: string; label: string } | null>(null)
  const [help, setHelp] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [clock, setClock] = useState(() => new Date())

  const readAloud = useRef<ReadAloud | null>(null)
  const lastActivity = useRef(Date.now())
  const locRef = useRef<Relocation | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** relocations before the book has opened restore the saved place; after that, the reader moved */
  const opened = useRef(false)
  const moved = useRef(false)
  /** the newest reading position this session knows of, to notice one synced from another device */
  const knownPosition = useRef(0)
  /** bumped to reopen the book in another view (PDF pages ↔ flowing text) */
  const [session, setSession] = useState(0)
  const reopenAt = useRef<string | null>(null)
  const narrow = typeof innerWidth === 'number' && innerWidth < 720
  const theme = themeById(settings.theme)
  const pdfBook = book?.format === 'pdf'
  const pdfFlow = pdfBook && book?.view?.pdfMode === 'flow'

  // ---------------------------------------------------------------- persistence
  const saveProgress = useCallback((r: Relocation | null, immediate = false) => {
    if (!r) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const run = () => {
      // only a place the reader moved to is saved: reopening at the saved place, or leaving
      // after another device read on, must not make this device's place the newest
      if (!moved.current) {
        updateBook(bookId, { lastReadAt: Date.now() }).catch(() => {})
        return
      }
      moved.current = false
      knownPosition.current = Date.now()
      updateBook(bookId, {
        progress: Math.min(1, r.fraction),
        location: r.locator,
        locationLabel: [r.chapter, locationText(r, r.locator.startsWith('pdf:') ? 'pdf' : 'reflowable')].filter(Boolean).join(' · '),
        lastReadAt: Date.now(),
        positionAt: knownPosition.current,
        ...(r.fraction >= 0.995 ? { finished: true } : {}),
      }).catch(() => {})
    }
    if (immediate) run()
    else saveTimer.current = setTimeout(run, 700)
  }, [bookId])

  // ---------------------------------------------------------------- overlays
  const closeOverlays = () => {
    let closed = false
    if (lookup) {
      setLookup(null)
      engine?.clearSelection()
      closed = true
    }
    if (selection) {
      setSelection(null)
      engine?.clearSelection()
      closed = true
    }
    if (activeAnn) {
      setActiveAnn(null)
      closed = true
    }
    if (typo) {
      setTypo(false)
      closed = true
    }
    if (panel.open) {
      setPanel(p => ({ ...p, open: false }))
      closed = true
    }
    return closed
  }

  const leave = () => go(from ?? { name: 'library' })
  const leaveLabel = from?.name === 'highlights' ? 'Back to highlights' : 'Back to library'

  const goLeft = () => (engine?.dir === 'rtl' ? engine?.next() : engine?.prev())
  const goRight = () => (engine?.dir === 'rtl' ? engine?.prev() : engine?.next())

  const navigate = (target: string, closePanel = true) => {
    if (loc) setReturnTo({ locator: loc.locator, label: locationText(loc, engine?.kind) || percent(loc.fraction) })
    engine?.goTo(target)
    if (closePanel) setPanel(p => ({ ...p, open: false }))
    setBars(false)
  }

  const openPanel = (tab: PanelTab) => {
    setTypo(false)
    setPanel(p => (p.open && p.tab === tab ? { ...p, open: false } : { open: true, tab }))
  }

  // ---------------------------------------------------------------- annotations
  const saveAnnotation = async (a: Annotation) => {
    const u = { ...a, updatedAt: Date.now() }
    await putAnnotation(u)
    setAnnotations(list => list.map(x => (x.id === u.id ? u : x)))
  }

  const createHighlight = async (s: SelectionInfo, color: HighlightColor, note?: string) => {
    if (!s.locator) return
    const existing = annotations.find(a => a.kind === 'highlight' && a.locator === s.locator)
    if (existing) await saveAnnotation({ ...existing, color, note: note ?? existing.note })
    else {
      const a: Annotation = {
        id: uid(), bookId, kind: 'highlight', locator: s.locator, text: s.text, color, note,
        chapter: s.chapter ?? loc?.chapter, fraction: s.fraction ?? loc?.fraction, page: s.page,
        createdAt: Date.now(), updatedAt: Date.now(),
      }
      await putAnnotation(a)
      setAnnotations(list => [...list, a])
    }
    engine?.clearSelection()
    setSelection(null)
    setLookup(null)
  }

  const removeAnnotation = async (a: Annotation) => {
    await deleteAnnotation(a.id)
    setAnnotations(list => list.filter(x => x.id !== a.id))
    setActiveAnn(null)
    toast(a.kind === 'bookmark' ? 'Bookmark removed' : 'Highlight deleted', 'info', {
      label: 'Undo',
      run: async () => {
        // newer than the deletion, which may have synced already
        const back = { ...a, updatedAt: Date.now() }
        await putAnnotation(back)
        setAnnotations(list => [...list, back])
      },
    })
  }

  const currentBookmark = useMemo(() => (loc && engine
    ? annotations.find(a => a.kind === 'bookmark' && isOnPage(a, loc))
    : undefined), [annotations, loc, engine])

  const toggleBookmark = async () => {
    if (!loc || !engine) return
    if (currentBookmark) {
      await removeAnnotation(currentBookmark)
      return
    }
    const a: Annotation = {
      id: uid(), bookId, kind: 'bookmark',
      locator: pdfBook ? `pdf:${loc.page?.current ?? 1}` : (loc.range?.start ?? loc.locator),
      text: loc.excerpt || loc.chapter || locationText(loc, engine.kind),
      chapter: loc.chapter, fraction: loc.fraction, page: pdfBook ? loc.page?.current : undefined,
      createdAt: Date.now(), updatedAt: Date.now(),
    }
    await putAnnotation(a)
    setAnnotations(list => [...list, a])
    toast('Page bookmarked', 'success')
  }

  // ---------------------------------------------------------------- read aloud
  const toggleReadAloud = async () => {
    if (!engine) return
    if (!ttsAvailable()) {
      toast('Text-to-speech is not available on this device', 'error')
      return
    }
    const s = getSettings()
    readAloud.current ??= new ReadAloud(engine, { lang: engine.language, voiceId: s.ttsVoice, rate: s.ttsRate, pitch: s.ttsPitch }, setTts)
    const ra = readAloud.current
    if (ra.state === 'idle') await ra.start().catch(e => toast(String(e?.message ?? e), 'error'))
    else if (ra.state === 'playing') ra.pause()
    else ra.resume()
  }

  useEffect(() => {
    readAloud.current?.setOptions({ voiceId: settings.ttsVoice, rate: settings.ttsRate, pitch: settings.ttsPitch })
  }, [settings.ttsVoice, settings.ttsRate, settings.ttsPitch])

  // ---------------------------------------------------------------- engine callbacks
  const handlers = useRef<EngineCallbacks>(null!)
  handlers.current = {
    onRelocate: r => {
      // the page moved (wheel, swipe, slider, links, scrolling, read aloud…): popups
      // pointing at text on the old page would float over unrelated text
      if (locRef.current && locRef.current.locator !== r.locator) {
        setSelection(null)
        setLookup(null)
        setActiveAnn(null)
        if (opened.current) moved.current = true
      }
      locRef.current = r
      lastActivity.current = Date.now()
      setLoc(r)
      saveProgress(r)
    },
    onSelection: s => {
      if (!s) {
        setSelection(null)
        return
      }
      setActiveAnn(null)
      if (s.isWord && getSettings().instantLookup) {
        setLookup({ word: s.lookup ?? s.text, rect: s.rect, context: s.context, sel: s })
        setSelection(null)
      } else {
        setSelection(s)
        setLookup(null)
      }
    },
    onAnnotationClick: (id, rect) => {
      setSelection(null)
      setLookup(null)
      setActiveAnn({ id, rect })
    },
    onTap: (zone: TapZone) => {
      lastActivity.current = Date.now()
      if (closeOverlays()) return
      if (!getSettings().tapZones || zone === 'center') {
        setBars(b => !b)
        return
      }
      setBars(false)
      if (zone === 'left') goLeft()
      else goRight()
    },
    onKey: e => onKeyRef.current(e),
    onActivity: () => {
      lastActivity.current = Date.now()
    },
    onViewChange: view => {
      updateBook(bookId, b => ({ view: { ...b.view, ...view } })).catch(() => {})
    },
    onError: msg => toast(msg, 'error'),
  }
  const callbacks = useMemo<EngineCallbacks>(() => ({
    onRelocate: r => handlers.current.onRelocate(r),
    onSelection: s => handlers.current.onSelection(s),
    onAnnotationClick: (id, rect) => handlers.current.onAnnotationClick(id, rect),
    onTap: z => handlers.current.onTap(z),
    onKey: e => handlers.current.onKey(e),
    onActivity: () => handlers.current.onActivity(),
    onViewChange: v => handlers.current.onViewChange?.(v),
    onError: m => handlers.current.onError(m),
  }), [])

  // ---------------------------------------------------------------- open the book
  useEffect(() => {
    let cancelled = false
    let eng: ReaderEngine | null = null
    const at = reopenAt.current
    reopenAt.current = null
    setEngine(null)
    setError(null)
    setLoc(null)
    opened.current = false
    moved.current = false
    ;(async () => {
      const [rec, blob] = await Promise.all([getBook(bookId), getBookFile(bookId)])
      if (!rec || !blob) throw new Error('This book could not be found in your library.')
      if (cancelled) return
      setBook(rec)
      knownPosition.current = Math.max(knownPosition.current, rec.positionAt ?? 0)
      // engines are loaded on demand to keep startup light
      if (rec.format !== 'pdf') eng = new (await import('./epub-engine')).EpubEngine(new File([blob], rec.fileName, { type: blob.type }), rec.title, callbacks)
      else {
        const data = new Uint8Array(await blob.arrayBuffer())
        const zoom = rec.view?.pdfZoom
        eng = rec.view?.pdfMode === 'flow'
          ? new (await import('./pdf-flow-engine')).PdfFlowEngine(data, rec.title, callbacks)
          : new (await import('./pdf-engine')).PdfEngine(data, callbacks, { zoom: typeof zoom === 'string' ? zoom : undefined })
      }
      if (cancelled) return
      eng.applySettings(getSettings())
      const location = at ?? rec.location
      try {
        await eng.open(stageRef.current!, location)
      } catch (e) {
        // a scanned PDF has no text to flow: fall back to its pages
        if ((e as Error)?.name !== 'FlowUnavailableError') throw e
        eng.destroy()
        eng = null
        if (cancelled) return
        toast((e as Error).message, 'error')
        await updateBook(bookId, b => ({ view: { ...b.view, pdfMode: 'pages' } }))
        reopenAt.current = location ?? null
        setSession(s => s + 1)
        return
      }
      if (cancelled) return
      // opened at a highlight (from the Highlights page): keep a way back to where reading left off
      if (target && at == null) {
        const reading = locRef.current
        await eng.goTo(target)
        if (cancelled) return
        if (reading && reading.locator !== locRef.current?.locator)
          setReturnTo({ locator: reading.locator, label: locationText(reading, eng.kind) || percent(reading.fraction) })
      }
      const anns = await getAnnotations(bookId)
      if (cancelled) return
      setAnnotations(anns)
      setEngine(eng)
      opened.current = true
      updateBook(bookId, { lastReadAt: Date.now() })
      stageRef.current?.querySelector<HTMLElement>('.pdf-scroller')?.focus({ preventScroll: true })
      setTimeout(() => !cancelled && setBars(false), 2500)
    })().catch(e => {
      console.error(e)
      if (!cancelled) setError(e instanceof Error ? e.message : String(e))
    })
    return () => {
      cancelled = true
      readAloud.current?.stop()
      readAloud.current = null
      saveProgress(locRef.current, true)
      eng?.destroy()
      refreshLibrary()
    }
  }, [bookId, session, callbacks, saveProgress, refreshLibrary]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Reopens a PDF as flowing text or as its original pages, at the same place. */
  const switchPdfView = async (flow: boolean) => {
    if (!book || !pdfBook || flow === pdfFlow) return
    reopenAt.current = locRef.current?.locator ?? null
    const view = { ...book.view, pdfMode: flow ? 'flow' : 'pages' }
    await updateBook(bookId, { view })
    setBook({ ...book, view })
    setSelection(null)
    setLookup(null)
    setActiveAnn(null)
    setReturnTo(null)
    setSession(s => s + 1)
  }

  useEffect(() => {
    engine?.setAnnotations(annotations)
  }, [engine, annotations])

  // a sync brought changes from another device
  const syncVersion = useApp(s => s.syncVersion)
  useEffect(() => {
    if (!engine || !syncVersion) return
    let alive = true
    ;(async () => {
      if (useApp.getState().syncedBooks.includes(bookId)) {
        const anns = await getAnnotations(bookId)
        if (alive) setAnnotations(anns)
      }
      const rec = await getBook(bookId)
      if (!alive || !rec?.location || (rec.positionAt ?? 0) <= knownPosition.current) return
      knownPosition.current = rec.positionAt!
      if (rec.location === locRef.current?.locator) return
      toast(`On another device you’re at ${rec.locationLabel || percent(rec.progress)}`, 'info', {
        label: 'Go there',
        run: () => navigate(rec.location!),
      })
    })().catch(() => {})
    return () => {
      alive = false
    }
  }, [engine, syncVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  const viewKey = VIEW_KEYS.map(k => String(settings[k])).join('|')
  useEffect(() => {
    engine?.applySettings(getSettings())
  }, [engine, viewKey])

  // ---------------------------------------------------------------- environment
  useEffect(() => {
    const iv = setInterval(() => {
      setClock(new Date())
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastActivity.current > 3 * 60_000 && readAloud.current?.state !== 'playing') return
      addReadingTime(bookId, 15_000).catch(() => {})
    }, 15_000)
    return () => clearInterval(iv)
  }, [bookId])

  useEffect(() => {
    if (!settings.keepAwake) return
    let lock: WakeLockSentinel | null = null
    let released = false
    const acquire = async () => {
      if (isNative) {
        const { KeepAwake } = await import('@capacitor-community/keep-awake')
        await KeepAwake.keepAwake().catch(() => {})
        return
      }
      try {
        lock = await navigator.wakeLock?.request('screen')
        if (released) lock?.release()
      } catch { /* not allowed */ }
    }
    acquire()
    const onVis = () => document.visibilityState === 'visible' && acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVis)
      lock?.release().catch(() => {})
      if (isNative) import('@capacitor-community/keep-awake').then(({ KeepAwake }) => KeepAwake.allowSleep().catch(() => {}))
    }
  }, [settings.keepAwake])

  useEffect(() => {
    if (!isNative) return
    SystemBars.setStyle({ style: theme.dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {})
    if (bars) SystemBars.show().catch(() => {})
    else SystemBars.hide().catch(() => {})
  }, [bars, theme.dark])
  useEffect(() => () => {
    if (isNative) SystemBars.show().catch(() => {})
  }, [])

  // popovers, sheets and menus render outside the reader: give them the page theme
  useEffect(() => {
    const root = document.documentElement
    const vars: Record<string, string> = {
      '--bg': theme.bg,
      '--bg-2': theme.surface,
      '--surface': theme.dark ? theme.surface : `color-mix(in srgb, ${theme.bg} 45%, #fff)`,
      '--surface-2': theme.dark ? `color-mix(in srgb, ${theme.surface} 80%, #fff 6%)` : theme.surface,
      '--text': theme.fg,
      '--muted': theme.muted,
      '--faint': theme.muted,
      '--border': theme.border,
      '--accent': theme.dark ? '#f0a35a' : '#c2621a',
      '--accent-2': theme.dark ? '#f6bd80' : '#de8838',
      '--accent-soft': theme.dark ? 'rgba(240,163,90,.15)' : 'rgba(194,98,26,.12)',
      '--accent-text': theme.dark ? '#1c1206' : '#fff',
    }
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    root.style.colorScheme = theme.dark ? 'dark' : 'light'
    return () => {
      for (const k of Object.keys(vars)) root.style.removeProperty(k)
      root.style.colorScheme = ''
    }
  }, [theme])

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    const prev = meta?.getAttribute('content')
    meta?.setAttribute('content', theme.bg)
    return () => {
      if (prev) meta?.setAttribute('content', prev)
    }
  }, [theme.bg])

  useEffect(() => {
    const update = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', update)
    const off = electron?.onFullscreen(setFullscreen)
    electron?.isFullscreen().then(setFullscreen)
    return () => {
      document.removeEventListener('fullscreenchange', update)
      off?.()
    }
  }, [])

  useEffect(() => {
    if (!returnTo) return
    const t = setTimeout(() => setReturnTo(null), 12_000)
    return () => clearTimeout(t)
  }, [returnTo])

  useEffect(() => {
    if (bars) {
      setSelection(null)
    }
  }, [bars])

  const anyOverlay = !!(lookup || selection || activeAnn || typo || panel.open)
  useBackHandler(() => closeOverlays(), anyOverlay)
  useBackHandler(leave)

  // ---------------------------------------------------------------- keyboard
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  onKeyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    if (e.defaultPrevented || t?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return
    if (document.querySelector('.sheet-backdrop')) return
    if (!engine) return
    lastActivity.current = Date.now()
    const k = e.key
    const mod = e.ctrlKey || e.metaKey
    const isPdf = engine.kind === 'pdf'
    if (k === 'Escape') {
      e.preventDefault()
      if (!closeOverlays()) {
        if (fullscreen) toggleFullscreen()
        else setBars(b => !b)
      }
      return
    }
    if (mod) {
      const key = k.toLowerCase()
      if (key === 'f') openPanel('search')
      else if (key === 'd' || key === 'b') toggleBookmark()
      else if (key === '=' || key === '+') isPdf ? engine.zoom?.('in') : getSettings().set({ fontSize: Math.min(40, getSettings().fontSize + 1) })
      else if (key === '-') isPdf ? engine.zoom?.('out') : getSettings().set({ fontSize: Math.max(12, getSettings().fontSize - 1) })
      else if (key === '0') isPdf ? engine.zoom?.('reset') : getSettings().reset(['fontSize'])
      else return
      e.preventDefault()
      return
    }
    if (e.altKey) {
      if (k === 'ArrowLeft' && engine.canGoBack()) {
        e.preventDefault()
        engine.back()
      }
      return
    }
    const nativeScroll = isPdf && getSettings().pdfScroll === 'continuous' && !!t?.closest?.('.pdf-scroller')
    let turned = true
    switch (k) {
      case 'ArrowLeft': case 'h': goLeft(); break
      case 'ArrowRight': case 'l': goRight(); break
      case 'ArrowDown': case 'j': if (nativeScroll) return; engine.next(); break
      case 'ArrowUp': case 'k': if (nativeScroll) return; engine.prev(); break
      case 'PageDown': engine.next(); break
      case 'PageUp': engine.prev(); break
      case ' ': if (e.shiftKey) engine.prev(); else engine.next(); break
      case 'Home': engine.goToFraction(0); break
      case 'End': engine.goToFraction(1); break
      default: turned = false
    }
    if (turned) {
      e.preventDefault()
      setBars(false)
      setSelection(null)
      setLookup(null)
      setActiveAnn(null)
      return
    }
    switch (k) {
      case 't': openPanel('contents'); break
      case 'n': openPanel('notes'); break
      case '/': openPanel('search'); break
      case 'b': toggleBookmark(); break
      case 'a': setPanel(p => ({ ...p, open: false })); setTypo(v => !v); break
      case 'v': if (!pdfBook) return; switchPdfView(!pdfFlow); break
      case 'f': toggleFullscreen(); break
      case 'r': toggleReadAloud(); break
      case '?': setHelp(true); break
      default: return
    }
    e.preventDefault()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---------------------------------------------------------------- render
  const activeAnnotation = activeAnn ? annotations.find(a => a.id === activeAnn.id) : undefined
  const style = {
    '--r-bg': theme.bg, '--r-fg': theme.fg, '--r-muted': theme.muted, '--r-surface': theme.surface,
    '--r-border': theme.border, '--r-link': theme.link,
    ...(insets && { '--stage-t': `${insets[0]}px`, '--stage-r': `${insets[1]}px`, '--stage-b': `${insets[2]}px`, '--stage-l': `${insets[3]}px` }),
  } as React.CSSProperties

  if (error) {
    return (
      <div className="reader-error" style={style}>
        <h2>Couldn’t open this book</h2>
        <p className="muted">{error}</p>
        <Button variant="primary" onClick={leave}><ArrowLeft size={16} />{leaveLabel}</Button>
      </div>
    )
  }

  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard'), () => toast('Copy failed', 'error'))
  const translate = (text: string) => openExternal(`https://translate.google.com/?sl=auto&tl=${settings.translateTo}&text=${encodeURIComponent(text)}&op=translate`)
  const sayText = async (text: string) => {
    if (!ttsAvailable()) return toast('Text-to-speech is not available on this device', 'error')
    await stopSpeaking()
    speak(text, { lang: engine?.language, voiceId: settings.ttsVoice, rate: settings.ttsRate }).catch(() => {})
  }

  const chapterLabel = loc?.chapter ?? ''
  const locText = locationText(loc, engine?.kind)
  const timeLeft = engine?.kind === 'reflowable' && loc?.timeLeft?.chapter != null
    ? `${formatMinutesLeft(loc.timeLeft.chapter)} left in chapter` : ''
  const isPdf = engine?.kind === 'pdf'

  const viewToggle = pdfFlow
    ? { label: 'Show original pages', icon: <FileText size={16} />, onSelect: () => switchPdfView(false) }
    : { label: 'Show as flowing text', icon: <TextWrap size={16} />, onSelect: () => switchPdfView(true) }
  const moreMenu = [
    ...(pdfBook ? [viewToggle, 'sep' as const] : []),
    { label: fullscreen ? 'Exit full screen' : 'Full screen', icon: fullscreen ? <Shrink size={16} /> : <Expand size={16} />, onSelect: () => toggleFullscreen() },
    { label: 'Keyboard shortcuts', icon: <Keyboard size={16} />, onSelect: () => setHelp(true) },
    { label: 'Settings', icon: <Settings2 size={16} />, onSelect: () => openSettings(true) },
    'sep' as const,
    {
      label: book?.finished ? 'Mark as unread' : 'Mark as finished', onSelect: async () => {
        if (!book) return
        await updateBook(bookId, { finished: !book.finished })
        setBook({ ...book, finished: !book.finished })
        toast(book.finished ? 'Marked as unread' : 'Marked as finished', 'success')
      },
    },
  ]

  return (
    <div className={`reader ${bars ? 'bars' : ''} ${theme.dark ? 'dark' : 'light'} ${isPdf ? 'is-pdf' : ''}`} style={style} data-theme-id={theme.id}>
      <div className="reader-stage" ref={stageRef} />
      {!engine && <div className="reader-loading"><Spinner size={28} /></div>}
      <div className="dimmer" style={{ opacity: 1 - settings.brightness }} />
      <div className="hot-zone top" onMouseEnter={() => !narrow && setBars(true)} />

      {settings.showClock && !bars && (
        <div className="reader-clock">{clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
      )}

      <header className="reader-bar top">
        <IconButton label={leaveLabel} onClick={leave}><ArrowLeft size={21} /></IconButton>
        <div className="reader-title">
          <div className="t1">{book?.title}</div>
          {chapterLabel && <div className="t2">{chapterLabel}</div>}
        </div>
        <div className="reader-actions">
          <IconButton className="wide-only" label="Contents (T)" active={panel.open && panel.tab === 'contents'} onClick={() => openPanel('contents')}><ListTree size={20} /></IconButton>
          <IconButton className="wide-only" label="Search (Ctrl+F)" active={panel.open && panel.tab === 'search'} onClick={() => openPanel('search')}><Search size={20} /></IconButton>
          <IconButton className="wide-only" label="Notes & highlights (N)" active={panel.open && panel.tab === 'notes'} onClick={() => openPanel('notes')}><NotebookPen size={20} /></IconButton>
          <IconButton className="wide-only" label="Read aloud (R)" active={tts !== 'idle'} onClick={toggleReadAloud}><Headphones size={20} /></IconButton>
          <IconButton className="wide-only" label="Appearance (A)" active={typo} onClick={() => { setPanel(p => ({ ...p, open: false })); setTypo(v => !v) }}><Type size={20} /></IconButton>
          <IconButton className="wide-only" label={fullscreen ? 'Exit full screen (F)' : 'Full screen (F)'} onClick={() => toggleFullscreen()}>{fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}</IconButton>
          {pdfBook && (
            <IconButton label={pdfFlow ? 'Show original pages (V)' : 'Show as flowing text (V)'} active={pdfFlow} onClick={() => switchPdfView(!pdfFlow)}>
              <TextWrap size={20} />
            </IconButton>
          )}
          <IconButton label={currentBookmark ? 'Remove bookmark (B)' : 'Bookmark this page (B)'} active={!!currentBookmark} onClick={toggleBookmark}>
            <Bookmark size={20} fill={currentBookmark ? 'currentColor' : 'none'} />
          </IconButton>
          <Menu items={moreMenu} trigger={p => <IconButton label="More" {...p}><Ellipsis size={20} /></IconButton>} />
        </div>
      </header>

      {currentBookmark && !bars && <div className="page-ribbon" aria-hidden><Bookmark size={22} fill="currentColor" /></div>}

      <footer className="reader-bar bottom">
        <div className="progress-row">
          <ProgressSlider fraction={loc?.fraction ?? 0} ticks={engine?.sectionFractions ?? []} rtl={engine?.dir === 'rtl'}
            pages={isPdf ? loc?.page?.total : undefined}
            onCommit={f => {
              if (loc) setReturnTo({ locator: loc.locator, label: locText || percent(loc.fraction) })
              engine?.goToFraction(f)
            }} />
        </div>
        <div className="info-row">
          <span className="info-left">{locText}</span>
          <span className="info-mid">{percent(loc?.fraction ?? 0)}</span>
          <span className="info-right">{timeLeft}</span>
          {isPdf && engine?.zoom && (
            <span className="zoom-ctl wide-only">
              <IconButton label="Zoom out (Ctrl −)" onClick={() => engine.zoom?.('out')}><Minus size={16} /></IconButton>
              <button className="zoom-label" onClick={() => engine.zoom?.('fit-width')} title="Fit width">{engine.zoomLabel}</button>
              <IconButton label="Zoom in (Ctrl +)" onClick={() => engine.zoom?.('in')}><Plus size={16} /></IconButton>
            </span>
          )}
        </div>
        <div className="action-row narrow-only">
          <button onClick={() => openPanel('contents')}><ListTree size={20} /><span>Contents</span></button>
          <button onClick={() => openPanel('search')}><Search size={20} /><span>Search</span></button>
          <button onClick={() => openPanel('notes')}><NotebookPen size={20} /><span>Notes</span></button>
          <button onClick={toggleReadAloud} className={tts !== 'idle' ? 'on' : ''}><Headphones size={20} /><span>Listen</span></button>
          <button onClick={() => { setPanel(p => ({ ...p, open: false })); setTypo(v => !v) }} className={typo ? 'on' : ''}><Type size={20} /><span>Display</span></button>
        </div>
      </footer>

      {returnTo && (
        <button className="return-chip" onClick={() => {
          engine?.goTo(returnTo.locator)
          setReturnTo(null)
        }}><Undo2 size={15} />Back to {returnTo.label}</button>
      )}

      {tts !== 'idle' && readAloud.current && (
        <ReadAloudBar state={tts} rate={settings.ttsRate} onToggle={toggleReadAloud} onStop={() => readAloud.current?.stop()}
          onSkip={d => readAloud.current?.skip(d)} onRate={r => settings.set({ ttsRate: r })} />
      )}

      {book && (
        <SidePanel open={panel.open} tab={panel.tab} onTab={tab => setPanel({ open: true, tab })} onClose={() => setPanel(p => ({ ...p, open: false }))}
          book={book} engine={engine} location={loc} annotations={annotations}
          onNavigate={t => navigate(t, panel.tab !== 'search' || narrow)}
          onEditNote={a => setNoteFor({ annotation: a })} onDelete={removeAnnotation}
          searchQuery={searchQuery} onSearchQuery={setSearchQuery} />
      )}

      <TypographyPanel open={typo} onClose={() => setTypo(false)} kind={engine?.kind ?? (pdfBook && !pdfFlow ? 'pdf' : 'reflowable')}
        pdfView={pdfBook ? (pdfFlow ? 'flow' : 'pages') : undefined} onPdfView={v => switchPdfView(v === 'flow')}
        onZoom={a => engine?.zoom?.(a)} zoomLabel={engine?.zoomLabel} zoomMode={engine?.zoomMode} />

      {selection && (
        <SelectionMenu rect={selection.rect} canHighlight={!!selection.locator}
          onHighlight={c => createHighlight(selection, c)}
          onNote={() => setNoteFor({ draft: selection, color: 'yellow' })}
          onDefine={() => {
            setLookup({ word: selection.lookup ?? selection.text, rect: selection.rect, context: selection.context, sel: selection })
            setSelection(null)
          }}
          onCopy={() => {
            copy(selection.text)
            engine?.clearSelection()
            setSelection(null)
          }}
          onTranslate={() => translate(selection.text)}
          onSearch={() => {
            setSearchQuery(selection.text)
            setPanel({ open: true, tab: 'search' })
            engine?.clearSelection()
            setSelection(null)
          }}
          onSpeak={() => sayText(selection.text)} />
      )}

      {activeAnn && activeAnnotation && (
        <AnnotationMenu rect={activeAnn.rect} annotation={activeAnnotation}
          onColor={c => {
            saveAnnotation({ ...activeAnnotation, color: c })
            setActiveAnn(null)
          }}
          onNote={() => {
            setNoteFor({ annotation: activeAnnotation })
            setActiveAnn(null)
          }}
          onCopy={() => {
            copy(activeAnnotation.text)
            setActiveAnn(null)
          }}
          onDefine={() => {
            setLookup({ word: activeAnnotation.text, rect: activeAnn.rect, sel: null })
            setActiveAnn(null)
          }}
          onDelete={() => removeAnnotation(activeAnnotation)} />
      )}

      {lookup && book && (
        <DictionaryPopup word={lookup.word} rect={lookup.rect} context={lookup.context} lang={engine?.language}
          bookId={bookId} bookTitle={book.title} canHighlight={!!lookup.sel?.locator}
          onHighlight={c => lookup.sel && createHighlight(lookup.sel, c)}
          onClose={() => {
            setLookup(null)
            engine?.clearSelection()
          }} />
      )}

      <NoteDialog
        annotation={noteFor ? ('annotation' in noteFor ? noteFor.annotation : { text: noteFor.draft.text, color: noteFor.color }) : null}
        onClose={() => setNoteFor(null)}
        onDelete={noteFor && 'annotation' in noteFor ? () => {
          removeAnnotation(noteFor.annotation)
          setNoteFor(null)
        } : undefined}
        onSave={async note => {
          if (!noteFor) return
          if ('annotation' in noteFor) await saveAnnotation({ ...noteFor.annotation, note: note || undefined })
          else await createHighlight(noteFor.draft, noteFor.color, note || undefined)
          setNoteFor(null)
        }} />

      <Sheet open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <dl className="shortcuts">
          {[
            ['→ / ←, Space, PgDn / PgUp', 'Next / previous page'],
            ['Home / End', 'Start / end of book'],
            ['T', 'Table of contents'],
            [`${modKey}+F or /`, 'Search in book'],
            ['N', 'Notes & highlights'],
            ['B', 'Bookmark page'],
            ['A', 'Appearance'],
            ...(pdfBook ? [['V', 'Flowing text / original pages']] : []),
            ['R', 'Read aloud'],
            ['F', 'Full screen'],
            [`${modKey} + / −`, isPdf ? 'Zoom in / out' : 'Larger / smaller text'],
            ['Alt+←', 'Go back after a jump'],
            ['Double-click a word', 'Look it up'],
            ['Esc', 'Close popups / toggle toolbars'],
          ].map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}
        </dl>
      </Sheet>
    </div>
  )
}

const ProgressSlider = ({ fraction, ticks, rtl, pages, onCommit }: {
  fraction: number
  ticks: number[]
  rtl?: boolean
  pages?: number
  onCommit: (f: number) => void
}) => {
  const [drag, setDrag] = useState<number | null>(null)
  const value = drag ?? Math.min(1, Math.max(0, fraction))
  const label = pages ? `Page ${Math.round(value * (pages - 1)) + 1}` : percent(value)
  return (
    <div className="progress-slider" dir={rtl ? 'rtl' : 'ltr'}>
      <div className="ticks" aria-hidden>
        {ticks.filter(t => t > 0.005 && t < 0.995).slice(0, 200).map((t, i) => <span key={i} style={{ insetInlineStart: `${t * 100}%` }} />)}
      </div>
      <input type="range" min={0} max={1} step={0.0005} value={value} aria-label="Reading progress"
        style={{ '--fill': `${value * 100}%` } as React.CSSProperties}
        onChange={e => setDrag(Number(e.target.value))}
        onPointerUp={() => {
          if (drag != null) onCommit(drag)
          setDrag(null)
        }}
        onKeyUp={e => {
          if (drag != null && (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')) {
            onCommit(drag)
            setDrag(null)
          }
        }} />
      {drag != null && <div className="slider-bubble" style={{ insetInlineStart: `${value * 100}%` }}>{label}</div>}
    </div>
  )
}
