import { useState } from 'react'
import { BellRing, BotMessageSquare, Gauge, LogIn, ShieldCheck, UserPlus, Warehouse } from 'lucide-react'
import { auth, errorText, type User } from '../api'

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const reg = mode === 'register'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onLogin(
        reg
          ? await auth.register({ username: login.trim(), email: email.trim(), password, fullName: fullName.trim() || undefined })
          : await auth.login(login, password),
      )
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <div className="login-art">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontWeight: 700 }}>
          <Warehouse size={22} /> Giám sát kho
        </div>
        <div>
          <h2>Theo dõi khói, khí độc, nhiệt độ và an ninh kho hàng theo thời gian thực.</h2>
          <ul>
            <li>
              <Gauge size={18} /> Số liệu cảm biến và trạng thái thiết bị trực tiếp
            </li>
            <li>
              <ShieldCheck size={18} /> Luật an toàn chạy ngay trên thiết bị, kể cả khi mất mạng
            </li>
            <li>
              <BellRing size={18} /> Cảnh báo tức thì, leo thang khi chưa ai xem
            </li>
            <li>
              <BotMessageSquare size={18} /> Trợ lý AI giải thích và điều khiển bằng tiếng Việt
            </li>
          </ul>
        </div>
        <small style={{ opacity: 0.7 }}>Cảm biến phổ thông — không thay thế hệ thống báo cháy đạt chuẩn.</small>
      </div>
      <div className="login-form">
        <form onSubmit={submit}>
          <div>
            <h1 style={{ fontSize: 24 }}>{reg ? 'Tạo tài khoản' : 'Đăng nhập'}</h1>
            <p className="muted" style={{ margin: '4px 0 8px' }}>
              {reg ? 'Mọi tài khoản đều xem và điều khiển được kho.' : 'Dùng tài khoản đã đăng ký trên hệ thống.'}
            </p>
          </div>
          <div className="field">
            <label htmlFor="login">{reg ? 'Tên đăng nhập' : 'Tên đăng nhập hoặc email'}</label>
            <input id="login" className="input" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required />
            {reg && <span className="hint">3–50 ký tự: chữ, số, dấu _ và .</span>}
          </div>
          {reg && (
            <>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input id="email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
              </div>
              <div className="field">
                <label htmlFor="fullName">Họ tên (tùy chọn)</label>
                <input id="fullName" className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" />
              </div>
            </>
          )}
          <div className="field">
            <label htmlFor="pw">Mật khẩu</label>
            <input
              id="pw"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={reg ? 'new-password' : 'current-password'}
              minLength={reg ? 6 : undefined}
              required
            />
          </div>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" style={{ height: 40 }} disabled={busy}>
            {reg ? <UserPlus size={16} /> : <LogIn size={16} />}{' '}
            {busy ? 'Đang xử lý…' : reg ? 'Tạo tài khoản' : 'Đăng nhập'}
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setMode(reg ? 'login' : 'register')
              setError('')
            }}
          >
            {reg ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký'}
          </button>
        </form>
      </div>
    </div>
  )
}
