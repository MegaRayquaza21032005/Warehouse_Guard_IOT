import type { AlertLevel, CommandSource, DeviceName, SafetyState } from './types'

export const DEVICE_LABEL: Record<DeviceName, string> = {
  fan: 'Quạt',
  mist: 'Phun sương',
  light: 'Đèn',
}

export const SAFETY_LABEL: Record<SafetyState, string> = {
  normal: 'Bình thường',
  gas: 'Có khí / khói',
  gas_danger: 'Rò rỉ khí nhiều',
  fire: 'Nghi cháy',
}

export const SAFETY_HINT: Record<SafetyState, string> = {
  normal: 'Không phát hiện bất thường.',
  gas: 'MQ2 vượt ngưỡng cảnh báo, nhiệt độ bình thường. Quạt đang thông gió.',
  gas_danger: 'Nồng độ khí rất cao. Quạt và đèn bật, phun sương tắt. Kiểm tra nguồn rò rỉ.',
  fire: 'Khói kèm nhiệt độ cao hoặc tăng nhanh. Quạt TẮT, phun sương và đèn BẬT.',
}

export const SOURCE_LABEL: Record<CommandSource, string> = {
  esp32_local: 'ESP32 (luật cục bộ)',
  rule: 'Tầng luật',
  agent: 'AI agent',
  user: 'Người dùng',
}

export const LEVEL_LABEL: Record<AlertLevel, string> = {
  critical: 'Nguy hiểm',
  warning: 'Cảnh báo',
  info: 'Thông tin',
}

const REASON: Record<string, string> = {
  fire_off: 'Tắt vì nghi cháy',
  fire: 'Nghi cháy',
  fire_max_time: 'Hết thời gian phun khi cháy',
  gas_danger: 'Khí nhiều',
  gas: 'Có khí / khói',
  hum_high: 'Độ ẩm cao',
  hum_ineffective: 'Thông gió không hiệu quả',
  temp_high: 'Nhiệt độ cao',
  cooling: 'Làm mát',
  cooldown: 'Nghỉ giữa các lần phun',
  blocked_hum_high: 'Bị chặn: độ ẩm cao',
  blocked_gas: 'Bị chặn: có khói, không nóng',
  manual: 'Thủ công',
  idle: 'Không có yêu cầu',
  motion_after_hours: 'Chuyển động ngoài giờ',
}

export const reasonLabel = (r: string) => REASON[r] ?? r

const ALERT_TYPE: Record<string, string> = {
  fire: 'Nghi cháy',
  fire_people: 'Nghi cháy, có người',
  gas_danger: 'Rò rỉ khí nhiều',
  gas: 'Có khí / khói',
  intrusion: 'Đột nhập',
  mist_fire_max_time: 'Phun sương hết giờ',
  device_offline: 'Thiết bị mất kết nối',
  no_data: 'Không có dữ liệu',
  device_no_response: 'Thiết bị không phản hồi',
  sensor_fault: 'Lỗi cảm biến',
  temp_high_prolonged: 'Nóng kéo dài',
  hum_high_prolonged: 'Ẩm kéo dài',
  ventilation_ineffective: 'Thông gió không hiệu quả',
  recovered: 'Đã phục hồi',
  escalation: 'Leo thang',
}

export const alertTypeLabel = (t: string) => {
  if (t.endsWith('_analysis')) return `Phân tích: ${ALERT_TYPE[t.replace(/_analysis$/, '')] ?? t}`
  return ALERT_TYPE[t] ?? t
}

export const FAULT_LABEL: Record<string, string> = {
  mq2_disconnected: 'MQ2 mất kết nối (đọc ≈ 0)',
  mq2_saturated: 'MQ2 bão hòa (đọc ≈ 4095)',
  dht_failed: 'DHT11 đọc lỗi liên tiếp',
}

const timeFmt = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' })
const timeSecFmt = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const dateTimeFmt = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})
const dayFmt = new Intl.DateTimeFormat('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' })

export const fmtTime = (iso: string | number) => timeFmt.format(new Date(iso))
export const fmtTimeSec = (iso: string | number) => timeSecFmt.format(new Date(iso))
export const fmtDateTime = (iso: string | number) => dateTimeFmt.format(new Date(iso))
export const fmtDay = (iso: string | number) => dayFmt.format(new Date(iso))

export function fmtAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 10) return 'vừa xong'
  if (s < 60) return `${s} giây trước`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} phút trước`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} giờ trước`
  return `${Math.round(h / 24)} ngày trước`
}

export function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h} giờ ${m} phút`
  if (m > 0) return `${m} phút`
  return `${sec} giây`
}

export const WEEKDAY_SHORT = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']
