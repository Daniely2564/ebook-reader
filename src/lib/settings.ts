import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export interface Settings {
  // app
  appTheme: 'system' | 'light' | 'dark'
  librarySort: 'recent' | 'added' | 'title' | 'author' | 'progress'
  libraryView: 'grid' | 'list'
  libraryFilter: 'all' | 'reading' | 'unread' | 'finished'
  highlightsGroup: 'book' | 'recent'

  // reflowable text
  theme: string
  font: string
  fontSize: number
  fontWeight: number
  lineHeight: number
  paragraphSpacing: number
  letterSpacing: number
  justify: boolean
  hyphenate: boolean
  overrideColors: 'auto' | 'always' | 'never'
  margin: number
  maxWidth: number
  flow: 'paginated' | 'scrolled'
  columns: 1 | 2
  animated: boolean
  runningHeads: boolean

  // pdf
  pdfThemed: boolean
  pdfScroll: 'continuous' | 'paged'
  pdfSpread: 'none' | 'odd'
  pdfZoom: string

  // general reading
  tapZones: boolean
  brightness: number
  showClock: boolean
  keepAwake: boolean

  // dictionary
  instantLookup: boolean
  onlineLookup: boolean
  /** the reader's own language: bilingual dictionary, translations, Translate button */
  translateTo: string
  /** last dictionary tab picked, per book language ("en", "fr", …) */
  dictTabs: Record<string, string>
  /** built-in dictionaries turned off in Settings */
  dictDisabled: string[]

  // read aloud
  ttsVoice: string
  ttsRate: number
  ttsPitch: number
}

const navLang = navigator.language || 'en'
const defaultLang = navLang.startsWith('zh') ? (/TW|HK|MO|Hant/i.test(navLang) ? 'zh-TW' : 'zh-CN') : navLang.split('-')[0]

export const DEFAULT_SETTINGS: Settings = {
  appTheme: 'system',
  librarySort: 'recent',
  libraryView: 'grid',
  libraryFilter: 'all',
  highlightsGroup: 'book',

  theme: 'paper',
  font: 'literata',
  fontSize: 19,
  fontWeight: 400,
  lineHeight: 1.6,
  paragraphSpacing: 0.4,
  letterSpacing: 0,
  justify: true,
  hyphenate: true,
  overrideColors: 'auto',
  margin: 7,
  maxWidth: 680,
  flow: 'paginated',
  columns: 2,
  animated: true,
  runningHeads: true,

  pdfThemed: true,
  pdfScroll: 'continuous',
  pdfSpread: 'none',
  pdfZoom: 'auto',

  tapZones: true,
  brightness: 1,
  showClock: false,
  keepAwake: true,

  instantLookup: true,
  onlineLookup: true,
  translateTo: defaultLang,
  dictTabs: {},
  dictDisabled: [],

  ttsVoice: '',
  ttsRate: 1,
  ttsPitch: 1,
}

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void
  reset: (keys?: (keyof Settings)[]) => void
}

export const useSettings = create<SettingsStore>()(
  persist(
    set => ({
      ...DEFAULT_SETTINGS,
      set: patch => set(patch),
      reset: keys => set(keys
        ? Object.fromEntries(keys.map(k => [k, DEFAULT_SETTINGS[k]]))
        : DEFAULT_SETTINGS),
    }),
    {
      name: 'lumen-settings',
      version: 2,
      // v1 defaulted English speakers' Translate target to Spanish; it now also picks the
      // language dictionary translations are shown in, so reset that untouched default
      migrate: (state, version) => {
        const s = state as Partial<Settings>
        if (version < 2 && s.translateTo === 'es' && defaultLang === 'en') s.translateTo = 'en'
        return s as SettingsStore
      },
      storage: createJSONStorage(() => localStorage),
      partialize: ({ set: _set, reset: _reset, ...rest }) => rest,
    },
  ),
)

export const getSettings = () => useSettings.getState()
