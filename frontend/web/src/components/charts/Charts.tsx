import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ChartBlock, DeviceName, StatsResponse, TimelineSegment } from '../../types'
import { getStats, getTimeline } from '../../api'
import { useCssVars } from '../../lib/hooks'
import { DEVICE_LABEL, SOURCE_LABEL, WEEKDAY_SHORT, alertTypeLabel, fmtDateTime, fmtDay, fmtTime, reasonLabel } from '../../lib/labels'

const VARS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 'c-temp', 'c-hum', 'c-mq2', 'grid', 'text-3', 'text-2', 'surface', 'ok', 'warn', 'crit', 'border-strong'] as const
export const SERIES = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'] as const

export function useChartColors() {
  return useCssVars(VARS)
}

// ------------------------------------------------------------------ tooltip

interface TipRow {
  name?: string | number
  value?: unknown
  color?: string
  dataKey?: unknown
  payload?: unknown
}
interface TipProps {
  active?: boolean
  payload?: readonly TipRow[]
  label?: unknown
  unit?: string
  labelFmt?: (v: unknown) => string
  names?: Record<string, string>
}

function fmtVal(v: unknown, unit = ''): string {
  if (Array.isArray(v)) return `${fmtVal(v[0])} – ${fmtVal(v[1], unit)}`
  if (typeof v === 'number') return `${Number.isInteger(v) ? v : v.toFixed(1)}${unit}`
  return String(v ?? '—')
}

export function Tip({ active, payload, label, unit, labelFmt, names }: TipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="chart-tooltip">
      <div className="t">{labelFmt ? labelFmt(label) : String(label)}</div>
      {payload.map((p) => {
        const key = String(p.dataKey ?? p.name)
        return (
          <div className="r" key={key}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <i style={{ width: 8, height: 8, borderRadius: 2, background: p.color, display: 'inline-block' }} />
              {names?.[key] ?? p.name}
            </span>
            <b>{fmtVal(p.value, unit)}</b>
          </div>
        )
      })}
    </div>
  )
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={i.dashed ? { background: 'transparent', borderTop: `2px dashed ${i.color}`, height: 0, width: 14 } : { background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

const axisTick = (c: Record<string, string>) => ({ fontSize: 11, fill: c['text-3'] })

function timeTick(span: number) {
  return (v: number) => (span > 2 * 86_400_000 ? fmtDay(v) : fmtTime(v))
}

// ------------------------------------------------------------------ đường theo thời gian (1 đại lượng + dải min–max + ngưỡng)

export interface TimeRow {
  t: number
  v: number | null
  range?: [number, number] | null
}

export function TimeLine({
  rows,
  color,
  bandColor,
  unit,
  name,
  thresholds = [],
  height = 180,
  syncId,
  zones,
  domain,
  showX = true,
}: {
  rows: TimeRow[]
  color: string
  bandColor?: string
  unit: string
  name: string
  thresholds?: { label: string; value: number; color?: string }[]
  height?: number
  syncId?: string
  zones?: { y1: number; y2: number; color: string }[]
  domain?: [number | 'auto' | 'dataMin', number | 'auto' | 'dataMax']
  showX?: boolean
}) {
  const c = useChartColors()
  const span = rows.length ? rows[rows.length - 1].t - rows[0].t : 0
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} syncId={syncId} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={c.grid} vertical={false} />
        {zones?.map((z) => <ReferenceArea key={z.y1} y1={z.y1} y2={z.y2} fill={z.color} fillOpacity={0.08} stroke="none" ifOverflow="hidden" />)}
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={timeTick(span)}
          tick={axisTick(c)}
          axisLine={false}
          tickLine={false}
          minTickGap={40}
          hide={!showX}
        />
        <YAxis tick={axisTick(c)} axisLine={false} tickLine={false} width={48} domain={domain ?? ['auto', 'auto']} unit={unit === '°C' ? '°' : unit === '%' ? '%' : ''} />
        <Tooltip
          content={(p) => <Tip {...p} unit={unit} labelFmt={(l) => fmtDateTime(Number(l))} names={{ v: name, range: 'Thấp nhất – cao nhất' }} />}
          cursor={{ stroke: c['border-strong'], strokeWidth: 1 }}
        />
        {rows.some((r) => r.range) && <Area dataKey="range" stroke="none" fill={bandColor} isAnimationActive={false} connectNulls={false} activeDot={false} />}
        {thresholds.map((th) => (
          <ReferenceLine
            key={th.label}
            y={th.value}
            stroke={th.color ?? c.crit}
            strokeDasharray="5 4"
            ifOverflow="extendDomain"
            label={{ value: `${th.label} ${th.value}${unit}`, position: 'insideTopRight', fontSize: 11, fill: c['text-2'] }}
          />
        ))}
        <Line dataKey="v" name={name} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} activeDot={{ r: 4, strokeWidth: 2, stroke: c.surface }} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

/** Nhiệt độ + độ ẩm: 2 biểu đồ xếp chồng chung trục thời gian (không dùng 2 trục Y). */
export function ClimateStack({
  temp,
  hum,
  tempHigh,
  humHigh,
  height = 170,
}: {
  temp: TimeRow[]
  hum: TimeRow[]
  tempHigh: number
  humHigh: number
  height?: number
}) {
  const c = useChartColors()
  const id = useId()
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className="legend">
        <span>
          <i style={{ background: c['c-temp'] }} /> Nhiệt độ (°C)
        </span>
      </div>
      <TimeLine rows={temp} color={c['c-temp']} bandColor={c['c-temp'] + '33'} unit="°C" name="Nhiệt độ" thresholds={[{ label: 'Ngưỡng nóng', value: tempHigh }]} height={height} syncId={id} showX={false} />
      <div className="legend">
        <span>
          <i style={{ background: c['c-hum'] }} /> Độ ẩm (%)
        </span>
      </div>
      <TimeLine rows={hum} color={c['c-hum']} bandColor={c['c-hum'] + '33'} unit="%" name="Độ ẩm" thresholds={[{ label: 'Ngưỡng ẩm', value: humHigh }]} height={height} syncId={id} />
    </div>
  )
}

export function Mq2Chart({ rows, warning, danger, height = 200 }: { rows: TimeRow[]; warning: number; danger: number; height?: number }) {
  const c = useChartColors()
  return (
    <TimeLine
      rows={rows}
      color={c['c-mq2']}
      bandColor={c['c-mq2'] + '30'}
      unit=""
      name="MQ2"
      height={height}
      domain={[0, Math.max(danger + 600, ...rows.map((r) => r.range?.[1] ?? r.v ?? 0))]}
      zones={[
        { y1: 0, y2: warning, color: c.ok },
        { y1: warning, y2: danger, color: c.warn },
        { y1: danger, y2: 4095, color: c.crit },
      ]}
      thresholds={[
        { label: 'Cảnh báo', value: warning, color: c.warn },
        { label: 'Nguy hiểm', value: danger, color: c.crit },
      ]}
    />
  )
}

// ------------------------------------------------------------------ cột (chồng / thường / ngang)

export function seriesLabel(name: string) {
  if (name === 'work_hours') return 'Trong giờ'
  if (name === 'after_hours') return 'Ngoài giờ'
  if (name === 'temp') return 'Nhiệt độ'
  if (name === 'hum') return 'Độ ẩm'
  if (name === 'count' || name === 'total') return 'Tổng'
  if (name in SOURCE_LABEL) return SOURCE_LABEL[name as keyof typeof SOURCE_LABEL]
  const r = reasonLabel(name)
  if (r !== name) return r
  return alertTypeLabel(name)
}

export function Bars({
  stats,
  stacked = true,
  unit = '',
  height = 220,
}: {
  stats: StatsResponse
  stacked?: boolean
  unit?: string
  height?: number
}) {
  const c = useChartColors()
  const names = stats.series.map((s) => s.name)
  const rows = useMemo(() => {
    const map = new Map<string, Record<string, number | string>>()
    for (const s of stats.series)
      for (const p of s.points) {
        const row = map.get(p.t) ?? { t: p.t }
        row[s.name] = p.v
        map.set(p.t, row)
      }
    return [...map.values()]
  }, [stats])
  const daily = stats.interval === '1d' || stats.interval === '1w'
  const labels = Object.fromEntries(names.map((n) => [n, seriesLabel(n)]))
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {names.length > 1 && <Legend items={names.map((n, i) => ({ label: labels[n], color: c[SERIES[i % 8]] }))} />}
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="22%">
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="t" tickFormatter={(v: string) => (daily ? fmtDay(v) : fmtTime(v))} tick={axisTick(c)} axisLine={false} tickLine={false} minTickGap={16} />
          <YAxis tick={axisTick(c)} axisLine={false} tickLine={false} width={44} />
          <Tooltip
            cursor={{ fill: c.grid, opacity: 0.6 }}
            content={(p) => <Tip {...p} unit={unit} labelFmt={(l) => (daily ? fmtDay(String(l)) : fmtDateTime(String(l)))} names={labels} />}
          />
          {names.map((n, i) => (
            <Bar
              key={n}
              dataKey={n}
              name={labels[n]}
              stackId={stacked ? 'a' : undefined}
              fill={c[SERIES[i % 8]]}
              stroke={c.surface}
              strokeWidth={stacked ? 1 : 0}
              radius={!stacked || i === names.length - 1 ? [4, 4, 0, 0] : 0}
              maxBarSize={36}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Cột ngang: tổng theo nhóm (vd. nguồn ra lệnh). */
export function HBars({ stats }: { stats: StatsResponse }) {
  const c = useChartColors()
  const rows = stats.series
    .map((s) => ({ name: seriesLabel(s.name), v: s.points.reduce((a, p) => a + p.v, 0) }))
    .sort((a, b) => b.v - a.v)
  const max = Math.max(1, ...rows.map((r) => r.v))
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {rows.map((r) => (
        <div key={r.name} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 44px', gap: 10, alignItems: 'center', fontSize: 13 }} title={`${r.name}: ${r.v}`}>
          <span className="muted">{r.name}</span>
          <div style={{ height: 14, borderRadius: 4, background: 'var(--surface-3)', overflow: 'hidden' }}>
            <div style={{ width: `${(r.v / max) * 100}%`, height: '100%', background: c.s1, borderRadius: '0 4px 4px 0' }} />
          </div>
          <b className="num" style={{ textAlign: 'right' }}>
            {r.v}
          </b>
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ heatmap

export function Heatmap({ cells, colorVar, unit }: { cells: NonNullable<StatsResponse['cells']>; colorVar: string; unit: string }) {
  const vals = cells.map((x) => x.v)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const [hover, setHover] = useState<{ d: number; h: number; v: number } | null>(null)
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="heatmap">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} style={{ textAlign: 'center' }}>
            {h % 3 === 0 ? h : ''}
          </span>
        ))}
        {WEEKDAY_SHORT.map((wd, di) => (
          <Row key={wd} label={wd}>
            {Array.from({ length: 24 }, (_, h) => {
              const cell = cells.find((x) => x.dayOfWeek === di + 1 && x.hour === h)
              const v = cell?.v ?? 0
              const pct = max === min ? 50 : 8 + ((v - min) / (max - min)) * 92
              return (
                <div
                  key={h}
                  className="cell"
                  onMouseEnter={() => setHover({ d: di, h, v })}
                  onMouseLeave={() => setHover(null)}
                  style={{
                    background: `color-mix(in oklab, var(--${colorVar}) ${pct}%, var(--surface-2))`,
                    outline: hover?.d === di && hover.h === h ? '2px solid var(--text)' : 'none',
                  }}
                />
              )
            })}
          </Row>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-3)', minHeight: 18 }}>
        <span>
          {fmtVal(min, unit)}
        </span>
        <div style={{ width: 120, height: 8, borderRadius: 4, background: `linear-gradient(90deg, color-mix(in oklab, var(--${colorVar}) 8%, var(--surface-2)), var(--${colorVar}))` }} />
        <span>{fmtVal(max, unit)}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-2)' }}>
          {hover ? `${WEEKDAY_SHORT[hover.d]}, ${hover.h}:00–${hover.h + 1}:00 · ${fmtVal(hover.v, unit)}` : 'Di chuột vào ô để xem giá trị'}
        </span>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="rl">{label}</span>
      {children}
    </>
  )
}

// ------------------------------------------------------------------ timeline trạng thái thiết bị

export function DeviceTimeline({ rows, from, to }: { rows: { device: DeviceName; segs: TimelineSegment[] }[]; from: number; to: number }) {
  const span = to - from
  const [hover, setHover] = useState<string>('')
  const ticks = 5
  return (
    <div className="timeline">
      {rows.map((r) => (
        <div className="timeline-row" key={r.device}>
          <span className="muted">{DEVICE_LABEL[r.device]}</span>
          <div className="timeline-bar">
            {r.segs
              .filter((s) => s.state === 'on')
              .map((s) => {
                const a = Math.max(from, new Date(s.start).getTime())
                const b = Math.min(to, new Date(s.end).getTime())
                const info = `${DEVICE_LABEL[r.device]} BẬT ${fmtDateTime(a)} → ${fmtTime(b)} · ${reasonLabel(s.reason)} · ${SOURCE_LABEL[s.source]}`
                return (
                  <span
                    key={s.start}
                    title={info}
                    onMouseEnter={() => setHover(info)}
                    onMouseLeave={() => setHover('')}
                    style={{
                      left: `${((a - from) / span) * 100}%`,
                      width: `max(2px, ${((b - a) / span) * 100}%)`,
                      background: 'var(--s1)',
                      borderRadius: 3,
                    }}
                  />
                )
              })}
          </div>
        </div>
      ))}
      <div className="timeline-axis">
        {Array.from({ length: ticks + 1 }, (_, i) => (
          <span key={i}>{(span > 2 * 86_400_000 ? fmtDay : fmtTime)(from + (span * i) / ticks)}</span>
        ))}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', minHeight: 18 }}>{hover || 'Thanh màu = thiết bị BẬT. Di chuột để xem lý do và nguồn lệnh.'}</div>
    </div>
  )
}

// ------------------------------------------------------------------ chuyển đổi dữ liệu

export function statsToRows(s: StatsResponse): TimeRow[] {
  const avg = s.series.find((x) => x.name === 'avg') ?? s.series[0]
  const min = s.series.find((x) => x.name === 'min')
  const max = s.series.find((x) => x.name === 'max')
  if (!avg) return []
  return avg.points.map((p, i) => ({
    t: new Date(p.t).getTime(),
    v: p.v,
    range: min?.points[i] && max?.points[i] ? [min.points[i].v, max.points[i].v] : null,
  }))
}

export function useStats(q: Parameters<typeof getStats>[0] | null) {
  const key = q ? JSON.stringify(q) : ''
  const [data, setData] = useState<{ key: string; res: StatsResponse } | null>(null)
  useEffect(() => {
    if (!q) return
    let alive = true
    getStats(q)
      .then((res) => alive && setData({ key, res }))
      .catch((e: Error) => alive && setData({ key, res: { metric: q.metric, interval: '', from: q.from, to: q.to, groupBy: null, series: [], error: e.message } }))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return data?.key === key ? data.res : null
}

export function useTimelines(devices: DeviceName[], from: string, to: string) {
  const key = `${devices.join()}|${from}|${to}`
  const [data, setData] = useState<{ key: string; rows: { device: DeviceName; segs: TimelineSegment[] }[] } | null>(null)
  useEffect(() => {
    let alive = true
    Promise.all(devices.map(async (d) => ({ device: d, segs: await getTimeline(d, from, to).catch(() => []) }))).then(
      (rows) => alive && setData({ key, rows }),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return data?.key === key ? data.rows : null
}

export function ChartEmpty({ height = 200, text }: { height?: number; text: string }) {
  return (
    <div className="empty" style={{ minHeight: height, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
      {text}
    </div>
  )
}

export function ChartSkeleton({ height = 200 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} />
}

// ------------------------------------------------------------------ khối biểu đồ (chat) — frontend tự gọi API theo `query`

export function ChartBlockView({ block, height = 200 }: { block: ChartBlock; height?: number }) {
  const c = useChartColors()
  const q = block.query
  const isTimeline = block.chart === 'timeline' && q.metric === 'device_state'
  const stats = useStats(isTimeline ? null : q)
  const devs: DeviceName[] = q.device ? [q.device] : ['fan', 'mist', 'light']
  const tl = useTimelines(isTimeline ? devs : [], q.from, q.to)

  if (isTimeline) return tl ? <DeviceTimeline rows={tl} from={new Date(q.from).getTime()} to={new Date(q.to).getTime()} /> : <ChartSkeleton height={100} />
  if (!stats) return <ChartSkeleton height={height} />
  if (stats.error) return <ChartEmpty height={height} text={`Không tải được số liệu: ${stats.error}`} />
  const empty = block.chart === 'heatmap' ? !stats.cells?.length : stats.series.every((x) => !x.points.length)
  if (empty) return <ChartEmpty height={block.chart === 'stat' ? 60 : height} text={block.chart === 'stat' ? '—' : 'Chưa có dữ liệu trong khoảng thời gian này'} />

  switch (block.chart) {
    case 'line': {
      const rows = statsToRows(stats)
      if (q.metric === 'mq2') {
        const w = block.thresholds?.[0]?.value ?? 1500
        const d = block.thresholds?.[1]?.value ?? 2500
        return <Mq2Chart rows={rows} warning={w} danger={d} height={height} />
      }
      const color = q.metric === 'hum' ? c['c-hum'] : q.metric === 'temp' ? c['c-temp'] : c.s1
      const unit = q.metric === 'hum' ? '%' : q.metric === 'temp' ? '°C' : q.metric.endsWith('rate') ? '%' : ''
      return (
        <TimeLine
          rows={rows}
          color={color}
          bandColor={color + '33'}
          unit={unit}
          name={block.title}
          thresholds={block.thresholds}
          height={height}
        />
      )
    }
    case 'stacked_bar':
      return <Bars stats={stats} height={height} />
    case 'bar':
      return q.group_by === 'source' ? <HBars stats={stats} /> : <Bars stats={stats} stacked={false} height={height} unit={q.metric.endsWith('pct') ? '%' : ''} />
    case 'heatmap':
      return stats.cells ? <Heatmap cells={stats.cells} colorVar={q.metric === 'hum' ? 'c-hum' : q.metric === 'temp' ? 'c-temp' : 's1'} unit={q.metric === 'hum' ? '%' : q.metric === 'temp' ? '°C' : ''} /> : null
    case 'stat': {
      const v = stats.series[0]?.points.at(-1)?.v
      return <div className="stat-big num">{v ?? '—'}</div>
    }
    default:
      return null
  }
}
