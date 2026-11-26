# ai-agent — FastAPI: tầng luật + multi-agent Supervisor (LangGraph)

Thiết kế: [../CLAUDE.md](../CLAUDE.md) mục 5 (logic cảnh báo), 6 (chatbot), 7 (memory), 8 (multi-agent).

- **Tầng luật** (giai đoạn 3, **không LLM**): nhận MQTT, phát hiện sự cố, gửi cảnh báo, bật đèn khi đột nhập, leo thang.
- **Multi-agent** (giai đoạn 4): Supervisor + 4 worker (Monitor, Analyst, Control, Notification), dùng cho **chatbot**
  (stream SSE qua Java BE, lệnh ghi phải bấm [Đồng ý]) và **luồng sự cố** (LLM viết nội dung cảnh báo). STT/TTS dự phòng.
- **Long-term memory** (giai đoạn 5): PostgresStore + pgvector (`halfvec` 3072 chiều) — hồ sơ người dùng, kiến thức kho,
  tóm tắt sự cố, phản hồi đúng / báo giả; tự nạp vào ngữ cảnh, bước trích xuất chạy nền. Memory **không bao giờ** chặn / hạ cảnh báo.
- OpenAI lỗi / chậm / thiếu key → tầng luật vẫn chạy đầy đủ, cảnh báo gửi bản cơ bản.

## Chạy

```bash
docker compose up -d                                     # ở thư mục gốc
cd ai-agent
conda run --no-capture-output -n iot-agent python -m app  # nghe 127.0.0.1:8000 (không public)
```

Cấu hình đọc từ `../.env`: `OPENAI_*` (model, STT, TTS, `OPENAI_REASONING_EFFORT`), `INCIDENT_LLM_ENABLED`, `AGENT_MAX_STEPS`, `WORKER_MAX_STEPS`, `WORKER_TIMEOUT_S`, `CHAT_TIMEOUT_S`, `CHAT_HISTORY_MAX_MESSAGES`, `CHAT_MAX_PER_HOUR`, `CONFIRM_TTL_S`, `OPENAI_EMBEDDING_MODEL`, `EMBEDDING_DIMS`, `MEMORY_*`, `CHECKPOINT_TTL_DAYS`, `TOOL_LOG_READ_DAYS`, `TOOL_LOG_WRITE_DAYS`, `POSTGRES_AGENT_*`, `MQTT_AGENT_*`, `INTERNAL_API_KEY`, `BACKEND_PORT`, `WORK_*`, các ngưỡng tầng luật (`OFFLINE_TIMEOUT_S`, `ALERT_COOLDOWN_MIN`, `GAS_CONFIRM_S`, `ENV_PROLONGED_MIN`, `LIGHT_ON_AFTER_HOURS_S`, `INTRUSION_CLEAR_MIN`, `CMD_ACK_TIMEOUT_S`, `ESCALATION_MIN`, `LLM_ALERT_TIMEOUT_S`), `LOG_LEVEL`, `LOG_FORMAT`, `LANGFUSE_*` (`LANGFUSE_HOST` hoặc `LANGFUSE_BASE_URL`).
Biến môi trường đặt khi chạy sẽ ghi đè `.env`, vd. test đột nhập ban ngày: `WORK_DAYS=7 python -m app`.

DB / broker / Java BE chưa chạy → agent vẫn khởi động, tự kết nối lại; thiếu DB thì chỉ mất phần lưu sự cố.

## Test

```bash
conda run --no-capture-output -n iot-agent python -m pytest -q   # test DB (integration) tự bỏ qua nếu docker chưa chạy
```

Test **không gọi OpenAI**: đồ thị multi-agent chạy với LLM giả có kịch bản (`tests/test_agent_graph.py`, `tests/test_agent_service.py`): xác nhận / hủy, Safety Guard chặn, quyền tối thiểu, giới hạn bước, luồng sự cố, nhật ký theo `trace_id`.

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
| `[SCHEDULE]` | Lệnh hẹn giờ / nối chuỗi: HẸN (lúc nào), CHẠY (kết quả), HỦY (lý do) |
| `[CHAT]` | Tin nhắn đến (`user`, `thread`, `trace`), chờ xác nhận, Đồng ý / Hủy, trả lời xong (thời gian) |
| `[AGENT]` | Supervisor xử lý sự cố, tóm tắt hội thoại dài |
| `[TOOL]` | **Mọi** tool call: `agent.tool` + trạng thái (`requested`, `pending_confirmation`, `approved`, `rejected`, `scheduled`, `cancelled`, `success`, `error`, `blocked_by_policy`) + thời gian; lệnh MQTT đã gửi |
| `[LLM]` | Token mỗi lần gọi LLM (`agent`, `in`, `out`) |
| `[VOICE]` | STT / TTS phía server |
| `[MEMORY]` | Lưu / xóa long-term memory (`namespace/key: nội dung`), lỗi bước trích xuất |
| `[MAINTAIN]` | Dọn checkpoint / nhật ký cũ |
| `[LANGFUSE]` `[DB]` `[BACKEND]` | Trạng thái kết nối |

`LOG_FORMAT=json` → mỗi dòng một JSON.

**Langfuse** (`LANGFUSE_ENABLED=true` + `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`/`LANGFUSE_BASE_URL`):
- Tầng luật: mỗi cảnh báo, lệnh, sự kiện sự cố là một event; cùng sự cố nằm chung một trace (seed = incident id).
- Multi-agent: callback LangGraph → cây trace `supervisor → dispatch → worker → tool`, mỗi lần gọi `ChatOpenAI` có token + chi phí. Trace id sinh từ `trace_id` của hệ thống (seed); `session` = `thread_id` (hội thoại hoặc sự cố); `user` = `user_id`; metadata có `trace_id`, `flow`.
- Bí mật được che (`mask`) trước khi gửi. Langfuse lỗi / tắt không ảnh hưởng luồng chính.

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
| `manual_notice` | do người dùng chọn | Thông báo phát từ chatbot (sau khi bấm [Đồng ý]), `source=agent` |
| `escalation` | critical | Cảnh báo critical chưa ai bấm "Đã xem" quá `ESCALATION_MIN` phút (hỏi Java BE 30s/lần) |

- `info` / `warning` cùng loại: cooldown `ALERT_COOLDOWN_MIN`. `critical` **không bao giờ** bị chặn.
- Gửi theo mức: `critical` gửi ngay (rồi LLM gửi thêm `<type>_analysis`); `warning` / `info` qua LLM trước (tối đa `LLM_ALERT_TIMEOUT_S`), quá hạn / lỗi → bản của tầng luật. `escalation` không qua LLM.

## Multi-agent (CLAUDE.md mục 8)

```
START ─► supervisor ──(ask_*)──► dispatch ──(có đề xuất)──► confirm (interrupt) ─┐
            ▲  └──(trả lời)──► END   │                                            │
            └────────────────────────┴────────────────────────────────────────────┘
```

| Agent | Tools | Loại |
|-------|-------|------|
| Supervisor | `ask_monitor`, `ask_analyst`, `ask_control`, `ask_notification` (giao việc) + `save_memory` | `save_memory`: **ghi** |
| Monitor | `get_current_state`, `get_sensor_history`, `get_device_status`, `get_device_logs`, `get_alert_history`, `get_statistics` | đọc (Java BE REST) |
| Analyst | `search_incidents`, `search_warehouse_facts`, `search_feedback` — tìm theo ngữ nghĩa trong long-term memory (`search_incidents` không có tóm tắt liên quan → sự cố gần nhất từ `agent.incidents`) | đọc |
| Control | `control_fan`, `control_mist`, `control_light`, `update_thresholds` | **ghi** |
| Notification | `publish_alert` | **ghi** |

- **Quyền tối thiểu:** mỗi worker chỉ được bind đúng bộ tool của mình; gọi tool ngoài quyền → ghi log `error`, không chạy.
- **Mọi tool call đều được ghi** (`app/agents/tools.py`: tool chỉ tạo được qua `make_read_tool` / `make_write_tool`), kể cả lệnh giao việc của Supervisor.
- **Safety Guard** (`app/agents/safety_guard.py`, code thuần): không bật quạt khi `fire`; không tắt quạt / đèn khi `gas_danger` (đèn: cả `fire`); không bật phun sương khi có khí/khói, độ ẩm ≥ `humHigh` hoặc không có số liệu ẩm gần đây (> 120s); ESP32 offline → chặn; ngưỡng kiểm tra giống firmware. Kiểm tra **2 lần**: khi tạo đề xuất và ngay trước khi gửi MQTT.
- **Luồng chat:** tool ghi chỉ tạo **đề xuất** (log `pending_confirmation`) → `interrupt` → người dùng bấm → `approved` → gửi lệnh (`source=user`, `user_id`) → chờ ESP32 `ack` tối đa 8s → `success`; Hủy → `rejected`; quá `CONFIRM_TTL_S` → hết hạn. Đang chờ xác nhận thì không nhận tin nhắn mới (409).
- **Lệnh nối chuỗi / hẹn giờ** ("bật phun sương 30s rồi bật quạt 30s", "10 phút nữa bật quạt", "tắt quạt rồi bật lại"): Control dùng `delay_s` (bắt đầu sau N giây **kể từ lúc bấm Đồng ý**, ≤ 24h); người dùng bấm [Đồng ý] **một lần** cho cả chuỗi. Lệnh không có `delay_s` chạy ngay **cùng lúc**; khung xác nhận luôn có `schedule_note` (code sinh) nói rõ lệnh nào chạy cùng lúc / hẹn giờ. Lệnh hẹn giờ nằm trong RAM (`app/agents/scheduler.py`): đến giờ Safety Guard **kiểm tra lại** rồi mới gửi MQTT (`source=user`, `user_id` người đồng ý); lệnh thủ công mới của người dùng cho cùng thiết bị → **hủy lịch** của thiết bị đó; ai-agent dừng / khởi động lại → lịch bị hủy (nhật ký `cancelled`). Safety Guard `check_schedule`: tối đa 2 lệnh / thiết bị / yêu cầu, cách nhau ≥ 10s (chống nháy relay), luồng sự cố không hẹn giờ, tối đa 20 lịch đang chờ. Log `[SCHEDULE]` (HẸN / CHẠY / HỦY).
- **Control trả lời mà không gọi tool** (LLM viết "đã tạo đề xuất" nhưng không có đề xuất nào, nên không có nút): `dispatch` phát hiện (`RunContext.tool_calls == 0`, 0 đề xuất) → gọi lại Control **1 lần** kèm `CONTROL_RETRY`; vẫn không gọi tool → Supervisor nhận câu cố định `CONTROL_NO_PROPOSAL` nên không thể nói "đang chờ [Đồng ý]". Trả lời bắt đầu bằng `THIẾU THÔNG TIN:` (cần hỏi lại người dùng) không bị gọi lại. Log `[AGENT]` mức WARNING; `ask_control` trong `tool_call_logs` có `result.retried = true`.
- **Luồng sự cố** (`AlertDispatcher.enricher`): Supervisor (`mode=incident`, thread = incident id) → Notification soạn nội dung. Control chỉ được tự động bật đèn / bật quạt khi có khí (`source=agent`); đổi ngưỡng luôn bị chặn. `warning`/`info`: quá `LLM_ALERT_TIMEOUT_S` → bản của tầng luật. `critical`: đã gửi ngay, LLM gửi thêm `<type>_analysis`. LLM không hạ mức, không tắt push của `warning`/`critical`.
- **Short-term memory:** `AsyncPostgresSaver` (bảng `checkpoints*` trong schema `agent`), `thread_id` = hội thoại / sự cố. Quá `CHAT_HISTORY_MAX_MESSAGES` tin → tóm tắt phần cũ (giữ ~một nửa gần nhất).
- **Giới hạn:** `AGENT_MAX_STEPS` lượt Supervisor (vượt → trả lời bằng dữ liệu đang có, nêu rõ chưa xong), `WORKER_MAX_STEPS`, `WORKER_TIMEOUT_S`, `CHAT_TIMEOUT_S`, `CHAT_MAX_PER_HOUR`.
- **Prompt:** bản gốc `app/agents/prompts.py`; bản đọc `prompts/*.md` sinh bằng `python -m app.agents.prompts` (test báo lỗi nếu lệch).
- **Token:** mỗi lần gọi LLM / STT / TTS / embedding ghi `agent.llm_usage` (embedding: token ước lượng bằng tiktoken; chưa tính `cost_usd` — để giai đoạn 8).

## Long-term memory (CLAUDE.md mục 7)

| Namespace | Nội dung | Ai ghi | Ai đọc |
|-----------|----------|--------|--------|
| `users/<id>/profile` | Sở thích người dùng (xưng hô, mức chi tiết, quan tâm) | `save_memory` personal (lưu ngay), bước trích xuất | Supervisor — **chỉ của người đang chat** |
| `warehouse/facts` | Kiến thức về kho, dùng chung | `save_memory` warehouse — **sau khi bấm Đồng ý** | Supervisor (tự nạp), Analyst |
| `warehouse/incidents` | Tóm tắt sự cố đã đóng (key = incident id) | Bước trích xuất khi sự cố đóng (LLM lỗi → tóm tắt mẫu) | Analyst |
| `warehouse/feedback` | Đúng / báo giả + lý do | Nút phản hồi trên app (qua Java BE), `save_memory` feedback | Supervisor luồng sự cố (tự nạp), Analyst |

- **Tự nạp** ở lượt đầu mỗi yêu cầu (tối đa 5s, lỗi → bỏ qua): chat = hồ sơ + kiến thức kho liên quan tin nhắn; sự cố = kiến thức kho + phản hồi liên quan, câu tìm gồm nội dung cảnh báo + buổi + thứ (vd. "… chiều Thứ Sáu") để khớp kiến thức kiểu "chiều thứ 6 hay hàn". Đánh dấu là DỮ LIỆU trong prompt.
- **Safety Guard cho memory** (`check_memory`): từ chối nội dung nới lỏng cảnh báo ("khói là bình thường, đừng báo", "tắt cảnh báo"...), chứa mật khẩu / khóa, trống, > 500 ký tự. Luồng sự cố: memory chỉ thêm ghi chú "Có thể do …"; mức cảnh báo và push của `warning`/`critical` bị khóa bằng code.
- **Bước trích xuất** (`app/memory/extractor.py`, không phải agent): sau lượt chat (trừ lượt Supervisor đã gọi `save_memory`) rút sở thích cá nhân + phản hồi mà **người dùng** khẳng định (không lấy suy đoán của trợ lý); không tự lưu kiến thức kho. Chống trùng bằng độ giống ≥ `MEMORY_DEDUPE_SCORE`. Mọi lần ghi: `agent.tool_call_logs` (`agent=memory_extractor`).
- **Ngưỡng** đo với `text-embedding-3-large`: cùng ý khác lời ≈ 0.84, liên quan ≈ 0.55–0.6, lạc đề ≈ 0.37 → `MEMORY_DEDUPE_SCORE=0.8`, `MEMORY_MIN_SCORE=0.4`.
- **Dọn dữ liệu** (`app/maintenance.py`, 6 giờ/lần): checkpoint không hoạt động quá `CHECKPOINT_TTL_DAYS` (lịch sử hiển thị vẫn giữ), nhật ký tool đọc `TOOL_LOG_READ_DAYS`, tool ghi `TOOL_LOG_WRITE_DAYS`.

## API nội bộ (chỉ Java BE gọi, header `X-Internal-Key`)

| Method | Path | |
|--------|------|--|
| GET | `/health` | Không cần khóa. `{"status","mqtt","db","langfuse","agent","memory"}` |
| GET | `/rules/state` | Trạng thái tầng luật: an toàn, sự cố đang mở, ngưỡng, thiết bị, số bản tin, cảnh báo đã gửi |
| GET | `/incidents?open_only=&limit=` | Sự cố đã lưu (schema `agent.incidents`) |
| POST | `/chat` | `{"user_id","username"?,"thread_id"?,"message","input_mode":"text\|voice"}` → **SSE**. Không có `thread_id` = hội thoại mới. 404 `thread_not_found`, 409 `thread_busy` / `confirmation_pending`, 429 `rate_limited`, 503 `llm_disabled` / `db_unavailable` |
| POST | `/chat/{thread_id}/confirm` | `{"user_id","approved"}` → **SSE**. 409 `no_pending_confirmation` |
| GET | `/chat/threads?user_id=` | Hội thoại của người dùng (mới nhất trước) |
| GET | `/chat/threads/{id}?user_id=` | `{thread, messages, pending}` — `pending` = đề xuất đang chờ (để hiện lại nút) |
| DELETE | `/chat/threads/{id}?user_id=` | Xóa hội thoại + checkpoint |
| POST | `/voice/stt` | multipart `file` (≤ 10 MB), `user_id`, `language=vi` → `{"text"}`. Không lưu âm thanh |
| POST | `/voice/tts` | `{"user_id","text"}` → `audio/mpeg` (bỏ khối biểu đồ, markdown) |
| GET | `/schedules` | Lệnh hẹn giờ đang chờ `[{id, device, description, run_at, remaining_s, user_id, trace_id, thread_id}]` |
| DELETE | `/schedules/{id}?user_id=` | Hủy lệnh hẹn giờ (204; 404 nếu đã chạy / đã hủy) |
| GET | `/memory?user_id=` | Memory cá nhân của người dùng |
| DELETE | `/memory/{key}?user_id=` | Xóa memory cá nhân (404 nếu không phải của người này) |
| GET | `/memory/warehouse?kind=facts\|incidents\|feedback&limit&offset` | Memory dùng chung |
| DELETE | `/memory/warehouse/{key}?user_id=&is_admin=` | Xóa kiến thức kho — người tạo hoặc ADMIN (403 `not_owner`) |
| POST | `/memory/feedback` | `{"user_id","alert":{id,type,level,message,ts},"feedback":"true_alarm\|false_alarm","note"?}` — Java BE gọi khi người dùng bấm phản hồi |
| GET | `/logs/tool-calls` | Lọc `trace_id`, `thread_id`, `user_id`, `viewer_id` (= chỉ của user này + luồng sự cố), `agent`, `tool`, `status`, `flow`, `from`, `to`, `limit`, `offset` |

**Sự kiện SSE** (`event:` / `data:` JSON):

| event | data |
|-------|------|
| `meta` | `{thread_id, trace_id}` — luôn đầu tiên |
| `status` | `{agent, text}` — Supervisor đang giao việc cho worker nào |
| `token` | `{text}` — từng đoạn câu trả lời của Supervisor |
| `discard` | `{}` — bỏ phần chữ tạm đã nhận (lượt đó Supervisor chuyển sang gọi tool) |
| `confirmation` | `{type, proposals:[{id, tool, kind, args, description, note}], expires_at, thread_id, trace_id}` — hiện [Đồng ý] / [Hủy]; stream kết thúc |
| `result` | `{approved, expired, outcomes:[{id, description, status, text, ack}]}` — sau khi bấm |
| `done` | `{message, blocks, speech, thread_id, trace_id, outcomes}` — **`blocks` là bản chuẩn để hiển thị** (`text` / `chart`); `speech` = chữ để đọc TTS |
| `error` | `{code, message, trace_id}` — `timeout` / `agent_error` |

Khối biểu đồ trong `message` có dạng ` ```chart {json} ``` `; server đã tách sẵn vào `blocks` (khối sai định dạng bị bỏ).

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
├── agents/                # MULTI-AGENT (giai đoạn 4)
│   ├── graph.py           # đồ thị LangGraph: supervisor / dispatch / confirm, WorkerRunner
│   ├── tools.py           # tools 4 worker + lớp log bắt buộc + ActionExecutor (gửi MQTT)
│   ├── safety_guard.py    # chính sách an toàn bằng code (thuần, test riêng)
│   ├── prompts.py         # prompt — bản gốc (sinh prompts/*.md)
│   ├── service.py         # chat SSE, hội thoại, xác nhận, rate limit, enrich cho luồng sự cố
│   ├── charts.py          # tách khối biểu đồ
│   ├── llm.py             # ChatOpenAI + ghi token
│   └── voice.py           # STT / TTS
├── memory/                # LONG-TERM MEMORY (giai đoạn 5)
│   ├── store.py           # MemoryService, namespace, embedding có ghi token, định dạng ngữ cảnh
│   └── extractor.py       # bước trích xuất chạy nền: sau chat, khi đóng sự cố, phản hồi từ app
├── maintenance.py         # dọn checkpoint / nhật ký cũ
├── observability/         # tool_logger.py, usage.py, langfuse.py, redact.py
└── api/                   # deps.py (khóa nội bộ), health.py, chat.py (chat, voice, logs), memory.py
migrations/                # 001: tool_call_logs, llm_usage, incidents · 002: chat_threads, chat_messages
prompts/*.md               # SINH từ app/agents/prompts.py — không sửa tay
```
