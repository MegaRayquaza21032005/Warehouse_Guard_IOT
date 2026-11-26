import { useEffect, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import type { DeviceConfig, DeviceName, DeviceStatus, LiveState } from '../../../../shared/types'
import { DEVICE_LABEL, FAULT_LABEL, SAFETY_HINT, SAFETY_LABEL, SOURCE_LABEL, fmtAgo, fmtDuration, reasonLabel } from '../../../../shared/labels'
import { fmtWorkHours } from '../../../../shared/config'
import { devices, errorText } from '../../lib/api'
import { refresh, live } from '../../lib/live'
import { useLive, useNow } from '../../lib/hooks'
import { useColors, type Colors } from '../../lib/theme'
import { Badge, Button, Card, CardTitle, Muted, Segmented } from '../../components/ui'
import { LineChart } from '../../components/Charts'

export default function Dashboard() {
  const c = useColors()
  const snap = useLive()
  const { live: st, config: cfg, alerts } = snap
  const [refreshing, setRefreshing] = useState(false)
  useNow(15_000)
  const criticals = alerts.filter((a) => !a.acknowledgedAt && a.level === 'critical' && a.source === 'rule')

  const temp = snap.buffer.map((p) => ({ t: p.t, v: p.temp }))
  const hum = snap.buffer.map((p) => ({ t: p.t, v: p.hum }))
  const mq135 = snap.buffer.map((p) => ({ t: p.t, v: p.mq135 }))

  return (
    <ScrollView
      contentContainerStyle={{ padding: 14, gap: 12 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true)
            await refresh()
            setRefreshing(false)
          }}
        />
      }
    >
      <ConnBar />
      {criticals.length > 0 && (
        <View style={{ backgroundColor: c.crit, borderRadius: 12, padding: 12, gap: 8 }} accessibilityRole="alert">
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
            <Ionicons name="alert-circle" size={20} color="#fff" />
            <Text style={{ color: '#fff', fontWeight: '700', flex: 1 }}>{criticals[0].message}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Button small label="Đã xem" onPress={() => criticals.forEach((a) => void live.ack(a.id))} />
            <Button small label="Chi tiết" onPress={() => router.push(`/alert/${criticals[0].id}`)} />
            {criticals.length > 1 && <Text style={{ color: '#fff', flex: 1 }}>+{criticals.length - 1} cảnh báo nguy hiểm khác</Text>}
          </View>
        </View>
      )}
      <SafetyCard st={st} />
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <TempCard st={st} cfg={cfg} />
        <HumCard st={st} cfg={cfg} />
      </View>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Mq135Card st={st} cfg={cfg} />
        <PirCard st={st} afterHours={snap.afterHours} hours={fmtWorkHours(snap.workHours)} />
      </View>
      <Card>
        <CardTitle title="Thiết bị" sub="Luật an toàn trên ESP32 luôn được ưu tiên" />
        {(['fan', 'mist', 'light'] as DeviceName[]).map((d) => (
          <DeviceRow key={d} device={d} status={st.devices[d]?.data ?? null} updatedAt={st.devices[d]?.updatedAt ?? null} st={st} cfg={cfg} />
        ))}
      </Card>
      <Card>
        <CardTitle title="Nhiệt độ" sub="30 phút gần nhất · đường đứt = ngưỡng nóng" />
        <LineChart rows={temp} color={c.temp} height={140} unit="°C" thresholds={[{ label: 'Ngưỡng nóng', value: cfg.tempHigh }]} />
        <CardTitle title="Độ ẩm" />
        <LineChart rows={hum} color={c.hum} height={120} unit="%" thresholds={[{ label: 'Ngưỡng ẩm', value: cfg.humHigh }]} />
      </Card>
      <Card>
        <CardTitle title="Khí / khói (MQ135)" sub="Nền vàng = vùng cảnh báo, đỏ = nguy hiểm" />
        <LineChart rows={mq135} color={c.mq135} height={140} zones={[cfg.mq135Warning, cfg.mq135Danger]} />
      </Card>
      <Muted style={{ textAlign: 'center' }}>Cảm biến phổ thông — không thay thế hệ thống báo cháy đạt chuẩn.</Muted>
    </ScrollView>
  )
}

function ConnBar() {
  const c = useColors()
  const { conn, error, live: st } = useLive()
  const ok = conn === 'open' && !error && st.brokerConnected !== false
  if (ok) return null
  const text = error ? `Không kết nối được backend: ${error}` : conn === 'connecting' ? 'Đang kết nối realtime…' : 'Mất kết nối realtime — đang thử lại'
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => void refresh()}
      style={{ backgroundColor: c.warnSoft, borderRadius: 10, padding: 10, flexDirection: 'row', gap: 8, alignItems: 'center' }}
    >
      <Ionicons name="cloud-offline-outline" size={16} color={c.warn} />
      <Text style={{ color: c.warn, flex: 1, fontSize: 13 }}>{text}</Text>
      <Text style={{ color: c.warn, fontWeight: '700', fontSize: 13 }}>Thử lại</Text>
    </Pressable>
  )
}

function SafetyCard({ st }: { st: LiveState }) {
  const c = useColors()
  const s = st.safety?.data
  const state = s?.state ?? 'normal'
  const offline = st.online?.data.status === 'offline'
  const tone = state === 'fire' || state === 'gas_danger' ? c.crit : state === 'gas' ? c.warn : c.ok
  const icon = state === 'fire' ? 'flame' : state === 'gas_danger' ? 'warning' : state === 'gas' ? 'alert-circle' : 'shield-checkmark'
  return (
    <Card style={{ borderColor: tone, borderWidth: 1.5 }}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: tone, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name={icon} size={26} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Muted style={{ fontWeight: '700', letterSpacing: 0.5 }}>TRẠNG THÁI AN TOÀN</Muted>
          <Text style={{ color: c.text, fontSize: 20, fontWeight: '800' }}>{s ? SAFETY_LABEL[state] : 'Chưa có dữ liệu'}</Text>
        </View>
      </View>
      <Text style={{ color: c.text2, fontSize: 13.5 }}>{s ? SAFETY_HINT[state] : 'Backend chưa nhận trạng thái an toàn từ ESP32.'}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {offline ? (
          <Badge tone="crit" label="ESP32 mất kết nối · số liệu cũ" />
        ) : st.online ? (
          <Badge tone="ok" label="Trực tuyến" />
        ) : (
          <Badge label="ESP32 chưa kết nối" />
        )}
        {(s?.faults ?? []).map((f) => (
          <Badge key={f} tone="warn" label={FAULT_LABEL[f] ?? f} />
        ))}
        {st.safety && <Badge label={`Đổi ${fmtAgo(st.safety.updatedAt)}`} />}
      </View>
    </Card>
  )
}

function Sensor({
  title,
  value,
  unit,
  foot,
  badge,
  color,
}: {
  title: string
  value: string
  unit?: string
  foot: string
  badge?: { label: string; tone: 'ok' | 'warn' | 'crit' | 'info' | 'neutral' }
  color?: string
}) {
  const c = useColors()
  return (
    <Card style={{ flex: 1, gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
        <Text style={{ color: c.text2, fontWeight: '600', fontSize: 13 }}>{title}</Text>
        {badge && <Badge tone={badge.tone} label={badge.label} />}
      </View>
      <Text style={{ color: color ?? c.text, fontSize: 26, fontWeight: '800' }}>
        {value}
        {unit ? <Text style={{ fontSize: 14, color: c.text3 }}> {unit}</Text> : null}
      </Text>
      <Muted>{foot}</Muted>
    </Card>
  )
}

function TempCard({ st, cfg }: { st: LiveState; cfg: DeviceConfig }) {
  const c = useColors()
  const d = st.sensors.dht11?.data
  if (d?.error) return <Sensor title="Nhiệt độ" value="Lỗi DHT11" foot={`Đọc lỗi ${d.failCount ?? ''} lần`} color={c.crit} />
  const hot = d?.temp !== undefined && d.temp >= cfg.tempHigh
  const rising = (d?.tempRise ?? 0) >= cfg.tempRiseC
  return (
    <Sensor
      title="Nhiệt độ"
      value={d?.temp?.toFixed(1) ?? '—'}
      unit="°C"
      foot={`Ngưỡng ${cfg.tempHigh}°C · +${(d?.tempRise ?? 0).toFixed(1)}°C/${cfg.tempRiseWindowMin}′`}
      badge={hot ? { label: 'Nóng', tone: 'warn' } : rising ? { label: 'Tăng nhanh', tone: 'crit' } : undefined}
    />
  )
}

function HumCard({ st, cfg }: { st: LiveState; cfg: DeviceConfig }) {
  const d = st.sensors.dht11?.data
  const high = d?.hum !== undefined && d.hum >= cfg.humHigh
  return (
    <Sensor
      title="Độ ẩm"
      value={d?.error ? '—' : (d?.hum?.toFixed(1) ?? '—')}
      unit="%"
      foot={`Ngưỡng ${cfg.humHigh}% · phun sương < ${cfg.mistHumMax}%`}
      badge={high ? { label: 'Cao', tone: 'warn' } : undefined}
    />
  )
}

function Mq135Card({ st, cfg }: { st: LiveState; cfg: DeviceConfig }) {
  const d = st.sensors.mq135?.data
  const badge = !d
    ? undefined
    : d.warmingUp
      ? ({ label: 'Làm nóng', tone: 'info' } as const)
      : d.level === 'danger'
        ? ({ label: 'Nguy hiểm', tone: 'crit' } as const)
        : d.level === 'warning'
          ? ({ label: 'Cảnh báo', tone: 'warn' } as const)
          : ({ label: 'Bình thường', tone: 'ok' } as const)
  return (
    <Sensor title="Khí / khói" value={d ? String(d.raw) : '—'} unit="/4095" foot={`Cảnh báo ${cfg.mq135Warning} · Nguy hiểm ${cfg.mq135Danger}`} badge={badge} />
  )
}

function PirCard({ st, afterHours, hours }: { st: LiveState; afterHours: boolean; hours: string }) {
  const c = useColors()
  const motion = st.sensors.pir?.data.motion ?? false
  return (
    <Sensor
      title="Chuyển động"
      value={motion ? 'Có' : 'Không'}
      color={motion && afterHours ? c.crit : motion ? c.text : c.text3}
      foot={afterHours ? 'Ngoài giờ: có chuyển động sẽ báo đột nhập + bật đèn' : `Giờ làm: ${hours}`}
      badge={{ label: afterHours ? 'Ngoài giờ' : 'Trong giờ', tone: afterHours ? 'info' : 'neutral' }}
    />
  )
}

function lockNote(device: DeviceName, st: LiveState, cfg: DeviceConfig): string | null {
  const s = st.safety?.data.state ?? 'normal'
  const hum = st.sensors.dht11?.data.hum ?? 0
  if (device === 'fan' && s === 'fire') return 'Nghi cháy: quạt luôn TẮT (không thổi thêm oxy).'
  if (device === 'fan' && s === 'gas_danger') return 'Rò rỉ khí nhiều: quạt luôn BẬT.'
  if (device === 'light' && (s === 'fire' || s === 'gas_danger')) return 'Đèn luôn BẬT để chiếu sáng thoát hiểm.'
  if (device === 'mist' && s === 'fire') return `Nghi cháy: phun sương BẬT tối đa ${cfg.mistFireMaxMin} phút. Vẫn có thể TẮT thủ công.`
  if (device === 'mist' && (s === 'gas' || s === 'gas_danger')) return 'Có khói nhưng không nóng: cấm phun sương.'
  if (device === 'mist' && hum >= cfg.humHigh) return `Độ ẩm ≥ ${cfg.humHigh}%: cấm phun sương, kể cả thủ công.`
  return null
}

const DURATIONS = [
  { value: '0', label: 'Luôn' },
  { value: '300', label: '5′' },
  { value: '1800', label: '30′' },
  { value: '3600', label: '1 giờ' },
]

const DEVICE_ICON = { fan: 'aperture-outline', mist: 'water-outline', light: 'bulb-outline' } as const

function DeviceRow({
  device,
  status,
  updatedAt,
  st,
  cfg,
}: {
  device: DeviceName
  status: DeviceStatus | null
  updatedAt: string | null
  st: LiveState
  cfg: DeviceConfig
}) {
  const c = useColors()
  // lệnh đã gửi (trace_id) → chờ ESP32 xác nhận qua status.* có ack.trace_id (tối đa 10 giây)
  const [sent, setSent] = useState<string | null>(null)
  const [timedOut, setTimedOut] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [duration, setDuration] = useState('0')
  const on = status?.state === 'on'
  const lock = lockNote(device, st, cfg)
  const current = !status ? null : status.mode === 'auto' ? 'auto' : status.source === 'esp32_local' ? null : status.state
  const lastAck = useLive().acks[device]
  const ack = sent && lastAck?.trace_id === sent ? lastAck.result : null
  const waiting = !!sent && !ack && timedOut !== sent

  useEffect(() => {
    if (!sent) return
    const id = setTimeout(() => setTimedOut(sent), 10_000)
    return () => clearTimeout(id)
  }, [sent])

  const result = err
    ? err
    : ack === 'applied'
      ? 'ESP32 đã xác nhận'
      : ack === 'ignored_user_priority'
        ? 'Bị bỏ qua (ưu tiên người dùng)'
        : ack
          ? 'Lệnh không hợp lệ'
          : sent && timedOut === sent
            ? 'Không nhận được xác nhận sau 10 giây'
            : null

  const send = async (v: 'auto' | 'on' | 'off') => {
    setErr(null)
    try {
      const d = Number(duration)
      setSent(await devices.command(device, v === 'auto' ? { mode: 'auto' } : { state: v, durationS: d || undefined }))
    } catch (e) {
      setSent(null)
      setErr(errorText(e))
    }
  }

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.accent : c.surface3 }}>
          <Ionicons name={DEVICE_ICON[device]} size={20} color={on ? c.onAccent : c.text2} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.text, fontWeight: '700', fontSize: 15 }}>{DEVICE_LABEL[device]}</Text>
          {status ? (
            <Text style={{ color: c.text2, fontSize: 12.5 }}>
              <Text style={{ fontWeight: '800', color: on ? c.accent : c.text2 }}>{on ? 'ĐANG BẬT' : 'ĐANG TẮT'}</Text> ·{' '}
              {status.mode === 'auto' ? 'Tự động' : 'Thủ công'}
              {status.reason && status.reason !== 'manual' ? ` · ${reasonLabel(status.reason)}` : ''}
            </Text>
          ) : (
            <Muted>Chưa có trạng thái từ ESP32</Muted>
          )}
          {status && (
            <Muted>
              {SOURCE_LABEL[status.source] ?? status.source}
              {updatedAt ? ` · ${fmtAgo(updatedAt)}` : ''}
            </Muted>
          )}
        </View>
      </View>
      {lock && <LockNote c={c} text={lock} />}
      <Segmented
        options={[
          { value: 'auto', label: 'Tự động' },
          { value: 'on', label: 'Bật' },
          { value: 'off', label: 'Tắt' },
        ]}
        value={current}
        disabled={waiting}
        onChange={(v) => void send(v as 'auto' | 'on' | 'off')}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Muted>Giữ lệnh:</Muted>
        <View style={{ flex: 1 }}>
          <Segmented options={DURATIONS} value={duration} onChange={setDuration} />
        </View>
      </View>
      <Text style={{ fontSize: 12.5, color: result?.startsWith('ESP32') ? c.ok : result ? c.warn : c.text3 }}>
        {waiting ? 'Đang chờ ESP32 xác nhận…' : (result ?? (Number(duration) ? `Lệnh thủ công tự hết hạn sau ${fmtDuration(Number(duration))}` : ' '))}
      </Text>
    </View>
  )
}

function LockNote({ c, text }: { c: Colors; text: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, backgroundColor: c.warnSoft, borderRadius: 8, padding: 8 }}>
      <Ionicons name="shield-half-outline" size={14} color={c.warn} style={{ marginTop: 1 }} />
      <Text style={{ color: c.warn, fontSize: 12.5, flex: 1 }}>{text}</Text>
    </View>
  )
}
