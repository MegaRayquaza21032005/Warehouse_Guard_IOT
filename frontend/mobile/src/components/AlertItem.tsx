import { Pressable, Text, View } from 'react-native'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import type { Alert } from '../../../shared/types'
import { LEVEL_LABEL, alertTypeLabel, fmtDateTime } from '../../../shared/labels'
import { useColors } from '../lib/theme'
import { Badge } from './ui'

export const levelTone = (l: Alert['level']) => (l === 'critical' ? 'crit' : l === 'warning' ? 'warn' : 'info') as 'crit' | 'warn' | 'info'

export function LevelIcon({ level, size = 18 }: { level: Alert['level']; size?: number }) {
  const c = useColors()
  const color = level === 'critical' ? c.crit : level === 'warning' ? c.warn : c.info
  const name = level === 'critical' ? 'alert-circle' : level === 'warning' ? 'warning' : 'information-circle'
  return <Ionicons name={name} size={size} color={color} />
}

export default function AlertItem({ a }: { a: Alert }) {
  const c = useColors()
  const unread = !a.acknowledgedAt
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/alert/${a.id}`)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: 10,
        padding: 12,
        borderRadius: 12,
        backgroundColor: unread ? c.surface : c.surface2,
        borderWidth: 1,
        borderColor: unread && a.level === 'critical' ? c.crit : c.border,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <LevelIcon level={a.level} />
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <Text style={{ color: c.text, fontWeight: '700', fontSize: 14 }}>{alertTypeLabel(a.type)}</Text>
          <Badge tone={levelTone(a.level)} label={LEVEL_LABEL[a.level]} />
          {a.source === 'agent' && <Badge tone="accent" label="AI" />}
          {unread && <Badge tone="crit" label="Chưa xem" />}
        </View>
        <Text style={{ color: c.text2, fontSize: 13.5 }} numberOfLines={3}>
          {a.message}
        </Text>
        <Text style={{ color: c.text3, fontSize: 12 }}>
          {fmtDateTime(a.ts)}
          {a.acknowledgedAt ? ` · đã xem${a.acknowledgedByName ? ` bởi ${a.acknowledgedByName}` : ''}` : ''}
          {a.feedback ? ` · ${a.feedback === 'false_alarm' ? 'báo giả' : 'đúng'}` : ''}
        </Text>
      </View>
    </Pressable>
  )
}
