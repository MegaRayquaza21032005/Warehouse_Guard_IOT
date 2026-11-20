import { useEffect, useState, useSyncExternalStore } from 'react'
import { live } from './live'

/** Trạng thái realtime (snapshot `GET /api/state` + WebSocket `/ws/live`). */
export const useLive = () => useSyncExternalStore(live.subscribe, live.getSnapshot)

/** Re-render định kỳ để cập nhật chữ "x phút trước". */
export function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
