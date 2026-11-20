-- Schema "app" (sở hữu bởi tài khoản backend). Mọi bảng nghiệp vụ của Java BE nằm ở đây.
-- Thời gian luôn là TIMESTAMPTZ (UTC trong DB, hiển thị theo Asia/Ho_Chi_Minh).

-- ===================== Người dùng & xác thực =====================
CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    full_name     VARCHAR(100),
    role          VARCHAR(20)  NOT NULL DEFAULT 'USER',   -- hiện mọi người cùng quyền; để sẵn cho phân quyền sau
    enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash  VARCHAR(64) NOT NULL UNIQUE,                -- SHA-256, không lưu token gốc
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);

-- ===================== Dữ liệu cảm biến =====================
CREATE TABLE mq2_readings (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw         INTEGER     NOT NULL,
    mv          INTEGER,
    level       VARCHAR(10) NOT NULL,                      -- normal | warning | danger
    warming_up  BOOLEAN     NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_mq2_readings_ts ON mq2_readings (ts);

CREATE TABLE climate_readings (
    id         BIGSERIAL PRIMARY KEY,
    ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
    temp       REAL,
    hum        REAL,
    temp_rise  REAL,
    error      VARCHAR(30)                                 -- read_failed khi DHT11 lỗi
);
CREATE INDEX idx_climate_readings_ts ON climate_readings (ts);

CREATE TABLE motion_events (
    id      BIGSERIAL PRIMARY KEY,
    ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
    motion  BOOLEAN     NOT NULL
);
CREATE INDEX idx_motion_events_ts ON motion_events (ts);

-- ===================== Trạng thái hệ thống =====================
CREATE TABLE safety_events (
    id         BIGSERIAL PRIMARY KEY,
    ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
    state      VARCHAR(15) NOT NULL,                       -- normal | gas | gas_danger | fire
    mq2_level  VARCHAR(10),
    temp_rise  REAL,
    faults     JSONB       NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_safety_events_ts ON safety_events (ts);

-- Mỗi lần ESP32 báo trạng thái thiết bị thay đổi (status/fan|mist|light)
CREATE TABLE device_states (
    id        BIGSERIAL PRIMARY KEY,
    ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
    device    VARCHAR(10) NOT NULL,                        -- fan | mist | light
    state     VARCHAR(3)  NOT NULL,                        -- on | off
    mode      VARCHAR(10),
    reason    VARCHAR(40),
    source    VARCHAR(15),                                 -- esp32_local | user | rule | agent
    trace_id  VARCHAR(64)
);
CREATE INDEX idx_device_states_device_ts ON device_states (device, ts);

CREATE TABLE device_health (
    id        BIGSERIAL PRIMARY KEY,
    ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
    online    BOOLEAN,
    uptime_s  BIGINT,
    rssi      INTEGER,
    ip        VARCHAR(45)
);
CREATE INDEX idx_device_health_ts ON device_health (ts);

-- Cấu hình ngưỡng hiện hành (ESP32 xác nhận qua status/config) — chỉ một dòng
CREATE TABLE device_config (
    id          SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    payload     JSONB       NOT NULL,
    error       VARCHAR(50),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===================== Nhật ký lệnh thiết bị — MỌI nguồn =====================
-- source: esp32_local | rule | agent | user  (CLAUDE.md mục 8)
CREATE TABLE device_command_logs (
    id               BIGSERIAL PRIMARY KEY,
    ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
    device           VARCHAR(10) NOT NULL,
    action           VARCHAR(5)  NOT NULL,                 -- on | off | auto
    source           VARCHAR(15) NOT NULL,
    user_id          BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    trace_id         VARCHAR(64),
    reason           VARCHAR(40),
    duration_s       INTEGER,
    result           VARCHAR(30),                          -- applied | ignored_user_priority | invalid_* | NULL = chưa xác nhận
    result_at        TIMESTAMPTZ,
    confirmed_state  VARCHAR(3),                           -- trạng thái relay ESP32 báo lại
    payload          JSONB
);
CREATE INDEX idx_device_command_logs_ts ON device_command_logs (ts);
CREATE INDEX idx_device_command_logs_trace ON device_command_logs (trace_id);

-- ===================== Cảnh báo =====================
CREATE TABLE alerts (
    id               BIGSERIAL PRIMARY KEY,
    ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
    type             VARCHAR(40) NOT NULL,
    level            VARCHAR(10) NOT NULL,                 -- info | warning | critical
    message          TEXT,
    source           VARCHAR(15),                          -- rule | agent
    incident_id      VARCHAR(64),
    acknowledged_by  BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    acknowledged_at  TIMESTAMPTZ,
    feedback         VARCHAR(15),                          -- true_alarm | false_alarm
    feedback_note    TEXT,
    feedback_by      BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    payload          JSONB
);
CREATE INDEX idx_alerts_ts ON alerts (ts);
