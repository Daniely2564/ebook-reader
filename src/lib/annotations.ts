import { compare as compareCFI } from '../vendor/foliate-js/epubcfi.js'
import { todayKey, type Annotation, type BookRecord } from './db'

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

type BookInfo = Pick<BookRecord, 'title' | 'author' | 'format'>

const whereOf = (a: Annotation) => a.page ? `p. ${a.page}` : a.fraction != null ? `${Math.round(a.fraction * 100)}%` : ''

/** One row per highlight, for spreadsheets and database apps (the first column becomes the row title). */
export const highlightsToCsv = (groups: { book: BookInfo; items: Annotation[] }[]) => {
  const esc = (s = '') => `"${s.replace(/"/g, '""')}"`
  const rows = [['Highlight', 'Note', 'Book', 'Author', 'Chapter', 'Location', 'Color', 'Highlighted']]
  for (const { book, items } of groups)
    for (const a of sortAnnotations(items, book.format))
      if (a.kind === 'highlight')
        rows.push([a.text, a.note, book.title, book.author, a.chapter, whereOf(a), a.color ?? 'yellow', todayKey(new Date(a.createdAt))].map(v => v ?? ''))
  return '\ufeff' + rows.map(r => r.map(esc).join(',')).join('\r\n')
}

export const annotationsToMarkdown = (book: BookInfo, list: Annotation[]) => {
  const lines = [`# ${book.title}`, '']
  if (book.author) lines.push(`*${book.author}*`, '')
  let chapter: string | undefined
  for (const a of sortAnnotations(list, book.format)) {
    if (a.chapter && a.chapter !== chapter) {
      chapter = a.chapter
      lines.push(`## ${chapter}`, '')
    }
    const where = whereOf(a)
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
