// Kiểu dữ liệu khớp với MQTT contract (CLAUDE.md mục 4) và API của Java BE (backend/README.md).
// Dùng chung cho web (frontend/web) và mobile (frontend/mobile).

export type Mq2Level = 'normal' | 'warning' | 'danger'
export type SafetyState = 'normal' | 'gas' | 'gas_danger' | 'fire'
export type DeviceName = 'fan' | 'mist' | 'light'
export type CommandSource = 'esp32_local' | 'user' | 'rule' | 'agent'
export type AlertLevel = 'critical' | 'warning' | 'info'
export type AckResult = 'applied' | 'ignored_user_priority' | 'invalid_command' | 'invalid_source'

export interface Mq2Data {
  raw: number
  mv: number
  level: Mq2Level
  warmingUp: boolean
}

export interface Dht11Data {
  temp?: number
  hum?: number
  tempRise?: number
  error?: string
  failCount?: number
}

export interface PirData {
  motion: boolean
}

export interface SafetyData {
  state: SafetyState
  mq2Level: Mq2Level
  tempRise: number
  faults: string[]
}

export interface DeviceStatus {
  state: 'on' | 'off'
  mode: 'auto' | 'manual'
  reason: string
  source: CommandSource
  trace_id: string | null
  ack?: { trace_id: string; result: AckResult }
}

export interface DeviceHealth {
  id: string
  uptime: number
  rssi: number
  ip: string
}

export interface DeviceConfig {
  mq2Warning: number
  mq2Danger: number
  tempHigh: number
  humHigh: number
  tempRiseC: number
  tempRiseWindowMin: number
  mistFireMaxMin: number
  mistCoolMaxMin: number
  mistCooldownMin: number
  mistHumMax: number
  humFanCheckMin: number
  humFanMinDrop: number
}

export interface Stamped<T> {
  data: T
  updatedAt: string
}

export interface WorkHours {
  start: string // "08:00"
  end: string
  days: number[] // 1 = Thứ 2 … 7 = Chủ nhật
  timezone: string
}

/**
 * `GET /api/state` của Java BE. Mục nào ESP32 chưa từng gửi thì là `null`
 * (vd. mới khởi động backend, chưa cắm thiết bị).
 */
export interface LiveState {
  online: Stamped<{ status: 'online' | 'offline' }> | null
  device: Stamped<DeviceHealth> | null
  safety: Stamped<SafetyData> | null
  sensors: {
    mq2: Stamped<Mq2Data> | null
    dht11: Stamped<Dht11Data> | null
    pir: Stamped<PirData> | null
  }
  devices: Record<DeviceName, Stamped<DeviceStatus> | null>
  config: Stamped<DeviceConfig> | null
  brokerConnected?: boolean
  workHours?: WorkHours
}

/** `GET /api/alerts` (+ sự kiện WebSocket `alert`). */
export interface Alert {
  id: number
  ts: string
  type: string
  level: AlertLevel
  message: string
  source: 'rule' | 'agent'
  incidentId: string | null
  acknowledgedBy: number | null
  acknowledgedByName: string | null
  acknowledgedAt: string | null
  feedback: 'true_alarm' | 'false_alarm' | null
  feedbackNote: string | null
  details: Record<string, unknown>
}

/** `GET /api/device-logs`. `result` = null: chưa có xác nhận (luật cục bộ ESP32 thì không cần). */
export interface DeviceLog {
  id: number
  ts: string
  device: DeviceName
  action: string
  source: CommandSource
  userId: number | null
  username: string | null
  traceId: string | null
  reason: string | null
  durationS: number | null
  result: AckResult | 'publish_failed' | null
  resultAt: string | null
  confirmedState: string | null
}

/** Memory cá nhân / dùng chung của AI Agent (`/api/memories`). */
export interface MemoryItem {
  key: string
  text: string
  kind?: string
  source?: string
  created_at?: string
  created_by?: number | string | null
}

export interface StatsQuery {
  metric: string
  from: string
  to: string
  interval?: '5m' | '1h' | '1d' | '1w'
  agg?: string[]
  group_by?: string
  device?: DeviceName
}

export interface StatsPoint {
  t: string
  v: number
}

export interface StatsResponse {
  metric: string
  interval: string
  from: string
  to: string
  groupBy: string | null
  series: { name: string; points: StatsPoint[] }[]
  cells?: { dayOfWeek: number; hour: number; v: number }[]
  /** Chỉ phía client: lỗi khi tải. */
  error?: string
}

export interface TimelineSegment {
  start: string
  end: string
  state: string
  reason: string
  source: CommandSource
}

export type ChartKind = 'line' | 'bar' | 'stacked_bar' | 'heatmap' | 'timeline' | 'stat'

/** Khối biểu đồ trong chat (CLAUDE.md mục 6) — chứa câu truy vấn, không chứa số liệu. */
export interface ChartBlock {
  type: 'chart'
  chart: ChartKind
  title: string
  query: StatsQuery
  thresholds?: { label: string; value: number }[]
}
