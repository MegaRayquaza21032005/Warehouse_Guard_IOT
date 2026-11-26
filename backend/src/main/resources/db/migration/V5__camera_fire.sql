-- Camera phát hiện lửa / khói (model YOLO fine-tune, cùng bản tin warehouse/sensor/camera).
-- Cột NULL = vision chưa có model lửa / khói lúc ghi (không biết), khác false (đã xem, không thấy).
ALTER TABLE camera_events
    ADD COLUMN fire       BOOLEAN,
    ADD COLUMN fire_conf  REAL,
    ADD COLUMN smoke      BOOLEAN,
    ADD COLUMN smoke_conf REAL;
