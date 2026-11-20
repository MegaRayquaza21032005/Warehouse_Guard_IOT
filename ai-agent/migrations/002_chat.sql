-- Giai đoạn 4: hội thoại chatbot. Bảng checkpoint của LangGraph (checkpoints, checkpoint_blobs,
-- checkpoint_writes, checkpoint_migrations) do AsyncPostgresSaver.setup() tự tạo trong schema agent.

-- Hội thoại: thuộc về đúng 1 người dùng (Java BE gửi user_id đã xác thực)
CREATE TABLE agent.chat_threads (
    id          VARCHAR(64) PRIMARY KEY,
    user_id     BIGINT       NOT NULL,
    title       VARCHAR(120) NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_threads_user ON agent.chat_threads (user_id, updated_at DESC);

-- Tin nhắn để HIỂN THỊ lại (độc lập với ngữ cảnh LLM — ngữ cảnh bị tóm tắt / cắt bớt)
CREATE TABLE agent.chat_messages (
    id          BIGSERIAL PRIMARY KEY,
    thread_id   VARCHAR(64)  NOT NULL REFERENCES agent.chat_threads (id) ON DELETE CASCADE,
    role        VARCHAR(10)  NOT NULL,                 -- user | assistant
    kind        VARCHAR(15)  NOT NULL DEFAULT 'text',  -- text | confirmation | result | error
    content     TEXT         NOT NULL,
    blocks      JSONB,                                 -- [{type:text|chart|confirmation,...}]
    input_mode  VARCHAR(10),                           -- text | voice (tin của user)
    trace_id    VARCHAR(64),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_messages_thread ON agent.chat_messages (thread_id, id);

CREATE INDEX idx_tool_call_logs_thread ON agent.tool_call_logs (thread_id);
CREATE INDEX idx_tool_call_logs_user ON agent.tool_call_logs (user_id, started_at);
