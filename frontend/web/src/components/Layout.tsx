import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  AlertOctagon,
  Bell,
  BotMessageSquare,
  ChartColumn,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  Moon,
  RefreshCw,
  Settings,
  Sun,
  Warehouse,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useAuth, useLive, useNow, useTheme } from '../lib/hooks'
import { live, onNewAlert, refresh, type ConnState } from '../lib/live'
import { LevelIcon } from './AlertList'
import { alertTypeLabel, fmtAgo } from '../lib/labels'
import type { Alert } from '../types'

const NAV = [
  { to: '/', label: 'Tổng quan', icon: LayoutDashboard, end: true },
  { to: '/alerts', label: 'Cảnh báo', icon: Bell },
  { to: '/stats', label: 'Thống kê', icon: ChartColumn },
  { to: '/device-logs', label: 'Nhật ký thiết bị', icon: ListChecks },
  { to: '/chat', label: 'Trợ lý AI', icon: BotMessageSquare },
  { to: '/settings', label: 'Cài đặt', icon: Settings },
]

const TITLES: Record<string, string> = {
  '/': 'Tổng quan',
  '/alerts': 'Cảnh báo',
  '/stats': 'Thống kê',
  '/device-logs': 'Nhật ký thiết bị',
  '/chat': 'Trợ lý AI',
  '/settings': 'Cài đặt',
}

export default function Layout() {
  const { user, logout } = useAuth()
  const snap = useLive()
  const loc = useLocation()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const unacked = snap.alerts.filter((a) => !a.acknowledgedAt)
  const criticals = unacked.filter((a) => a.level === 'critical' && a.source === 'rule')
  const online = snap.live.online?.data.status === 'online'
  const health = snap.live.device?.data
  const lastData = snap.live.sensors.mq2?.updatedAt ?? snap.live.sensors.dht11?.updatedAt
  useNow(15_000)

  useEffect(() => setOpen(false), [loc.pathname])

  return (
    <div className="app">
      {open && <div className="backdrop" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-logo">
            <Warehouse size={19} />
          </div>
          <div>
            <div className="brand-name">Giám sát kho</div>
            <div className="brand-sub">Kho A · 1 điểm đo</div>
          </div>
        </div>
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Icon size={18} />
            {label}
            {to === '/alerts' && unacked.length > 0 && <span className="count">{unacked.length}</span>}
          </NavLink>
        ))}
        <div className="sidebar-foot">
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', color: online ? 'var(--ok)' : 'var(--crit)', fontWeight: 600 }}>
            {online ? <Wifi size={14} /> : <WifiOff size={14} />}
            ESP32 {online ? 'trực tuyến' : snap.live.online ? 'mất kết nối' : 'chưa có dữ liệu'}
          </span>
          {health && (
            <span>
              {health.id} · RSSI {health.rssi} dBm
            </span>
          )}
          <span>{lastData ? `Cập nhật ${fmtAgo(lastData)}` : 'Chưa nhận số liệu cảm biến'}</span>
        </div>
      </aside>

      <div className="main">
        {criticals.length > 0 && (
          <div className="critical-strip" role="alert">
            <AlertOctagon size={20} style={{ flex: 'none' }} />
            <span className="msg">{criticals[0].message}</span>
            {criticals.length > 1 && <span className="hide-sm">+{criticals.length - 1}</span>}
            <button className="btn sm" onClick={() => criticals.forEach((a) => void live.ack(a.id))}>
              Đã xem
            </button>
            <button className="btn sm hide-sm" onClick={() => nav('/alerts')}>
              Chi tiết
            </button>
          </div>
        )}
        <header className="topbar">
          <button className="btn icon ghost menu-btn" aria-label="Mở menu" onClick={() => setOpen(true)}>
            <Menu size={18} />
          </button>
          <h1>{TITLES[loc.pathname] ?? ''}</h1>
          <div className="spacer" />
          <ConnBadge conn={snap.conn} broker={snap.live.brokerConnected} error={snap.error} />
          <ThemeButton />
          <UserMenu name={user.fullName || user.username} username={user.username} onLogout={logout} />
        </header>
        <main className="content">
          <Outlet />
        </main>
        <p className="footer-note">
          Hệ thống dùng cảm biến phổ thông (MQ2, DHT11) — không thay thế hệ thống báo cháy đạt chuẩn.
        </p>
      </div>
      <Toasts />
    </div>
  )
}

function ConnBadge({ conn, broker, error }: { conn: ConnState; broker?: boolean; error: string | null }) {
  const ok = conn === 'open' && broker !== false && !error
  const text = error
    ? 'Không kết nối được backend'
    : conn === 'open'
      ? broker === false
        ? 'Backend mất kết nối MQTT'
        : 'Realtime'
      : conn === 'connecting'
        ? 'Đang kết nối…'
        : 'Mất kết nối realtime — đang thử lại'
  return (
    <button
      className={`badge ${ok ? 'ok' : conn === 'connecting' && !error ? '' : 'warn'}`}
      style={{ border: 0, cursor: ok ? 'default' : 'pointer', height: 28 }}
      title={ok ? 'Đang nhận số liệu trực tiếp qua WebSocket' : 'Bấm để nạp lại'}
      onClick={() => !ok && void refresh()}
    >
      {ok ? <span className="dot pulse" /> : <RefreshCw size={12} />}
      <span className="hide-sm">{text}</span>
    </button>
  )
}

function ThemeButton() {
  const [theme, setTheme] = useTheme()
  const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor
  const label = theme === 'light' ? 'Sáng' : theme === 'dark' ? 'Tối' : 'Theo hệ thống'
  return (
    <button className="btn icon ghost hide-sm" onClick={() => setTheme(next)} title={`Giao diện: ${label}`} aria-label={`Giao diện: ${label}`}>
      <Icon size={18} />
    </button>
  )
}

function UserMenu({ name, username, onLogout }: { name: string; username: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return (
    <div className="rel" ref={ref}>
      <button
        className="btn icon"
        style={{ borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'transparent', fontWeight: 700 }}
        onClick={() => setOpen((v) => !v)}
        aria-label="Tài khoản"
      >
        {name.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="popover" style={{ width: 220 }}>
          <div>
            <b>{name}</b>
            <div className="faint">@{username}</div>
          </div>
          <button className="btn" onClick={onLogout}>
            <LogOut size={15} /> Đăng xuất
          </button>
        </div>
      )}
    </div>
  )
}

function Toasts() {
  const [items, setItems] = useState<Alert[]>([])
  useEffect(
    () =>
      onNewAlert((a) => {
        setItems((prev) => [a, ...prev].slice(0, 3))
        setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== a.id)), a.level === 'critical' ? 9000 : 6000)
      }),
    [],
  )
  if (!items.length) return null
  return (
    <div className="toast-stack" aria-live="polite">
      {items.map((a) => (
        <div key={a.id} className={`toast ${a.level}`}>
          <LevelIcon level={a.level} />
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 13 }}>
              {alertTypeLabel(a.type)}
              {a.source === 'agent' && <span className="badge accent" style={{ marginLeft: 6 }}>AI</span>}
            </b>
            <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{a.message}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
