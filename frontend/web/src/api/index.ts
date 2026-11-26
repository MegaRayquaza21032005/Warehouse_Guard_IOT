/**
 * Lớp API cho giao diện — gọi Java BE (cửa ngõ duy nhất, CLAUDE.md mục 3). Các trang chỉ dùng module này.
 * Tài liệu API: backend/README.md.
 */
import type {
  Alert,
  AlertLevel,
  CameraSnapshot,
  CameraStatus,
  DeviceConfig,
  DeviceLog,
  DeviceName,
  CommandSource,
  LiveState,
  MemoryItem,
  ScheduledCommand,
  StatsQuery,
  StatsResponse,
  TimelineSegment,
} from '../types'
import { ApiError, buildUrl, getSession, refreshSession, request, setSession, type User } from './client'

export { ApiError, type User }

interface AuthResponse {
  accessToken: string
  refreshToken: string
  user: User
}

export const auth = {
  current: (): User | null => getSession()?.user ?? null,
  async login(login: string, password: string): Promise<User> {
    const r = await request<AuthResponse>('/api/auth/login', { method: 'POST', body: { login: login.trim(), password }, auth: false })
    setSession({ accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user })
    return r.user
  },
  async register(body: { username: string; email: string; password: string; fullName?: string }): Promise<User> {
    const r = await request<AuthResponse>('/api/auth/register', { method: 'POST', body, auth: false })
    setSession({ accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user })
    return r.user
  },
  async logout() {
    const s = getSession()
    setSession(null)
    if (s) await request('/api/auth/logout', { method: 'POST', body: { refreshToken: s.refreshToken }, auth: false }).catch(() => undefined)
  },
  /** Access token còn hạn cho WebSocket (refresh trước nếu cần). */
  async wsToken(forceRefresh = false): Promise<string | null> {
    if (forceRefresh) await refreshSession()
    return getSession()?.accessToken ?? null
  },
}

export const isAdmin = (u: User | null | undefined) => u?.role?.toUpperCase() === 'ADMIN'

// ------------------------------------------------------------------ trạng thái & dữ liệu

export const getState = () => request<LiveState>('/api/state')

export interface ClimateReading {
  ts: string
  temp: number | null
  hum: number | null
  tempRise: number | null
  error: string | null
}
export interface Mq135Reading {
  ts: string
  raw: number
  mv: number | null
  level: string
  warmingUp: boolean
}

export const readings = {
  climate: (from: string, to?: string, limit = 2000) => request<ClimateReading[]>('/api/readings/climate', { query: { from, to, limit } }),
  mq135: (from: string, to?: string, limit = 2000) => request<Mq135Reading[]>('/api/readings/mq135', { query: { from, to, limit } }),
}

export function getStats(q: StatsQuery): Promise<StatsResponse> {
  return request<StatsResponse>('/api/stats', {
    query: { metric: q.metric, from: q.from, to: q.to, interval: q.interval, agg: q.agg?.join(','), group_by: q.group_by, device: q.device },
  })
}

export function getTimeline(device: DeviceName, from: string, to: string): Promise<TimelineSegment[]> {
  return request<TimelineSegment[]>('/api/stats/timeline', { query: { device, from, to } })
}

// ------------------------------------------------------------------ thiết bị & cấu hình

export const devices = {
  /** `POST /api/devices/{device}/command` → trace_id (ESP32 xác nhận qua WebSocket `status.*` có `ack.trace_id`). */
  async command(device: DeviceName, body: { state?: 'on' | 'off'; mode?: 'auto'; durationS?: number }): Promise<string> {
    const r = await request<{ traceId: string }>(`/api/devices/${device}/command`, { method: 'POST', body })
    return r.traceId
  },
  logs: (q: { device?: DeviceName; source?: CommandSource; from?: string; to?: string; page?: number; size?: number }) =>
    request<DeviceLog[]>('/api/device-logs', { query: q }),
}

export const configApi = {
  get: () => request<DeviceConfig>('/api/config'),
  /** `PUT /api/config` (202) — ESP32 xác nhận qua `status/config`. */
  update: (partial: Partial<DeviceConfig>) => request<{ status: string; config: DeviceConfig }>('/api/config', { method: 'PUT', body: partial }),
}

// ------------------------------------------------------------------ cảnh báo

export const alertsApi = {
  list: (q: { level?: AlertLevel; unacked?: boolean; page?: number; size?: number } = {}) => request<Alert[]>('/api/alerts', { query: q }),
  ack: (id: number) => request<Alert>(`/api/alerts/${id}/ack`, { method: 'POST' }),
  feedback: (id: number, feedback: 'true_alarm' | 'false_alarm', note?: string) =>
    request<Alert>(`/api/alerts/${id}/feedback`, { method: 'POST', body: { feedback, note } }),
}

// ------------------------------------------------------------------ memory của trợ lý AI

export const memoriesApi = {
  mine: () => request<MemoryItem[]>('/api/memories'),
  deleteMine: (key: string) => request<void>(`/api/memories/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  warehouse: (kind: 'facts' | 'incidents' | 'feedback' = 'facts') => request<MemoryItem[]>('/api/memories/warehouse', { query: { kind } }),
  deleteFact: (key: string) => request<void>(`/api/memories/warehouse/${encodeURIComponent(key)}`, { method: 'DELETE' }),
}

// ------------------------------------------------------------------ lệnh hẹn giờ (tạo từ chatbot)

export const schedulesApi = {
  list: () => request<ScheduledCommand[]>('/api/schedules'),
  cancel: (id: string) => request<void>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

// ------------------------------------------------------------------ camera (service vision qua Java BE)

/**
 * Thẻ <img> không gửi được header Authorization → URL ảnh / MJPEG mang access token trong query
 * (backend chỉ chấp nhận cách này cho GET /api/camera/*). Token hết hạn → ảnh lỗi → gọi `cameraApi.refreshToken()`
 * rồi tạo lại URL.
 */
export const cameraApi = {
  status: () => request<CameraStatus>('/api/camera/status'),
  snapshots: (q: { alertId?: number; incidentId?: string; limit?: number } = {}) =>
    request<CameraSnapshot[]>('/api/camera/snapshots', { query: q }),
  streamUrl: (fps = 10, n = 0) => buildUrl('/api/camera/stream', { fps, n, access_token: getSession()?.accessToken }),
  snapshotUrl: () => buildUrl('/api/camera/snapshot', { access_token: getSession()?.accessToken, t: Date.now() }),
  imageUrl: (id: number) => buildUrl(`/api/camera/snapshots/${id}/image`, { access_token: getSession()?.accessToken }),
  /** Làm mới access token (khi ảnh / luồng bị 401). Trả false nếu phiên đã hết. */
  refreshToken: () => refreshSession(),
}

// ------------------------------------------------------------------ chat & giọng nói

export interface ChatThread {
  id: string
  title: string | null
  created_at: string
  updated_at: string
}

export interface StoredMessage {
  id: number
  role: 'user' | 'assistant'
  kind: 'text' | 'confirmation' | 'result' | 'error' | string
  content: string
  blocks: Record<string, unknown>[] | null
  input_mode: 'text' | 'voice' | null
  trace_id: string | null
  created_at: string
}

export const chatApi = {
  threads: () => request<ChatThread[]>('/api/chat/threads', { query: { limit: 50 } }),
  thread: (id: string) =>
    request<{ thread: ChatThread; messages: StoredMessage[]; pending: Record<string, unknown> | null }>(`/api/chat/threads/${encodeURIComponent(id)}`),
  deleteThread: (id: string) => request<void>(`/api/chat/threads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** SSE — đọc bằng `readSse` trong lib/sse.ts. */
  send: (message: string, threadId: string | null, inputMode: 'text' | 'voice', signal?: AbortSignal) =>
    request<Response>('/api/chat', { method: 'POST', body: { message, threadId: threadId ?? undefined, inputMode }, raw: true, signal }),
  confirm: (threadId: string, approved: boolean, signal?: AbortSignal) =>
    request<Response>(`/api/chat/${encodeURIComponent(threadId)}/confirm`, { method: 'POST', body: { approved }, raw: true, signal }),
}

export const voiceApi = {
  /** Dự phòng khi thiết bị không tự nhận dạng được tiếng Việt → OpenAI STT qua ai-agent. */
  async stt(audio: Blob, filename = 'voice.webm'): Promise<string> {
    const fd = new FormData()
    fd.append('file', audio, filename)
    const r = await request<{ text: string }>('/api/voice/stt', { method: 'POST', body: fd })
    return r.text
  },
  /** Không có giọng tiếng Việt trên thiết bị → OpenAI TTS (audio/mpeg). */
  async tts(text: string): Promise<Blob> {
    const res = await request<Response>('/api/voice/tts', { method: 'POST', body: { text }, raw: true })
    return res.blob()
  },
}

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e))
