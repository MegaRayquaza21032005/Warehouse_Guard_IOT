/**
 * Camera: xem trực tiếp (MJPEG có khung YOLO, qua Java BE), trạng thái phát hiện người + lửa / khói, ảnh chụp khi
 * có sự cố. Camera BỔ SUNG cảm biến chuyển động PIR và cảm biến khói MQ135 — không thay thế.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Cctv, CloudFog, Download, Flame, Maximize2, Pause, PersonStanding, Play, RefreshCw } from 'lucide-react'
import { cameraApi } from '../api'
import type { CameraSnapshot, CameraStatus } from '../types'
import { useLive, useNow } from '../lib/hooks'
import { onLiveMessage } from '../lib/live'
import { SAFETY_LABEL, alertTypeLabel, cameraErrorLabel, fmtAgo, fmtDateTime } from '../lib/labels'
import { fmtWorkHours } from '../lib/config'
import { Lightbox, SnapshotThumb } from '../components/Snapshot'

const STATUS_POLL_MS = 5000
/** Ảnh trống 1px: gán vào src để NGẮT luồng MJPEG (Chrome không tự ngắt khi gỡ thẻ img — luồng rò vẫn chạy). */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='

export default function Camera() {
  const [status, setStatus] = useState<CameraStatus | null>(null)
  const [statusErr, setStatusErr] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await cameraApi.status())
      setStatusErr(null)
    } catch (e) {
      setStatusErr((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    const id = setInterval(() => void loadStatus(), STATUS_POLL_MS)
    return () => clearInterval(id)
  }, [loadStatus])

  return (
    <div className="camera-layout">
      <div className="card camera-card">
        <LiveView status={status} />
      </div>
      <div className="grid" style={{ alignContent: 'start' }}>
        <DetectionCard status={status} error={statusErr} />
        <FireCard status={status} />
        <Snapshots />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ xem trực tiếp

type ViewState = 'loading' | 'live' | 'error' | 'paused'

function LiveView({ status }: { status: CameraStatus | null }) {
  const snap = useLive()
  const [nonce, setNonce] = useState(0) // đổi -> tạo lại URL = kết nối lại luồng
  const [state, setState] = useState<ViewState>('loading')
  const [paused, setPaused] = useState(false)
  const [hidden, setHidden] = useState(document.hidden)
  const [message, setMessage] = useState<string | null>(null)
  const startedAt = useRef(Date.now())
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)

  const reconnect = useCallback((delayMs = 0) => {
    if (retryTimer.current) clearTimeout(retryTimer.current)
    retryTimer.current = setTimeout(() => {
      startedAt.current = Date.now()
      setState('loading')
      setNonce((n) => n + 1)
    }, delayMs)
  }, [])

  useEffect(() => () => void (retryTimer.current && clearTimeout(retryTimer.current)), [])

  // Tab ẩn -> ngừng xem (tiết kiệm băng thông, giảm tải backend); hiện lại -> xem tiếp
  useEffect(() => {
    const h = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [])
  const active = !paused && !hidden
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) reconnect() // xem tiếp / quay lại tab
    wasActive.current = active
  }, [active, reconnect])

  // Gán / ngắt luồng bằng tay: mỗi lần đổi (kết nối lại, tạm dừng, rời trang) đều ngắt luồng cũ trước
  useEffect(() => {
    const el = img.current
    if (!active || !el) return
    el.src = cameraApi.streamUrl(10, nonce)
    return () => {
      el.src = BLANK
    }
  }, [active, nonce])

  // MJPEG không báo lỗi khi luồng bị cắt giữa chừng (ảnh đứng hình) -> dựa vào trạng thái service:
  // service vision khởi động lại sau khi bắt đầu xem / đang tắt rồi bật lại -> kết nối lại.
  const reachable = status?.reachable
  const uptime = status?.service?.uptimeS
  useEffect(() => {
    if (!active || status == null) return
    if (!reachable) {
      setState('error')
      setMessage(cameraErrorLabel('vision_unavailable'))
      return
    }
    const serviceStart = Date.now() - (uptime ?? 0) * 1000
    if (state === 'error' || serviceStart > startedAt.current + 3000) reconnect()
  }, [reachable, uptime]) // eslint-disable-line react-hooks/exhaustive-deps

  const onError = async () => {
    setState('error')
    try {
      const st = await cameraApi.status()
      if (!st.reachable) {
        setMessage(cameraErrorLabel('vision_unavailable'))
        return // chờ service chạy lại (effect trên tự kết nối)
      }
      await cameraApi.refreshToken() // có thể do access token hết hạn
      setMessage('Mất kết nối luồng hình — đang kết nối lại…')
    } catch (e) {
      setMessage((e as Error).message)
    }
    reconnect(3000)
  }

  const det = snap.live.sensors.camera?.data
  const present = !!det?.person && !det.error
  const count = det?.personCount ?? 0
  const fire = !det?.error && det?.fire === true
  const smoke = !det?.error && det?.smoke === true
  const camError = det?.error ?? status?.service?.camera?.error ?? null

  return (
    <>
      <div className="card-head">
        <Cctv size={18} />
        <h2>Camera trực tiếp</h2>
        <span className="sub hide-sm">Xanh = người · cam = lửa · xám = khói</span>
        <div className="actions">
          <button className="btn sm" onClick={() => setPaused((p) => !p)} title={paused ? 'Xem tiếp' : 'Tạm dừng xem (camera vẫn phát hiện người)'}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
            <span className="hide-sm">{paused ? 'Xem tiếp' : 'Tạm dừng'}</span>
          </button>
          <a
            className="btn sm"
            href="#"
            title="Tải ảnh hiện tại"
            onClick={(e) => {
              // tạo URL lúc bấm (access token mới nhất, ảnh mới nhất)
              e.currentTarget.href = cameraApi.snapshotUrl()
              e.currentTarget.download = `camera-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`
            }}
          >
            <Download size={14} />
            <span className="hide-sm">Chụp</span>
          </a>
          <button className="btn sm icon" onClick={() => void box.current?.requestFullscreen?.()} title="Toàn màn hình" aria-label="Toàn màn hình">
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
      <div className="camera-view" ref={box}>
        <img
          ref={img}
          alt="Hình trực tiếp từ camera kho"
          style={{ visibility: active ? 'visible' : 'hidden' }}
          onLoad={(e) => {
            if (e.currentTarget.src === BLANK) return
            setState('live')
            setMessage(null)
          }}
          onError={(e) => {
            if (e.currentTarget.src !== BLANK) void onError()
          }}
        />
        <div className="camera-overlay">
          {state === 'live' && active && (
            <span className="badge crit">
              <span className="dot pulse" /> TRỰC TIẾP
            </span>
          )}
          {present && (
            <span className={`badge ${snap.afterHours ? 'crit' : 'accent'}`}>
              <PersonStanding size={13} /> {count} người
            </span>
          )}
          {fire && (
            <span className="badge crit">
              <Flame size={13} /> LỬA
            </span>
          )}
          {smoke && (
            <span className="badge warn">
              <CloudFog size={13} /> Khói
            </span>
          )}
        </div>
        {!active && (
          <div className="camera-msg">
            <Pause size={26} />
            <span>{paused ? 'Đã tạm dừng xem. Camera vẫn đang phát hiện người.' : 'Tạm dừng khi tab bị ẩn.'}</span>
            {paused && (
              <button className="btn sm" onClick={() => setPaused(false)}>
                <Play size={14} /> Xem tiếp
              </button>
            )}
          </div>
        )}
        {active && state === 'loading' && (
          <div className="camera-msg">
            <RefreshCw size={22} className="spin" />
            <span>Đang kết nối camera…</span>
          </div>
        )}
        {active && state === 'error' && (
          <div className="camera-msg">
            <Cctv size={26} />
            <span>{message ?? 'Không xem được camera'}</span>
            <button className="btn sm" onClick={() => reconnect()}>
              <RefreshCw size={14} /> Thử lại
            </button>
          </div>
        )}
      </div>
      {camError && state === 'live' && <p className="error" style={{ marginTop: 10 }}>{cameraErrorLabel(camError)}</p>}
      <p className="faint" style={{ fontSize: 12, marginTop: 10 }}>
        Camera bổ sung cảm biến chuyển động PIR và cảm biến khói MQ135: một trong hai phát hiện người ngoài giờ là đủ báo
        đột nhập và bật đèn; camera thấy lửa là đủ báo cháy. Camera kém khi thiếu sáng hoặc bị che, có thể nhầm đèn / nắng
        với lửa, hơi nước với khói — không thay thế hệ thống báo cháy và an ninh chuyên dụng.
      </p>
    </>
  )
}

// ------------------------------------------------------------------ trạng thái phát hiện

function DetectionCard({ status, error }: { status: CameraStatus | null; error: string | null }) {
  const snap = useLive()
  useNow(5000)
  const det = snap.live.sensors.camera
  const online = snap.live.camera?.data.status === 'online'
  const svc = status?.service
  const pir = snap.live.sensors.pir
  const present = !!det?.data.person && !det.data.error

  return (
    <div className="card">
      <div className="card-head">
        <PersonStanding size={18} />
        <h3>Phát hiện người</h3>
        <span className={`badge ${online ? 'ok' : snap.live.camera ? 'crit' : ''}`} style={{ marginLeft: 'auto' }}>
          <span className="dot" /> {online ? 'Đang chạy' : snap.live.camera ? 'Mất kết nối' : 'Chưa có dữ liệu'}
        </span>
      </div>
      <div className="camera-now" style={{ color: present ? (snap.afterHours ? 'var(--crit)' : 'var(--accent)') : 'var(--text-3)' }}>
        <PersonStanding size={26} />
        {det?.data.error ? 'Không có hình' : present ? `${det.data.personCount ?? 1} người` : 'Không có người'}
      </div>
      <dl className="kv">
        <dt>Cập nhật</dt>
        <dd>{det ? fmtAgo(det.updatedAt) : '—'}</dd>
        {present && det.data.personConf != null && (
          <>
            <dt>Độ tin cậy</dt>
            <dd className="num">{Math.round(det.data.personConf * 100)}%</dd>
          </>
        )}
        <dt>Cảm biến PIR</dt>
        <dd>
          <Activity size={13} style={{ verticalAlign: -2 }} /> {pir?.data.motion ? 'Có chuyển động' : pir ? 'Không có' : '—'}
        </dd>
        <dt>Thời gian</dt>
        <dd>{snap.afterHours ? <span className="badge info">Ngoài giờ</span> : `Trong giờ (${fmtWorkHours(snap.workHours)})`}</dd>
        {svc && (
          <>
            <dt>Model</dt>
            <dd>
              {svc.model.name} · {svc.model.device.startsWith('cuda') ? `GPU${svc.model.half ? ' FP16' : ''}` : 'CPU'}
            </dd>
            <dt>Tốc độ</dt>
            <dd className="num">
              {svc.detection.fps != null ? `${svc.detection.fps} khung/s` : '—'}
              {svc.detection.inferMs != null && ` · ${svc.detection.inferMs} ms/khung`}
            </dd>
            <dt>Camera</dt>
            <dd>
              {svc.camera?.opened ? `${svc.camera.width}×${svc.camera.height}` : cameraErrorLabel(svc.camera?.error ?? 'camera_unavailable')}
            </dd>
            <dt>Đang xem</dt>
            <dd className="num">{svc.viewers}</dd>
          </>
        )}
      </dl>
      {status && !status.reachable && <p className="error">{cameraErrorLabel(status.error ?? 'vision_unavailable')}</p>}
      {error && <p className="error">{error}</p>}
      {snap.afterHours && <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>Ngoài giờ: thấy người sẽ báo đột nhập, bật đèn và chụp ảnh.</p>}
    </div>
  )
}

// ------------------------------------------------------------------ lửa / khói

function FireCard({ status }: { status: CameraStatus | null }) {
  const snap = useLive()
  useNow(5000)
  const det = snap.live.sensors.camera
  const d = det?.data
  const fireModel = status?.service?.model.fire
  // Bản tin không có trường fire = vision chưa bật model lửa / khói
  const enabled = d ? typeof d.fire === 'boolean' : !!fireModel && !fireModel.error
  const fire = !d?.error && d?.fire === true
  const smoke = !d?.error && d?.smoke === true
  const safety = snap.live.safety?.data
  const mq = snap.live.sensors.mq135?.data

  return (
    <div className="card">
      <div className="card-head">
        <Flame size={18} />
        <h3>Phát hiện lửa / khói</h3>
        <span className={`badge ${!enabled ? '' : fire ? 'crit' : smoke ? 'warn' : 'ok'}`} style={{ marginLeft: 'auto' }}>
          <span className="dot" /> {!enabled ? 'Chưa bật' : fire ? 'Thấy lửa' : smoke ? 'Thấy khói' : 'Bình thường'}
        </span>
      </div>
      {enabled ? (
        <div className="camera-now" style={{ color: fire ? 'var(--crit)' : smoke ? 'var(--warn)' : 'var(--text-3)' }}>
          {fire ? <Flame size={26} /> : <CloudFog size={26} />}
          {d?.error ? 'Không có hình' : fire ? (smoke ? 'Lửa và khói' : 'Lửa') : smoke ? 'Khói' : 'Không thấy lửa / khói'}
        </div>
      ) : (
        <p className="faint" style={{ fontSize: 13 }}>
          {fireModel?.error ? `Không nạp được model lửa / khói: ${fireModel.error}` : 'Service camera chưa bật model lửa / khói (VISION_FIRE_MODEL).'}
        </p>
      )}
      <dl className="kv">
        {fire && d?.fireConf != null && (
          <>
            <dt>Lửa — tin cậy</dt>
            <dd className="num">{Math.round(d.fireConf * 100)}%</dd>
          </>
        )}
        {smoke && d?.smokeConf != null && (
          <>
            <dt>Khói — tin cậy</dt>
            <dd className="num">{Math.round(d.smokeConf * 100)}%</dd>
          </>
        )}
        <dt>Cảm biến MQ135</dt>
        <dd>{mq ? `${mq.raw} (${mq.level === 'normal' ? 'bình thường' : mq.level === 'warning' ? 'có khí / khói' : 'rất cao'})` : '—'}</dd>
        <dt>Trạng thái an toàn</dt>
        <dd>
          {safety ? SAFETY_LABEL[safety.state] : '—'}
          {safety?.cameraFire && <span className="badge crit" style={{ marginLeft: 6 }}>theo camera</span>}
        </dd>
        {fireModel && !fireModel.error && (
          <>
            <dt>Model</dt>
            <dd>{fireModel.name}</dd>
          </>
        )}
      </dl>
      <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>
        Lửa + MQ135 có khói → ESP32 chuyển “nghi cháy” (tắt quạt, phun sương, bật đèn). Chỉ camera thấy lửa → cảnh báo
        nguy hiểm, bật đèn, chụp ảnh (không tự phun sương). Camera thấy khói → cảnh báo, không đổi thiết bị.
      </p>
    </div>
  )
}

// ------------------------------------------------------------------ ảnh chụp khi có sự cố

function Snapshots() {
  const [items, setItems] = useState<CameraSnapshot[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<CameraSnapshot | null>(null)

  const load = useCallback(async () => {
    try {
      setItems(await cameraApi.snapshots({ limit: 12 }))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
    return onLiveMessage((type) => type === 'camera.snapshot' && void load())
  }, [load])

  const caption = (s: CameraSnapshot) =>
    `${s.alertType ? alertTypeLabel(s.alertType) : 'Ảnh chụp'} · ${fmtDateTime(s.ts)}${s.personCount ? ` · ${s.personCount} người` : ''}`

  return (
    <div className="card">
      <div className="card-head">
        <h3>Ảnh khi có sự cố</h3>
        <span className="sub">Đột nhập / cháy / lửa, khói</span>
      </div>
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <div className="empty" style={{ padding: 16 }}>Chưa có ảnh nào.</div>}
      {items && items.length > 0 && (
        <div className="snap-grid">
          {items.map((s) => (
            <div key={s.id} className="snap-item">
              <SnapshotThumb id={s.id} caption={caption(s)} onOpen={() => setOpen(s)} />
              <div className="snap-cap">
                <b>{s.alertType ? alertTypeLabel(s.alertType) : 'Ảnh'}</b>
                <span title={fmtDateTime(s.ts)}>{fmtAgo(s.ts)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {open && <Lightbox id={open.id} caption={caption(open)} onClose={() => setOpen(null)} />}
    </div>
  )
}
