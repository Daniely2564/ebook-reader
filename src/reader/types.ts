import type { Annotation } from '../lib/db'
import type { Settings } from '../lib/settings'

export interface TocItem {
  id: string
  label: string
  /** opaque navigation target */
  target: string
  level: number
  children?: TocItem[]
}

export interface Relocation {
  fraction: number
  /** stable position for resuming / bookmarks */
  locator: string
  chapter?: string
  chapterTarget?: string
  page?: { current: number; total: number; label?: string }
  /** minutes left in the chapter / book */
  timeLeft?: { chapter?: number; book?: number }
  /** visible range, for bookmark detection */
  range?: { start: string; end: string }
  /** text at the top of the page (bookmark label) */
  excerpt?: string
}

export interface SelectionInfo {
  text: string
  /** viewport rectangle of the selection */
  rect: { left: number; top: number; right: number; bottom: number }
  /** locator usable as a highlight */
  locator: string | null
  /** surrounding sentence, for vocabulary context */
  context: string
  chapter?: string
  page?: number
  fraction?: number
  /** true when triggered by a double-click / long press on one word */
  isWord: boolean
  /** what to look up when it differs from text ("'tis" for a double-click on "’Tis") */
  lookup?: string
}

export interface SearchHit {
  locator: string
  label?: string
  excerpt: { pre: string; match: string; post: string }
}

export interface SpeechChunk {
  text: string
  /** highlight this chunk and make sure it is visible */
  show(): void
}

export type TapZone = 'left' | 'center' | 'right'

export interface EngineCallbacks {
  onRelocate(r: Relocation): void
  onSelection(s: SelectionInfo | null): void
  onAnnotationClick(id: string, rect: SelectionInfo['rect']): void
  onTap(zone: TapZone): void
  onKey(e: KeyboardEvent): void
  onActivity(): void
  onFootnote?(el: HTMLElement | null, rect: SelectionInfo['rect']): void
  onError(message: string): void
}

export interface ReaderEngine {
  readonly kind: 'reflowable' | 'pdf'
  readonly toc: TocItem[]
  /** fractions where chapters start (slider ticks) */
  readonly sectionFractions: number[]
  readonly language?: string
  readonly dir?: 'ltr' | 'rtl'
  open(container: HTMLElement, location?: string): Promise<void>
  destroy(): void
  next(): void
  prev(): void
  goTo(target: string): Promise<void>
  goToFraction(fraction: number): Promise<void>
  canGoBack(): boolean
  back(): void
  applySettings(s: Settings): void
  setAnnotations(list: Annotation[]): void
  clearSelection(): void
  search(query: string, onHit: (hit: SearchHit) => void, onProgress: (p: number) => void, signal: AbortSignal): Promise<void>
  clearSearch(): void
  /** speakable chunks from the current position to the end of the current section/page */
  speechChunks(): Promise<SpeechChunk[]>
  /** advance to the next section/page for read-aloud; false at the end of the book */
  speechAdvance(): Promise<boolean>
  clearSpeech(): void
  /** zoom (PDF) */
  zoom?(action: 'in' | 'out' | 'fit-width' | 'fit-page' | 'reset'): void
  readonly zoomLabel?: string
}
