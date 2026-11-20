import { useEffect, useState } from 'react'
import { ActivityIndicator, AppState, View } from 'react-native'
import { Stack, router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as Notifications from 'expo-notifications'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { loadSession, onSessionChange, type User } from '../lib/api'
import { live } from '../lib/live'
import { alertIdOf, registerForPush } from '../lib/push'
import { useColors } from '../lib/theme'
import { AuthContext, setPushState } from '../lib/auth'
import Login from '../components/Login'

export default function RootLayout() {
  const c = useColors()
  const [user, setUser] = useState<User | null | undefined>(undefined)

  useEffect(() => {
    void loadSession().then((s) => setUser(s?.user ?? null))
    return onSessionChange((s) => setUser(s?.user ?? null))
  }, [])

  // Đăng nhập xong: realtime + đăng ký push; app quay lại foreground → kết nối lại
  useEffect(() => {
    if (!user) return
    void live.start()
    void registerForPush().then(setPushState)
    const tick = setInterval(() => live.tick(), 30_000)
    const sub = AppState.addEventListener('change', (s) => s === 'active' && live.resume())
    return () => {
      clearInterval(tick)
      sub.remove()
      live.stop()
    }
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Bấm thông báo push → mở đúng cảnh báo (kể cả khi app đang đóng)
  useEffect(() => {
    if (!user) return
    const open = (resp: Notifications.NotificationResponse | null) => {
      const id = alertIdOf(resp)
      if (id) router.push(`/alert/${id}`)
    }
    void Notifications.getLastNotificationResponseAsync()
      .then((r) => {
        open(r)
        if (r) void Notifications.clearLastNotificationResponseAsync()
      })
      .catch(() => undefined)
    const sub = Notifications.addNotificationResponseReceivedListener(open)
    return () => sub.remove()
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (user === undefined) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}>
        <ActivityIndicator color={c.accent} />
      </View>
    )
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {!user ? (
        <Login />
      ) : (
        <AuthContext.Provider value={user}>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: c.surface },
              headerTintColor: c.text,
              headerTitleStyle: { fontWeight: '700' },
              contentStyle: { backgroundColor: c.bg },
              headerBackTitle: 'Quay lại',
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="alert/[id]" options={{ title: 'Chi tiết cảnh báo' }} />
            <Stack.Screen name="device-logs" options={{ title: 'Nhật ký thiết bị' }} />
            <Stack.Screen name="thresholds" options={{ title: 'Ngưỡng ESP32' }} />
          </Stack>
        </AuthContext.Provider>
      )}
    </SafeAreaProvider>
  )
}
