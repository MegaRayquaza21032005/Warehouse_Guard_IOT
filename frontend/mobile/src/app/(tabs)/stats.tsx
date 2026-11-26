import { useMemo, useState } from 'react'
import { ScrollView, Text } from 'react-native'
import type { ChartBlock, DeviceName, StatsQuery } from '../../../../shared/types'
import { DEVICE_LABEL, fmtDateTime } from '../../../../shared/labels'
import { useLive } from '../../lib/hooks'
import { useColors } from '../../lib/theme'
import { ChartBlockView } from '../../components/Charts'
import { Card, CardTitle, Muted, Segmented } from '../../components/ui'

type Range = '24h' | '7d' | '30d'
type Tab = 'env' | 'security' | 'devices' | 'system'
const RANGES: { value: Range; label: string; ms: number; interval: NonNullable<StatsQuery['interval']> }[] = [
  { value: '24h', label: '24 giờ', ms: 86_400_000, interval: '5m' },
  { value: '7d', label: '7 ngày', ms: 7 * 86_400_000, interval: '1h' },
  { value: '30d', label: '30 ngày', ms: 30 * 86_400_000, interval: '1d' },
]

const blk = (chart: ChartBlock['chart'], query: StatsQuery, thresholds?: ChartBlock['thresholds']): ChartBlock => ({
  type: 'chart',
  chart,
  title: '',
  query,
  thresholds,
})

function Panel({ title, sub, block, height }: { title: string; sub?: string; block: ChartBlock; height?: number }) {
  return (
    <Card>
      <CardTitle title={title} sub={sub} />
      <ChartBlockView block={block} height={height} />
    </Card>
  )
}

/** Cùng danh mục biểu đồ với web (CLAUDE.md mục 6) — gọi thẳng API thống kê, không qua AI. */
export default function Stats() {
  const c = useColors()
  const cfg = useLive().config
  const [range, setRange] = useState<Range>('7d')
  const [tab, setTab] = useState<Tab>('env')
  const [device, setDevice] = useState<DeviceName>('fan')
  const r = RANGES.find((x) => x.value === range)!
  const { from, to, from8w, from12w } = useMemo(() => {
    const end = new Date()
    end.setMinutes(0, 0, 0)
    end.setHours(end.getHours() + 1)
    const ago = (ms: number) => new Date(end.getTime() - ms).toISOString()
    return { from: ago(r.ms), to: end.toISOString(), from8w: ago(56 * 86_400_000), from12w: ago(84 * 86_400_000) }
  }, [r.ms])
  const daily = range === '24h' ? '1h' : '1d'

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }}>
      <Segmented
        options={[
          { value: 'env', label: 'Môi trường' },
          { value: 'security', label: 'An ninh' },
          { value: 'devices', label: 'Thiết bị' },
          { value: 'system', label: 'Hệ thống' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
      />
      <Segmented options={RANGES} value={range} onChange={(v) => setRange(v as Range)} />
      <Muted>
        {fmtDateTime(from)} → {fmtDateTime(to)} · số liệu tính ở backend (SQL)
      </Muted>
      {tab === 'env' && (
        <>
          <Panel
            title="Nhiệt độ"
            sub="Đường = trung bình · dải mờ = thấp – cao"
            block={blk('line', { metric: 'temp', from, to, interval: r.interval, agg: ['avg', 'min', 'max'] }, [{ label: 'Ngưỡng nóng', value: cfg.tempHigh }])}
          />
          <Panel
            title="Độ ẩm"
            block={blk('line', { metric: 'hum', from, to, interval: r.interval, agg: ['avg', 'min', 'max'] }, [{ label: 'Ngưỡng ẩm', value: cfg.humHigh }])}
          />
          <Panel
            title="Quạt & phun sương"
            sub="Đặt dưới biểu đồ nhiệt độ để thấy hiệu quả làm mát"
            block={{ ...blk('timeline', { metric: 'device_state', from, to }), query: { metric: 'device_state', from, to } }}
          />
          <Panel
            title="Khí / khói (MQ135)"
            block={blk('line', { metric: 'mq135', from, to, interval: r.interval, agg: ['avg', 'min', 'max'] }, [
              { label: 'Cảnh báo', value: cfg.mq135Warning },
              { label: 'Nguy hiểm', value: cfg.mq135Danger },
            ])}
          />
          <Panel title="Nhiệt độ theo giờ trong tuần" block={blk('heatmap', { metric: 'temp', from, to, group_by: 'hour_of_day,day_of_week' })} />
          <Panel title="Độ ẩm theo giờ trong tuần" block={blk('heatmap', { metric: 'hum', from, to, group_by: 'hour_of_day,day_of_week' })} />
          <Panel title="% thời gian vượt ngưỡng" block={blk('bar', { metric: 'threshold_exceeded_pct', from, to, interval: daily })} />
        </>
      )}
      {tab === 'security' && (
        <>
          <Panel
            title="Số lần chuyển động"
            sub="Trong giờ / ngoài giờ làm việc"
            block={blk('stacked_bar', { metric: 'motion_count', from, to, interval: daily, group_by: 'work_hours' })}
          />
          <Panel title="Chuyển động theo giờ trong tuần" block={blk('heatmap', { metric: 'motion_count', from, to, group_by: 'hour_of_day,day_of_week' })} />
        </>
      )}
      {tab === 'devices' && (
        <>
          <Segmented
            options={(['fan', 'mist', 'light'] as DeviceName[]).map((d) => ({ value: d, label: DEVICE_LABEL[d] }))}
            value={device}
            onChange={(v) => setDevice(v as DeviceName)}
          />
          <Panel
            title={`Thời gian ${DEVICE_LABEL[device].toLowerCase()} chạy theo lý do`}
            sub="phút"
            block={blk('stacked_bar', { metric: 'device_on_minutes', device, from, to, interval: daily, group_by: 'reason' })}
          />
          <Panel title="Trạng thái thiết bị" sub="Khoảng thời gian bật" block={blk('timeline', { metric: 'device_state', from, to })} />
          <Panel
            title="Ai ra lệnh nhiều nhất?"
            sub="Số lệnh theo nguồn"
            block={blk('bar', { metric: 'command_count', from, to, interval: daily, group_by: 'source' })}
          />
        </>
      )}
      {tab === 'system' && (
        <>
          <Panel title="Số cảnh báo theo loại" block={blk('stacked_bar', { metric: 'alert_count', from, to, interval: daily, group_by: 'type' })} />
          <Panel
            title="Tỉ lệ báo giả theo tuần"
            sub="% — từ phản hồi 👍/👎"
            block={blk('line', { metric: 'false_alarm_rate', from: from8w, to, interval: '1w' })}
          />
          <Panel title="Thời gian xử lý sự cố TB" sub="phút" block={blk('stat', { metric: 'incident_resolve_minutes', from, to })} />
          <Panel title="ESP32 trực tuyến" sub="% thời gian" block={blk('stat', { metric: 'device_online', from, to })} />
          <Panel title="Cường độ WiFi (RSSI)" sub="dBm" block={blk('line', { metric: 'rssi', from, to, interval: daily })} />
          <Panel
            title="Mức nền MQ135 theo tuần"
            sub="Tăng dần → cảm biến trôi, cần hiệu chuẩn lại"
            block={blk('line', { metric: 'mq135_baseline', from: from12w, to, interval: '1w' })}
          />
        </>
      )}
      <Text style={{ color: c.text3, fontSize: 11.5, textAlign: 'center' }}>Biểu đồ ở đây gọi thẳng API thống kê, không tốn chi phí AI.</Text>
    </ScrollView>
  )
}
