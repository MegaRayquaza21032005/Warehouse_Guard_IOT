import { createContext, useContext, useSyncExternalStore } from 'react'
import type { User } from './api'
import type { PushState } from './push'

export const AuthContext = createContext<User | null>(null)

export function useUser(): User {
  const u = useContext(AuthContext)
  if (!u) throw new Error('useUser ngoài AuthContext')
  return u
}

// trạng thái đăng ký push (hiển thị ở màn hình "Thêm")
let pushState: PushState | null = null
const subs = new Set<() => void>()
export function setPushState(s: PushState) {
  pushState = s
  subs.forEach((l) => l())
}
export const usePushState = () =>
  useSyncExternalStore(
    (l) => {
      subs.add(l)
      return () => {
        subs.delete(l)
      }
    },
    () => pushState,
  )
