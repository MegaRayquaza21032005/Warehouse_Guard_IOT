import { useCallback, useEffect, useState } from 'react'
import { FlatList, RefreshControl, Text, View } from 'react-native'
import type { CommandSource, DeviceLog, DeviceName } from '../../../shared/types'
import { DEVICE_LABEL, SOURCE_LABEL, fmtDateTime, reasonLabel } from '../../../shared/labels'
import { devices, errorText } from '../lib/api'
import { onLiveMessage } from '../lib/live'
import { useColors } from '../lib/theme'
import { Badge, Button, Empty, ErrorText, Segmented } from '../components/ui'

const PAGE = 50
const CMD: Record<string, string> = { on: 'BẬT', off: 'TẮT', auto: 'Tự động' }

function resultOf(l: DeviceLog): { label: string; tone: 'ok' | 'warn' | 'crit' | 'neutral' } {
  if (l.source === 'esp32_local') return { label: 'ESP32 tự quyết', tone: 'neutral' }
  if (l.result === 'applied') return { label: 'Đã áp dụng', tone: 'ok' }
  if (l.result === 'ignored_user_priority') return { label: 'Bỏ qua (ưu tiên user)', tone: 'warn' }
  if (l.result === 'publish_failed') return { label: 'Không gửi được', tone: 'crit' }
  if (l.result) return { label: 'Lệnh sai', tone: 'crit' }
  return Date.now() - new Date(l.ts).getTime() < 10_000 ? { label: 'Đang chờ', tone: 'neutral' } : { label: 'Không phản hồi', tone: 'crit' }
}

/** Ai / cái gì đã bật, tắt thiết bị — mọi nguồn (CLAUDE.md mục 8). */
export default function DeviceLogs() {
  const c = useColors()
  const [device, setDevice] = useState<DeviceName | 'all'>('all')
  const [source, setSource] = useState<CommandSource | 'all'>('all')
  const [rows, setRows] = useState<DeviceLog[]>([])
  const [pages, setPages] = useState(1)
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(
    async (n: number) => {
      try {
        const from = new Date(Date.now() - 30 * 86_400_000).toISOString()
        const q = { device: device === 'all' ? undefined : device, source: source === 'all' ? undefined : source, from }
        const all = await Promise.all(Array.from({ length: n }, (_, p) => devices.logs({ ...q, page: p, size: PAGE })))
        setRows(all.flat())
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

  // đổi bộ lọc → nạp lại từ server (đồng bộ với hệ thống ngoài, setState chỉ chạy sau khi có dữ liệu)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(1)
  }, [load])

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const off = onLiveMessage((type) => {
      if (!/^status\.(fan|mist|light)$/.test(type)) return
      if (t) clearTimeout(t)
      t = setTimeout(() => void load(pages), 1000)
    })
    return () => {
      off()
      if (t) clearTimeout(t)
    }
  }, [load, pages])

  return (
    <FlatList
      data={rows}
      keyExtractor={(l) => String(l.id)}
      contentContainerStyle={{ padding: 14, gap: 8 }}
      refreshControl={
        <RefreshControl
          refreshing={loading}
          onRefresh={() => {
            setLoading(true)
            void load(pages)
          }}
        />
      }
      ListHeaderComponent={
        <View style={{ gap: 8, marginBottom: 4 }}>
          <Segmented
            options={[
              { value: 'all', label: 'Mọi thiết bị' },
              ...(['fan', 'mist', 'light'] as DeviceName[]).map((d) => ({ value: d, label: DEVICE_LABEL[d] })),
            ]}
            value={device}
            onChange={(v) => {
              setPages(1)
              setDevice(v as DeviceName | 'all')
            }}
          />
          <Segmented
            options={[
              { value: 'all', label: 'Mọi nguồn' },
              { value: 'user', label: 'Người' },
              { value: 'esp32_local', label: 'ESP32' },
              { value: 'rule', label: 'Luật' },
              { value: 'agent', label: 'AI' },
            ]}
            value={source}
            onChange={(v) => {
              setPages(1)
              setSource(v as CommandSource | 'all')
            }}
          />
          {error ? <ErrorText text={error} /> : null}
        </View>
      }
      ListEmptyComponent={loading ? undefined : <Empty text="Không có bản ghi trong 30 ngày." />}
      renderItem={({ item: l }) => {
        const r = resultOf(l)
        return (
          <View style={{ backgroundColor: c.surface, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: c.border, gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text style={{ color: c.text, fontWeight: '700' }}>
                {DEVICE_LABEL[l.device]} · {CMD[l.action] ?? l.action}
                {l.durationS ? ` · ${Math.round(l.durationS / 60)} phút` : ''}
              </Text>
              <Badge tone={r.tone} label={r.label} />
            </View>
            <Text style={{ color: c.text2, fontSize: 13 }}>
              {SOURCE_LABEL[l.source] ?? l.source}
              {l.username ? ` · ${l.username}` : ''}
              {l.reason ? ` · ${reasonLabel(l.reason)}` : ''}
            </Text>
            <Text style={{ color: c.text3, fontSize: 12 }}>
              {fmtDateTime(l.ts)}
              {l.traceId ? ` · ${l.traceId}` : ''}
            </Text>
          </View>
        )
      }}
      ListFooterComponent={
        more ? (
          <Button
            label="Xem thêm"
            busy={loading}
            onPress={() => {
              setLoading(true)
              setPages(pages + 1)
              void load(pages + 1)
            }}
          />
        ) : undefined
      }
    />
  )
}
