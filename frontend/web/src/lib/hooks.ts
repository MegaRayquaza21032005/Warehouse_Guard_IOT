import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { live } from './live'
import type { User } from '../api'

/** Trạng thái realtime từ Java BE (snapshot + WebSocket `/ws/live`). */
export const useLive = () => useSyncExternalStore(live.subscribe, live.getSnapshot)

export function useNow(intervalMs = 10_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export const AuthContext = createContext<{ user: User; logout: () => void } | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth ngoài AuthContext')
  return ctx
}

export type Theme = 'light' | 'dark' | 'system'
const THEME_KEY = 'warehouse.theme'

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  useEffect(() => {
    const el = document.documentElement
    if (theme === 'system') el.removeAttribute('data-theme')
    else el.setAttribute('data-theme', theme)
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* bỏ qua */
    }
  }, [theme])
  return [theme, setTheme] as const
}

const AUTO_READ_KEY = 'warehouse.autoRead'

/** Tự đọc câu trả lời khi hỏi bằng giọng nói (CLAUDE.md mục 6) — lưu theo trình duyệt. */
export function useAutoRead() {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem(AUTO_READ_KEY) !== 'false'
    } catch {
      return true
    }
  })
  const update = (next: boolean) => {
    setV(next)
    try {
      localStorage.setItem(AUTO_READ_KEY, String(next))
    } catch {
      /* bỏ qua */
    }
  }
  return [v, update] as const
}

/** Giá trị màu thật của một biến CSS (Recharts cần chuỗi màu, đổi theo theme). */
export function useCssVars<K extends string>(names: readonly K[]): Record<K, string> {
  const read = () => {
    const cs = getComputedStyle(document.documentElement)
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(`--${n}`).trim()])) as Record<K, string>
  }
  const [vals, setVals] = useState(read)
  useEffect(() => {
    const update = () => setVals(read())
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', update)
    return () => {
      mo.disconnect()
      mq.removeEventListener('change', update)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return vals
}
