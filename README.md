# Warehouse Guard IoT — Hệ thống giám sát an toàn kho

Hệ thống IoT giám sát kho hàng theo thời gian thực: phát hiện **khí / khói, cháy, nóng ẩm bất thường và đột nhập ngoài giờ**, tự động điều khiển quạt, phun sương, đèn, gửi cảnh báo tới web và điện thoại (push FCM), kèm **trợ lý AI** (chat bằng chữ hoặc giọng nói tiếng Việt) để hỏi số liệu, xem thống kê và ra lệnh thiết bị có xác nhận.

| Thành phần | Thư mục | Công nghệ | Tài liệu chi tiết |
|------------|---------|-----------|-------------------|
| Firmware ESP32 | [firmware/](firmware/) | Arduino C++, PubSubClient, DHT, ArduinoJson v7 | Mục [Firmware](#firmware-esp32) bên dưới |
| Backend | [backend/](backend/) | Java 21, Spring Boot 4.1, PostgreSQL 16 + Flyway, Paho MQTT, JWT | [backend/README.md](backend/README.md) |
| AI Agent | [ai-agent/](ai-agent/) | Python 3.12, FastAPI, LangGraph, OpenAI, pgvector, Langfuse | [ai-agent/README.md](ai-agent/README.md) |
| Web | [frontend/web/](frontend/web/) | React 19, Vite, TypeScript, Recharts | [frontend/web/README.md](frontend/web/README.md) |
| Mobile | [frontend/mobile/](frontend/mobile/) | Expo (React Native), Expo Router, FCM | [frontend/mobile/README.md](frontend/mobile/README.md) |
| Code dùng chung web / mobile | [frontend/shared/](frontend/shared/) | TypeScript | Kiểu dữ liệu, nhãn tiếng Việt, kiểm tra cấu hình, parser SSE |
| Hạ tầng | [docker-compose.yml](docker-compose.yml) | PostgreSQL (pgvector), Mosquitto 2.0, pgAdmin | Mục [Cài đặt](#cài-đặt-và-chạy) |
| Công cụ dev | [tools/](tools/) | Bash, Python | Mục [Công cụ](#công-cụ-dev) |

---

## Kiến trúc

```
                         ┌──────────────────────────── MQTT (Mosquitto :1883) ────────────────────────────┐
                         │                                                                                │
┌───────────────┐  sensor/*, status/*        ┌──────────────────────┐   REST (X-Internal-Key)   ┌─────────────────────┐
│ ESP32         │ ─────────────────────────► │ Backend (Java)       │ ◄──────────────────────── │ AI Agent (Python)   │
│ MQ135, DHT11, │ ◄───────────────────────── │ :8080                │ ────────────────────────► │ 127.0.0.1:8000      │
│ PIR, 3 relay  │  cmd/fan|mist|light|config │ lưu DB, API, WS, FCM │   chat / voice / memory   │ tầng luật + LLM     │
└───────────────┘                            └──────────┬───────────┘                           └──────────┬──────────┘
        ▲  cmd/* (rule / agent)                         │ REST + WebSocket + SSE                            │
        └───────────────────────────────────────────────┼───────────────────────────────────── alert, cmd/*┘
                                                        ▼
                                         ┌─────────────────────────────┐
                                         │ Web (React) · Mobile (Expo) │
                                         └─────────────────────────────┘
                     PostgreSQL: schema "app" (backend)  ·  schema "agent" (AI Agent, pgvector)
```

**Nguyên tắc thiết kế**

1. **ESP32 tự bảo vệ kho khi mất mạng.** Logic an toàn (khí, cháy, quạt, phun sương, đèn) chạy ngay trên board; server chỉ bổ sung cảnh báo, thống kê và AI.
2. **Mỗi service có tài khoản riêng**, cả ở MQTT lẫn PostgreSQL. Backend sở hữu schema `app`, AI Agent sở hữu schema `agent`; hai bên không đọc được schema của nhau và trao đổi qua REST.
3. **Web / mobile chỉ nói chuyện với Backend** (REST, WebSocket `/ws/live`, SSE cho chat). AI Agent chỉ nghe trên `127.0.0.1`, Backend làm trung gian và gắn `user_id` lấy từ JWT.
4. **Cảnh báo không phụ thuộc LLM.** Tầng luật của AI Agent là code thuần: OpenAI lỗi, chậm hoặc thiếu key thì cảnh báo vẫn được gửi (bản cơ bản). Cảnh báo `critical` không bao giờ bị chặn hay hạ mức.
5. **Mọi lệnh ghi từ AI phải được người dùng bấm [Đồng ý]**, qua Safety Guard kiểm tra hai lần (lúc tạo đề xuất và ngay trước khi gửi MQTT), và được ghi nhật ký.
6. **Thứ tự ưu tiên lệnh thiết bị** trên ESP32: an toàn (cháy / khí nguy hiểm) > người dùng (`user`) > tầng luật (`rule`) / AI (`agent`) > tự động.

### Luồng dữ liệu chính

| Luồng | Đường đi |
|-------|----------|
| Số liệu cảm biến | ESP32 → MQTT `warehouse/sensor/*` (5 giây/lần) → Backend lưu DB + đẩy WebSocket → web / mobile; AI Agent đọc cùng lúc để chạy luật |
| Cảnh báo | AI Agent (tầng luật, có thể nhờ LLM viết lại nội dung) → MQTT `warehouse/alert` → Backend lưu `app.alerts`, đẩy WebSocket, gửi push FCM |
| Điều khiển từ giao diện | Web / mobile → `POST /api/devices/{fan\|mist\|light}/command` → MQTT `warehouse/cmd/*` (`source=user`) → ESP32 trả `ack` trong `status/<thiết bị>` |
| Chatbot | Web / mobile → `POST /api/chat` (SSE) → Backend → AI Agent (Supervisor + 4 worker) → stream trả lời; lệnh ghi hiện nút [Đồng ý] / [Hủy] |
| Đổi ngưỡng | `PUT /api/config` hoặc `tools/push_config.py` → `warehouse/cmd/config` → ESP32 kiểm tra, lưu flash, trả `status/config` |

---

## Hợp đồng MQTT

Mọi topic bắt đầu bằng `warehouse/`, payload là JSON. Broker bắt buộc đăng nhập (`allow_anonymous false`).

### ESP32 gửi lên

| Topic | Nội dung chính | Ghi chú |
|-------|----------------|---------|
| `sensor/mq135` | `raw` (ADC 0..4095), `mv`, `level` (`normal` / `warning` / `danger`), `warmingUp` | Bỏ qua cảnh báo 60 giây đầu khi MQ135 làm nóng |
| `sensor/dht11` | `temp`, `hum`, `tempRise`; lỗi: `error: "read_failed"`, `failCount` | |
| `sensor/pir` | `motion` (bool) | PIR cần ~30 giây ổn định sau khi bật |
| `status/safety` | `state` (`normal` / `gas` / `gas_danger` / `fire`), `tempRise`, `faults[]` | Gửi khi đổi trạng thái |
| `status/online` | `{"status":"online"}` / `{"status":"offline"}` | Retained; `offline` là LWT khi ESP32 mất kết nối |
| `status/device` | `id`, `uptime`, `rssi`, `ip` | Heartbeat 30 giây/lần |
| `status/fan`, `status/mist`, `status/light` | `state` (`on`/`off`), `mode` (`auto`/`manual`), `reason`, `source`, `trace_id`, `ack{trace_id, result}` | `result`: `applied`, `ignored_user_priority`, `invalid_source`, `invalid_command` |
| `status/config` | Toàn bộ ngưỡng đang dùng, `error` nếu cấu hình bị từ chối | |

### Gửi xuống ESP32

| Topic | Payload | Ghi chú |
|-------|---------|---------|
| `cmd/fan`, `cmd/mist`, `cmd/light` | `{"state":"on"\|"off","duration_s"?,"source":"user"\|"rule"\|"agent","reason"?,"trace_id"}` hoặc `{"mode":"auto"}` | `duration_s` tối đa 86400, `0` = không hết hạn. Lệnh `rule`/`agent` bị bỏ qua khi người dùng đang điều khiển |
| `cmd/config` | Các khóa ngưỡng (xem bảng [Ngưỡng](#ngưỡng-cảnh-báo)), chỉ cần gửi khóa muốn đổi | ESP32 kiểm tra hợp lệ rồi lưu vào flash (`Preferences`) |

### Giữa các service

| Topic | Bên gửi → nhận | Payload |
|-------|----------------|---------|
| `alert` | AI Agent → Backend | `{"type","level":"info"\|"warning"\|"critical","message","source":"rule"\|"agent","incident_id","details","ts"}` |

Xem toàn bộ bản tin khi đang chạy: `bash test.sh` (chạy `mosquitto_sub -t 'warehouse/#'` trong container).

---

## Firmware ESP32

| Linh kiện | GPIO | Ghi chú |
|-----------|------|---------|
| MQ135 (AO) | 34 | ADC1, chỉ input — dùng cầu chia áp để tín hiệu ≤ 3.3V |
| DHT11 (DATA) | 4 | Đọc 2,5 giây/lần |
| PIR HC-SR501 (OUT) | 27 | |
| Relay quạt | 26 | Relay 1 kênh |
| Relay phun sương | 25 | Relay 2 kênh, IN1 |
| Relay đèn | 33 | Relay 2 kênh, IN2 |

Relay mặc định kích mức thấp (`*_ACTIVE_LOW true` trong [config.h](firmware/warehouse_monitor/config.h)); các relay đóng cách nhau 200 ms để tránh sụt áp khi cấp nguồn USB.

### Trạng thái an toàn

| Trạng thái | Điều kiện |
|------------|-----------|
| `normal` | MQ135 dưới ngưỡng cảnh báo |
| `gas` | MQ135 ≥ `mq135Warning`, không nóng |
| `gas_danger` | MQ135 ≥ `mq135Danger`, không nóng |
| `fire` | Có khí / khói **và** (nhiệt độ ≥ `tempHigh` **hoặc** tăng ≥ `tempRiseC` trong `tempRiseWindowMin` phút) |

Hết nguy hiểm liên tục 2 phút mới hạ trạng thái. DHT11 hỏng khi đang `fire` thì giữ `fire`.

### Logic thiết bị (tự động)

| Thiết bị | Hành vi |
|----------|---------|
| Quạt | `fire` → **tắt** (không thổi thêm oxy) · `gas_danger` / `gas` → bật · độ ẩm cao / nhiệt độ cao → bật. Quạt chạy vì ẩm `humFanCheckMin` phút mà ẩm giảm < `humFanMinDrop` → báo `hum_ineffective`, khóa luật này 60 phút |
| Phun sương | `fire` → bật tối đa `mistFireMaxMin` phút · chỉ có khí (không nóng) → **cấm** · độ ẩm cao → cấm, kể cả lệnh thủ công · làm mát khi nóng và ẩm < `mistHumMax`, tối đa `mistCoolMaxMin` phút, nghỉ `mistCooldownMin` phút |
| Đèn | `fire` / `gas_danger` → bật; ngoài ra theo lệnh (vd. AI Agent bật đèn khi phát hiện đột nhập ngoài giờ) |

Phát hiện lỗi cảm biến: MQ135 ≤ 10 hoặc ≥ 4090 liên tục 10 giây (đứt dây / bão hòa), DHT11 lỗi đọc 5 lần liên tiếp → đưa vào `status/safety.faults`.

### Nạp firmware

1. Arduino IDE, board **ESP32 Dev Module**. Cài thư viện qua Library Manager: `PubSubClient`, `DHT sensor library` (Adafruit) + `Adafruit Unified Sensor`, `ArduinoJson` v7.
2. Sao chép [secrets.example.h](firmware/warehouse_monitor/secrets.example.h) thành `secrets.h` (đã `.gitignore`), điền WiFi **2.4 GHz** và `MQTT_HOST` = **IP LAN** của máy chạy Docker (không dùng `localhost`).
3. Mở `firmware/warehouse_monitor/warehouse_monitor.ino`, nạp lên board.
4. Chỉnh ngưỡng trong `.env` rồi chạy `python tools/push_config.py` để gửi xuống board.

Test logic firmware trên máy tính (cần `g++`), không cần board:

```bash
bash firmware/tests/run_tests.sh
```

---

## Cài đặt và chạy

### Yêu cầu

- Docker + Docker Compose
- Java 21 + Maven (hoặc dùng `backend/mvnw`)
- Conda (Python 3.12) cho AI Agent và công cụ dev
- Node.js + npm cho web / mobile
- Khóa OpenAI (không bắt buộc — thiếu khóa thì chatbot tắt, tầng luật và cảnh báo vẫn chạy)

### 1. Cấu hình

```bash
cp .env.example .env          # sửa mật khẩu, JWT_SECRET, OPENAI_API_KEY...
```

`.env` dùng chung cho mọi service và **không commit**. Các nhóm biến chính:

| Nhóm | Biến |
|------|------|
| Hạ tầng | `HOST_UID`, `HOST_GID`, `POSTGRES_*`, `PGADMIN_*`, `MQTT_*` (mỗi service một tài khoản) |
| Backend | `BACKEND_PORT`, `JWT_SECRET`, `JWT_ACCESS_TTL_MIN`, `JWT_REFRESH_TTL_DAYS`, `INTERNAL_API_KEY`, `WORK_HOURS_START/END`, `WORK_DAYS`, `CORS_ALLOWED_ORIGINS`, `FCM_CREDENTIALS_FILE` |
| Ngưỡng ESP32 | `MQ135_*`, `TEMP_*`, `HUM_*`, `MIST_*` — gửi xuống board bằng `tools/push_config.py` |
| Tầng luật AI Agent | `OFFLINE_TIMEOUT_S`, `ALERT_COOLDOWN_MIN`, `GAS_CONFIRM_S`, `ENV_PROLONGED_MIN`, `LIGHT_ON_AFTER_HOURS_S`, `INTRUSION_CLEAR_MIN`, `CMD_ACK_TIMEOUT_S`, `ESCALATION_MIN`, `LLM_ALERT_TIMEOUT_S` |
| LLM / multi-agent / memory | `OPENAI_*`, `INCIDENT_LLM_ENABLED`, `AGENT_MAX_STEPS`, `WORKER_*`, `CHAT_*`, `CONFIRM_TTL_S`, `EMBEDDING_DIMS`, `MEMORY_*`, `CHECKPOINT_TTL_DAYS`, `TOOL_LOG_*` |
| Theo dõi | `LOG_LEVEL`, `LOG_FORMAT`, `LANGFUSE_*` |

Mô tả từng biến nằm ngay trong [.env.example](.env.example).

### 2. Hạ tầng (PostgreSQL + Mosquitto + pgAdmin)

```bash
./tools/gen_mqtt_passwd.sh    # tạo mqtt-broker/config/passwd từ các tài khoản MQTT trong .env
docker compose up -d
```

| Dịch vụ | Địa chỉ | Ghi chú |
|---------|---------|---------|
| PostgreSQL 16 + pgvector | `127.0.0.1:5432` | Lần đầu chạy, [postgres/init/01-init.sh](postgres/init/01-init.sh) tạo extension `vector`, tài khoản `backend` / `agent` và schema `app` / `agent` |
| Mosquitto | `:1883` (mở ra LAN cho ESP32), WebSocket `127.0.0.1:9001` | |
| pgAdmin | http://localhost:5050 | Đăng nhập bằng `PGADMIN_EMAIL` / `PGADMIN_PASSWORD` |

Dừng: `docker compose down` (giữ dữ liệu). Xóa sạch DB: `docker compose down -v`. Đổi mật khẩu MQTT trong `.env` → chạy lại `gen_mqtt_passwd.sh` rồi `docker compose restart mosquitto`.

### 3. Backend

```bash
cd backend
mvn spring-boot:run           # http://localhost:8080, Flyway tự migrate schema "app"
```

### 4. AI Agent

```bash
conda env create -f ai-agent/environment.yml      # lần đầu (env "iot-agent")
cd ai-agent
conda run --no-capture-output -n iot-agent python -m app   # 127.0.0.1:8000
```

### 5. Giao diện

```bash
cd frontend/web && npm install && npm run dev       # http://localhost:5173
cd frontend/mobile && npm install && npx expo start # quét QR bằng Expo Go
```

Đăng ký tài khoản ngay trên màn hình đăng nhập. Điện thoại thật phải nhập **IP LAN** của máy chạy Backend (vd. `http://192.168.1.13:8080`). Push notification cần development build và cấu hình Firebase — xem [frontend/mobile/README.md](frontend/mobile/README.md#bật-push-notification-fcm).

### 6. Chạy thử không cần ESP32

```bash
conda run -n iot-agent python tools/simulate_esp32.py --plan normal:30,gas:30,fire:60,normal:30 --interval 2
```

Kịch bản: `normal`, `gas`, `gas_danger`, `fire`, `humid`, `hot`. Thêm `--once` để chạy hết kế hoạch rồi thoát. **Không chạy giả lập khi board thật đang online** — hai nguồn ghi cùng topic sẽ làm lẫn số liệu.

---

## Ngưỡng cảnh báo

Ngưỡng do ESP32 dùng (khóa JSON trong `cmd/config` ↔ biến `.env`). Đổi được trên trang **Cài đặt** của web / mobile, qua chatbot (có xác nhận), hoặc `tools/push_config.py`.

| Khóa | Biến `.env` | Mặc định | Ý nghĩa | Giới hạn |
|------|-------------|----------|---------|----------|
| `mq135Warning` | `MQ135_WARNING` | 1500 | Ngưỡng khí / khói (ADC thô) | ≥ 150 |
| `mq135Danger` | `MQ135_DANGER` | 2500 | Ngưỡng khí nguy hiểm | > `mq135Warning` + 150, ≤ 4095 |
| `tempHigh` | `TEMP_HIGH` | 38 °C | Nhiệt độ cao | 0–80 |
| `humHigh` | `HUM_HIGH` | 80 % | Độ ẩm cao | 10–100 |
| `tempRiseC` | `TEMP_RISE_C` | 3 °C | Mức tăng nhiệt nghi cháy | 0,5–20 |
| `tempRiseWindowMin` | `TEMP_RISE_WINDOW_MIN` | 5 phút | Cửa sổ đo tăng nhiệt | 1–15 |
| `mistFireMaxMin` | `MIST_FIRE_MAX_MIN` | 10 phút | Phun sương tối đa khi cháy | 1–60 |
| `mistCoolMaxMin` | `MIST_COOL_MAX_MIN` | 5 phút | Phun sương tối đa mỗi lần làm mát | 1–60 |
| `mistCooldownMin` | `MIST_COOLDOWN_MIN` | 15 phút | Nghỉ giữa 2 lần làm mát | 0–240 |
| `mistHumMax` | `MIST_HUM_MAX` | 70 % | Chỉ làm mát khi ẩm dưới mức này | 10 – `< humHigh` |
| `humFanCheckMin` | `HUM_FAN_CHECK_MIN` | 30 phút | Thời gian kiểm tra quạt hút ẩm | 5–240 |
| `humFanMinDrop` | `HUM_FAN_MIN_DROP` | 3 % | Mức giảm ẩm tối thiểu | 0,5–50 |

Các loại cảnh báo do tầng luật phát (`fire`, `fire_people`, `gas_danger`, `gas`, `intrusion`, `device_offline`, `sensor_fault`, `escalation`...) và mức của chúng: xem [ai-agent/README.md — Luật](ai-agent/README.md#luật-claudemd-mục-54).

---

## Trợ lý AI

- **Supervisor + 4 worker** (LangGraph): Monitor (đọc số liệu qua Backend), Analyst (tìm trong long-term memory), Control (đề xuất điều khiển / đổi ngưỡng), Notification (phát thông báo).
- **Lệnh ghi** chỉ tạo đề xuất → người dùng bấm [Đồng ý] → Safety Guard kiểm tra lại → gửi MQTT → chờ ESP32 `ack`. Hỗ trợ lệnh **nối chuỗi / hẹn giờ** ("10 phút nữa bật quạt", "phun sương 30 giây rồi bật quạt").
- **Safety Guard** (code thuần) chặn các lệnh nguy hiểm, vd. bật quạt khi cháy, tắt quạt / đèn khi khí nguy hiểm, phun sương khi có khí hoặc ẩm cao, gửi lệnh khi ESP32 offline.
- **Long-term memory** (pgvector): hồ sơ người dùng, kiến thức về kho, tóm tắt sự cố, phản hồi đúng / báo giả. Memory không bao giờ được dùng để chặn hoặc hạ mức cảnh báo.
- **Giọng nói**: ưu tiên nhận dạng / đọc tiếng Việt trên thiết bị, dự phòng STT / TTS của OpenAI qua server.
- **Theo dõi**: log terminal có nhãn (`[RULE]`, `[ALERT]`, `[TOOL]`, `[CHAT]`...), nhật ký mọi tool call theo `trace_id`, tracing Langfuse (tùy chọn).

Chi tiết đồ thị, tool, API nội bộ và sự kiện SSE: [ai-agent/README.md](ai-agent/README.md).

---

## Công cụ dev

| Lệnh | Tác dụng |
|------|----------|
| `./tools/gen_mqtt_passwd.sh` | Sinh file mật khẩu Mosquitto từ `.env` |
| `python tools/push_config.py` | Gửi ngưỡng trong `.env` xuống ESP32 (retained, chờ `status/config` xác nhận) |
| `python tools/simulate_esp32.py --plan ...` | Giả lập ESP32: gửi cảm biến theo kịch bản, phản hồi `cmd/*` và `cmd/config` |
| `bash test.sh` | Xem mọi bản tin `warehouse/#` trên broker |

Các script Python chạy trong conda env `iot-agent` và đọc `.env` ở thư mục gốc.

## Kiểm thử

| Thành phần | Lệnh | Ghi chú |
|------------|------|---------|
| Firmware | `bash firmware/tests/run_tests.sh` | Test logic an toàn trong `logic.h`, cần `g++` |
| Backend | `cd backend && mvn test` | Cần Docker (Testcontainers dựng PostgreSQL riêng; MQTT giả lập) |
| AI Agent | `cd ai-agent && conda run -n iot-agent python -m pytest -q` | Không gọi OpenAI (LLM giả có kịch bản); test DB tự bỏ qua nếu Docker chưa chạy |
| Web | `cd frontend/web && npm run build && npm run lint` | Type-check + oxlint |
| Mobile | `cd frontend/mobile && npm run typecheck && npm run lint` | |
| Đầu cuối | `tools/simulate_esp32.py --plan normal:12,gas:20,fire:24 --interval 2 --once` | Chạy Backend + AI Agent trước |

---

## Cấu trúc thư mục

```
Warehouse_Guard_IOT/
├── .env.example            # mẫu cấu hình dùng chung (copy thành .env)
├── docker-compose.yml      # PostgreSQL (pgvector) + Mosquitto + pgAdmin
├── firmware/
│   ├── warehouse_monitor/  # sketch ESP32: .ino (phần cứng, MQTT), logic.h (logic an toàn), config.h (GPIO, mặc định)
│   └── tests/              # test logic.h trên máy tính
├── backend/                # Spring Boot: auth JWT, lưu MQTT, REST, WebSocket, thống kê, push FCM, trung gian AI
├── ai-agent/               # FastAPI: tầng luật, multi-agent LangGraph, memory, voice
│   ├── app/                # rules/, agents/, memory/, api/, mqtt/, observability/
│   ├── migrations/         # SQL cho schema "agent"
│   └── prompts/            # bản đọc của prompt (sinh từ app/agents/prompts.py)
├── frontend/
│   ├── web/                # React + Vite
│   ├── mobile/             # Expo
│   └── shared/             # types, labels, config, sse dùng chung
├── mqtt-broker/config/     # mosquitto.conf (+ passwd sinh ra, không commit)
├── postgres/init/          # script tạo tài khoản / schema lần đầu
├── pgadmin/servers.json    # khai báo sẵn server cho pgAdmin
└── tools/                  # gen_mqtt_passwd.sh, push_config.py, simulate_esp32.py
```

## Bảo mật

- Không commit: `.env`, `firmware/**/secrets.h`, `mqtt-broker/config/passwd`, `secrets/`, file service account Firebase, `google-services.json` (đã có trong `.gitignore`).
- Mật khẩu trong `.env.example` chỉ dành cho dev / demo — đổi toàn bộ khi triển khai thật, đặc biệt `JWT_SECRET` (≥ 32 byte) và `INTERNAL_API_KEY`.
- PostgreSQL, pgAdmin, WebSocket MQTT và AI Agent chỉ mở trên `127.0.0.1`; chỉ cổng MQTT 1883 và Backend 8080 mở ra mạng LAN.
