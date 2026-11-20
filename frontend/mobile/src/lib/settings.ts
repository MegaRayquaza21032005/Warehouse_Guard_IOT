/** Cài đặt nhỏ của app (lưu trên máy). */
import { useEffect, useState } from 'react'
import { storage } from './storage'

const AUTO_READ = 'warehouse.autoRead'
let autoRead = true
const subs = new Set<(v: boolean) => void>()
void storage.get(AUTO_READ).then((v) => {
  autoRead = v !== 'false'
  subs.forEach((l) => l(autoRead))
})

/** Tự đọc câu trả lời khi hỏi bằng giọng nói (CLAUDE.md mục 6). */
export function useAutoRead() {
  const [v, setV] = useState(autoRead)
  useEffect(() => {
    subs.add(setV)
    return () => {
      subs.delete(setV)
    }
  }, [])
  const set = (next: boolean) => {
    autoRead = next
    subs.forEach((l) => l(next))
    void storage.set(AUTO_READ, String(next))
  }
  return [v, set] as const
}
