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

/** pdf_viewer.mjs reads `globalThis.pdfjsLib` at evaluation time, so load it lazily. */
export const loadPdfViewer = async () => {
  ;(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjsLib
  return import('pdfjs-dist/legacy/web/pdf_viewer.mjs')
}
