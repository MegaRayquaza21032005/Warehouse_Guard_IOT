import { useMemo, useState } from 'react'
import { FlatList, RefreshControl, View } from 'react-native'
import type { AlertLevel } from '../../../../shared/types'
import { LEVEL_LABEL } from '../../../../shared/labels'
import { useLive } from '../../lib/hooks'
import { live, refresh } from '../../lib/live'
import { useColors } from '../../lib/theme'
import AlertItem from '../../components/AlertItem'
import { Button, Empty, Muted, Segmented } from '../../components/ui'

export default function Alerts() {
  const c = useColors()
  const { alerts, alertsLoaded, moreAlerts } = useLive()
  const [level, setLevel] = useState<AlertLevel | 'all'>('all')
  const [unackedOnly, setUnackedOnly] = useState<'all' | 'unacked'>('all')
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const rows = useMemo(
    () => alerts.filter((a) => (level === 'all' || a.level === level) && (unackedOnly === 'all' || !a.acknowledgedAt)),
    [alerts, level, unackedOnly],
  )
  const unacked = alerts.filter((a) => !a.acknowledgedAt).length

  return (
    <FlatList
      data={rows}
      keyExtractor={(a) => String(a.id)}
      contentContainerStyle={{ padding: 14, gap: 10 }}
      style={{ backgroundColor: c.bg }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true)
            await refresh()
            setRefreshing(false)
          }}
        />
      }
      ListHeaderComponent={
        <View style={{ gap: 10 }}>
          <Segmented
            options={[{ value: 'all', label: 'Tất cả' }, ...(['critical', 'warning', 'info'] as const).map((l) => ({ value: l, label: LEVEL_LABEL[l] }))]}
            value={level}
            onChange={(v) => setLevel(v as AlertLevel | 'all')}
          />
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Segmented
                options={[
                  { value: 'all', label: 'Mọi trạng thái' },
                  { value: 'unacked', label: `Chưa xem (${unacked})` },
                ]}
                value={unackedOnly}
                onChange={(v) => setUnackedOnly(v as 'all' | 'unacked')}
              />
            </View>
            <Button small label="Đã xem hết" disabled={!unacked} onPress={() => void live.ackAll()} />
          </View>
          <Muted>Cảnh báo nguy hiểm không ai bấm “Đã xem” sau 5 phút sẽ gửi lại cho tất cả người dùng.</Muted>
        </View>
      }
      ListEmptyComponent={<Empty text={alertsLoaded ? 'Không có cảnh báo.' : 'Đang tải…'} />}
      renderItem={({ item }) => <AlertItem a={item} />}
      ListFooterComponent={
        moreAlerts ? (
          <Button
            label="Tải cảnh báo cũ hơn"
            busy={loadingMore}
            onPress={async () => {
              setLoadingMore(true)
              await live.loadMoreAlerts().catch(() => undefined)
              setLoadingMore(false)
            }}
          />
        ) : undefined
      }
    />
  )
}
