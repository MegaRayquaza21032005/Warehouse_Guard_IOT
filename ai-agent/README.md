# ai-agent — FastAPI + tầng luật (+ LangGraph từ giai đoạn 4)

Thiết kế: [../CLAUDE.md](../CLAUDE.md) mục 5 (logic cảnh báo), 7 (memory), 8 (multi-agent).
Hiện tại (**giai đoạn 3**): tầng luật **không dùng LLM** — nhận MQTT, phát hiện sự cố, gửi cảnh báo, bật đèn khi có đột nhập, leo thang cảnh báo chưa ai xem.

## Chạy

```bash
docker compose up -d                                     # ở thư mục gốc
cd ai-agent
conda run --no-capture-output -n iot-agent python -m app  # nghe 127.0.0.1:8000 (không public)
```

Cấu hình đọc từ `../.env`: `POSTGRES_AGENT_*`, `MQTT_AGENT_*`, `INTERNAL_API_KEY`, `BACKEND_PORT`, `WORK_*`, các ngưỡng tầng luật (`OFFLINE_TIMEOUT_S`, `ALERT_COOLDOWN_MIN`, `GAS_CONFIRM_S`, `ENV_PROLONGED_MIN`, `LIGHT_ON_AFTER_HOURS_S`, `INTRUSION_CLEAR_MIN`, `CMD_ACK_TIMEOUT_S`, `ESCALATION_MIN`, `LLM_ALERT_TIMEOUT_S`), `LOG_LEVEL`, `LOG_FORMAT`, `LANGFUSE_*`.
Biến môi trường đặt khi chạy sẽ ghi đè `.env`, vd. test đột nhập ban ngày: `WORK_DAYS=7 python -m app`.

DB / broker / Java BE chưa chạy → agent vẫn khởi động, tự kết nối lại; thiếu DB thì chỉ mất phần lưu sự cố.

## Test

```bash
conda run --no-capture-output -n iot-agent python -m pytest -q   # test DB (integration) tự bỏ qua nếu docker chưa chạy
```

Đầu cuối không cần ESP32: chạy Java BE + agent, rồi `python tools/simulate_esp32.py --plan normal:12,gas:20,fire:24 --interval 2 --once` (thư mục gốc).

## Theo dõi: log terminal + Langfuse

**Log terminal luôn bật** (song song với Langfuse). Mỗi dòng có nhãn:

| Nhãn | Nội dung |
|------|----------|
| `[APP]` `[SERVER]` | Khởi động / dừng |
| `[MQTT]` | Kết nối broker; `LOG_LEVEL=DEBUG` để thấy từng bản tin nhận được |
| `[RULE]` | Quyết định của tầng luật (đổi trạng thái an toàn, bỏ qua do cooldown...) |
| `[ALERT]` | Cảnh báo đã gửi (`CRIT` đỏ / `WARN` vàng / `INFO`) |
| `[CMD]` | Lệnh thiết bị tầng luật gửi |
| `[INCIDENT]` | Mở / cập nhật / đóng sự cố |
| `[ESCALATE]` | Leo thang cảnh báo critical chưa ai xem |
| `[TOOL]` `[LLM]` | Tool call / token LLM (giai đoạn 4) |
| `[LANGFUSE]` `[DB]` `[BACKEND]` | Trạng thái kết nối |

`LOG_FORMAT=json` → mỗi dòng một JSON.

**Langfuse** (`LANGFUSE_ENABLED=true` + `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`): mỗi cảnh báo, lệnh, sự kiện sự cố được gửi thành event; các event cùng sự cố nằm chung một trace (trace id sinh từ incident id). Bí mật được che trước khi gửi. Langfuse lỗi / tắt không ảnh hưởng tầng luật.

## Luật (CLAUDE.md mục 5.4)

| Cảnh báo `type` | Mức | Khi nào |
|-----------------|-----|---------|
| `fire` / `fire_people` | critical | `status/safety` → `fire`; `fire_people` nếu có chuyển động trong 2 phút (hoặc chuyển động xuất hiện trong lúc cháy) |
| `gas_danger` | critical | → `gas_danger` |
| `gas` | warning | → `gas` và giữ ≥ `GAS_CONFIRM_S` (chống báo giả) |
| `intrusion` | critical | Chuyển động ngoài giờ làm việc → bật đèn `LIGHT_ON_AFTER_HOURS_S` giây (lệnh `source=rule`); hết chuyển động `INTRUSION_CLEAR_MIN` phút → đóng sự cố |
| `mist_fire_max_time` | critical | Phun sương báo `reason=fire_max_time` |
| `device_offline` / `no_data` | warning | LWT offline / không có dữ liệu > `OFFLINE_TIMEOUT_S` |
| `device_no_response` | warning | Lệnh `cmd/*` không có `ack` sau `CMD_ACK_TIMEOUT_S` |
| `sensor_fault` | warning | Lỗi mới trong `status/safety.faults` |
| `temp_high_prolonged` / `hum_high_prolonged` | info | Vượt ngưỡng liên tục `ENV_PROLONGED_MIN` phút |
| `ventilation_ineffective` | info | Quạt báo `reason=hum_ineffective` |
| `recovered` | info | Đóng sự cố (kèm thời gian kéo dài) |
| `escalation` | critical | Cảnh báo critical chưa ai bấm "Đã xem" quá `ESCALATION_MIN` phút (hỏi Java BE 30s/lần) |

- `info` / `warning` cùng loại: cooldown `ALERT_COOLDOWN_MIN`. `critical` **không bao giờ** bị chặn.
- Gửi theo mức: `critical` gửi ngay; `warning` / `info` sẽ qua LLM (tối đa `LLM_ALERT_TIMEOUT_S`) từ giai đoạn 4 — hiện chưa có LLM nên gửi bản của tầng luật ngay.

## API nội bộ (chỉ Java BE gọi, header `X-Internal-Key`)

| Method | Path | |
|--------|------|--|
| GET | `/health` | Không cần khóa. `{"status","mqtt","db","langfuse"}` |
| GET | `/rules/state` | Trạng thái tầng luật: an toàn, sự cố đang mở, ngưỡng, số bản tin, cảnh báo đã gửi |
| GET | `/incidents?open_only=&limit=` | Sự cố đã lưu (schema `agent.incidents`) |

## Cấu trúc

```
app/
├── main.py, __main__.py   # FastAPI + khởi động
├── config.py              # đọc ../.env
├── logging_setup.py       # log terminal (text có màu / json)
├── db.py                  # pool PostgreSQL + chạy migrations/*.sql
├── backend_client.py      # REST Java BE (X-Internal-Key)
├── runtime.py             # vòng lặp: MQTT -> engine -> thực thi; tick 1s; leo thang 30s
├── mqtt/client.py
├── rules/                 # TẦNG LUẬT — engine.py là logic thuần (test bằng đồng hồ giả)
│   ├── engine.py, actions.py, schedule.py
│   └── alert_policy.py    # gửi theo mức, chờ LLM có timeout
├── observability/         # tool_logger.py, usage.py (giai đoạn 4), langfuse.py, redact.py
└── api/                   # deps.py (khóa nội bộ), health.py
migrations/001_init.sql    # agent.tool_call_logs, llm_usage, incidents
```
