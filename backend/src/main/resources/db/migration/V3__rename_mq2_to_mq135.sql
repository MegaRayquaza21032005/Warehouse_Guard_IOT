-- Cảm biến khí đổi từ MQ2 sang MQ135 (vẫn GPIO34). Đổi tên, giữ nguyên dữ liệu cũ.
ALTER TABLE app.mq2_readings RENAME TO mq135_readings;
ALTER INDEX app.idx_mq2_readings_ts RENAME TO idx_mq135_readings_ts;
ALTER TABLE app.safety_events RENAME COLUMN mq2_level TO mq135_level;
