import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { CommandSource, DeviceLog, DeviceName } from '../types'
import { devices, errorText } from '../api'
import { onLiveMessage } from '../lib/live'
import { DEVICE_LABEL, SOURCE_LABEL, fmtDateTime, reasonLabel } from '../lib/labels'

const PAGE = 50

function resultOf(l: DeviceLog): { label: string; tone: string } {
  if (l.source === 'esp32_local') return { label: 'ESP32 tự quyết', tone: '' }
  switch (l.result) {
    case 'applied':
      return { label: 'Đã áp dụng', tone: 'ok' }
    case 'ignored_user_priority':
      return { label: 'Bỏ qua (ưu tiên user)', tone: 'warn' }
    case 'invalid_command':
      return { label: 'Lệnh sai', tone: 'crit' }
    case 'invalid_source':
      return { label: 'Nguồn sai', tone: 'crit' }
    case 'publish_failed':
      return { label: 'Không gửi được (MQTT)', tone: 'crit' }
    default:
      // chưa có ack: mới gửi thì đang chờ, quá 10 giây là không phản hồi (CMD_ACK_TIMEOUT_S)
      return Date.now() - new Date(l.ts).getTime() < 10_000 ? { label: 'Đang chờ', tone: '' } : { label: 'Không phản hồi', tone: 'crit' }
  }
}

const CMD: Record<string, string> = { on: 'BẬT', off: 'TẮT', auto: 'Tự động' }

export default function DeviceLogs() {
  const [device, setDevice] = useState<DeviceName | 'all'>('all')
  const [source, setSource] = useState<CommandSource | 'all'>('all')
  const [rows, setRows] = useState<DeviceLog[]>([])
  const [pages, setPages] = useState(1)
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(
    async (n: number) => {
      setLoading(true)
      try {
        const q = { device: device === 'all' ? undefined : device, source: source === 'all' ? undefined : source }
        // 30 ngày gần nhất (mặc định của backend là 7 ngày)
        const from = new Date(Date.now() - 30 * 86_400_000).toISOString()
        const all = await Promise.all(Array.from({ length: n }, (_, p) => devices.logs({ ...q, from, page: p, size: PAGE })))
        const flat = all.flat()
        setRows(flat)
        setMore(all[all.length - 1].length === PAGE)
        setError('')
      } catch (e) {
        setError(errorText(e))
      } finally {
        setLoading(false)
      }
    },
    [device, source],
  )

  useEffect(() => {
    setPages(1)
    void load(1)
  }, [load])

  // trạng thái thiết bị đổi (ack / luật cục bộ) → nạp lại sau 1 giây
  useEffect(
    () =>
      onLiveMessage((type) => {
        if (!type.startsWith('status.fan') && !type.startsWith('status.mist') && !type.startsWith('status.light')) return
        if (reloadTimer.current) clearTimeout(reloadTimer.current)
        reloadTimer.current = setTimeout(() => void load(pages), 1000)
      }),
    [load, pages],
  )

  return (
    <div className="card">
      <div className="card-head" style={{ flexWrap: 'wrap' }}>
        <div>
          <h2>Ai / cái gì đã bật, tắt thiết bị?</h2>
          <div className="sub">Mọi nguồn trong 30 ngày: luật cục bộ ESP32, tầng luật, AI agent, người dùng (nút bấm hoặc chatbot)</div>
        </div>
        <div className="actions filters">
          <select className="select" value={device} onChange={(e) => setDevice(e.target.value as typeof device)}>
            <option value="all">Mọi thiết bị</option>
            {(Object.keys(DEVICE_LABEL) as DeviceName[]).map((d) => (
              <option key={d} value={d}>
                {DEVICE_LABEL[d]}
              </option>
            ))}
          </select>
          <select className="select" value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="all">Mọi nguồn</option>
            {(Object.keys(SOURCE_LABEL) as CommandSource[]).map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
          <button className="btn icon ghost" title="Nạp lại" aria-label="Nạp lại" onClick={() => void load(pages)} disabled={loading}>
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {error && <div className="error" style={{ marginBottom: 10 }}>{error}</div>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Thời gian</th>
              <th>Thiết bị</th>
              <th>Lệnh</th>
              <th>Lý do</th>
              <th>Nguồn</th>
              <th>Người dùng</th>
              <th>Kết quả</th>
              <th className="hide-sm">trace_id</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => {
              const r = resultOf(l)
              return (
              <tr key={l.id}>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {fmtDateTime(l.ts)}
                </td>
                <td>{DEVICE_LABEL[l.device]}</td>
                <td>
                  <b>{CMD[l.action] ?? l.action}</b>
                  {l.durationS ? <span className="faint"> · {Math.round(l.durationS / 60)} phút</span> : null}
                </td>
                <td>{l.reason ? reasonLabel(l.reason) : <span className="faint">—</span>}</td>
                <td>
                  <span className={`badge ${l.source === 'user' ? 'accent' : l.source === 'agent' ? 'info' : ''}`}>{SOURCE_LABEL[l.source] ?? l.source}</span>
                </td>
                <td>{l.username ?? <span className="faint">—</span>}</td>
                <td>
                  <span className={`badge ${r.tone}`}>{r.label}</span>
                </td>
                <td className="mono faint hide-sm">{l.traceId ?? '—'}</td>
              </tr>
              )
            })}
          </tbody>
        </table>
        {!rows.length && <div className="empty">{loading ? 'Đang tải…' : 'Không có bản ghi.'}</div>}
      </div>
      {more && (
        <div style={{ textAlign: 'center', paddingTop: 12 }}>
          <button
            className="btn"
            disabled={loading}
            onClick={() => {
              setPages(pages + 1)
              void load(pages + 1)
            }}
          >
            {loading ? 'Đang tải…' : 'Xem thêm'}
          </button>
        </div>
      )}
    </div>
  )
}
