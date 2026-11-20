import { useEffect, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import type { Alert } from '../../../../shared/types'
import { LEVEL_LABEL, alertTypeLabel, fmtDateTime } from '../../../../shared/labels'
import { alertsApi, errorText } from '../../lib/api'
import { useLive } from '../../lib/hooks'
import { live } from '../../lib/live'
import { useColors } from '../../lib/theme'
import { LevelIcon, levelTone } from '../../components/AlertItem'
import { Badge, Button, Card, ErrorText, Muted } from '../../components/ui'

const DETAIL_LABEL: Record<string, string> = {
  temp: 'Nhiệt độ (°C)',
  hum: 'Độ ẩm (%)',
  mq2: 'MQ2',
  safety: 'Trạng thái an toàn',
  duration_min: 'Thời gian (phút)',
  motion: 'Chuyển động',
  device: 'Thiết bị',
}

/** Chi tiết một cảnh báo — màn hình mở ra khi bấm push notification. */
export default function AlertDetail() {
  const c = useColors()
  const { id } = useLocalSearchParams<{ id: string }>()
  const alertId = Number(id)
  const cached = useLive().alerts.find((a) => a.id === alertId)
  const [fetched, setFetched] = useState<Alert | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const a = cached ?? fetched

  useEffect(() => {
    if (!cached && alertId)
      alertsApi
        .get(alertId)
        .then(setFetched)
        .catch((e) => setError(errorText(e)))
  }, [alertId, cached])

  const act = async (kind: string, fn: () => Promise<Alert>) => {
    setBusy(kind)
    setError('')
    try {
      const updated = await fn()
      setFetched(updated)
      live.replaceAlert(updated)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  if (!a) return <View style={{ padding: 16 }}>{error ? <ErrorText text={error} /> : <Muted>Đang tải…</Muted>}</View>

  const details = Object.entries(a.details ?? {}).filter(([k, v]) => k !== 'push' && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'))

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }}>
      <Card>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <LevelIcon level={a.level} size={28} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.text, fontSize: 18, fontWeight: '800' }}>{alertTypeLabel(a.type)}</Text>
            <Muted>{fmtDateTime(a.ts)}</Muted>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Badge tone={levelTone(a.level)} label={LEVEL_LABEL[a.level]} />
          <Badge tone={a.source === 'agent' ? 'accent' : 'neutral'} label={a.source === 'agent' ? 'AI phân tích' : 'Tầng luật'} />
          {a.acknowledgedAt ? (
            <Badge tone="ok" label={`Đã xem${a.acknowledgedByName ? ` · ${a.acknowledgedByName}` : ''}`} />
          ) : (
            <Badge tone="crit" label="Chưa ai xem" />
          )}
        </View>
        <Text style={{ color: c.text, fontSize: 15.5, lineHeight: 22 }}>{a.message}</Text>
        {details.length > 0 && (
          <View style={{ gap: 4, backgroundColor: c.surface2, borderRadius: 10, padding: 10 }}>
            {details.map(([k, v]) => (
              <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Muted>{DETAIL_LABEL[k] ?? k}</Muted>
                <Text style={{ color: c.text, fontSize: 13, fontWeight: '600' }}>{String(v)}</Text>
              </View>
            ))}
          </View>
        )}
        {a.incidentId && <Muted>Sự cố: {a.incidentId}</Muted>}
        {error ? <ErrorText text={error} /> : null}
        {!a.acknowledgedAt && <Button label="Đã xem" kind="primary" busy={busy === 'ack'} onPress={() => void act('ack', () => alertsApi.ack(a.id))} />}
      </Card>
      {a.level !== 'info' && (
        <Card>
          <Text style={{ color: c.text, fontWeight: '700' }}>Cảnh báo này có đúng không?</Text>
          <Muted>Phản hồi giúp trợ lý AI giảm báo giả — không làm tắt cảnh báo nguy hiểm.</Muted>
          {a.feedback ? (
            <Badge
              tone={a.feedback === 'true_alarm' ? 'ok' : 'neutral'}
              label={a.feedback === 'true_alarm' ? 'Bạn đã xác nhận: đúng' : 'Bạn đã đánh dấu: báo giả'}
            />
          ) : (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button
                style={{ flex: 1 }}
                label="👍 Đúng"
                busy={busy === 'true'}
                onPress={() => void act('true', () => alertsApi.feedback(a.id, 'true_alarm'))}
              />
              <Button
                style={{ flex: 1 }}
                label="👎 Báo giả"
                busy={busy === 'false'}
                onPress={() => void act('false', () => alertsApi.feedback(a.id, 'false_alarm'))}
              />
            </View>
          )}
        </Card>
      )}
    </ScrollView>
  )
}
