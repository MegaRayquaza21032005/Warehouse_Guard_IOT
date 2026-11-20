/**
 * HTTP client tới Java BE: gắn JWT, tự refresh khi access token hết hạn (401), chuẩn hóa lỗi
 * `{"error","message"}` của backend thành `ApiError`.
 */

export interface User {
  id: number
  username: string
  email: string
  fullName: string | null
  role: 'ADMIN' | 'USER' | string
  createdAt?: string
}

interface Session {
  accessToken: string
  refreshToken: string
  user: User
}

/** Gốc API: rỗng = cùng origin (dev dùng proxy của Vite). Build cho máy khác: đặt VITE_API_URL. */
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const SESSION_KEY = 'warehouse.session'

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

let session: Session | null = load()
const listeners = new Set<(s: Session | null) => void>()

function load(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

export function setSession(s: Session | null) {
  session = s
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* chế độ riêng tư — chỉ giữ trong RAM */
  }
  listeners.forEach((l) => l(s))
}

export const getSession = () => session
export function onSessionChange(l: (s: Session | null) => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Sai tên đăng nhập hoặc mật khẩu',
  username_taken: 'Tên đăng nhập đã có người dùng',
  email_taken: 'Email đã được đăng ký',
  agent_unavailable: 'Trợ lý AI chưa chạy. Cảnh báo và nút điều khiển vẫn hoạt động.',
  llm_disabled: 'Trợ lý AI đang tắt (chưa cấu hình OpenAI).',
  rate_limited: 'Bạn đã gửi quá nhiều tin nhắn, thử lại sau.',
  mqtt_unavailable: 'Mất kết nối tới MQTT broker, chưa gửi được lệnh.',
  confirmation_pending: 'Đang có đề xuất chờ bạn xác nhận.',
  thread_busy: 'Trợ lý đang xử lý tin nhắn trước.',
}

async function toError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`
  let message = res.statusText || 'Lỗi không xác định'
  try {
    const body = await res.json()
    if (body?.error) code = body.error
    if (body?.message) message = body.message
    if (body?.details && typeof body.details === 'object') {
      const FIELD: Record<string, string> = { username: 'Tên đăng nhập', email: 'Email', password: 'Mật khẩu', fullName: 'Họ tên' }
      const parts = Object.entries(body.details as Record<string, unknown>).map(([k, v]) => `${FIELD[k] ?? k}: ${v}`)
      if (parts.length && code === 'validation_failed') message = parts.join(' · ')
    }
  } catch {
    /* không phải JSON */
  }
  if (res.status === 502 || res.status === 504) message = 'Không kết nối được backend'
  return new ApiError(res.status, code, MESSAGES[code] ?? message)
}

let refreshing: Promise<boolean> | null = null

/** Đổi refresh token lấy cặp token mới (chỉ một request refresh chạy cùng lúc). */
export function refreshSession(): Promise<boolean> {
  if (!session) return Promise.resolve(false)
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: session!.refreshToken }),
      })
      if (!res.ok) {
        if (res.status === 401) setSession(null) // refresh token hết hạn / bị thu hồi → đăng nhập lại
        return false
      }
      const r = await res.json()
      setSession({ accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user })
      return true
    } catch {
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export interface RequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  signal?: AbortSignal
  /** Trả Response thô (stream SSE, audio) thay vì JSON. */
  raw?: boolean
  auth?: boolean
}

export function buildUrl(path: string, query?: RequestOptions['query']) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
  const s = qs.toString()
  return `${API_BASE}${path}${s ? `?${s}` : ''}`
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, raw, auth = true } = opts
  const doFetch = () => {
    const headers: Record<string, string> = {}
    if (auth && session) headers.Authorization = `Bearer ${session.accessToken}`
    let payload: BodyInit | undefined
    if (body instanceof FormData) payload = body
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    return fetch(buildUrl(path, query), { method, headers, body: payload, signal })
  }
  let res: Response
  try {
    res = await doFetch()
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, 'network', 'Không kết nối được backend')
  }
  if (res.status === 401 && auth && session && (await refreshSession())) res = await doFetch()
  if (!res.ok) throw await toError(res)
  if (raw) return res as unknown as T
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}
