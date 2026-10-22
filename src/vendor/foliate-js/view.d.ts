// Minimal type surface of foliate-js used by Lumen Reader.
export interface FoliateTocItem {
  id?: number
  label: string
  href: string
  subitems?: FoliateTocItem[] | null
}

export interface FoliateSection {
  id?: string | number
  linear?: string
  size?: number
  cfi?: string
  /** URL of the section document */
  load?: () => string | Promise<string>
  unload?: () => void
  createDocument?: () => Promise<Document>
}

export interface FoliateBook {
  metadata?: Record<string, any>
  toc?: FoliateTocItem[]
  pageList?: FoliateTocItem[]
  sections: FoliateSection[]
  dir?: string
  rendition?: { layout?: string }
  getCover?: () => Promise<Blob | null> | Blob | null
  resolveHref?: (href: string) => { index: number; anchor: (doc: Document) => Element | Range | null }
  /** section id and fragment of a TOC / page-list href */
  splitTOCHref?: (href: string) => (string | number)[]
  getTOCFragment?: (doc: Document, fragment: string) => Element | null
  isExternal?: (href: string) => boolean
  destroy?: () => void
}

export interface FoliateRelocateDetail {
  fraction: number
  section?: { current: number; total: number }
  location?: { current: number; next: number; total: number }
  time?: { section: number; total: number }
  tocItem?: FoliateTocItem | null
  pageItem?: FoliateTocItem | null
  cfi: string
  range?: Range
}

export interface FoliateRenderer extends HTMLElement {
  heads?: HTMLElement[] | null
  feet?: HTMLElement[] | null
  setStyles?: (styles: string | [string, string]) => void
  getContents: () => { index: number; doc: Document; overlayer?: any }[]
  scrollToAnchor?: (anchor: Range | Element | number, select?: boolean) => Promise<void>
  nextSection?: () => Promise<void>
  prevSection?: () => Promise<void>
  goTo: (target: any) => Promise<void>
  next: (distance?: number) => Promise<void>
  prev: (distance?: number) => Promise<void>
  destroy?: () => void
  readonly atStart?: boolean
  readonly atEnd?: boolean
}

export interface FoliateView extends HTMLElement {
  book: FoliateBook
  renderer: FoliateRenderer
  isFixedLayout: boolean
  lastLocation?: FoliateRelocateDetail
  history: EventTarget & { back(): void; forward(): void; canGoBack: boolean; canGoForward: boolean }
  open(book: File | Blob | string | FoliateBook): Promise<void>
  close(): void
  init(opts: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>
  goTo(target: string | number): Promise<any>
  goToFraction(fraction: number): Promise<void>
  goLeft(): Promise<void>
  goRight(): Promise<void>
  prev(distance?: number): Promise<void>
  next(distance?: number): Promise<void>
  addAnnotation(annotation: { value: string; [k: string]: any }, remove?: boolean): Promise<any>
  deleteAnnotation(annotation: { value: string }): Promise<any>
  search(opts: { query: string; matchCase?: boolean; matchDiacritics?: boolean; matchWholeWords?: boolean; index?: number; drawOptions?: Record<string, unknown> }): AsyncGenerator<any>
  clearSearch(): void
  getCFI(index: number, range?: Range): string
  resolveNavigation(target: any): { index: number; anchor?: (doc: Document) => Element | Range } | undefined
  getSectionFractions(): number[]
  deselect(): void
}

export function makeBook(file: File | Blob | string): Promise<FoliateBook>
