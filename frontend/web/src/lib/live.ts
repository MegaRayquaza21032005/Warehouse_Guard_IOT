/**
 * Trạng thái realtime từ Java BE: snapshot `GET /api/state` + WebSocket `/ws/live` (tự kết nối lại),
 * bộ đệm 30 phút cho biểu đồ tổng quan, danh sách cảnh báo gần nhất.
 */
import type { Alert, DeviceConfig, LiveState, Stamped, WorkHours } from '../types'
import { alertsApi, auth, configApi, getState, readings } from '../api'
import { API_BASE } from '../api/client'
import { DEFAULT_CONFIG, DEFAULT_WORK_HOURS, isWorkHours } from './config'

export interface BufferPoint {
  t: number
  temp: number | null
  hum: number | null
  mq2: number | null
}

export type ConnState = 'connecting' | 'open' | 'closed'

export interface LiveSnapshot {
  live: LiveState
  /** Cấu hình đang dùng: `status/config` của ESP32 → `GET /api/config` → mặc định firmware. */
  config: DeviceConfig
  configUpdatedAt: string | null
  workHours: WorkHours
  afterHours: boolean
  buffer: BufferPoint[]
  alerts: Alert[]
  alertsLoaded: boolean
  moreAlerts: boolean
  conn: ConnState
  error: string | null
  /**
   * `ack` gần nhất của từng thiết bị. ESP32 chỉ gửi `ack` trong bản tin ngay sau lệnh; bản tin kế tiếp
   * (vd. relay vừa đóng xong) không có `ack` → phải giữ lại ở đây để giao diện không bỏ lỡ xác nhận.
   */
  acks: Partial<Record<'fan' | 'mist' | 'light', { trace_id: string; result: string }>>
}

const BUFFER_MS = 30 * 60_000
const ALERT_PAGE = 100

const EMPTY_LIVE: LiveState = {
  online: null,
  device: null,
  safety: null,
  sensors: { mq2: null, dht11: null, pir: null },
  devices: { fan: null, mist: null, light: null },
  config: null,
}

let snap: LiveSnapshot = initial()
const listeners = new Set<() => void>()
const alertListeners = new Set<(a: Alert) => void>()
const messageListeners = new Set<(type: string, data: unknown) => void>()
let fetchedConfig: DeviceConfig | null = null
let ws: WebSocket | null = null
let retry = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
let running = false
let alertPage = 0

function initial(): LiveSnapshot {
  return {
    live: EMPTY_LIVE,
    config: DEFAULT_CONFIG,
    configUpdatedAt: null,
    workHours: DEFAULT_WORK_HOURS,
    afterHours: !isWorkHours(DEFAULT_WORK_HOURS),
    buffer: [],
    alerts: [],
    alertsLoaded: false,
    moreAlerts: false,
    conn: 'connecting',
    error: null,
    acks: {},
  }
}

function set(patch: Partial<LiveSnapshot>) {
  snap = { ...snap, ...patch }
  listeners.forEach((l) => l())
}

function withLive(live: LiveState): Partial<LiveSnapshot> {
  const wh = live.workHours ?? snap.workHours
  const cfg = live.config?.data && !('error' in (live.config.data as object)) ? live.config : null
  return {
    live,
    workHours: wh,
    afterHours: !isWorkHours(wh),
    config: { ...DEFAULT_CONFIG, ...(fetchedConfig ?? {}), ...(cfg ? stripConfig(cfg.data) : {}) },
    configUpdatedAt: cfg?.updatedAt ?? snap.configUpdatedAt,
  }
}

/** Bỏ trường không phải ngưỡng (vd. "error") khỏi bản tin status/config. */
function stripConfig(c: Partial<DeviceConfig> & { error?: unknown }): Partial<DeviceConfig> {
  const out: Partial<DeviceConfig> = {}
  for (const k of Object.keys(DEFAULT_CONFIG) as (keyof DeviceConfig)[]) if (typeof c[k] === 'number') out[k] = c[k]
  return out
}

function mergeLive(type: string, data: unknown, ts: string): LiveState {
  const st = <T>(d: unknown): Stamped<T> => ({ data: d as T, updatedAt: ts })
  const l = snap.live
  switch (type) {
    case 'sensor.mq2':
      return { ...l, sensors: { ...l.sensors, mq2: st(data) } }
    case 'sensor.dht11':
      return { ...l, sensors: { ...l.sensors, dht11: st(data) } }
    case 'sensor.pir':
      return { ...l, sensors: { ...l.sensors, pir: st(data) } }
    case 'status.safety':
      return { ...l, safety: st(data) }
    case 'status.online':
      return { ...l, online: st(data) }
    case 'status.device':
      return { ...l, device: st(data) }
    case 'status.config':
      return { ...l, config: st(data) }
    case 'status.fan':
    case 'status.mist':
    case 'status.light': {
      const d = type.slice(7) as 'fan' | 'mist' | 'light'
      return { ...l, devices: { ...l.devices, [d]: st(data) } }
    }
    default:
      return l
  }
}

function pushBuffer(p: Partial<BufferPoint>, t: number) {
  const last = snap.buffer[snap.buffer.length - 1]
  const point: BufferPoint = {
    t,
    temp: p.temp !== undefined ? p.temp : (last?.temp ?? null),
    hum: p.hum !== undefined ? p.hum : (last?.hum ?? null),
    mq2: p.mq2 !== undefined ? p.mq2 : (last?.mq2 ?? null),
  }
  const cut = t - BUFFER_MS
  return [...snap.buffer.filter((x) => x.t >= cut), point]
}

function onMessage(msg: { type: string; data: unknown; ts?: string }) {
  const ts = msg.ts ?? new Date().toISOString()
  const t = new Date(ts).getTime()
  if (msg.type === 'snapshot') {
    set(withLive({ ...snap.live, ...(msg.data as LiveState), workHours: snap.live.workHours, brokerConnected: snap.live.brokerConnected }))
    return
  }
  if (msg.type === 'alert') {
    const a = normalizeAlert(msg.data as Alert)
    if (!snap.alerts.some((x) => x.id === a.id)) {
      set({ alerts: [a, ...snap.alerts] })
      alertListeners.forEach((l) => l(a))
    }
  } else {
    const live = mergeLive(msg.type, msg.data, ts)
    const patch: Partial<LiveSnapshot> = withLive(live)
    const d = msg.data as Record<string, unknown>
    const ack = d.ack as { trace_id?: string; result?: string } | undefined
    if (/^status\.(fan|mist|light)$/.test(msg.type) && ack?.trace_id && ack.result) {
      patch.acks = { ...snap.acks, [msg.type.slice(7)]: { trace_id: ack.trace_id, result: ack.result } }
    }
    if (msg.type === 'sensor.mq2' && typeof d.raw === 'number' && !d.warmingUp) patch.buffer = pushBuffer({ mq2: d.raw }, t)
    if (msg.type === 'sensor.dht11' && typeof d.temp === 'number') patch.buffer = pushBuffer({ temp: d.temp, hum: (d.hum as number) ?? null }, t)
    set(patch)
  }
  messageListeners.forEach((l) => l(msg.type, msg.data))
}

export function normalizeAlert(a: Alert): Alert {
  return { ...a, details: a.details ?? {}, incidentId: a.incidentId ?? null, feedback: a.feedback ?? null }
}

async function loadBuffer() {
  const from = new Date(Date.now() - BUFFER_MS).toISOString()
  const [cl, mq] = await Promise.all([readings.climate(from).catch(() => []), readings.mq2(from).catch(() => [])])
  const pts: BufferPoint[] = []
  for (const c of cl) if (c.temp !== null) pts.push({ t: new Date(c.ts).getTime(), temp: c.temp, hum: c.hum, mq2: null })
  for (const m of mq) if (!m.warmingUp) pts.push({ t: new Date(m.ts).getTime(), temp: null, hum: null, mq2: m.raw })
  pts.sort((a, b) => a.t - b.t)
  // điền giá trị gần nhất để hai chuỗi vẽ liền
  let temp: number | null = null
  let hum: number | null = null
  let mq2: number | null = null
  const merged = pts.map((p) => {
    temp = p.temp ?? temp
    hum = p.hum ?? hum
    mq2 = p.mq2 ?? mq2
    return { t: p.t, temp, hum, mq2 }
  })
  set({ buffer: [...merged, ...snap.buffer.filter((p) => p.t > (merged.at(-1)?.t ?? 0))] })
}

async function loadAlerts() {
  alertPage = 0
  const list = await alertsApi.list({ size: ALERT_PAGE, page: 0 })
  set({ alerts: list.map(normalizeAlert), alertsLoaded: true, moreAlerts: list.length === ALERT_PAGE })
}

async function connect(forceRefresh = false) {
  if (!running) return
  set({ conn: 'connecting' })
  const token = await auth.wsToken(forceRefresh)
  if (!token || !running) return
  const base = API_BASE || window.location.origin
  const url = `${base.replace(/^http/, 'ws')}/ws/live?token=${encodeURIComponent(token)}`
  const sock = new WebSocket(url)
  ws = sock
  let opened = false
  sock.onopen = () => {
    opened = true
    retry = 0
    set({ conn: 'open', error: null })
  }
  sock.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data))
    } catch {
      /* bản tin hỏng — bỏ qua */
    }
  }
  sock.onclose = () => {
    if (ws !== sock) return
    ws = null
    if (!running) return
    set({ conn: 'closed' })
    retry++
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(retry, 5))
    // không mở được (thường là token hết hạn → 401) → refresh token trước khi thử lại
    retryTimer = setTimeout(() => {
      void connect(!opened)
      if (opened) void refresh() // vừa mất kết nối → nạp lại snapshot và cảnh báo bị lỡ
    }, delay)
  }
}

/** Nạp lại toàn bộ (sau khi mất kết nối). */
export async function refresh() {
  try {
    const [state, cfg] = await Promise.all([getState(), configApi.get().catch(() => null)])
    fetchedConfig = cfg
    set({ ...withLive(state), error: null })
    await loadAlerts()
  } catch (e) {
    set({ error: (e as Error).message })
  }
}

export const live = {
  subscribe(l: () => void) {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
  getSnapshot: () => snap,

  async start() {
    if (running) return
    running = true
    snap = initial()
    await refresh()
    void loadBuffer()
    void connect()
  },

  stop() {
    running = false
    if (retryTimer) clearTimeout(retryTimer)
    const s = ws
    ws = null
    s?.close()
    snap = initial()
  },

  async loadMoreAlerts() {
    alertPage++
    const list = await alertsApi.list({ size: ALERT_PAGE, page: alertPage })
    const known = new Set(snap.alerts.map((a) => a.id))
    set({ alerts: [...snap.alerts, ...list.map(normalizeAlert).filter((a) => !known.has(a.id))], moreAlerts: list.length === ALERT_PAGE })
  },

  /** Cập nhật một cảnh báo sau ack / feedback (giá trị server trả về). */
  replaceAlert(a: Alert) {
    set({ alerts: snap.alerts.map((x) => (x.id === a.id ? normalizeAlert(a) : x)) })
  },

  async ack(id: number) {
    live.replaceAlert(await alertsApi.ack(id))
  },

  async ackAll() {
    const ids = snap.alerts.filter((a) => !a.acknowledgedAt).map((a) => a.id)
    const res = await Promise.allSettled(ids.map((id) => alertsApi.ack(id)))
    for (const r of res) if (r.status === 'fulfilled') live.replaceAlert(r.value)
  },

  async feedback(id: number, fb: 'true_alarm' | 'false_alarm') {
    live.replaceAlert(await alertsApi.feedback(id, fb))
  },

  /** Tính lại "ngoài giờ" (gọi định kỳ). */
  tick() {
    const ah = !isWorkHours(snap.workHours)
    if (ah !== snap.afterHours) set({ afterHours: ah })
  },
}

export function onNewAlert(l: (a: Alert) => void) {
  alertListeners.add(l)
  return () => {
    alertListeners.delete(l)
  }
}

/** Mọi bản tin WebSocket (type, data) — vd. trang nhật ký thiết bị nạp lại khi `status.*` đổi. */
export function onLiveMessage(l: (type: string, data: unknown) => void) {
  messageListeners.add(l)
  return () => {
    messageListeners.delete(l)
  }
}
