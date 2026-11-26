// Kiểu dữ liệu khớp với MQTT contract (CLAUDE.md mục 4) và API của Java BE (backend/README.md).
// Dùng chung cho web (frontend/web) và mobile (frontend/mobile).

export type Mq135Level = 'normal' | 'warning' | 'danger'
export type SafetyState = 'normal' | 'gas' | 'gas_danger' | 'fire'
export type DeviceName = 'fan' | 'mist' | 'light'
export type CommandSource = 'esp32_local' | 'user' | 'rule' | 'agent'
export type AlertLevel = 'critical' | 'warning' | 'info'
export type AckResult = 'applied' | 'ignored_user_priority' | 'invalid_command' | 'invalid_source'

export interface Mq135Data {
  raw: number
  mv: number
  level: Mq135Level
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

/**
 * `warehouse/sensor/camera` — service vision (camera + YOLO). Gửi 5s/lần + khi có / hết người, lửa, khói.
 * Lỗi camera: chỉ có `error` (vd. `camera_unavailable`, `detector_failed`).
 * `fire` / `smoke` không có = vision chưa có model lửa / khói (không biết).
 */
export interface CameraData {
  person?: boolean
  personCount?: number
  personConf?: number | null
  fire?: boolean
  fireConf?: number | null
  smoke?: boolean
  smokeConf?: number | null
  fps?: number | null
  error?: string
}

/** `warehouse/status/camera` (retained, LWT offline). */
export interface CameraOnline {
  status: 'online' | 'offline'
  model?: string
  /** Model lửa / khói; null = không bật */
  fireModel?: string | null
  device?: string
}

export interface SafetyData {
  state: SafetyState
  mq135Level: Mq135Level
  tempRise: number
  faults: string[]
  /** ESP32 đang dùng "camera thấy lửa" làm bằng chứng nóng (MQ135 có khói + camera thấy lửa -> fire) */
  cameraFire?: boolean
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
  mq135Warning: number
  mq135Danger: number
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
    mq135: Stamped<Mq135Data> | null
    dht11: Stamped<Dht11Data> | null
    pir: Stamped<PirData> | null
    camera?: Stamped<CameraData> | null
  }
  devices: Record<DeviceName, Stamped<DeviceStatus> | null>
  config: Stamped<DeviceConfig> | null
  /** Service vision online / offline. */
  camera?: Stamped<CameraOnline> | null
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
  /** Ảnh camera chụp lúc có cảnh báo (đột nhập / cháy có người) — `GET /api/camera/snapshots/{id}/image`. */
  snapshotId?: number | null
}

/** `GET /api/camera/snapshots` — ảnh chụp khi có sự cố (không kèm dữ liệu ảnh). */
export interface CameraSnapshot {
  id: number
  ts: string
  alertId: number | null
  alertType: string | null
  incidentId: string | null
  personCount: number | null
  contentType: string
  sizeBytes: number
}

/** `GET /api/camera/status` — bản tin MQTT mới nhất + chi tiết từ service vision (nếu đang chạy). */
export interface CameraStatus {
  online: Stamped<CameraOnline> | null
  detection: Stamped<CameraData> | null
  reachable: boolean
  error?: string
  service: {
    uptimeS: number
    camera: { source: string; opened: boolean; error: string | null; width: number | null; height: number | null } | null
    model: {
      name: string
      device: string
      half: boolean
      imgsz: number
      conf: number
      inferFps: number
      /** Model lửa / khói: null = tắt; có `error` = không nạp được */
      fire?: { name: string; fireConf?: number; smokeConf?: number; confirmFrames?: number; clearS?: number; error?: string } | null
    }
    detection: {
      person: boolean
      personCount: number
      personConf: number | null
      detections: number
      fps: number | null
      inferMs: number | null
      frames: number
      error: string | null
      fireEnabled?: boolean
      fire?: boolean
      fireConf?: number | null
      smoke?: boolean
      smokeConf?: number | null
    }
    mqttConnected: boolean
    viewers: number
  } | null
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

/**
 * Lệnh thiết bị hẹn giờ / nối chuỗi do chatbot tạo (`GET /api/schedules`) — nằm trong RAM của AI Agent,
 * mất khi AI Agent khởi động lại. Lệnh thủ công mới cho cùng thiết bị sẽ hủy lịch.
 */
export interface ScheduledCommand {
  id: string
  device: DeviceName
  description: string
  run_at: string
  created_at: string
  remaining_s: number
  user_id: number | null
  trace_id: string
  thread_id: string | null
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
