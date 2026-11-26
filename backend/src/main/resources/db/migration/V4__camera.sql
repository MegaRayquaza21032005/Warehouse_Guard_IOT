-- Camera + YOLO phát hiện người (service vision, warehouse/sensor/camera).

-- Chỉ ghi khi đổi (có / hết người, số người, lỗi) — bản tin định kỳ 5s giống hệt thì bỏ qua.
CREATE TABLE camera_events (
    id           BIGSERIAL   PRIMARY KEY,
    ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
    person       BOOLEAN     NOT NULL,
    person_count INTEGER     NOT NULL DEFAULT 0,
    person_conf  REAL,
    error        VARCHAR(40)
);
CREATE INDEX idx_camera_events_ts ON camera_events (ts);

-- Ảnh chụp làm bằng chứng khi có sự cố (đột nhập / cháy có người). Ảnh JPEG đã có khung YOLO, ~20–80 KB.
-- Xóa theo CAMERA_SNAPSHOT_RETENTION_DAYS; xóa cảnh báo -> xóa ảnh kèm theo.
CREATE TABLE camera_snapshots (
    id           BIGSERIAL   PRIMARY KEY,
    ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
    alert_id     BIGINT      REFERENCES alerts (id) ON DELETE CASCADE,
    alert_type   VARCHAR(40),
    incident_id  VARCHAR(64),
    person_count INTEGER,
    content_type VARCHAR(30) NOT NULL DEFAULT 'image/jpeg',
    size_bytes   INTEGER     NOT NULL,
    image        BYTEA       NOT NULL
);
CREATE INDEX idx_camera_snapshots_ts ON camera_snapshots (ts);
CREATE INDEX idx_camera_snapshots_alert ON camera_snapshots (alert_id);
