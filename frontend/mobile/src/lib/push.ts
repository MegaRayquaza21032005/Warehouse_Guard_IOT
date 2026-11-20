/**
 * Push notification FCM (CLAUDE.md mục 3, PLAN giai đoạn 7): lấy token FCM của máy, đăng ký với Java BE;
 * bấm thông báo → mở đúng cảnh báo. Cần development build + google-services.json (Expo Go không nhận push).
 */
import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications'
import { pushApi } from './api'
import { storage } from './storage'

const TOKEN_KEY = 'warehouse.pushToken'

// App đang mở: vẫn hiện banner + âm thanh (cảnh báo an toàn không được im lặng)
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
})

export type PushState = { ok: true; message: string } | { ok: false; message: string }

/** Kênh Android phải tạo trước khi nhận push (id khớp `channel_id` backend gửi). */
async function ensureChannels() {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync('alerts-critical', {
    name: 'Cảnh báo nguy hiểm',
    importance: AndroidImportance.MAX,
    vibrationPattern: [0, 400, 200, 400, 200, 400],
    sound: 'default',
    bypassDnd: true,
    lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
  })
  await Notifications.setNotificationChannelAsync('alerts', {
    name: 'Cảnh báo & thông tin',
    importance: AndroidImportance.HIGH,
    sound: 'default',
  })
}

export async function registerForPush(): Promise<PushState> {
  if (Platform.OS === 'web') return { ok: false, message: 'Bản web không nhận push — dùng app trên điện thoại.' }
  if (!Device.isDevice) return { ok: false, message: 'Máy ảo không nhận được push FCM.' }
  if (Constants.executionEnvironment === 'storeClient') {
    return { ok: false, message: 'Expo Go không nhận push. Cần cài bản development build (xem README).' }
  }
  if (!(Constants.expoConfig?.extra as { fcm?: boolean } | undefined)?.fcm) {
    return { ok: false, message: 'Bản build chưa có google-services.json (Firebase) — chưa bật push.' }
  }
  try {
    await ensureChannels()
    let perm = await Notifications.getPermissionsAsync()
    if (!perm.granted) perm = await Notifications.requestPermissionsAsync()
    if (!perm.granted) return { ok: false, message: 'Bạn chưa cho phép thông báo. Bật lại trong Cài đặt của điện thoại.' }
    const token = await Notifications.getDevicePushTokenAsync()
    if (Platform.OS !== 'android') {
      // iOS trả token APNs, backend hiện gửi qua FCM → cần thêm Firebase iOS SDK (chưa làm)
      return { ok: false, message: 'Push trên iOS chưa hỗ trợ (backend gửi qua FCM Android).' }
    }
    await pushApi.register(String(token.data), Platform.OS)
    await storage.set(TOKEN_KEY, String(token.data))
    const st = await pushApi.status().catch(() => null)
    return st?.enabled === false
      ? { ok: false, message: 'Đã đăng ký máy, nhưng backend chưa cấu hình FCM_CREDENTIALS_FILE.' }
      : { ok: true, message: 'Đã bật thông báo cảnh báo trên máy này.' }
  } catch (e) {
    return { ok: false, message: `Không lấy được token push: ${(e as Error).message}` }
  }
}

/** Đăng xuất: máy này thôi nhận push của tài khoản. */
export async function unregisterPush() {
  const t = await storage.get(TOKEN_KEY)
  if (!t) return
  await pushApi.unregister(t).catch(() => undefined)
  await storage.set(TOKEN_KEY, null)
}

/** id cảnh báo trong dữ liệu của push (backend gửi `data.alertId`). */
export function alertIdOf(resp: Notifications.NotificationResponse | null): number | null {
  const v = (resp?.notification.request.content.data as Record<string, unknown> | undefined)?.alertId
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}
