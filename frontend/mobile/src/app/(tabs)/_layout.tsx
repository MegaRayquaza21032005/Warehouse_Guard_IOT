import { Tabs } from 'expo-router/tabs'
import type { ColorValue } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLive } from '../../lib/hooks'
import { useColors } from '../../lib/theme'

type IconName = keyof typeof Ionicons.glyphMap

export default function TabsLayout() {
  const c = useColors()
  const { alerts } = useLive()
  const unacked = alerts.filter((a) => !a.acknowledgedAt).length
  const icon = (name: IconName) =>
    function TabIcon({ color, size }: { color: ColorValue; size: number }) {
      return <Ionicons name={name} color={color as string} size={size} />
    }
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: c.surface },
        headerTintColor: c.text,
        headerTitleStyle: { fontWeight: '700' },
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.border },
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.text3,
        sceneStyle: { backgroundColor: c.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Tổng quan', tabBarIcon: icon('grid-outline') }} />
      <Tabs.Screen
        name="alerts"
        options={{ title: 'Cảnh báo', tabBarIcon: icon('notifications-outline'), tabBarBadge: unacked ? (unacked > 99 ? '99+' : unacked) : undefined }}
      />
      <Tabs.Screen name="chat" options={{ title: 'Trợ lý AI', tabBarIcon: icon('chatbubble-ellipses-outline') }} />
      <Tabs.Screen name="stats" options={{ title: 'Thống kê', tabBarIcon: icon('bar-chart-outline') }} />
      <Tabs.Screen name="more" options={{ title: 'Thêm', tabBarIcon: icon('menu-outline') }} />
    </Tabs>
  )
}
