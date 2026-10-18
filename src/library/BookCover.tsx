import type { BookRecord } from '../lib/db'
import { hashHue } from '../lib/format'

const urls = new Map<string, { blob: Blob; url: string }>()

export const coverUrl = (book: Pick<BookRecord, 'id' | 'cover'>) => {
  if (!book.cover) return null
  const cached = urls.get(book.id)
  if (cached?.blob === book.cover) return cached.url
  if (cached) URL.revokeObjectURL(cached.url)
  const url = URL.createObjectURL(book.cover)
  urls.set(book.id, { blob: book.cover, url })
  return url
}

export const forgetCover = (id: string) => {
  const c = urls.get(id)
  if (c) URL.revokeObjectURL(c.url)
  urls.delete(id)
}

export const BookCover = ({ book, className = '' }: { book: Pick<BookRecord, 'id' | 'cover' | 'title' | 'author' | 'format'>; className?: string }) => {
  const url = coverUrl(book)
  if (url) return <img className={`cover ${className}`} src={url} alt="" draggable={false} loading="lazy" decoding="async" />
  const hue = hashHue(book.title + book.author)
  return (
    <div className={`cover cover-gen ${className}`} style={{ '--h': hue } as React.CSSProperties} aria-hidden>
      <div className="cover-gen-rule" />
      <div className="cover-gen-title">{book.title}</div>
      {book.author && <div className="cover-gen-author">{book.author}</div>}
      <div className="cover-gen-format">{book.format.toUpperCase()}</div>
    </div>
  )
}
