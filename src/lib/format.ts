export const formatDuration = (ms: number) => {
  const mins = Math.round(ms / 60000)
  if (mins < 1) return ms > 0 ? '<1 min' : '0 min'
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

export const formatMinutesLeft = (mins?: number) => {
  if (mins == null || !isFinite(mins)) return ''
  const m = Math.round(mins)
  if (m < 1) return 'less than a minute'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60 ? `${m % 60} min` : ''}`.trim()
}

export const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
export const formatRelative = (t?: number) => {
  if (!t) return ''
  const diff = (t - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 60) return 'just now'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day')
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export const percent = (f: number) => `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`

export const hashHue = (s: string) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

export const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'export'
