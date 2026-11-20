/**
 * Biểu đồ vẽ bằng react-native-svg (chạy cả Android / iOS / web). Cùng quy ước khối biểu đồ với web
 * (CLAUDE.md mục 6): khối chỉ chứa câu truy vấn, app tự gọi `/api/stats` rồi vẽ.
 */
import { useEffect, useState } from 'react'
import { Text, View, type LayoutChangeEvent } from 'react-native'
import Svg, { Line, Path, Rect, Text as SvgText, Circle } from 'react-native-svg'
import type { ChartBlock, DeviceName, StatsQuery, StatsResponse, TimelineSegment } from '../../../shared/types'
import { DEVICE_LABEL, SOURCE_LABEL, WEEKDAY_SHORT, alertTypeLabel, fmtDateTime, reasonLabel } from '../../../shared/labels'
import { errorText, getStats, getTimeline } from '../lib/api'
import { useColors, type Colors } from '../lib/theme'
import { Empty } from './ui'

// ------------------------------------------------------------------ dữ liệu

export function useStats(q: StatsQuery | null) {
  const key = q ? JSON.stringify(q) : ''
  const [data, setData] = useState<{ key: string; res: StatsResponse } | null>(null)
  useEffect(() => {
    if (!q) return
    let alive = true
    getStats(q)
      .then((res) => alive && setData({ key, res }))
      .catch((e) => alive && setData({ key, res: { metric: q.metric, interval: '', from: q.from, to: q.to, groupBy: null, series: [], error: errorText(e) } }))
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
    if (!devices.length) return
    let alive = true
    Promise.all(devices.map(async (d) => ({ device: d, segs: await getTimeline(d, from, to).catch(() => [] as TimelineSegment[]) }))).then(
      (rows) => alive && setData({ key, rows }),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return data?.key === key ? data.rows : null
}

export interface Row {
  t: number
  v: number | null
  min?: number | null
  max?: number | null
}

export function statsToRows(s: StatsResponse): Row[] {
  const avg = s.series.find((x) => x.name === 'avg') ?? s.series[0]
  const min = s.series.find((x) => x.name === 'min')
  const max = s.series.find((x) => x.name === 'max')
  if (!avg) return []
  return avg.points.map((p, i) => ({ t: new Date(p.t).getTime(), v: p.v, min: min?.points[i]?.v, max: max?.points[i]?.v }))
}

export function seriesLabel(name: string) {
  if (name === 'work_hours') return 'Trong giờ'
  if (name === 'after_hours') return 'Ngoài giờ'
  if (name === 'temp') return 'Nhiệt độ'
  if (name === 'hum') return 'Độ ẩm'
  if (name === 'count' || name === 'total' || name === 'minutes') return 'Tổng'
  if (name in SOURCE_LABEL) return SOURCE_LABEL[name as keyof typeof SOURCE_LABEL]
  const r = reasonLabel(name)
  if (r !== name) return r
  return alertTypeLabel(name)
}

// ------------------------------------------------------------------ tiện ích vẽ

function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [w, setW] = useState(0)
  return [w, (e) => setW(Math.round(e.nativeEvent.layout.width))]
}

function niceRange(vals: number[], extra: number[] = []): [number, number] {
  const all = [...vals, ...extra].filter((v) => Number.isFinite(v))
  if (!all.length) return [0, 1]
  let lo = Math.min(...all)
  let hi = Math.max(...all)
  if (lo === hi) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.08
  return [lo - pad, hi + pad]
}

const fmtNum = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString())
const hhmm = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const ddmm = (t: number) => {
  const d = new Date(t)
  return `${d.getDate()}/${d.getMonth() + 1}`
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  const c = useColors()
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 6 }}>
      {items.map((i) => (
        <View key={i.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: i.color }} />
          <Text style={{ color: c.text2, fontSize: 11.5 }}>{i.label}</Text>
        </View>
      ))}
    </View>
  )
}

// ------------------------------------------------------------------ đường (kèm dải min–max, ngưỡng, vùng nền MQ2)

export function LineChart({
  rows,
  color,
  height = 180,
  unit = '',
  thresholds = [],
  zones,
}: {
  rows: Row[]
  color: string
  height?: number
  unit?: string
  thresholds?: { label: string; value: number }[]
  /** Nền theo vùng (MQ2): [cảnh báo, nguy hiểm]. */
  zones?: [number, number]
}) {
  const c = useColors()
  const [w, onLayout] = useWidth()
  const pts = rows.filter((r) => r.v !== null && r.v !== undefined)
  const padL = 34
  const padB = 18
  const W = Math.max(w, 1)
  const H = height
  const vals = pts.flatMap((r) => [r.v as number, r.min ?? (r.v as number), r.max ?? (r.v as number)])
  const [lo, hi] = niceRange(
    vals,
    thresholds.map((t) => t.value),
  )
  const t0 = pts[0]?.t ?? 0
  const t1 = pts[pts.length - 1]?.t ?? 1
  const x = (t: number) => padL + (t1 === t0 ? (W - padL) / 2 : ((t - t0) / (t1 - t0)) * (W - padL - 6))
  const y = (v: number) => 6 + (1 - (v - lo) / (hi - lo)) * (H - padB - 6)
  const yc = (v: number) => y(Math.min(hi, Math.max(lo, v)))
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v as number).toFixed(1)}`).join('')
  const band =
    pts.some((p) => p.min !== undefined && p.min !== null) && pts.length > 1
      ? pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y((p.max ?? p.v) as number).toFixed(1)}`).join('') +
        [...pts]
          .reverse()
          .map((p) => `L${x(p.t).toFixed(1)},${y((p.min ?? p.v) as number).toFixed(1)}`)
          .join('') +
        'Z'
      : ''
  const ticks = [0, 0.5, 1].map((f) => lo + (hi - lo) * f)
  const span = t1 - t0
  const fmtT = span > 2 * 86_400_000 ? ddmm : hhmm
  return (
    <View onLayout={onLayout} style={{ height }}>
      {w > 0 && pts.length > 0 && (
        <Svg width={W} height={H}>
          {zones && (
            <>
              {/* vùng cảnh báo: giữa ngưỡng cảnh báo và nguy hiểm; vùng nguy hiểm: trên ngưỡng nguy hiểm */}
              <Rect x={padL} y={yc(zones[1])} width={W - padL} height={Math.max(0, yc(zones[0]) - yc(zones[1]))} fill={c.warnSoft} />
              <Rect x={padL} y={6} width={W - padL} height={Math.max(0, yc(zones[1]) - 6)} fill={c.critSoft} />
            </>
          )}
          {ticks.map((v) => (
            <Line key={v} x1={padL} x2={W} y1={y(v)} y2={y(v)} stroke={c.grid} strokeWidth={1} />
          ))}
          {ticks.map((v) => (
            <SvgText key={`l${v}`} x={padL - 4} y={y(v) + 3} fontSize={9.5} fill={c.text3} textAnchor="end">
              {fmtNum(v)}
            </SvgText>
          ))}
          {band ? <Path d={band} fill={color} opacity={0.16} /> : null}
          {thresholds.map((t) => (
            <Line key={t.label} x1={padL} x2={W} y1={y(t.value)} y2={y(t.value)} stroke={c.crit} strokeDasharray="4 4" strokeWidth={1} />
          ))}
          {pts.length > 1 ? (
            <Path d={line} stroke={color} strokeWidth={2} fill="none" />
          ) : (
            <Circle cx={x(pts[0].t)} cy={y(pts[0].v as number)} r={3.5} fill={color} />
          )}
          <SvgText x={padL} y={H - 4} fontSize={9.5} fill={c.text3}>
            {fmtT(t0)}
          </SvgText>
          <SvgText x={W - 2} y={H - 4} fontSize={9.5} fill={c.text3} textAnchor="end">
            {fmtT(t1)}
          </SvgText>
          {unit ? (
            <SvgText x={W - 2} y={14} fontSize={10} fill={c.text3} textAnchor="end">
              {unit}
            </SvgText>
          ) : null}
        </Svg>
      )}
      {w > 0 && !pts.length && <Empty text="Chưa có dữ liệu" />}
    </View>
  )
}

// ------------------------------------------------------------------ cột (chồng / nhóm) và cột ngang

export function Bars({ stats, stacked = true, height = 190, unit = '' }: { stats: StatsResponse; stacked?: boolean; height?: number; unit?: string }) {
  const c = useColors()
  const [w, onLayout] = useWidth()
  const names = stats.series.map((s) => s.name)
  const times = [...new Set(stats.series.flatMap((s) => s.points.map((p) => p.t)))].sort()
  const val = (n: string, t: string) => stats.series.find((s) => s.name === n)?.points.find((p) => p.t === t)?.v ?? 0
  const totals = times.map((t) => (stacked ? names.reduce((a, n) => a + val(n, t), 0) : Math.max(...names.map((n) => val(n, t)))))
  const max = Math.max(1, ...totals)
  const padL = 30
  const padB = 18
  const H = height
  const slot = times.length ? (w - padL) / times.length : 0
  const bw = Math.max(2, Math.min(28, slot * 0.7))
  const color = (i: number) => c.series[i % c.series.length]
  const y = (v: number) => 4 + (1 - v / max) * (H - padB - 4)
  const daily = times.length > 1 && new Date(times[1]).getTime() - new Date(times[0]).getTime() >= 86_400_000
  return (
    <View>
      {names.length > 1 && <Legend items={names.map((n, i) => ({ label: seriesLabel(n), color: color(i) }))} />}
      <View onLayout={onLayout} style={{ height }}>
        {w > 0 && (
          <Svg width={w} height={H}>
            {[0, 0.5, 1].map((f) => (
              <Line key={f} x1={padL} x2={w} y1={y(max * f)} y2={y(max * f)} stroke={c.grid} />
            ))}
            {[0, 1].map((f) => (
              <SvgText key={`t${f}`} x={padL - 4} y={y(max * f) + 3} fontSize={9.5} fill={c.text3} textAnchor="end">
                {fmtNum(max * f)}
                {f ? unit : ''}
              </SvgText>
            ))}
            {times.map((t, ti) => {
              const cx = padL + slot * ti + slot / 2
              let acc = 0
              return names.map((n, ni) => {
                const v = val(n, t)
                if (!v) return null
                if (stacked) {
                  const top = y(acc + v)
                  const r = <Rect key={`${t}${n}`} x={cx - bw / 2} y={top} width={bw} height={y(acc) - top} fill={color(ni)} />
                  acc += v
                  return r
                }
                const gw = bw / names.length
                return <Rect key={`${t}${n}`} x={cx - bw / 2 + ni * gw} y={y(v)} width={gw} height={y(0) - y(v)} fill={color(ni)} />
              })
            })}
            {times.length > 0 && (
              <>
                <SvgText x={padL} y={H - 4} fontSize={9.5} fill={c.text3}>
                  {(daily ? ddmm : hhmm)(new Date(times[0]).getTime())}
                </SvgText>
                <SvgText x={w - 2} y={H - 4} fontSize={9.5} fill={c.text3} textAnchor="end">
                  {(daily ? ddmm : hhmm)(new Date(times[times.length - 1]).getTime())}
                </SvgText>
              </>
            )}
          </Svg>
        )}
      </View>
    </View>
  )
}

export function HBars({ stats }: { stats: StatsResponse }) {
  const c = useColors()
  const rows = stats.series.map((s) => ({ name: s.name, v: s.points.reduce((a, p) => a + (p.v ?? 0), 0) })).sort((a, b) => b.v - a.v)
  const max = Math.max(1, ...rows.map((r) => r.v))
  return (
    <View style={{ gap: 8 }}>
      {rows.map((r, i) => (
        <View key={r.name} style={{ gap: 3 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: c.text2, fontSize: 12.5 }}>{seriesLabel(r.name)}</Text>
            <Text style={{ color: c.text, fontSize: 12.5, fontWeight: '700' }}>{fmtNum(r.v)}</Text>
          </View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: c.surface3 }}>
            <View style={{ width: `${(r.v / max) * 100}%`, height: 8, borderRadius: 4, backgroundColor: c.series[i % c.series.length] }} />
          </View>
        </View>
      ))}
    </View>
  )
}

// ------------------------------------------------------------------ heatmap 7 ngày × 24 giờ

export function Heatmap({ cells, color, unit }: { cells: NonNullable<StatsResponse['cells']>; color: string; unit: string }) {
  const c = useColors()
  const [w, onLayout] = useWidth()
  const vals = cells.map((x) => x.v)
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const padL = 22
  const cw = w > 0 ? (w - padL) / 24 : 0
  const ch = 16
  return (
    <View onLayout={onLayout}>
      {w > 0 && (
        <Svg width={w} height={7 * ch + 16}>
          {WEEKDAY_SHORT.map((d, di) => (
            <SvgText key={d} x={0} y={di * ch + 12} fontSize={9.5} fill={c.text3}>
              {d}
            </SvgText>
          ))}
          {cells.map((cell) => (
            <Rect
              key={`${cell.dayOfWeek}-${cell.hour}`}
              x={padL + cell.hour * cw}
              y={(cell.dayOfWeek - 1) * ch}
              width={Math.max(1, cw - 1)}
              height={ch - 1}
              rx={2}
              fill={color}
              opacity={hi === lo ? 0.6 : 0.12 + 0.88 * ((cell.v - lo) / (hi - lo))}
            />
          ))}
          {[0, 6, 12, 18, 23].map((h) => (
            <SvgText key={h} x={padL + h * cw + cw / 2} y={7 * ch + 12} fontSize={9} fill={c.text3} textAnchor="middle">
              {h}h
            </SvgText>
          ))}
        </Svg>
      )}
      <Text style={{ color: c.text3, fontSize: 11.5 }}>
        Nhạt = {fmtNum(lo)}
        {unit} · đậm = {fmtNum(hi)}
        {unit}
      </Text>
    </View>
  )
}

// ------------------------------------------------------------------ dòng thời gian bật / tắt thiết bị

export function DeviceTimeline({ rows, from, to }: { rows: { device: DeviceName; segs: TimelineSegment[] }[]; from: number; to: number }) {
  const c = useColors()
  const [w, onLayout] = useWidth()
  const padL = 70
  const x = (t: number) => padL + ((t - from) / (to - from)) * (w - padL)
  return (
    <View onLayout={onLayout} style={{ gap: 6 }}>
      {w > 0 &&
        rows.map((r) => (
          <View key={r.device} style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Svg width={w} height={18}>
              <SvgText x={0} y={13} fontSize={11} fill={c.text2}>
                {DEVICE_LABEL[r.device]}
              </SvgText>
              <Rect x={padL} y={3} width={w - padL} height={12} rx={3} fill={c.surface3} />
              {r.segs
                .filter((s) => s.state === 'on')
                .map((s) => {
                  const a = Math.max(from, new Date(s.start).getTime())
                  const b = Math.min(to, new Date(s.end).getTime())
                  return b > a ? <Rect key={s.start} x={x(a)} y={3} width={Math.max(1.5, x(b) - x(a))} height={12} rx={2} fill={c.accent} /> : null
                })}
            </Svg>
          </View>
        ))}
      <Text style={{ color: c.text3, fontSize: 11 }}>
        {fmtDateTime(from)} → {fmtDateTime(to)} · xanh = đang bật
      </Text>
    </View>
  )
}

// ------------------------------------------------------------------ khối biểu đồ

function metricColor(c: Colors, metric: string) {
  return metric === 'hum' ? c.hum : metric === 'temp' ? c.temp : metric === 'mq2' ? c.mq2 : c.series[0]
}

export function ChartBlockView({ block, height = 180 }: { block: ChartBlock; height?: number }) {
  const c = useColors()
  const q = block.query
  const isTimeline = block.chart === 'timeline' && q.metric === 'device_state'
  const stats = useStats(isTimeline ? null : q)
  const devs: DeviceName[] = isTimeline ? (q.device ? [q.device] : ['fan', 'mist', 'light']) : []
  const tl = useTimelines(devs, q.from, q.to)

  if (isTimeline) return tl ? <DeviceTimeline rows={tl} from={new Date(q.from).getTime()} to={new Date(q.to).getTime()} /> : <Skeleton height={60} />
  if (!stats) return <Skeleton height={height} />
  if (stats.error) return <Empty text={`Không tải được số liệu: ${stats.error}`} />
  const empty = block.chart === 'heatmap' ? !stats.cells?.length : stats.series.every((s) => !s.points.length)
  if (empty) return <Empty text={block.chart === 'stat' ? '—' : 'Chưa có dữ liệu trong khoảng thời gian này'} />
  const unit = q.metric === 'hum' || q.metric.endsWith('pct') || q.metric.endsWith('rate') ? '%' : q.metric === 'temp' ? '°C' : ''

  switch (block.chart) {
    case 'line': {
      const rows = statsToRows(stats)
      if (q.metric === 'mq2') {
        const wv = block.thresholds?.[0]?.value ?? 1500
        const dv = block.thresholds?.[1]?.value ?? 2500
        return <LineChart rows={rows} color={c.mq2} height={height} zones={[wv, dv]} />
      }
      return <LineChart rows={rows} color={metricColor(c, q.metric)} height={height} unit={unit} thresholds={block.thresholds} />
    }
    case 'stacked_bar':
      return <Bars stats={stats} height={height} unit={unit} />
    case 'bar':
      return q.group_by === 'source' ? <HBars stats={stats} /> : <Bars stats={stats} stacked={false} height={height} unit={unit} />
    case 'heatmap':
      return stats.cells ? <Heatmap cells={stats.cells} color={metricColor(c, q.metric)} unit={unit} /> : null
    case 'stat': {
      const v = stats.series[0]?.points.at(-1)?.v
      return <Text style={{ color: c.text, fontSize: 30, fontWeight: '800' }}>{v !== undefined && v !== null ? `${fmtNum(v)}${unit}` : '—'}</Text>
    }
    default:
      return null
  }
}

export function Skeleton({ height = 120 }: { height?: number }) {
  const c = useColors()
  return <View style={{ height, borderRadius: 10, backgroundColor: c.surface3, opacity: 0.6 }} />
}
