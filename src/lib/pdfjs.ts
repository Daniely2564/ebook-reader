// The legacy build runs on older Android System WebViews and Chromium versions
// that lack the newest JS built-ins used by the modern pdf.js build.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { publicUrl } from './platform'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjsLib }

export const openPdf = (data: Uint8Array) => pdfjsLib.getDocument({
  data,
  cMapUrl: publicUrl('pdfjs/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: publicUrl('pdfjs/standard_fonts/'),
  wasmUrl: publicUrl('pdfjs/wasm/'),
  iccUrl: publicUrl('pdfjs/iccs/'),
  enableXfa: true,
}).promise

export interface PdfOutlineNode {
  title: string
  /** 1-based page of the destination, when it resolves */
  page: number | null
  /** top of the destination in PDF user space (XYZ / FitH / FitBH) */
  top: number | null
  url?: string
  dest: unknown
  items: PdfOutlineNode[]
}

/** The document outline with destinations resolved to pages. */
export const resolveOutline = async (doc: pdfjsLib.PDFDocumentProxy): Promise<PdfOutlineNode[]> => {
  const outline = await doc.getOutline()
  const convert = (items: NonNullable<typeof outline>): Promise<PdfOutlineNode[]> => Promise.all(items.map(async item => {
    let page: number | null = null
    let top: number | null = null
    if (!item.url) {
      try {
        const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest
        const ref = Array.isArray(dest) ? dest[0] : null
        page = ref == null ? null : typeof ref === 'number' ? ref + 1 : (await doc.getPageIndex(ref)) + 1
        const kind = Array.isArray(dest) ? (dest[1] as { name?: string } | null)?.name : null
        const y = kind === 'XYZ' ? dest![3] : kind === 'FitH' || kind === 'FitBH' ? dest![2] : null
        if (typeof y === 'number') top = y
      } catch { /* unresolved destination */ }
    }
    return {
      title: item.title?.trim() || 'Untitled',
      page,
      top,
      url: item.url ?? undefined,
      dest: item.dest,
      items: item.items?.length ? await convert(item.items) : [],
    }
  }))
  return outline?.length ? convert(outline) : []
}

/** pdf_viewer.mjs reads `globalThis.pdfjsLib` at evaluation time, so load it lazily. */
export const loadPdfViewer = async () => {
  ;(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjsLib
  return import('pdfjs-dist/legacy/web/pdf_viewer.mjs')
}
