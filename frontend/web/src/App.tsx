import { useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { auth, type User } from './api'
import { onSessionChange } from './api/client'
import { live } from './lib/live'
import { AuthContext, useTheme } from './lib/hooks'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Alerts from './pages/Alerts'
import Stats from './pages/Stats'
import DeviceLogs from './pages/DeviceLogs'
import Chat from './pages/Chat'
import Settings from './pages/Settings'

export default function App() {
  const [user, setUser] = useState<User | null>(() => auth.current())
  useTheme() // áp theme đã lưu ngay từ đầu

  // refresh token hết hạn / đăng xuất ở tab khác → về trang đăng nhập
  useEffect(() => onSessionChange((s) => setUser(s?.user ?? null)), [])

  useEffect(() => {
    if (!user) return
    void live.start()
    const id = setInterval(() => live.tick(), 30_000)
    return () => {
      clearInterval(id)
      live.stop()
    }
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const ctx = useMemo(
    () =>
      user && {
        user,
        logout: () => {
          void auth.logout()
          setUser(null)
        },
      },
    [user],
  )

  if (!ctx) return <Login onLogin={setUser} />

  return (
    <AuthContext.Provider value={ctx}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="stats" element={<Stats />} />
            <Route path="device-logs" element={<DeviceLogs />} />
            <Route path="chat" element={<Chat />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthContext.Provider>
  )
}
