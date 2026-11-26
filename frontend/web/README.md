# Web — Giám sát kho (React)

Vite + React 19 + TypeScript · Recharts · lucide-react · react-router. Nói chuyện **chỉ với Java BE** (CLAUDE.md mục 3): REST + WebSocket `/ws/live` + SSE cho chat.

## Chạy

Cần backend đang chạy (`backend/`, cổng 8080). Muốn dùng chatbot thì chạy thêm `ai-agent/`.

```bash
cd frontend/web
npm install
npm run dev        # http://localhost:5173 — /api và /ws được Vite chuyển tiếp sang http://localhost:8080
npm run build      # type-check + build ra dist/
npm run lint       # oxlint
```

- Backend ở máy khác khi dev: `VITE_BACKEND_URL=http://192.168.1.13:8080 npm run dev`.
- Build để chạy ở origin khác backend: `VITE_API_URL=http://<backend>:8080 npm run build`, và thêm origin của web vào `CORS_ALLOWED_ORIGINS` trong `.env`.
- Chưa có tài khoản thì bấm **Đăng ký** ngay trên màn hình đăng nhập.
- Chưa có ESP32 thì chạy giả lập: `conda run -n iot-agent python tools/simulate_esp32.py --plan normal:60,gas:40 --interval 2`. **Không chạy giả lập khi board thật đang online**: hai nguồn cùng ghi một topic sẽ làm lẫn số liệu, và khi tắt, giả lập sẽ phát `status/online = offline` đè lên trạng thái của board thật.

## Cấu trúc

| File | Vai trò |
|------|---------|
| `src/api/client.ts` | `fetch` + JWT, tự refresh khi gặp 401, chuẩn hóa lỗi `{"error","message"}` |
| `src/api/index.ts` | Các endpoint: auth, state, readings, stats, devices, config, alerts, memories, chat, voice |
| `src/lib/live.ts` | Store realtime: snapshot `GET /api/state` + WebSocket (tự kết nối lại, refresh token), bộ đệm 30 phút cho biểu đồ, cảnh báo mới nhất, **ack gần nhất của từng thiết bị** |
| `src/lib/sse.ts` | Đọc SSE của `/api/chat` bằng `fetch` + `ReadableStream` |
| `../shared/` | **Dùng chung với mobile**: `types.ts` (khớp MQTT contract + API), `labels.ts` (nhãn tiếng Việt), `config.ts` (ngưỡng mặc định, kiểm tra như firmware, giờ làm việc), `sse.ts` (parser) |

## Trang

| Đường dẫn | Nội dung |
|-----------|----------|
| `/` | Trạng thái an toàn, 4 cảm biến, điều khiển 3 thiết bị (chờ ESP32 `ack`), **lệnh hẹn giờ** từ trợ lý AI (`/api/schedules`: đếm ngược, Hủy lịch), biểu đồ 30 phút, cảnh báo gần đây |
| `/alerts` | Lọc theo mức / nguồn, "Đã xem", phản hồi đúng / báo giả (gửi tiếp sang memory của AI) |
| `/stats` | Biểu đồ theo danh mục CLAUDE.md mục 6, gọi thẳng `/api/stats` (không qua AI) |
| `/device-logs` | Nhật ký lệnh thiết bị mọi nguồn trong 30 ngày, tự nạp lại khi có thay đổi |
| `/chat` | Trợ lý AI: stream SSE, trạng thái worker, biểu đồ trong chat, [Đồng ý] / [Hủy] (kèm ghi chú lệnh nào chạy cùng lúc / hẹn giờ), lịch sử hội thoại, mic (Web Speech API, dự phòng ghi âm + STT server), đọc thành tiếng (giọng tiếng Việt của trình duyệt, dự phòng TTS server) |
| `/settings` | Ngưỡng ESP32 (kiểm tra như firmware, chờ ESP32 xác nhận qua `status/config`), memory cá nhân (xem / xóa), kiến thức chung về kho, giao diện, tự đọc câu trả lời |
