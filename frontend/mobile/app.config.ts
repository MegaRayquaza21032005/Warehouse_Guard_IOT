/// <reference types="node" />
import fs from 'node:fs'
import type { ExpoConfig } from 'expo/config'

/**
 * Cấu hình app (thay app.json để bật FCM có điều kiện).
 * - Push FCM cần `google-services.json` (tải từ Firebase console, KHÔNG commit) đặt cạnh file này.
 * - Địa chỉ Java BE mặc định: biến môi trường EXPO_PUBLIC_API_URL; đổi được ngay trên màn hình đăng nhập.
 */
const hasFcm = fs.existsSync('./google-services.json')

const config: ExpoConfig = {
  name: 'Giám sát kho',
  slug: 'warehouse-monitor',
  scheme: 'warehouse',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.warehouse.monitor',
  },
  android: {
    package: 'com.warehouse.monitor',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    // Backend dev chạy http trong mạng LAN
    usesCleartextTraffic: true,
    ...(hasFcm ? { googleServicesFile: './google-services.json' } : {}),
  } as ExpoConfig['android'],
  web: {
    favicon: './assets/favicon.png',
    output: 'single',
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    ['expo-audio', { microphonePermission: 'Cho phép dùng micro để ra lệnh bằng giọng nói cho trợ lý kho.' }],
    'expo-font',
    [
      'expo-speech-recognition',
      {
        microphonePermission: 'Cho phép dùng micro để ra lệnh bằng giọng nói cho trợ lý kho.',
        speechRecognitionPermission: 'Cho phép nhận dạng giọng nói để chuyển lời nói thành tin nhắn.',
      },
    ],
    ['expo-notifications', { color: '#2563EB', defaultChannel: 'alerts-critical' }],
  ],
  experiments: { typedRoutes: false },
  extra: { fcm: hasFcm },
}

export default config
