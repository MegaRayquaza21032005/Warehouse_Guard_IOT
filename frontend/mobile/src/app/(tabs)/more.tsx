import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, Switch, Text, View } from 'react-native'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import type { MemoryItem } from '../../../../shared/types'
import { fmtDateTime } from '../../../../shared/labels'
import { fmtWorkHours } from '../../../../shared/config'
import { auth, errorText, getApiUrl, isAdmin, memoriesApi } from '../../lib/api'
import { setPushState, usePushState, useUser } from '../../lib/auth'
import { useLive } from '../../lib/hooks'
import { registerForPush, unregisterPush } from '../../lib/push'
import { useAutoRead } from '../../lib/settings'
import { useColors } from '../../lib/theme'
import { Badge, Button, Card, CardTitle, Empty, ErrorText, Muted } from '../../components/ui'

function Link({ icon, label, to }: { icon: keyof typeof Ionicons.glyphMap; label: string; to: '/device-logs' | '/thresholds' }) {
  const c = useColors()
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push(to)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }}>
      <Ionicons name={icon} size={20} color={c.accent} />
      <Text style={{ color: c.text, flex: 1, fontSize: 15 }}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color={c.text3} />
    </Pressable>
  )
}

export default function More() {
  const c = useColors()
  const user = useUser()
  const snap = useLive()
  const push = usePushState()
  const [autoRead, setAutoRead] = useAutoRead()
  const [mem, setMem] = useState<MemoryItem[] | null>(null)
  const [memErr, setMemErr] = useState('')
  const [busy, setBusy] = useState(false)

  const loadMem = useCallback(() => {
    memoriesApi
      .mine()
      .then((m) => {
        setMem(m)
        setMemErr('')
      })
      .catch((e) => {
        setMem([])
        setMemErr(errorText(e))
      })
  }, [])
  useEffect(loadMem, [loadMem])

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }}>
      <Card>
        <CardTitle title={user.fullName || user.username} sub={`@${user.username} · ${user.email}${isAdmin(user) ? ' · quản trị' : ''}`} />
        <Muted>Máy chủ: {getApiUrl()}</Muted>
        <Muted>
          ESP32: {snap.live.online?.data.status === 'online' ? 'trực tuyến' : snap.live.online ? 'mất kết nối' : 'chưa có dữ liệu'}
          {snap.live.device ? ` · ${snap.live.device.data.id} · RSSI ${snap.live.device.data.rssi} dBm` : ''}
        </Muted>
        <Muted>Giờ làm việc: {fmtWorkHours(snap.workHours)}</Muted>
      </Card>

      <Card>
        <CardTitle title="Quản lý" />
        <Link icon="list-outline" label="Nhật ký thiết bị (ai bật / tắt)" to="/device-logs" />
        <Link icon="options-outline" label="Ngưỡng & thông số ESP32" to="/thresholds" />
      </Card>

      <Card>
        <CardTitle title="Thông báo đẩy" sub="Nhận cảnh báo cả khi app đang đóng" />
        {push ? <Badge tone={push.ok ? 'ok' : 'warn'} label={push.ok ? 'Đang bật' : 'Chưa bật'} /> : <Muted>Đang kiểm tra…</Muted>}
        {push && <Text style={{ color: c.text2, fontSize: 13.5 }}>{push.message}</Text>}
        <Button
          small
          label="Đăng ký lại"
          busy={busy}
          onPress={async () => {
            setBusy(true)
            setPushState(await registerForPush())
            setBusy(false)
          }}
        />
      </Card>

      <Card>
        <CardTitle title="Giọng nói" />
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: c.text, flex: 1 }}>Tự đọc câu trả lời khi hỏi bằng giọng nói</Text>
          <Switch value={autoRead} onValueChange={setAutoRead} />
        </View>
      </Card>

      <Card>
        <CardTitle title="Trợ lý AI ghi nhớ về bạn" sub="Chỉ bạn thấy · xóa được bất cứ lúc nào" />
        {memErr ? <ErrorText text={memErr} /> : null}
        {mem === null ? (
          <Muted>Đang tải…</Muted>
        ) : mem.length === 0 ? (
          !memErr && <Empty text="Chưa có ghi nhớ nào." />
        ) : (
          mem.map((m) => (
            <View key={m.key} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', borderTopWidth: 1, borderTopColor: c.border, paddingTop: 8 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text }}>{m.text}</Text>
                {m.created_at ? <Muted>{fmtDateTime(m.created_at)}</Muted> : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Xóa ghi nhớ"
                onPress={async () => {
                  try {
                    await memoriesApi.deleteMine(m.key)
                    setMem((prev) => (prev ?? []).filter((x) => x.key !== m.key))
                  } catch (e) {
                    setMemErr(errorText(e))
                  }
                }}
                style={{ padding: 6 }}
              >
                <Ionicons name="trash-outline" size={18} color={c.text3} />
              </Pressable>
            </View>
          ))
        )}
      </Card>

      <Button
        label="Đăng xuất"
        kind="danger"
        onPress={async () => {
          await unregisterPush()
          await auth.logout()
        }}
      />
      <Muted style={{ textAlign: 'center' }}>Cảm biến phổ thông (MQ135, DHT11) — không thay thế hệ thống báo cháy đạt chuẩn.</Muted>
    </ScrollView>
  )
}
