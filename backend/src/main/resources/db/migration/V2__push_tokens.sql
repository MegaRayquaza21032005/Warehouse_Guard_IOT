-- Token FCM của điện thoại (app mobile) — dùng để gửi push cảnh báo khi app đóng (CLAUDE.md mục 3)
CREATE TABLE push_tokens (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT       NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token        VARCHAR(4096) NOT NULL UNIQUE,
    platform     VARCHAR(10)  NOT NULL,                     -- android | ios
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_push_tokens_user ON push_tokens (user_id);
