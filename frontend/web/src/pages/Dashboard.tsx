import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  CheckCircle2,
  Clock,
  Droplets,
  Fan,
  Flame,
  Lightbulb,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Thermometer,
  TriangleAlert,
  Waves,
  Wind,
} from 'lucide-react'
import type { DeviceConfig, DeviceName, DeviceStatus, LiveState, ScheduledCommand, WorkHours } from '../types'
import { useLive, useNow } from '../lib/hooks'
import { fmtWorkHours } from '../lib/config'
import { DEVICE_LABEL, FAULT_LABEL, SAFETY_HINT, SAFETY_LABEL, SOURCE_LABEL, fmtAgo, fmtCountdown, fmtDuration, reasonLabel } from '../lib/labels'
import { devices as devicesApi, errorText, schedulesApi } from '../api'
import AlertList from '../components/AlertList'
import { ClimateStack, Mq135Chart, type TimeRow } from '../components/charts/Charts'

export default function Dashboard() {
  const snap = useLive()
  const { live, buffer, alerts, afterHours, config: cfg, workHours } = snap
  const recent = alerts.slice(0, 5)

  const rows = useMemo(() => {
    const temp: TimeRow[] = buffer.map((p) => ({ t: p.t, v: p.temp }))
    const hum: TimeRow[] = buffer.map((p) => ({ t: p.t, v: p.hum }))
    const mq135: TimeRow[] = buffer.map((p) => ({ t: p.t, v: p.mq135 }))
    return { temp, hum, mq135 }
  }, [buffer])

  return (
    <>
      <SafetyBanner live={live} />

      <div className="grid cols-4">
        <TempCard live={live} cfg={cfg} />
        <HumCard live={live} cfg={cfg} />
        <Mq135Card live={live} cfg={cfg} />
        <PirCard live={live} afterHours={afterHours} workHours={workHours} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Thiết bị</h2>
          <span className="sub">Bấm để điều khiển thủ công · luật an toàn luôn được ưu tiên</span>
        </div>
        <div className="grid cols-3">
          {(['fan', 'mist', 'light'] as DeviceName[]).map((d) => (
            <DeviceCard key={d} device={d} status={live.devices[d]?.data ?? null} updatedAt={live.devices[d]?.updatedAt ?? null} live={live} cfg={cfg} />
          ))}
        </div>
        <ScheduleList live={live} />
      </div>

      <div className="grid cols-3">
        <div className="card span-2">
          <div className="card-head">
            <h2>Nhiệt độ & độ ẩm</h2>
            <span className="sub">30 phút gần nhất</span>
            <div className="actions">
              <Link className="btn sm ghost" to="/stats">
                Xem thống kê
              </Link>
            </div>
          </div>
          <ClimateStack temp={rows.temp} hum={rows.hum} tempHigh={cfg.tempHigh} humHigh={cfg.humHigh} height={150} />
        </div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="card-head">
            <h2>Cảnh báo gần đây</h2>
            <div className="actions">
              <Link className="btn sm ghost" to="/alerts">
                Tất cả
              </Link>
            </div>
          </div>
          <div style={{ overflowY: 'auto', maxHeight: 400 }}>
            <AlertList alerts={recent} compact />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Khí / khói (MQ135)</h2>
          <span className="sub">30 phút gần nhất · nền màu theo vùng bình thường / cảnh báo / nguy hiểm</span>
        </div>
        <Mq135Chart rows={rows.mq135} warning={cfg.mq135Warning} danger={cfg.mq135Danger} height={190} />
      </div>
    </>
  )
}

// ------------------------------------------------------------------ trạng thái an toàn

function SafetyBanner({ live }: { live: LiveState }) {
  const s = live.safety?.data ?? { state: 'normal' as const, mq135Level: 'normal' as const, tempRise: 0, faults: [] }
  const noData = !live.safety
  const offline = live.online?.data.status === 'offline'
  const Icon = s.state === 'fire' ? Flame : s.state === 'gas_danger' ? Siren : s.state === 'gas' ? ShieldAlert : ShieldCheck
  useNow(5000)
  return (
    <section className={`safety ${s.state}`} aria-live="polite">
      <div className="icon">
        <Icon size={26} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="faint" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>
          Trạng thái an toàn
        </div>
        <div className="title">{noData ? 'Chưa có dữ liệu' : SAFETY_LABEL[s.state]}</div>
        <div className="muted" style={{ fontSize: 13 }}>
          {noData ? 'Backend chưa nhận trạng thái an toàn từ ESP32. Kiểm tra thiết bị đã bật và kết nối MQTT.' : SAFETY_HINT[s.state]}
        </div>
      </div>
      <div className="meta">
        {offline ? (
          <span className="badge crit">
            <span className="dot pulse" /> ESP32 mất kết nối · số liệu cũ
          </span>
        ) : live.online ? (
          <span className="badge ok">
            <span className="dot pulse" /> Trực tuyến
          </span>
        ) : (
          <span className="badge">ESP32 chưa kết nối</span>
        )}
        {(s.faults ?? []).map((f) => (
          <span key={f} className="badge warn">
            <TriangleAlert size={12} /> {FAULT_LABEL[f] ?? f}
          </span>
        ))}
        {live.safety && <span className="badge">Đổi {fmtAgo(live.safety.updatedAt)}</span>}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ cảm biến

function Gauge({ value, max, color, marks = [] }: { value: number; max: number; color: string; marks?: number[] }) {
  return (
    <div className="gauge">
      <span style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} />
      {marks.map((m) => (
        <i key={m} className="mark" style={{ left: `${(m / max) * 100}%` }} />
      ))}
    </div>
  )
}

function TempCard({ live, cfg }: { live: LiveState; cfg: DeviceConfig }) {
  const d = live.sensors.dht11?.data ?? {}
  const hot = d.temp !== undefined && d.temp >= cfg.tempHigh
  const rising = (d.tempRise ?? 0) >= cfg.tempRiseC
  return (
    <div className="card sensor">
      <div className="label">
        <span className="ic" style={{ background: 'color-mix(in oklab, var(--c-temp) 16%, transparent)', color: 'var(--c-temp)' }}>
          <Thermometer size={17} />
        </span>
        Nhiệt độ
        {(hot || rising) && <span className="badge warn" style={{ marginLeft: 'auto' }}>{hot ? 'Nóng' : 'Tăng nhanh'}</span>}
      </div>
      {d.error ? (
        <div className="value" style={{ color: 'var(--crit)', fontSize: 18 }}>
          Lỗi đọc DHT11 <small>({d.failCount} lần)</small>
        </div>
      ) : (
        <div className="value num">
          {d.temp?.toFixed(1) ?? '—'}
          <small>°C</small>
        </div>
      )}
      <Gauge value={d.temp ?? 0} max={60} color="var(--c-temp)" marks={[cfg.tempHigh]} />
      <div className="foot">
        <span>Ngưỡng {cfg.tempHigh}°C</span>
        <span>·</span>
        <span className="num" style={{ color: rising ? 'var(--crit)' : undefined }}>
          +{(d.tempRise ?? 0).toFixed(1)}°C / {cfg.tempRiseWindowMin} phút
        </span>
      </div>
    </div>
  )
}

function HumCard({ live, cfg }: { live: LiveState; cfg: DeviceConfig }) {
  const d = live.sensors.dht11?.data ?? {}
  const high = d.hum !== undefined && d.hum >= cfg.humHigh
  return (
    <div className="card sensor">
      <div className="label">
        <span className="ic" style={{ background: 'color-mix(in oklab, var(--c-hum) 16%, transparent)', color: 'var(--c-hum)' }}>
          <Droplets size={17} />
        </span>
        Độ ẩm
        {high && <span className="badge warn" style={{ marginLeft: 'auto' }}>Cao</span>}
      </div>
      {d.error ? (
        <div className="value" style={{ color: 'var(--crit)', fontSize: 18 }}>
          Không có dữ liệu
        </div>
      ) : (
        <div className="value num">
          {d.hum?.toFixed(1) ?? '—'}
          <small>%</small>
        </div>
      )}
      <Gauge value={d.hum ?? 0} max={100} color="var(--c-hum)" marks={[cfg.mistHumMax, cfg.humHigh]} />
      <div className="foot">
        <span>Ngưỡng {cfg.humHigh}%</span>
        <span>·</span>
        <span>Phun sương khi &lt; {cfg.mistHumMax}%</span>
      </div>
    </div>
  )
}

function Mq135Card({ live, cfg }: { live: LiveState; cfg: DeviceConfig }) {
  const d = live.sensors.mq135?.data ?? { raw: 0, mv: 0, level: 'normal' as const, warmingUp: false }
  const none = !live.sensors.mq135
  const color = d.level === 'danger' ? 'var(--crit)' : d.level === 'warning' ? 'var(--warn)' : 'var(--c-mq135)'
  return (
    <div className="card sensor">
      <div className="label">
        <span className="ic" style={{ background: 'color-mix(in oklab, var(--c-mq135) 16%, transparent)', color: 'var(--c-mq135)' }}>
          <Wind size={17} />
        </span>
        Khí / khói (MQ135)
        <span className={`badge ${d.level === 'danger' ? 'crit' : d.level === 'warning' ? 'warn' : 'ok'}`} style={{ marginLeft: 'auto' }}>
          {none ? 'Chưa có' : d.warmingUp ? 'Đang làm nóng' : d.level === 'danger' ? 'Nguy hiểm' : d.level === 'warning' ? 'Cảnh báo' : 'Bình thường'}
        </span>
      </div>
      <div className="value num">
        {none ? '—' : d.raw}
        <small>/ 4095</small>
      </div>
      <Gauge value={d.raw} max={4095} color={color} marks={[cfg.mq135Warning, cfg.mq135Danger]} />
      <div className="foot">
        <span>
          Cảnh báo {cfg.mq135Warning} · Nguy hiểm {cfg.mq135Danger}
        </span>
        <span>·</span>
        <span className="num">{d.mv} mV</span>
      </div>
    </div>
  )
}

function PirCard({ live, afterHours, workHours }: { live: LiveState; afterHours: boolean; workHours: WorkHours }) {
  const d = live.sensors.pir?.data ?? { motion: false }
  useNow(5000)
  return (
    <div className="card sensor">
      <div className="label">
        <span className="ic" style={{ background: 'var(--surface-3)', color: 'var(--text-2)' }}>
          <Activity size={17} />
        </span>
        Chuyển động
        <span className={`badge ${afterHours ? 'info' : ''}`} style={{ marginLeft: 'auto' }}>
          {afterHours ? 'Ngoài giờ' : 'Trong giờ làm'}
        </span>
      </div>
      <div className="value" style={{ color: d.motion ? (afterHours ? 'var(--crit)' : 'var(--text)') : 'var(--text-3)', fontSize: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
        {d.motion ? <Waves size={22} /> : <CheckCircle2 size={22} />}
        {d.motion ? 'Có chuyển động' : 'Không có'}
      </div>
      <div className="foot">
        <span>{live.sensors.pir ? `Thay đổi ${fmtAgo(live.sensors.pir.updatedAt)}` : 'Chưa có dữ liệu'}</span>
      </div>
      <div className="foot">
        <span>{afterHours ? 'Chuyển động lúc này sẽ báo đột nhập + bật đèn' : `Giờ làm việc: ${fmtWorkHours(workHours)}`}</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ thiết bị

const DEVICE_ICON = { fan: Fan, mist: Droplets, light: Lightbulb }

function lockNote(device: DeviceName, live: LiveState, cfg: DeviceConfig): string | null {
  const s = live.safety?.data.state ?? 'normal'
  const hum = live.sensors.dht11?.data.hum ?? 0
  if (device === 'fan' && s === 'fire') return 'Nghi cháy: quạt luôn TẮT (không thổi thêm oxy).'
  if (device === 'fan' && s === 'gas_danger') return 'Rò rỉ khí nhiều: quạt luôn BẬT.'
  if (device === 'light' && (s === 'fire' || s === 'gas_danger')) return 'Đèn luôn BẬT để chiếu sáng thoát hiểm.'
  if (device === 'mist' && s === 'fire') return 'Nghi cháy: phun sương BẬT tối đa ' + cfg.mistFireMaxMin + ' phút. Vẫn có thể TẮT thủ công.'
  if (device === 'mist' && (s === 'gas' || s === 'gas_danger')) return 'Có khói nhưng không nóng: cấm phun sương.'
  if (device === 'mist' && hum >= cfg.humHigh) return `Độ ẩm ≥ ${cfg.humHigh}%: cấm phun sương, kể cả thủ công.`
  return null
}

const DURATIONS = [
  { v: 0, label: 'Không hết hạn' },
  { v: 300, label: '5 phút' },
  { v: 1800, label: '30 phút' },
  { v: 3600, label: '1 giờ' },
]

function DeviceCard({
  device,
  status,
  updatedAt,
  live,
  cfg,
}: {
  device: DeviceName
  status: DeviceStatus | null
  updatedAt: string | null
  live: LiveState
  cfg: DeviceConfig
}) {
  const [pending, setPending] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  // ack gần nhất của thiết bị (store giữ lại vì bản tin status sau đó không còn "ack")
  const lastAck = useLive().acks[device]
  const Icon = DEVICE_ICON[device]
  const on = status?.state === 'on'
  const lock = lockNote(device, live, cfg)
  const offline = live.online?.data.status !== 'online'
  // Đang manual nhưng luật an toàn ghi đè (source = esp32_local) → không tô nút nào
  const current = !status ? null : status.mode === 'auto' ? 'auto' : status.source === 'esp32_local' ? null : status.state
  useNow(5000)

  useEffect(() => {
    if (pending && lastAck?.trace_id === pending) {
      setPending(null)
      setResult(
        lastAck.result === 'applied'
          ? 'ESP32 đã xác nhận'
          : lastAck.result === 'ignored_user_priority'
            ? 'Bị bỏ qua (ưu tiên người dùng)'
            : 'Lệnh không hợp lệ',
      )
      const id = setTimeout(() => setResult(null), 4000)
      return () => clearTimeout(id)
    }
  }, [lastAck, pending])

  useEffect(() => {
    if (!pending) return
    const id = setTimeout(() => {
      setPending(null)
      setResult('Không nhận được xác nhận')
    }, 10_000)
    return () => clearTimeout(id)
  }, [pending])

  const send = async (v: 'auto' | 'on' | 'off') => {
    setResult(null)
    try {
      setPending(await devicesApi.command(device, v === 'auto' ? { mode: 'auto' } : { state: v, durationS: duration || undefined }))
    } catch (e) {
      setResult(errorText(e))
    }
  }

  return (
    <div className={`device ${on ? 'on' : ''}`}>
      <div className="device-top">
        <div className={`device-ic ${device === 'fan' ? 'spin' : ''}`}>
          <Icon size={21} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="device-name">{DEVICE_LABEL[device]}</div>
          <div className="device-state">
            {status ? (
              <>
                <b style={{ color: on ? 'var(--accent)' : 'var(--text-2)' }}>{on ? 'ĐANG BẬT' : 'ĐANG TẮT'}</b> · {status.mode === 'auto' ? 'Tự động' : 'Thủ công'}
              </>
            ) : (
              <span className="faint">Chưa có trạng thái từ ESP32</span>
            )}
          </div>
        </div>
      </div>
      {status && (
        <div className="device-reason">
          <span>Lý do:</span>
          <b>{reasonLabel(status.reason)}</b>
          <span className="faint">
            · {SOURCE_LABEL[status.source] ?? status.source}
            {updatedAt && ` · ${fmtAgo(updatedAt)}`}
          </span>
        </div>
      )}
      {lock && (
        <div className="lock-note">
          <ShieldAlert size={14} style={{ flex: 'none', marginTop: 2 }} />
          {lock}
        </div>
      )}
      <div className="device-controls">
        <div className="seg" role="group" aria-label={`Điều khiển ${DEVICE_LABEL[device]}`}>
          {(['auto', 'on', 'off'] as const).map((v) => (
            <button key={v} className={current === v ? 'on' : ''} disabled={!!pending} onClick={() => void send(v)}>
              {v === 'auto' ? 'Tự động' : v === 'on' ? 'Bật' : 'Tắt'}
            </button>
          ))}
        </div>
        <select className="select" style={{ height: 30, fontSize: 12.5 }} value={duration} onChange={(e) => setDuration(Number(e.target.value))} title="Thời gian giữ lệnh thủ công">
          {DURATIONS.map((d) => (
            <option key={d.v} value={d.v}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ fontSize: 12, minHeight: 18, color: result?.startsWith('ESP32') ? 'var(--ok)' : result ? 'var(--warn)' : 'var(--text-3)' }}>
        {pending ? (offline ? 'Đã gửi — ESP32 đang mất kết nối…' : 'Đang chờ ESP32 xác nhận…') : (result ?? (duration ? `Lệnh thủ công tự hết hạn sau ${fmtDuration(duration)}` : ''))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ lệnh hẹn giờ do trợ lý AI tạo

function ScheduleList({ live }: { live: LiveState }) {
  const [items, setItems] = useState<ScheduledCommand[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const now = useNow(1000)
  // nạp lại khi trạng thái thiết bị đổi (lệnh hẹn giờ vừa chạy / bị hủy) + 10 giây/lần
  const sig = (['fan', 'mist', 'light'] as DeviceName[]).map((d) => live.devices[d]?.updatedAt ?? '').join('|')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let alive = true
    const load = () =>
      schedulesApi
        .list()
        .then((x) => alive && (setItems(x), setErr(null)))
        .catch((e) => alive && setErr(errorText(e)))
    load()
    const t = setInterval(load, 10_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [sig, reload])

  const cancel = async (id: string) => {
    setBusy(id)
    try {
      await schedulesApi.cancel(id)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(null)
      setReload((n) => n + 1)
    }
  }

  if (!items.length && !err) return null
  return (
    <div className="schedules">
      <div className="sub">
        <Clock size={14} /> Lệnh hẹn giờ từ trợ lý AI · lệnh thủ công mới cho cùng thiết bị sẽ hủy lịch
      </div>
      {err && <div className="faint" style={{ color: 'var(--crit)' }}>{err}</div>}
      {items.map((i) => {
        const left = (new Date(i.run_at).getTime() - now) / 1000
        return (
          <div key={i.id} className="schedule-row">
            <span className="badge info">{left > 0 ? fmtCountdown(left) : 'đang chạy…'}</span>
            <span className="grow">{i.description}</span>
            <button className="btn sm ghost" disabled={busy === i.id} onClick={() => cancel(i.id)}>
              Hủy lịch
            </button>
          </div>
        )
      })}
    </div>
  )
}
