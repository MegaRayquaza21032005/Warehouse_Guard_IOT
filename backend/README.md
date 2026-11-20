# Backend — Java Spring Boot

Cửa ngõ duy nhất cho web / app: đăng nhập, lưu dữ liệu MQTT vào PostgreSQL, điều khiển thiết bị, thống kê, realtime qua WebSocket. Thiết kế tổng thể: [../CLAUDE.md](../CLAUDE.md).

**Công nghệ:** Java 21, Spring Boot 4.1 (Spring Security 7, Jackson 3, Hibernate 7), PostgreSQL 16 (schema `app`, Flyway), Eclipse Paho MQTT, JWT HS256.

## Chạy

```bash
docker compose up -d                 # ở thư mục gốc: PostgreSQL + Mosquitto + pgAdmin
cd backend
mvn spring-boot:run                  # hoặc: mvn package -DskipTests && java -jar target/backend-0.0.1-SNAPSHOT.jar
```

- Cấu hình đọc từ `../.env` (phải chạy trong thư mục `backend/`): `POSTGRES_*`, `MQTT_BACKEND_*`, `JWT_SECRET`, `JWT_ACCESS_TTL_MIN`, `JWT_REFRESH_TTL_DAYS`, `INTERNAL_API_KEY`, `WORK_HOURS_*`, `WORK_DAYS`, `CORS_ALLOWED_ORIGINS`, `BACKEND_PORT` (8080), `AGENT_PORT` / `AGENT_URL` (AI Agent, mặc định `http://localhost:8000`).
- Migration Flyway tự chạy khi khởi động (`src/main/resources/db/migration`).
- Broker chưa chạy → app vẫn khởi động, tự kết nối lại mỗi 5 giây.

## Test

```bash
mvn test        # cần Docker: Testcontainers tự dựng PostgreSQL riêng, MQTT được giả lập
```

Test đầu cuối không cần ESP32: chạy backend rồi `conda run -n iot-agent python tools/simulate_esp32.py --plan normal:20,gas:20,fire:30 --interval 2` (ở thư mục gốc).

## Xác thực

| Cách | Dùng cho | Header |
|------|----------|--------|
| JWT access token (60 phút) | Web / app | `Authorization: Bearer <accessToken>` |
| Khóa nội bộ | AI Agent | `X-Internal-Key: <INTERNAL_API_KEY>` — đọc được mọi API, **không** gọi được API cần người dùng (điều khiển, ack...) |

Refresh token (30 ngày) xoay vòng: mỗi lần `/refresh` trả cặp token mới, token cũ hết hiệu lực.

## API

Lỗi luôn có dạng `{"error": "<mã>", "message": "...", "details": {...}}`. Thời gian: ISO-8601 UTC (`2026-01-05T03:00:00Z`) — nếu gửi `+07:00` trong query phải mã hóa `+` thành `%2B`.

### Đăng ký / đăng nhập — `/api/auth` (không cần token, trừ `/me`)

| Method | Path | Body | Trả về |
|--------|------|------|--------|
| POST | `/register` | `{"username","email","password","fullName"?}` | 201 `AuthResponse` · 409 `username_taken` / `email_taken` · 400 `validation_failed` |
| POST | `/login` | `{"login": "<username hoặc email>", "password"}` | 200 `AuthResponse` · 401 `invalid_credentials` |
| POST | `/refresh` | `{"refreshToken"}` | 200 `AuthResponse` · 401 `invalid_refresh_token` |
| POST | `/logout` | `{"refreshToken"}` | 204 |
| GET | `/me` | — | `{"id","username","email","fullName","role","createdAt"}` |

`AuthResponse`: `{"accessToken","refreshToken","tokenType":"Bearer","expiresIn":3600,"user":{...}}`. Username: 3–50 ký tự `[a-zA-Z0-9_.]`, lưu chữ thường; mật khẩu 6–100 ký tự (BCrypt).

### Trạng thái & dữ liệu

| Method | Path | Ghi chú |
|--------|------|---------|
| GET | `/api/state` | Snapshot hiện tại: `online`, `device`, `safety`, `sensors{mq2,dht11,pir}`, `devices{fan,mist,light}`, `config`, `brokerConnected`. Mỗi mục `{"data": <payload MQTT>, "updatedAt"}` |
| GET | `/api/readings/{kind}?from&to&limit&device` | Dữ liệu thô, mới nhất trước. `kind`: `mq2`, `climate`, `motion`, `safety`, `health`, `device-states`. Mặc định 1 giờ gần nhất, tối đa 5000 dòng |

### Thiết bị

| Method | Path | Ghi chú |
|--------|------|---------|
| GET | `/api/devices` | Trạng thái quạt / phun sương / đèn |
| POST | `/api/devices/{fan\|mist\|light}/command` | Body `{"state":"on"}`, `{"state":"off","durationS":600}` hoặc `{"mode":"auto"}`. 202 `{"traceId",...}`. ESP32 xác nhận qua WebSocket `status.*` có `ack.trace_id`. 503 `mqtt_unavailable` nếu broker mất |
| GET | `/api/device-logs?device&source&from&to&page&size` | Nhật ký lệnh **mọi nguồn** (`esp32_local`, `rule`, `agent`, `user`), kèm `result` ESP32 xác nhận. Mặc định 7 ngày |
| GET | `/api/config` | Ngưỡng ESP32 đang dùng (chưa có → mặc định firmware) |
| PUT | `/api/config` | Chỉ gửi trường muốn đổi, vd. `{"mq2Warning":1700}`. Kiểm tra giống firmware; 202 → ESP32 xác nhận qua `status/config` |

### Cảnh báo

| Method | Path | Ghi chú |
|--------|------|---------|
| GET | `/api/alerts?level&unacked&page&size` | Mới nhất trước |
| GET | `/api/alerts/{id}` | |
| POST | `/api/alerts/{id}/ack` | "Đã xem" (dừng leo thang) |
| POST | `/api/alerts/{id}/feedback` | `{"feedback":"true_alarm\|false_alarm","note"?}` |

### Thống kê — `/api/stats`

`GET /api/stats?metric=&from=&to=&interval=&agg=&group_by=&device=` → `{"metric","interval","from","to","groupBy","series":[{"name","points":[{"t","v"}]}],"cells":[{"dayOfWeek","hour","v"}]}`

| `metric` | `agg` | `group_by` | Ghi chú |
|----------|-------|------------|---------|
| `temp`, `hum`, `mq2` | `avg,min,max` | — hoặc `hour_of_day,day_of_week` (heatmap → `cells`) | MQ2 bỏ qua lúc làm nóng |
| `motion_count` | — | — / `work_hours` / `hour_of_day,day_of_week` | `work_hours` → series `work_hours`, `after_hours` theo `WORK_*` |
| `threshold_exceeded_pct` | — | — | Series `temp`, `hum`: % thời gian vượt `tempHigh` / `humHigh` |
| `device_on_minutes` | — | — / `reason` | Cần `device`; chia chính xác theo bucket |
| `command_count` | — | — / `source` | `device` tùy chọn |

- `interval`: `5m`, `1h` (mặc định), `1d`, `1w`; tối đa 2000 điểm. Bucket ngày / tuần bắt đầu 00:00 / thứ Hai giờ Việt Nam.
- Mặc định 24 giờ gần nhất. `dayOfWeek`: 1 = thứ Hai … 7 = Chủ nhật.

`GET /api/stats/timeline?device=fan&from&to` → `[{"start","end","state","reason","source"}]` (biểu đồ `timeline`).

### Chatbot, giọng nói, nhật ký agent — trung gian tới AI Agent

Java BE gắn `user_id` (và `username`) **lấy từ JWT** rồi gọi ai-agent bằng `X-Internal-Key`. Khóa nội bộ không dùng được các API này (403). AI Agent chưa chạy → 503 `agent_unavailable` (cảnh báo và nút điều khiển vẫn hoạt động).

| Method | Path | Ghi chú |
|--------|------|---------|
| POST | `/api/chat` | Body `{"message", "threadId"?, "inputMode": "text"\|"voice"}` (message 1–2000 ký tự; không có `threadId` = hội thoại mới). Trả **`text/event-stream`** chuyển tiếp nguyên văn từ agent |
| POST | `/api/chat/{threadId}/confirm` | Body `{"approved": true\|false}` — bấm [Đồng ý] / [Hủy]. Trả SSE |
| GET | `/api/chat/threads?limit` | Hội thoại của tôi |
| GET | `/api/chat/threads/{threadId}` | `{thread, messages, pending}`; `pending` ≠ null → hiện lại nút xác nhận |
| DELETE | `/api/chat/threads/{threadId}` | 204 |
| POST | `/api/voice/stt` | multipart `file` (≤ 10 MB) → `{"text"}`. Chỉ dùng khi thiết bị không tự nhận dạng được; không lưu âm thanh |
| POST | `/api/voice/tts` | `{"text"}` (≤ 4000 ký tự) → `audio/mpeg` |
| GET | `/api/agent/tool-calls?traceId&threadId&agent&tool&status&flow&from&to&page&size` | Nhật ký tool call. `ADMIN` xem tất cả (+ `userId`); người dùng thường chỉ thấy của mình + luồng sự cố |

### Long-term memory — `/api/memories` (trung gian tới AI Agent)

| Method | Path | Ghi chú |
|--------|------|---------|
| GET | `/api/memories?limit` | Memory **cá nhân** của tôi (`key`, `text`, `kind`, `source`, `created_at`) |
| DELETE | `/api/memories/{key}` | Xóa memory cá nhân của tôi. 204 · 404 `memory_not_found` |
| GET | `/api/memories/warehouse?kind=facts\|incidents\|feedback&page&size` | Memory dùng chung (ai cũng xem) |
| DELETE | `/api/memories/warehouse/{key}` | Xóa kiến thức kho — người tạo hoặc `ADMIN`; khác → 403 `not_owner` |

`POST /api/alerts/{id}/feedback` ngoài lưu ở Java BE còn **chạy nền** gửi sang memory `warehouse/feedback` của agent (lỗi không ảnh hưởng kết quả).

Lỗi từ agent giữ nguyên mã: 404 `thread_not_found`, 409 `confirmation_pending` / `thread_busy` / `no_pending_confirmation`, 429 `rate_limited`, 503 `llm_disabled`.

**Sự kiện SSE:** `meta` → (`status` | `token` | `discard`)* → `confirmation` **hoặc** `done` **hoặc** `error`; sau `/confirm`: `meta` → `result` → … → `done`. Chi tiết `data` của từng sự kiện: [../ai-agent/README.md](../ai-agent/README.md#api-nội-bộ-chỉ-java-be-gọi-header-x-internal-key). Đọc stream bằng `fetch` + `ReadableStream` (EventSource không gửi được POST / header `Authorization`).

```bash
curl -N -X POST localhost:8080/api/chat -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"message":"Kho đang thế nào?"}'
```

### Realtime — WebSocket

`ws://<host>:8080/ws/live?token=<accessToken>` (sai / thiếu token → 401).

1. Ngay khi kết nối: `{"type":"snapshot","data":<giống GET /api/state>,"ts"}`.
2. Mỗi bản tin MQTT: `{"type":"sensor.mq2","topic":"warehouse/sensor/mq2","data":{...},"ts"}`. `type` = topic bỏ `warehouse/`, `/` → `.`: `sensor.mq2|dht11|pir`, `status.safety|online|device|config|fan|mist|light`, `alert` (data là cảnh báo đã lưu, có `id`).

Token hết hạn không tự ngắt WebSocket đang mở; client nên kết nối lại với token mới sau khi refresh.

## Database (schema `app`)

`users`, `refresh_tokens` (SHA-256), `mq2_readings`, `climate_readings`, `motion_events`, `safety_events` (chỉ ghi khi đổi), `device_states` (chỉ ghi khi đổi), `device_health`, `device_config` (1 dòng), `device_command_logs`, `alerts`. Bản tin retained gửi lại khi kết nối lại broker không tạo dòng trùng.
