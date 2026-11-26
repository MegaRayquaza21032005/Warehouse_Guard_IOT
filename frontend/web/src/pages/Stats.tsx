import { useMemo, useState, type ReactNode } from 'react'
import type { ChartBlock, DeviceName, StatsQuery } from '../types'
import { useLive } from '../lib/hooks'
import { DEVICE_LABEL, fmtDateTime } from '../lib/labels'
import { ChartBlockView, ChartSkeleton, ClimateStack, DeviceTimeline, statsToRows, useStats, useTimelines } from '../components/charts/Charts'

type Range = '24h' | '7d' | '30d'
type Tab = 'env' | 'security' | 'devices' | 'system'

const RANGES: { id: Range; label: string; ms: number; interval: StatsQuery['interval'] }[] = [
  { id: '24h', label: '24 giờ', ms: 86_400_000, interval: '5m' },
  { id: '7d', label: '7 ngày', ms: 7 * 86_400_000, interval: '1h' },
  { id: '30d', label: '30 ngày', ms: 30 * 86_400_000, interval: '1d' },
]

const TABS: { id: Tab; label: string }[] = [
  { id: 'env', label: 'Môi trường' },
  { id: 'security', label: 'An ninh' },
  { id: 'devices', label: 'Thiết bị' },
  { id: 'system', label: 'Cảnh báo & hệ thống' },
]

export default function Stats() {
  const [range, setRange] = useState<Range>('7d')
  const [tab, setTab] = useState<Tab>('env')
  const r = RANGES.find((x) => x.id === range)!
  const { from, to, from8w, from12w } = useMemo(() => {
    const end = new Date()
    end.setMinutes(0, 0, 0)
    end.setHours(end.getHours() + 1)
    const ago = (ms: number) => new Date(end.getTime() - ms).toISOString()
    return { from: ago(r.ms), to: end.toISOString(), from8w: ago(56 * 86_400_000), from12w: ago(84 * 86_400_000) }
  }, [r.ms])
  const daily = range === '24h' ? '1h' : '1d'

  return (
    <>
      <div className="filters">
        <div className="seg" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} role="tab" aria-selected={tab === t.id}>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div className="seg">
          {RANGES.map((x) => (
            <button key={x.id} className={range === x.id ? 'on' : ''} onClick={() => setRange(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
        {fmtDateTime(from)} → {fmtDateTime(to)} · Số liệu tính sẵn ở backend (SQL), giao diện chỉ vẽ.
      </p>

      {tab === 'env' && <EnvTab from={from} to={to} interval={r.interval!} daily={daily} />}
      {tab === 'security' && (
        <div className="grid cols-2">
          <Panel title="Số lần chuyển động" sub="Trong giờ / ngoài giờ làm việc">
            <ChartBlockView block={blk('stacked_bar', '', { metric: 'motion_count', from, to, interval: daily, group_by: 'work_hours' })} />
          </Panel>
          <Panel title="Chuyển động theo giờ trong tuần" sub="Đậm = nhiều lần">
            <ChartBlockView block={blk('heatmap', '', { metric: 'motion_count', from, to, group_by: 'hour_of_day,day_of_week' })} />
          </Panel>
          <Panel title="Chuyển động ngoài giờ" sub="Mỗi chấm là một lần phát hiện" span>
            <MotionDots from={from} to={to} />
          </Panel>
        </div>
      )}
      {tab === 'devices' && <DevicesTab from={from} to={to} daily={daily} />}
      {tab === 'system' && (
        <div className="grid cols-2">
          <Panel title="Số cảnh báo theo loại">
            <ChartBlockView block={blk('stacked_bar', '', { metric: 'alert_count', from, to, interval: daily, group_by: 'type' })} />
          </Panel>
          <Panel title="Tỉ lệ báo giả theo tuần" sub="Từ phản hồi 👍/👎 — đo AI có tốt lên không">
            <ChartBlockView block={blk('line', 'Tỉ lệ báo giả', { metric: 'false_alarm_rate', from: from8w, to, interval: '1w' })} />
          </Panel>
          <div className="grid cols-2">
            <Panel title="Thời gian xử lý sự cố TB" sub="phút">
              <ChartBlockView block={blk('stat', '', { metric: 'incident_resolve_minutes', from, to })} />
            </Panel>
            <Panel title="ESP32 trực tuyến" sub="% thời gian">
              <ChartBlockView block={blk('stat', '', { metric: 'device_online', from, to })} />
            </Panel>
          </div>
          <Panel title="Cường độ WiFi (RSSI)" sub="dBm">
            <ChartBlockView block={blk('line', 'RSSI', { metric: 'rssi', from, to, interval: daily })} height={160} />
          </Panel>
          <Panel title="Mức nền MQ135 theo tuần" sub="Tăng dần → cảm biến trôi, cần hiệu chuẩn lại" span>
            <ChartBlockView block={blk('line', 'Mức nền MQ135', { metric: 'mq135_baseline', from: from12w, to, interval: '1w' })} height={180} />
          </Panel>
        </div>
      )}
    </>
  )
}

function blk(chart: ChartBlock['chart'], title: string, query: StatsQuery, thresholds?: ChartBlock['thresholds']): ChartBlock {
  return { type: 'chart', chart, title, query, thresholds }
}

function Panel({ title, sub, children, span }: { title: string; sub?: string; children: ReactNode; span?: boolean }) {
  return (
    <div className={`card ${span ? 'span-2' : ''}`}>
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          {sub && <div className="sub">{sub}</div>}
        </div>
      </div>
      {children}
    </div>
  )
}

function EnvTab({ from, to, interval, daily }: { from: string; to: string; interval: NonNullable<StatsQuery['interval']>; daily: StatsQuery['interval'] }) {
  const cfg = useLive().config
  const temp = useStats({ metric: 'temp', from, to, interval, agg: ['avg', 'min', 'max'] })
  const hum = useStats({ metric: 'hum', from, to, interval, agg: ['avg', 'min', 'max'] })
  const tl = useTimelines(['fan', 'mist'], from, to)
  return (
    <div className="grid cols-2">
      <Panel title="Nhiệt độ & độ ẩm" sub="Đường = trung bình · dải mờ = thấp nhất – cao nhất · đường đứt = ngưỡng" span>
        {temp && hum ? <ClimateStack temp={statsToRows(temp)} hum={statsToRows(hum)} tempHigh={cfg.tempHigh} humHigh={cfg.humHigh} /> : <ChartSkeleton height={360} />}
        <div style={{ marginTop: 14 }}>
          <div className="sub faint" style={{ marginBottom: 8, fontSize: 12 }}>
            Quạt & phun sương trong cùng khoảng — để thấy hiệu quả làm mát / thông gió
          </div>
          {tl ? <DeviceTimeline rows={tl} from={new Date(from).getTime()} to={new Date(to).getTime()} /> : <ChartSkeleton height={80} />}
        </div>
      </Panel>
      <Panel title="Khí / khói (MQ135)" sub="Trung bình và đỉnh, nền theo vùng" span>
        <ChartBlockView
          block={blk('line', 'MQ135', { metric: 'mq135', from, to, interval, agg: ['avg', 'min', 'max'] }, [
            { label: 'Cảnh báo', value: cfg.mq135Warning },
            { label: 'Nguy hiểm', value: cfg.mq135Danger },
          ])}
        />
      </Panel>
      <Panel title="Nhiệt độ theo giờ trong tuần" sub="Tìm quy luật nóng theo giờ">
        <ChartBlockView block={blk('heatmap', '', { metric: 'temp', from, to, group_by: 'hour_of_day,day_of_week' })} />
      </Panel>
      <Panel title="Độ ẩm theo giờ trong tuần">
        <ChartBlockView block={blk('heatmap', '', { metric: 'hum', from, to, group_by: 'hour_of_day,day_of_week' })} />
      </Panel>
      <Panel title="% thời gian vượt ngưỡng" sub="Nhiệt độ ≥ ngưỡng nóng, độ ẩm ≥ ngưỡng ẩm" span>
        <ChartBlockView block={blk('bar', '', { metric: 'threshold_exceeded_pct', from, to, interval: daily })} height={200} />
      </Panel>
    </div>
  )
}

function DevicesTab({ from, to, daily }: { from: string; to: string; daily: StatsQuery['interval'] }) {
  const [device, setDevice] = useState<DeviceName>('fan')
  return (
    <div className="grid cols-2">
      <div className="card span-2">
        <div className="card-head">
          <div>
            <h3>Thời gian chạy theo lý do</h3>
            <div className="sub">phút</div>
          </div>
          <div className="actions seg">
            {(['fan', 'mist', 'light'] as DeviceName[]).map((d) => (
              <button key={d} className={device === d ? 'on' : ''} onClick={() => setDevice(d)}>
                {DEVICE_LABEL[d]}
              </button>
            ))}
          </div>
        </div>
        <ChartBlockView block={blk('stacked_bar', '', { metric: 'device_on_minutes', device, from, to, interval: daily, group_by: 'reason' })} height={230} />
      </div>
      <Panel title="Trạng thái thiết bị" sub="Khoảng thời gian bật">
        <ChartBlockView block={blk('timeline', '', { metric: 'device_state', from, to })} />
      </Panel>
      <Panel title="Ai ra lệnh nhiều nhất?" sub="Số lệnh theo nguồn">
        <ChartBlockView block={blk('bar', '', { metric: 'command_count', from, to, interval: daily, group_by: 'source' })} />
      </Panel>
    </div>
  )
}

function MotionDots({ from, to }: { from: string; to: string }) {
  const s = useStats({ metric: 'motion_events', from, to })
  const a = new Date(from).getTime()
  const b = new Date(to).getTime()
  const [hover, setHover] = useState('')
  if (!s) return <ChartSkeleton height={60} />
  const pts = s.series[0]?.points ?? []
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ position: 'relative', height: 34, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
        {pts.map((p) => {
          const t = new Date(p.t).getTime()
          return (
            <span
              key={p.t}
              onMouseEnter={() => setHover(fmtDateTime(p.t))}
              onMouseLeave={() => setHover('')}
              title={fmtDateTime(p.t)}
              style={{
                position: 'absolute',
                top: '50%',
                left: `${((t - a) / (b - a)) * 100}%`,
                width: 11,
                height: 11,
                marginLeft: -5.5,
                marginTop: -5.5,
                borderRadius: '50%',
                background: 'var(--s2)',
                boxShadow: '0 0 0 2px var(--surface)',
                cursor: 'default',
              }}
            />
          )
        })}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', minHeight: 18 }}>
        {hover ? `Chuyển động lúc ${hover}` : `${pts.length} lần chuyển động ngoài giờ trong khoảng đã chọn`}
      </div>
    </div>
  )
}
