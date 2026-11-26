/**
 * Camera: xem trực tiếp (ảnh có khung YOLO, qua Java BE), trạng thái phát hiện người, ảnh chụp khi có sự cố.
 *
 * Image của React Native không hiển thị được MJPEG -> lấy ảnh hiện tại liên tục (~4 khung/giây), hai lớp ảnh
 * chồng nhau: lớp sau tải xong mới đưa lên trước (không nháy trắng). Chỉ tải khi màn hình đang mở và app ở foreground.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Image, Modal, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useIsFocused } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import type { CameraSnapshot, CameraStatus } from '../../../../shared/types'
import { SAFETY_LABEL, alertTypeLabel, cameraErrorLabel, fmtAgo, fmtDateTime } from '../../../../shared/labels'
import { fmtWorkHours } from '../../../../shared/config'
import { cameraApi, errorText } from '../../lib/api'
import { useLive, useNow } from '../../lib/hooks'
import { onLiveMessage } from '../../lib/live'
import { useColors } from '../../lib/theme'
import { Badge, Button, Card, CardTitle, Empty, ErrorText, Muted } from '../../components/ui'
import { SnapshotImage } from '../../components/SnapshotImage'

const FRAME_GAP_MS = 200
const STATUS_POLL_MS = 5000

export default function CameraScreen() {
  const focused = useIsFocused()
  const [status, setStatus] = useState<CameraStatus | null>(null)
  const [statusErr, setStatusErr] = useState('')
  const [snaps, setSnaps] = useState<CameraSnapshot[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await cameraApi.status())
      setStatusErr('')
    } catch (e) {
      setStatusErr(errorText(e))
    }
  }, [])
  const loadSnaps = useCallback(async () => {
    try {
      setSnaps(await cameraApi.snapshots({ limit: 12 }))
    } catch (e) {
      setStatusErr(errorText(e))
    }
  }, [])

  // Chỉ nạp khi màn hình đang mở
  useEffect(() => {
    if (!focused) return
    let alive = true
    const st = () =>
      cameraApi
        .status()
        .then((x) => alive && (setStatus(x), setStatusErr('')))
        .catch((e) => alive && setStatusErr(errorText(e)))
    const sn = () =>
      cameraApi
        .snapshots({ limit: 12 })
        .then((x) => alive && setSnaps(x))
        .catch((e) => alive && setStatusErr(errorText(e)))
    st()
    sn()
    const id = setInterval(st, STATUS_POLL_MS)
    const off = onLiveMessage((type) => type === 'camera.snapshot' && void sn())
    return () => {
      alive = false
      clearInterval(id)
      off()
    }
  }, [focused])

  return (
    <ScrollView
      contentContainerStyle={{ padding: 14, gap: 12 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true)
            await Promise.all([loadStatus(), loadSnaps()])
            setRefreshing(false)
          }}
        />
      }
    >
      <LiveView focused={focused} status={status} />
      <Detection status={status} error={statusErr} />
      <FireSmoke status={status} />
      <Snapshots items={snaps} />
    </ScrollView>
  )
}

// ------------------------------------------------------------------ xem trực tiếp

function LiveView({ focused, status }: { focused: boolean; status: CameraStatus | null }) {
  const c = useColors()
  const snap = useLive()
  const [appActive, setAppActive] = useState(AppState.currentState === 'active')
  const [paused, setPaused] = useState(false)
  const [n, setN] = useState(1)
  const [layers, setLayers] = useState<[string | null, string | null]>([null, null])
  const [front, setFront] = useState<0 | 1>(0)
  const [state, setState] = useState<'loading' | 'live' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'))
    return () => sub.remove()
  }, [])
  const active = focused && appActive && !paused

  // Nạp khung kế tiếp vào lớp sau
  useEffect(() => {
    if (!active) return
    const back = (front ^ 1) as 0 | 1
    timer.current = setTimeout(
      () =>
        setLayers((l) => {
          const next: [string | null, string | null] = [l[0], l[1]]
          next[back] = cameraApi.frameUrl(n)
          return next
        }),
      n === 1 ? 0 : FRAME_GAP_MS,
    )
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [n, active]) // eslint-disable-line react-hooks/exhaustive-deps

  const onLoad = (i: 0 | 1) => {
    if (i === front && state === 'live') return
    setFront(i)
    setState('live')
    setMessage('')
    setN((x) => x + 1)
  }

  const onError = async () => {
    setState('error')
    try {
      const st = await cameraApi.status()
      if (!st.reachable) setMessage(cameraErrorLabel('vision_unavailable'))
      else {
        await cameraApi.refreshToken() // có thể do access token hết hạn
        setMessage(st.service?.camera?.opened === false ? cameraErrorLabel('camera_unavailable') : 'Mất kết nối — đang thử lại…')
      }
    } catch (e) {
      setMessage(errorText(e))
    }
    timer.current = setTimeout(() => setN((x) => x + 1), 3000)
  }

  // service chạy lại sau khi báo lỗi -> thử ngay
  useEffect(() => {
    if (!(active && state === 'error' && status?.reachable)) return
    const t = setTimeout(() => setN((x) => x + 1), 0)
    return () => clearTimeout(t)
  }, [status?.reachable]) // eslint-disable-line react-hooks/exhaustive-deps

  const det = snap.live.sensors.camera?.data
  const present = !!det?.person && !det.error
  const fire = !det?.error && det?.fire === true
  const smoke = !det?.error && det?.smoke === true

  return (
    <Card>
      <CardTitle
        title="Camera trực tiếp"
        sub="Xanh = người · cam = lửa · xám = khói"
        right={<Button small label={paused ? 'Xem tiếp' : 'Tạm dừng'} onPress={() => setPaused((p) => !p)} />}
      />
      <View style={{ aspectRatio: 4 / 3, backgroundColor: '#000', borderRadius: 10, overflow: 'hidden' }}>
        {([0, 1] as const).map((i) =>
          layers[i] && active ? (
            <Image
              key={i}
              source={{ uri: layers[i]! }}
              onLoad={() => onLoad(i)}
              onError={() => void onError()}
              resizeMode="contain"
              accessibilityLabel="Hình trực tiếp từ camera kho"
              style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: i === front ? 1 : 0 }}
            />
          ) : null,
        )}
        <View style={{ position: 'absolute', top: 8, right: 8, flexDirection: 'row', gap: 6 }}>
          {state === 'live' && active && <Badge tone="crit" label="● TRỰC TIẾP" />}
          {present && <Badge tone={snap.afterHours ? 'crit' : 'accent'} label={`${det.personCount ?? 1} người`} />}
          {fire && <Badge tone="crit" label="LỬA" />}
          {smoke && <Badge tone="warn" label="Khói" />}
        </View>
        {(!active || state !== 'live') && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16, backgroundColor: 'rgba(0,0,0,0.55)' }}>
            <Ionicons name={!active ? 'pause' : state === 'error' ? 'videocam-off-outline' : 'sync'} size={26} color="#d5dbe3" />
            <Text style={{ color: '#d5dbe3', textAlign: 'center' }}>
              {!active ? 'Đã tạm dừng xem. Camera vẫn đang phát hiện người.' : state === 'error' ? message || 'Không xem được camera' : 'Đang kết nối camera…'}
            </Text>
          </View>
        )}
      </View>
      <Muted style={{ fontSize: 12 }}>
        Camera bổ sung cảm biến chuyển động PIR và cảm biến khói MQ135 — kém khi thiếu sáng hoặc bị che, có thể nhầm đèn / nắng
        với lửa, hơi nước với khói; không thay thế hệ thống báo cháy và an ninh chuyên dụng.
      </Muted>
      {state === 'live' && det?.error ? <Text style={{ color: c.crit, fontSize: 13 }}>{cameraErrorLabel(det.error)}</Text> : null}
    </Card>
  )
}

// ------------------------------------------------------------------ trạng thái

function Row({ k, v }: { k: string; v: string }) {
  const c = useColors()
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
      <Muted>{k}</Muted>
      <Text style={{ color: c.text, fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' }}>{v}</Text>
    </View>
  )
}

function Detection({ status, error }: { status: CameraStatus | null; error: string }) {
  const c = useColors()
  const snap = useLive()
  useNow(5000)
  const det = snap.live.sensors.camera
  const online = snap.live.camera?.data.status === 'online'
  const present = !!det?.data.person && !det.data.error
  const svc = status?.service
  const pir = snap.live.sensors.pir
  return (
    <Card>
      <CardTitle
        title="Phát hiện người"
        right={<Badge tone={online ? 'ok' : snap.live.camera ? 'crit' : 'neutral'} label={online ? 'Đang chạy' : snap.live.camera ? 'Mất kết nối' : 'Chưa có dữ liệu'} />}
      />
      <Text style={{ fontSize: 22, fontWeight: '800', color: present ? (snap.afterHours ? c.crit : c.accent) : c.text3 }}>
        {det?.data.error ? 'Không có hình' : present ? `${det.data.personCount ?? 1} người` : 'Không có người'}
      </Text>
      <View style={{ gap: 6 }}>
        <Row k="Cập nhật" v={det ? fmtAgo(det.updatedAt) : '—'} />
        {present && det.data.personConf != null && <Row k="Độ tin cậy" v={`${Math.round(det.data.personConf * 100)}%`} />}
        <Row k="Cảm biến PIR" v={pir?.data.motion ? 'Có chuyển động' : pir ? 'Không có' : '—'} />
        <Row k="Thời gian" v={snap.afterHours ? 'Ngoài giờ' : `Trong giờ (${fmtWorkHours(snap.workHours)})`} />
        {svc && (
          <>
            <Row k="Model" v={`${svc.model.name} · ${svc.model.device.startsWith('cuda') ? `GPU${svc.model.half ? ' FP16' : ''}` : 'CPU'}`} />
            <Row k="Tốc độ" v={`${svc.detection.fps ?? '—'} khung/s${svc.detection.inferMs != null ? ` · ${svc.detection.inferMs} ms` : ''}`} />
            <Row k="Camera" v={svc.camera?.opened ? `${svc.camera.width}×${svc.camera.height}` : cameraErrorLabel(svc.camera?.error ?? 'camera_unavailable')} />
          </>
        )}
      </View>
      {status && !status.reachable ? <ErrorText text={cameraErrorLabel(status.error ?? 'vision_unavailable')} /> : null}
      {error ? <ErrorText text={error} /> : null}
    </Card>
  )
}

function FireSmoke({ status }: { status: CameraStatus | null }) {
  const c = useColors()
  const snap = useLive()
  useNow(5000)
  const d = snap.live.sensors.camera?.data
  const fireModel = status?.service?.model.fire
  // Bản tin không có trường fire = vision chưa bật model lửa / khói
  const enabled = d ? typeof d.fire === 'boolean' : !!fireModel && !fireModel.error
  const fire = !d?.error && d?.fire === true
  const smoke = !d?.error && d?.smoke === true
  const safety = snap.live.safety?.data
  const mq = snap.live.sensors.mq135?.data
  return (
    <Card>
      <CardTitle
        title="Phát hiện lửa / khói"
        right={<Badge tone={!enabled ? 'neutral' : fire ? 'crit' : smoke ? 'warn' : 'ok'} label={!enabled ? 'Chưa bật' : fire ? 'Thấy lửa' : smoke ? 'Thấy khói' : 'Bình thường'} />}
      />
      {enabled ? (
        <Text style={{ fontSize: 22, fontWeight: '800', color: fire ? c.crit : smoke ? c.warn : c.text3 }}>
          {d?.error ? 'Không có hình' : fire ? (smoke ? 'Lửa và khói' : 'Lửa') : smoke ? 'Khói' : 'Không thấy lửa / khói'}
        </Text>
      ) : (
        <Muted>{fireModel?.error ? `Không nạp được model lửa / khói: ${fireModel.error}` : 'Service camera chưa bật model lửa / khói.'}</Muted>
      )}
      <View style={{ gap: 6 }}>
        {fire && d?.fireConf != null && <Row k="Lửa — tin cậy" v={`${Math.round(d.fireConf * 100)}%`} />}
        {smoke && d?.smokeConf != null && <Row k="Khói — tin cậy" v={`${Math.round(d.smokeConf * 100)}%`} />}
        <Row k="Cảm biến MQ135" v={mq ? `${mq.raw} (${mq.level === 'normal' ? 'bình thường' : mq.level === 'warning' ? 'có khí / khói' : 'rất cao'})` : '—'} />
        <Row k="Trạng thái an toàn" v={safety ? SAFETY_LABEL[safety.state] + (safety.cameraFire ? ' (theo camera)' : '') : '—'} />
        {fireModel && !fireModel.error ? <Row k="Model" v={fireModel.name} /> : null}
      </View>
      <Muted style={{ fontSize: 12 }}>
        Lửa + MQ135 có khói → ESP32 chuyển “nghi cháy” (tắt quạt, phun sương, bật đèn). Chỉ camera thấy lửa → cảnh báo nguy hiểm,
        bật đèn, chụp ảnh. Camera thấy khói → cảnh báo, không đổi thiết bị.
      </Muted>
    </Card>
  )
}

// ------------------------------------------------------------------ ảnh khi có sự cố

function Snapshots({ items }: { items: CameraSnapshot[] | null }) {
  const c = useColors()
  const [open, setOpen] = useState<CameraSnapshot | null>(null)
  return (
    <Card>
      <CardTitle title="Ảnh khi có sự cố" sub="Đột nhập / cháy / lửa, khói" />
      {items && items.length === 0 && <Empty text="Chưa có ảnh nào." />}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(items ?? []).map((s) => (
          <Pressable key={s.id} onPress={() => setOpen(s)} style={{ width: '48%' }} accessibilityLabel={`Ảnh ${alertTypeLabel(s.alertType ?? '')}`}>
            <SnapshotImage id={s.id} style={{ width: '100%', aspectRatio: 4 / 3, borderRadius: 8 }} />
            <Text style={{ color: c.text2, fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
              {s.alertType ? alertTypeLabel(s.alertType) : 'Ảnh'}
            </Text>
            <Muted style={{ fontSize: 11 }}>{fmtAgo(s.ts)}</Muted>
          </Pressable>
        ))}
      </View>
      <Modal visible={!!open} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
        <Pressable onPress={() => setOpen(null)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', padding: 12, gap: 10 }}>
          {open && (
            <>
              <SnapshotImage key={open.id} id={open.id} style={{ width: '100%', aspectRatio: 4 / 3, borderRadius: 8 }} />
              <Text style={{ color: '#e6e9ee', textAlign: 'center' }}>
                {open.alertType ? alertTypeLabel(open.alertType) : 'Ảnh'} · {fmtDateTime(open.ts)}
                {open.personCount ? ` · ${open.personCount} người` : ''}
              </Text>
              <Muted style={{ textAlign: 'center', color: '#aab' }}>Chạm để đóng</Muted>
            </>
          )}
        </Pressable>
      </Modal>
    </Card>
  )
}
