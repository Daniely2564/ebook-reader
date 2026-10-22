// Positions inside a PDF, shared by the page view and the flowing-text view so
// highlights, bookmarks and the reading position work in both.

/** A rectangle normalized to the page box: x, y, width, height in 0…1, top-down. */
export type Rect4 = [number, number, number, number]

/** A highlight: its page and one rectangle per line. Stored as JSON. */
export interface PdfLocator { p: number; r: Rect4[] }

export const parsePdfLocator = (s: string): PdfLocator | null => {
  try {
    const v = JSON.parse(s)
    return typeof v?.p === 'number' ? v : null
  } catch {
    return null
  }
}

/** Merges per-glyph-run rectangles into one rectangle per line. */
export const mergeRects = (rects: Rect4[]) => {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const out: Rect4[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[1] - r[1]) < Math.min(last[3], r[3]) * 0.5 && r[0] <= last[0] + last[2] + 0.02) {
      const right = Math.max(last[0] + last[2], r[0] + r[2])
      const top = Math.min(last[1], r[1])
      const bottom = Math.max(last[1] + last[3], r[1] + r[3])
      last[0] = Math.min(last[0], r[0])
      last[2] = right - last[0]
      last[1] = top
      last[3] = bottom - top
    } else out.push([...r])
  }
  return out.map(r => r.map(v => Math.round(v * 10000) / 10000) as Rect4)
}
