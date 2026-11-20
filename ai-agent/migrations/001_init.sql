-- Schema "agent" (sở hữu bởi tài khoản agent). Bảng do ai-agent tự định nghĩa.
-- Bảng của LangGraph (checkpoint, store) do thư viện tự tạo ở giai đoạn 4-5.

-- Nhật ký MỌI tool call của agent (CLAUDE.md mục 8) — dùng từ giai đoạn 4
CREATE TABLE agent.tool_call_logs (
    id            UUID PRIMARY KEY,
    trace_id      VARCHAR(64) NOT NULL,
    thread_id     VARCHAR(64),
    flow          VARCHAR(10) NOT NULL,                 -- chat | incident
    agent         VARCHAR(30) NOT NULL,                 -- supervisor | monitor | analyst | control | notification | memory_extractor
    tool          VARCHAR(60) NOT NULL,
    args          JSONB,
    result        JSONB,
    status        VARCHAR(25) NOT NULL,                 -- requested | pending_confirmation | approved | rejected | success | error | blocked_by_policy
    error         TEXT,
    user_id       BIGINT,
    confirmed_by  BIGINT,
    is_write      BOOLEAN     NOT NULL DEFAULT FALSE,   -- tool ghi: giữ >= 1 năm
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    duration_ms   INTEGER
);
CREATE INDEX idx_tool_call_logs_trace ON agent.tool_call_logs (trace_id);
CREATE INDEX idx_tool_call_logs_started ON agent.tool_call_logs (started_at);

-- Token / chi phí mỗi lần gọi LLM, STT, TTS, embedding
CREATE TABLE agent.llm_usage (
    id                BIGSERIAL PRIMARY KEY,
    ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
    trace_id          VARCHAR(64),
    agent             VARCHAR(30),
    model             VARCHAR(80) NOT NULL,
    kind              VARCHAR(15) NOT NULL DEFAULT 'chat',   -- chat | embedding | stt | tts
    input_tokens      INTEGER,
    output_tokens     INTEGER,
    audio_seconds     REAL,
    cost_usd          NUMERIC(12, 6)
);
CREATE INDEX idx_llm_usage_ts ON agent.llm_usage (ts);

-- Sự cố do tầng luật mở / đóng (thread_id của luồng sự cố = id)
CREATE TABLE agent.incidents (
    id           VARCHAR(64) PRIMARY KEY,
    kind         VARCHAR(20) NOT NULL,                  -- safety | intrusion | offline
    level        VARCHAR(10) NOT NULL,                  -- mức cao nhất đã gặp
    state        VARCHAR(20),                           -- vd. gas, fire (sự cố safety)
    opened_at    TIMESTAMPTZ NOT NULL,
    closed_at    TIMESTAMPTZ,
    events       JSONB       NOT NULL DEFAULT '[]'      -- diễn biến: [{ts, event, ...}]
);
CREATE INDEX idx_incidents_opened ON agent.incidents (opened_at);
