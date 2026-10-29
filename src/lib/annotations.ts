import { compare as compareCFI } from '../vendor/foliate-js/epubcfi.js'
import type { Annotation, BookRecord } from './db'

const pdfPos = (a: Annotation) => {
  try {
    const v = JSON.parse(a.locator)
    return [v.p ?? 0, v.r?.[0]?.[1] ?? 0]
  } catch {
    const m = a.locator.match(/^pdf:(\d+)/)
    return [m ? Number(m[1]) : (a.page ?? 0), 0]
  }
}

export const sortAnnotations = (list: Annotation[], format: BookRecord['format']) => [...list].sort((a, b) => {
  if (format === 'pdf') {
    const [pa, ya] = pdfPos(a)
    const [pb, yb] = pdfPos(b)
    return pa - pb || ya - yb
  }
  try {
    return compareCFI(a.locator, b.locator)
  } catch {
    return (a.fraction ?? 0) - (b.fraction ?? 0)
  }
})

export const annotationsToMarkdown = (book: Pick<BookRecord, 'title' | 'author' | 'format'>, list: Annotation[]) => {
  const lines = [`# ${book.title}`, '']
  if (book.author) lines.push(`*${book.author}*`, '')
  let chapter: string | undefined
  for (const a of sortAnnotations(list, book.format)) {
    if (a.chapter && a.chapter !== chapter) {
      chapter = a.chapter
      lines.push(`## ${chapter}`, '')
    }
    const where = a.page ? `p. ${a.page}` : a.fraction != null ? `${Math.round(a.fraction * 100)}%` : ''
    if (a.kind === 'bookmark') lines.push(`- 🔖 Bookmark${where ? ` (${where})` : ''}`, '')
    else {
      lines.push(...a.text.split('\n').map(l => `> ${l}`))
      if (where) lines.push(`> — ${where}`)
      lines.push('')
      if (a.note) lines.push(a.note, '')
    }
  }
  return lines.join('\n')
}
