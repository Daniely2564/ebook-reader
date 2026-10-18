import { useEffect, useState } from 'react'
import { getBooks, getStats, todayKey, type BookRecord } from '../lib/db'
import { useApp } from '../lib/store'

export const useBooks = () => {
  const version = useApp(s => s.libraryVersion)
  const [books, setBooks] = useState<BookRecord[] | null>(null)
  useEffect(() => {
    let alive = true
    getBooks().then(b => alive && setBooks(b)).catch(() => alive && setBooks([]))
    return () => {
      alive = false
    }
  }, [version])
  return books
}

export interface ReadingStats {
  todayMs: number
  weekMs: number
  streak: number
  days: { date: string; ms: number }[]
}

export const useReadingStats = () => {
  const version = useApp(s => s.libraryVersion)
  const [stats, setStats] = useState<ReadingStats | null>(null)
  useEffect(() => {
    getStats().then(all => {
      const map = new Map(all.map(d => [d.date, d.ms]))
      const days: { date: string; ms: number }[] = []
      const now = new Date()
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now)
        d.setDate(now.getDate() - i)
        const key = todayKey(d)
        days.push({ date: key, ms: map.get(key) ?? 0 })
      }
      // streak: consecutive days with ≥1 minute, counting back from today (or yesterday)
      let streak = 0
      const d = new Date(now)
      if ((map.get(todayKey(d)) ?? 0) < 60000) d.setDate(d.getDate() - 1)
      while ((map.get(todayKey(d)) ?? 0) >= 60000) {
        streak++
        d.setDate(d.getDate() - 1)
      }
      setStats({
        todayMs: map.get(todayKey()) ?? 0,
        weekMs: days.slice(-7).reduce((n, x) => n + x.ms, 0),
        streak,
        days,
      })
    }).catch(() => {})
  }, [version])
  return stats
}
