/** Lưu trữ nhỏ: SecureStore trên điện thoại (token được mã hóa), localStorage khi chạy bản web. */
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'

const web = Platform.OS === 'web'

export const storage = {
  async get(key: string): Promise<string | null> {
    try {
      return web ? (globalThis.localStorage?.getItem(key) ?? null) : await SecureStore.getItemAsync(key)
    } catch {
      return null
    }
  },
  async set(key: string, value: string | null) {
    try {
      if (web) {
        if (value === null) globalThis.localStorage?.removeItem(key)
        else globalThis.localStorage?.setItem(key, value)
      } else if (value === null) await SecureStore.deleteItemAsync(key)
      else await SecureStore.setItemAsync(key, value)
    } catch {
      /* bỏ qua — chỉ mất phần ghi nhớ */
    }
  },
}
