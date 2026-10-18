import type { FoliateBook } from './view.js'
export class FootnoteHandler extends EventTarget {
  detectFootnotes: boolean
  handle(book: FoliateBook, e: CustomEvent): Promise<void> | undefined
}
