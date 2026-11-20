# Mobile — Giám sát kho (React Native / Expo)

Expo SDK 58 · Expo Router · react-native-svg (biểu đồ tự vẽ). Cùng chức năng với web, cộng thêm **push notification FCM** khi app đóng. Code dùng chung với web nằm ở `../shared/` (kiểu dữ liệu, nhãn tiếng Việt, kiểm tra cấu hình, parser SSE). Metro đọc thư mục này qua `metro.config.js`.

## Chạy nhanh

```bash
cd frontend/mobile
npm install
npx expo start            # quét QR bằng Expo Go (Android / iOS)
npx expo start --web      # chạy thử trên trình duyệt: http://localhost:8081
npm run typecheck && npm run lint
```

- **Địa chỉ backend** nhập ngay trên màn hình đăng nhập (lưu lại trên máy). Điện thoại thật phải dùng **IP LAN** của máy chạy Java BE, vd. `http://192.168.1.13:8080` (không dùng `localhost`). Mặc định lấy từ `EXPO_PUBLIC_API_URL`.
- Backend phải nghe trên mạng LAN (Spring Boot mặc định nghe mọi interface), tường lửa mở cổng 8080.
- Bản web của app gọi backend từ origin `http://localhost:8081`, đã có trong `CORS_ALLOWED_ORIGINS`.

## Expo Go và development build

| Tính năng | Expo Go | Development build |
|-----------|---------|-------------------|
| Dashboard, điều khiển, cảnh báo, thống kê, chat, xác nhận | ✅ | ✅ |
| Đọc thành tiếng (giọng của máy, dự phòng OpenAI TTS) | ✅ | ✅ |
| Mic: ghi âm rồi gửi OpenAI STT qua server | ✅ | ✅ |
| Mic: nhận dạng tiếng Việt trên máy (`expo-speech-recognition`) | ❌ (tự chuyển sang ghi âm + server) | ✅ |
| **Push notification FCM** | ❌ | ✅ (cần `google-services.json`) |

Tạo development build (Android):

```bash
npx eas-cli@latest build --profile development --platform android   # build trên cloud EAS, không cần Android Studio
# hoặc build trên máy (cần Android SDK): npx expo run:android
```

Không sửa tay thư mục `android/` hay `ios/`: chúng được sinh ra từ `app.config.ts` và các config plugin.

## Bật push notification (FCM)

1. Tạo project trên [Firebase console](https://console.firebase.google.com) → thêm app **Android** với package `com.warehouse.monitor`.
2. Tải `google-services.json` → đặt vào `frontend/mobile/google-services.json`. File này **không commit** (đã có trong `.gitignore`). Khi có file, `app.config.ts` tự bật FCM.
3. Firebase → Project settings → **Service accounts** → *Generate new private key*. Lưu file vào `secrets/firebase-service-account.json` ở thư mục gốc (đã `.gitignore`), rồi trong `.env` đặt `FCM_CREDENTIALS_FILE=../secrets/firebase-service-account.json` và khởi động lại Java BE. Log có dòng `[PUSH] Bật FCM`.
4. Build lại development build, đăng nhập. App tự xin quyền thông báo và đăng ký token (`POST /api/push/tokens`). Màn hình **Thêm → Thông báo đẩy** cho biết đã bật hay chưa.

Cách gửi (backend): `critical` và `warning` luôn push (Android priority HIGH; kênh `alerts-critical` cho mức nguy hiểm, kênh `alerts` cho các mức khác). `info` cũng push, trừ khi LLM đặt `details.push=false`. Push gửi cho **mọi** tài khoản đã đăng ký máy. Bấm vào thông báo sẽ mở đúng màn hình **Chi tiết cảnh báo** (`/alert/<id>`), kể cả khi app đang đóng. Đăng xuất sẽ hủy token của máy đó.

iOS: `getDevicePushTokenAsync` trả token APNs, còn backend hiện chỉ gửi qua FCM. Cần thêm Firebase iOS SDK; phần này chưa làm.

## Màn hình

| Route | Nội dung |
|-------|----------|
| `(tabs)/index` | Tổng quan: dải cảnh báo nguy hiểm chưa xem, trạng thái an toàn, 4 cảm biến, điều khiển 3 thiết bị (chờ ESP32 `ack`), biểu đồ 30 phút |
| `(tabs)/alerts` | Cảnh báo: lọc theo mức / chưa xem, đánh dấu đã xem hết, kéo để nạp lại |
| `alert/[id]` | Chi tiết cảnh báo (màn hình mở từ push): đã xem, phản hồi đúng / báo giả |
| `(tabs)/chat` | Trợ lý AI: SSE (`expo/fetch` đọc stream), biểu đồ trong chat, [Đồng ý] / [Hủy], lịch sử hội thoại, mic, đọc thành tiếng |
| `(tabs)/stats` | Thống kê theo danh mục CLAUDE.md mục 6 |
| `(tabs)/more` | Tài khoản, trạng thái push, tự đọc câu trả lời, memory cá nhân, đăng xuất |
| `device-logs`, `thresholds` | Nhật ký thiết bị; ngưỡng ESP32 (kiểm tra như firmware, chờ `status/config`) |

Token đăng nhập lưu bằng `expo-secure-store` (mã hóa trên máy). Khi app quay lại foreground, WebSocket tự kết nối lại và số liệu được nạp lại.
