import literataUrl from '@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url'
import literataItalicUrl from '@fontsource-variable/literata/files/literata-latin-wght-italic.woff2?url'
import literataExtUrl from '@fontsource-variable/literata/files/literata-latin-ext-wght-normal.woff2?url'
import sourceSerifUrl from '@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2?url'
import sourceSerifItalicUrl from '@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-italic.woff2?url'
import merriweather400 from '@fontsource/merriweather/files/merriweather-latin-400-normal.woff2?url'
import merriweather400i from '@fontsource/merriweather/files/merriweather-latin-400-italic.woff2?url'
import merriweather700 from '@fontsource/merriweather/files/merriweather-latin-700-normal.woff2?url'
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import interItalicUrl from '@fontsource-variable/inter/files/inter-latin-wght-italic.woff2?url'
import atkinson400 from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2?url'
import atkinson400i from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-italic.woff2?url'
import atkinson700 from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2?url'
import dyslexic400 from '@fontsource/opendyslexic/files/opendyslexic-latin-400-normal.woff2?url'
import dyslexic400i from '@fontsource/opendyslexic/files/opendyslexic-latin-400-italic.woff2?url'
import dyslexic700 from '@fontsource/opendyslexic/files/opendyslexic-latin-700-normal.woff2?url'

export interface ReaderTheme {
  id: string
  name: string
  bg: string
  fg: string
  muted: string
  link: string
  /** chrome surface for bars and panels */
  surface: string
  border: string
  selection: string
  dark: boolean
  /** CSS filter applied to PDF pages for this theme */
  pdfFilter: string
}

export const THEMES: ReaderTheme[] = [
  { id: 'light', name: 'Light', bg: '#ffffff', fg: '#1d1d21', muted: '#6b6b74', link: '#2357c6', surface: '#f7f7f8', border: '#e4e4e8', selection: 'rgba(35,87,198,.22)', dark: false, pdfFilter: 'none' },
  { id: 'paper', name: 'Paper', bg: '#faf7f0', fg: '#2a2722', muted: '#7a7466', link: '#9a4d12', surface: '#f2ede2', border: '#e4dccb', selection: 'rgba(214,140,48,.25)', dark: false, pdfFilter: 'sepia(.12) brightness(.99)' },
  { id: 'sepia', name: 'Sepia', bg: '#f1e4c8', fg: '#3d2f1f', muted: '#806a4d', link: '#8a3f0c', surface: '#e8d9b8', border: '#d9c6a0', selection: 'rgba(160,100,30,.25)', dark: false, pdfFilter: 'sepia(.45) brightness(.95) contrast(.98)' },
  { id: 'sage', name: 'Sage', bg: '#e3ebdf', fg: '#24301f', muted: '#5d6b57', link: '#2e6a3a', surface: '#d8e2d3', border: '#c4d1bd', selection: 'rgba(60,120,70,.22)', dark: false, pdfFilter: 'sepia(.2) hue-rotate(50deg) brightness(.96)' },
  { id: 'dusk', name: 'Dusk', bg: '#2a2c33', fg: '#dcd8cf', muted: '#9a978f', link: '#8fb4ff', surface: '#32353d', border: '#41444d', selection: 'rgba(143,180,255,.3)', dark: true, pdfFilter: 'invert(.86) hue-rotate(180deg) brightness(1.05)' },
  { id: 'night', name: 'Night', bg: '#17171b', fg: '#cfccc4', muted: '#8a8780', link: '#86a8f0', surface: '#202026', border: '#2f2f37', selection: 'rgba(134,168,240,.3)', dark: true, pdfFilter: 'invert(.9) hue-rotate(180deg)' },
  { id: 'black', name: 'Black', bg: '#000000', fg: '#bdbab3', muted: '#7d7a74', link: '#7f9fe0', surface: '#0e0e10', border: '#222226', selection: 'rgba(127,159,224,.3)', dark: true, pdfFilter: 'invert(.94) hue-rotate(180deg) contrast(1.05)' },
]

export const themeById = (id: string) => THEMES.find(t => t.id === id) ?? THEMES[1]

export const HIGHLIGHT_COLORS = {
  yellow: { light: '#ffd84d', dark: '#b8961c', label: 'Yellow' },
  green: { light: '#8ee07a', dark: '#4f9a3e', label: 'Green' },
  blue: { light: '#7cc4ff', dark: '#3f7fb8', label: 'Blue' },
  pink: { light: '#ff9ec4', dark: '#b85a80', label: 'Pink' },
  purple: { light: '#c6a6ff', dark: '#7d62b8', label: 'Purple' },
} as const

export interface ReadingFont {
  id: string
  name: string
  family: string
  /** @font-face rules (absolute URLs are resolved at injection time) */
  faces?: { url: string; weight: string; style: 'normal' | 'italic' }[]
  note?: string
}

export const FONTS: ReadingFont[] = [
  { id: 'publisher', name: 'Original', family: '', note: 'Use the book’s fonts' },
  {
    id: 'literata', name: 'Literata', family: '"Lumen Literata", Georgia, serif',
    faces: [
      { url: literataUrl, weight: '200 900', style: 'normal' },
      { url: literataExtUrl, weight: '200 900', style: 'normal' },
      { url: literataItalicUrl, weight: '200 900', style: 'italic' },
    ],
  },
  {
    id: 'source-serif', name: 'Source Serif', family: '"Lumen Source Serif", Georgia, serif',
    faces: [
      { url: sourceSerifUrl, weight: '200 900', style: 'normal' },
      { url: sourceSerifItalicUrl, weight: '200 900', style: 'italic' },
    ],
  },
  {
    id: 'merriweather', name: 'Merriweather', family: '"Lumen Merriweather", Georgia, serif',
    faces: [
      { url: merriweather400, weight: '400', style: 'normal' },
      { url: merriweather400i, weight: '400', style: 'italic' },
      { url: merriweather700, weight: '700', style: 'normal' },
    ],
  },
  {
    id: 'inter', name: 'Inter', family: '"Lumen Inter", system-ui, sans-serif',
    faces: [
      { url: interUrl, weight: '100 900', style: 'normal' },
      { url: interItalicUrl, weight: '100 900', style: 'italic' },
    ],
  },
  {
    id: 'atkinson', name: 'Atkinson Hyperlegible', family: '"Lumen Atkinson", system-ui, sans-serif',
    faces: [
      { url: atkinson400, weight: '400', style: 'normal' },
      { url: atkinson400i, weight: '400', style: 'italic' },
      { url: atkinson700, weight: '700', style: 'normal' },
    ],
    note: 'Designed for low vision readers',
  },
  {
    id: 'opendyslexic', name: 'OpenDyslexic', family: '"Lumen OpenDyslexic", sans-serif',
    faces: [
      { url: dyslexic400, weight: '400', style: 'normal' },
      { url: dyslexic400i, weight: '400', style: 'italic' },
      { url: dyslexic700, weight: '700', style: 'normal' },
    ],
    note: 'Weighted letterforms for dyslexia',
  },
  { id: 'system-serif', name: 'System Serif', family: 'ui-serif, Georgia, "Times New Roman", serif' },
  { id: 'system-sans', name: 'System Sans', family: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
]

export const fontById = (id: string) => FONTS.find(f => f.id === id) ?? FONTS[0]

/** @font-face CSS for a reading font, with absolute URLs so it also works inside book iframes. */
export const fontFaceCss = (font: ReadingFont) => {
  if (!font.faces) return ''
  const name = font.family.split(',')[0]
  return font.faces.map(f => `@font-face {
  font-family: ${name};
  src: url("${new URL(f.url, document.baseURI).href}") format("woff2");
  font-weight: ${f.weight};
  font-style: ${f.style};
  font-display: block;
}`).join('\n')
}

let previewInjected = false
/** Registers every reading font in the app document (for previews in the settings UI). */
export const injectFontPreviews = () => {
  if (previewInjected) return
  previewInjected = true
  const style = document.createElement('style')
  style.textContent = FONTS.map(fontFaceCss).join('\n')
  document.head.append(style)
}
