/**
 * Client tới Java BE (cửa ngõ duy nhất — CLAUDE.md mục 3): JWT + tự refresh, chuẩn hóa lỗi, các endpoint.
 * Cùng API với web (frontend/web/src/api); kiểu dữ liệu dùng chung ở frontend/shared.
 */
import { fetch as expoFetch } from 'expo/fetch'
import { Platform } from 'react-native'
import type {
  Alert,
  AlertLevel,
  CommandSource,
  DeviceConfig,
  DeviceLog,
  DeviceName,
  LiveState,
  MemoryItem,
  ScheduledCommand,
  StatsQuery,
  StatsResponse,
  TimelineSegment,
} from '../../../shared/types'
import { SseParser, type SseEvent } from '../../../shared/sse'
import { storage } from './storage'

export interface User {
  id: number
  username: string
  email: string
  fullName: string | null
  role: string
}

interface Session {
  accessToken: string
  refreshToken: string
  user: User
}

const SESSION_KEY = 'warehouse.session'
const URL_KEY = 'warehouse.apiUrl'

/** Mặc định: EXPO_PUBLIC_API_URL, bản web dùng cùng máy; điện thoại thật phải nhập IP LAN của máy chạy backend. */
export const DEFAULT_API_URL = process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'web' ? 'http://localhost:8080' : 'http://192.168.1.13:8080')

let apiUrl = DEFAULT_API_URL
let session: Session | null = null
const listeners = new Set<(s: Session | null) => void>()

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Đọc session + địa chỉ backend đã lưu (gọi một lần khi mở app). */
export async function loadSession(): Promise<Session | null> {
  apiUrl = (await storage.get(URL_KEY)) ?? DEFAULT_API_URL
  const raw = await storage.get(SESSION_KEY)
  try {
    session = raw ? (JSON.parse(raw) as Session) : null
  } catch {
    session = null
  }
  return session
}

export const getApiUrl = () => apiUrl
export async function setApiUrl(url: string) {
  apiUrl = url.trim().replace(/\/+$/, '')
  await storage.set(URL_KEY, apiUrl)
}

export const getSession = () => session
export async function setSession(s: Session | null) {
  session = s
  await storage.set(SESSION_KEY, s ? JSON.stringify(s) : null)
  listeners.forEach((l) => l(s))
}
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
const FIELD: Record<string, string> = { username: 'Tên đăng nhập', email: 'Email', password: 'Mật khẩu', fullName: 'Họ tên' }

async function toError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`
  let message = `Lỗi ${res.status}`
  try {
    const body = await res.json()
    if (body?.error) code = body.error
    if (body?.message) message = body.message
    if (code === 'validation_failed' && body?.details && typeof body.details === 'object') {
      message = Object.entries(body.details as Record<string, unknown>)
        .map(([k, v]) => `${FIELD[k] ?? k}: ${v}`)
        .join(' · ')
    }
  } catch {
    /* không phải JSON */
  }
  return new ApiError(res.status, code, MESSAGES[code] ?? message)
}

let refreshing: Promise<boolean> | null = null

export function refreshSession(): Promise<boolean> {
  if (!session) return Promise.resolve(false)
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${apiUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: session!.refreshToken }),
      })
      if (!res.ok) {
        if (res.status === 401) await setSession(null)
        return false
      }
      const r = await res.json()
      await setSession({ accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user })
      return true
    } catch {
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

type Query = Record<string, string | number | boolean | undefined | null>

function buildUrl(path: string, query?: Query) {
  const qs = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return `${apiUrl}${path}${qs ? `?${qs}` : ''}`
}

interface Opts {
  method?: string
  body?: unknown
  query?: Query
  auth?: boolean
  /** Trả Response thô (stream SSE / âm thanh). `stream` dùng expo/fetch để đọc body theo từng đoạn. */
  raw?: boolean
  stream?: boolean
  signal?: AbortSignal
}

export async function request<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
  const { method = 'GET', body, query, auth = true, raw, stream, signal } = opts
  const doFetch = (): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (auth && session) headers.Authorization = `Bearer ${session.accessToken}`
    let payload: BodyInit | undefined
    if (body instanceof FormData) payload = body
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    if (stream) headers.Accept = 'text/event-stream'
    const f = (stream ? expoFetch : fetch) as typeof fetch
    return f(buildUrl(path, query), { method, headers, body: payload, signal })
  }
  let res: Response
  try {
    res = await doFetch()
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, 'network', `Không kết nối được backend (${apiUrl})`)
  }
  if (res.status === 401 && auth && session && (await refreshSession())) res = await doFetch()
  if (!res.ok) throw await toError(res)
  if (raw || stream) return res as unknown as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
export const isAdmin = (u: User | null | undefined) => u?.role?.toUpperCase() === 'ADMIN'

// ------------------------------------------------------------------ xác thực

interface AuthResponse {
  accessToken: string
  refreshToken: string
  user: User
}

export const auth = {
  async login(login: string, password: string) {
    const r = await request<AuthResponse>('/api/auth/login', { method: 'POST', body: { login: login.trim(), password }, auth: false })
    await setSession({ accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user })
    return r.user
  },
  async register(body: { username: string; email: string; password: string; fullName?: string }) {
    const r = await request<AuthResponse>('/api/auth/register', { method: 'POST', body, auth: false })
    await setSession({ accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user })
    return r.user
  },
  async logout() {
    const s = session
    if (s) await request('/api/auth/logout', { method: 'POST', body: { refreshToken: s.refreshToken }, auth: false }).catch(() => undefined)
    await setSession(null)
  },
}

// ------------------------------------------------------------------ dữ liệu

export const getState = () => request<LiveState>('/api/state')

export const readings = {
  climate: (from: string) => request<{ ts: string; temp: number | null; hum: number | null }[]>('/api/readings/climate', { query: { from, limit: 2000 } }),
  mq135: (from: string) => request<{ ts: string; raw: number; warmingUp: boolean }[]>('/api/readings/mq135', { query: { from, limit: 2000 } }),
}

export const getStats = (q: StatsQuery) =>
  request<StatsResponse>('/api/stats', {
    query: { metric: q.metric, from: q.from, to: q.to, interval: q.interval, agg: q.agg?.join(','), group_by: q.group_by, device: q.device },
  })

export const getTimeline = (device: DeviceName, from: string, to: string) => request<TimelineSegment[]>('/api/stats/timeline', { query: { device, from, to } })

export const devices = {
  async command(device: DeviceName, body: { state?: 'on' | 'off'; mode?: 'auto'; durationS?: number }) {
    return (await request<{ traceId: string }>(`/api/devices/${device}/command`, { method: 'POST', body })).traceId
  },
  logs: (q: { device?: DeviceName; source?: CommandSource; from?: string; page?: number; size?: number }) =>
    request<DeviceLog[]>('/api/device-logs', { query: q }),
}

export const configApi = {
  get: () => request<DeviceConfig>('/api/config'),
  update: (partial: Partial<DeviceConfig>) => request('/api/config', { method: 'PUT', body: partial }),
}

export const alertsApi = {
  list: (q: { level?: AlertLevel; unacked?: boolean; page?: number; size?: number } = {}) => request<Alert[]>('/api/alerts', { query: q }),
  get: (id: number) => request<Alert>(`/api/alerts/${id}`),
  ack: (id: number) => request<Alert>(`/api/alerts/${id}/ack`, { method: 'POST' }),
  feedback: (id: number, feedback: 'true_alarm' | 'false_alarm', note?: string) =>
    request<Alert>(`/api/alerts/${id}/feedback`, { method: 'POST', body: { feedback, note } }),
}

export const memoriesApi = {
  mine: () => request<MemoryItem[]>('/api/memories'),
  deleteMine: (key: string) => request(`/api/memories/${encodeURIComponent(key)}`, { method: 'DELETE' }),
}

export const schedulesApi = {
  list: () => request<ScheduledCommand[]>('/api/schedules'),
  cancel: (id: string) => request(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

export const pushApi = {
  status: () => request<{ enabled: boolean; myDevices: number }>('/api/push/status'),
  register: (token: string, platform: string) => request('/api/push/tokens', { method: 'POST', body: { token, platform } }),
  unregister: (token: string) => request('/api/push/tokens', { method: 'DELETE', body: { token } }),
}

// ------------------------------------------------------------------ chat & giọng nói

export interface ChatThread {
  id: string
  title: string | null
  updated_at: string
}

export interface StoredMessage {
  id: number
  role: 'user' | 'assistant'
  kind: string
  content: string
  blocks: Record<string, unknown>[] | null
  input_mode: 'text' | 'voice' | null
}

/** Đọc stream SSE (expo/fetch hỗ trợ đọc body theo từng đoạn trên điện thoại). */
export async function* readSse(res: Response): AsyncGenerator<SseEvent> {
  const parser = new SseParser()
  const body = res.body
  if (!body) {
    yield* parser.push((await res.text()) + '\n\n')
    return
  }
  const reader = body.getReader()
  const dec = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    yield* parser.push(dec.decode(value, { stream: true }))
  }
}

export const chatApi = {
  threads: () => request<ChatThread[]>('/api/chat/threads', { query: { limit: 30 } }),
  thread: (id: string) => request<{ messages: StoredMessage[]; pending: Record<string, unknown> | null }>(`/api/chat/threads/${encodeURIComponent(id)}`),
  deleteThread: (id: string) => request(`/api/chat/threads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  send: (message: string, threadId: string | null, inputMode: 'text' | 'voice', signal?: AbortSignal) =>
    request<Response>('/api/chat', { method: 'POST', body: { message, threadId: threadId ?? undefined, inputMode }, stream: true, signal }),
  confirm: (threadId: string, approved: boolean, signal?: AbortSignal) =>
    request<Response>(`/api/chat/${encodeURIComponent(threadId)}/confirm`, { method: 'POST', body: { approved }, stream: true, signal }),
}

export const voiceApi = {
  /** Gửi file ghi âm lên server (OpenAI STT) — dự phòng khi máy không tự nhận dạng được tiếng Việt. */
  async stt(uri: string): Promise<string> {
    const fd = new FormData()
    if (Platform.OS === 'web') {
      const blob = await (await fetch(uri)).blob()
      fd.append('file', blob, 'voice.webm')
    } else {
      const name = uri.split('/').pop() || 'voice.m4a'
      fd.append('file', { uri, name, type: name.endsWith('.webm') ? 'audio/webm' : 'audio/m4a' } as unknown as Blob)
    }
    return (await request<{ text: string }>('/api/voice/stt', { method: 'POST', body: fd })).text
  },
  async tts(text: string): Promise<ArrayBuffer> {
    const res = await request<Response>('/api/voice/tts', { method: 'POST', body: { text }, raw: true })
    return res.arrayBuffer()
  },
}
