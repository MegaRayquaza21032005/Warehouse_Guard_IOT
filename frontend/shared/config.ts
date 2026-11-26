import type { DeviceConfig, WorkHours } from './types'

/** Mặc định của firmware (`config.h`) — dùng khi ESP32 chưa gửi `status/config`. */
export const DEFAULT_CONFIG: DeviceConfig = {
  mq135Warning: 1500,
  mq135Danger: 2500,
  tempHigh: 38,
  humHigh: 80,
  tempRiseC: 3,
  tempRiseWindowMin: 5,
  mistFireMaxMin: 10,
  mistCoolMaxMin: 5,
  mistCooldownMin: 15,
  mistHumMax: 70,
  humFanCheckMin: 30,
  humFanMinDrop: 3,
}

/** Kiểm tra giống firmware (CLAUDE.md mục 4, `cmd/config`). Trả về lỗi hoặc null. */
export function validateConfig(c: DeviceConfig): string | null {
  if (c.mq135Danger <= c.mq135Warning + 150) return 'Ngưỡng nguy hiểm MQ135 phải lớn hơn ngưỡng cảnh báo + 150'
  if (c.mq135Danger > 4095) return 'Ngưỡng nguy hiểm MQ135 tối đa 4095'
  if (c.mistHumMax >= c.humHigh) return 'Độ ẩm cho phép phun sương phải nhỏ hơn ngưỡng độ ẩm cao'
  if (c.tempRiseWindowMin < 1 || c.tempRiseWindowMin > 15) return 'Khoảng thời gian tăng nhiệt: 1–15 phút'
  for (const k of ['mistFireMaxMin', 'mistCoolMaxMin'] as const) if (c[k] < 1 || c[k] > 60) return 'Thời gian phun sương: 1–60 phút'
  if (c.mistCooldownMin < 0 || c.mistCooldownMin > 240) return 'Thời gian nghỉ phun sương: 0–240 phút'
  if (c.humFanCheckMin < 5 || c.humFanCheckMin > 240) return 'Thời gian kiểm tra thông gió: 5–240 phút'
  return null
}

export const DEFAULT_WORK_HOURS: WorkHours = { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5, 6], timezone: 'Asia/Ho_Chi_Minh' }

/** Đang trong giờ làm việc? Tính theo múi giờ của kho (không theo múi giờ trình duyệt). */
export function isWorkHours(wh: WorkHours, at = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: wh.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1
  const minutes = Number(get('hour')) * 60 + Number(get('minute'))
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
  return wh.days.includes(dow) && minutes >= toMin(wh.start) && minutes < toMin(wh.end)
}

const DAY_NAMES = ['', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']

/** "T2–T7, 08:00–17:30" */
export function fmtWorkHours(wh: WorkHours): string {
  const d = [...wh.days].sort()
  const contiguous = d.every((v, i) => i === 0 || v === d[i - 1] + 1)
  const days = d.length > 2 && contiguous ? `${DAY_NAMES[d[0]]}–${DAY_NAMES[d[d.length - 1]]}` : d.map((x) => DAY_NAMES[x]).join(', ')
  return `${days}, ${wh.start}–${wh.end}`
}
