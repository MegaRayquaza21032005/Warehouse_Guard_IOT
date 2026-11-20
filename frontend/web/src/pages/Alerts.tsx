import { useMemo, useState } from 'react'
import { CheckCheck } from 'lucide-react'
import type { AlertLevel } from '../types'
import { useLive } from '../lib/hooks'
import { live } from '../lib/live'
import AlertList from '../components/AlertList'
import { LEVEL_LABEL } from '../lib/labels'

const PAGE = 20

export default function Alerts() {
  const { alerts, alertsLoaded, moreAlerts } = useLive()
  const [loadingMore, setLoadingMore] = useState(false)
  const [level, setLevel] = useState<AlertLevel | 'all'>('all')
  const [unackedOnly, setUnackedOnly] = useState(false)
  const [source, setSource] = useState<'all' | 'rule' | 'agent'>('all')
  const [limit, setLimit] = useState(PAGE)

  const filtered = useMemo(
    () =>
      alerts.filter(
        (a) => (level === 'all' || a.level === level) && (!unackedOnly || !a.acknowledgedAt) && (source === 'all' || a.source === source),
      ),
    [alerts, level, unackedOnly, source],
  )
  const counts = useMemo(() => {
    const c = { critical: 0, warning: 0, info: 0, unacked: 0 }
    for (const a of alerts) {
      c[a.level]++
      if (!a.acknowledgedAt) c.unacked++
    }
    return c
  }, [alerts])

  return (
    <>
      <div className="grid cols-4">
        <Stat label="Chưa xem" value={counts.unacked} tone={counts.unacked ? 'crit' : undefined} />
        <Stat label={LEVEL_LABEL.critical} value={counts.critical} />
        <Stat label={LEVEL_LABEL.warning} value={counts.warning} />
        <Stat label={LEVEL_LABEL.info} value={counts.info} />
      </div>
      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <div className="filters">
            <div className="seg">
              {(['all', 'critical', 'warning', 'info'] as const).map((l) => (
                <button key={l} className={level === l ? 'on' : ''} onClick={() => setLevel(l)}>
                  {l === 'all' ? 'Tất cả' : LEVEL_LABEL[l]}
                </button>
              ))}
            </div>
            <select className="select" value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
              <option value="all">Mọi nguồn</option>
              <option value="rule">Tầng luật</option>
              <option value="agent">AI agent</option>
            </select>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <button className={`switch ${unackedOnly ? 'on' : ''}`} onClick={() => setUnackedOnly(!unackedOnly)} aria-pressed={unackedOnly} />
              Chỉ chưa xem
            </label>
          </div>
          <div className="actions">
            <button className="btn sm" disabled={!counts.unacked} onClick={() => void live.ackAll()}>
              <CheckCheck size={15} /> Đánh dấu tất cả đã xem
            </button>
          </div>
        </div>
        <p className="faint" style={{ margin: '0 0 6px', fontSize: 12.5 }}>
          Cảnh báo nguy hiểm không ai bấm "Đã xem" sau 5 phút sẽ được gửi lại cho tất cả người dùng. Phản hồi 👍 / 👎 giúp AI giảm báo giả (không làm tắt cảnh báo nguy hiểm). Số đếm ở trên tính trên {alerts.length} cảnh báo mới nhất đã tải.
        </p>
        {alertsLoaded ? <AlertList alerts={filtered.slice(0, limit)} /> : <div className="empty">Đang tải…</div>}
        {(filtered.length > limit || moreAlerts) && (
          <div style={{ textAlign: 'center', paddingTop: 12 }}>
            <button
              className="btn"
              disabled={loadingMore}
              onClick={async () => {
                if (filtered.length > limit) return setLimit(limit + PAGE)
                setLoadingMore(true)
                try {
                  await live.loadMoreAlerts()
                  setLimit(limit + PAGE)
                } finally {
                  setLoadingMore(false)
                }
              }}
            >
              {loadingMore ? 'Đang tải…' : filtered.length > limit ? `Xem thêm (${filtered.length - limit})` : 'Tải cảnh báo cũ hơn'}
            </button>
          </div>
        )}
      </div>
    </>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'crit' }) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 13 }}>
        {label}
      </div>
      <div className="stat-big num" style={{ color: tone ? 'var(--crit)' : undefined }}>
        {value}
      </div>
    </div>
  )
}
