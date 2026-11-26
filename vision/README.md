# Vision — camera + YOLO phát hiện người, lửa / khói

Service Python đọc camera (webcam laptop khi demo), chạy **2 model YOLO** trên cùng khung hình — phát hiện **người** (YOLO26n, COCO) và **lửa / khói** (YOLO26s fine-tune trên FASDD_CV) — gửi kết quả lên MQTT và cung cấp hình (có khung YOLO) cho Java BE. Thiết kế tổng thể: [../CLAUDE.md](../CLAUDE.md).

Camera **bổ sung** cảm biến chuyển động PIR (không thay thế): một trong hai thấy người ngoài giờ là đủ báo đột nhập + bật đèn; camera thấy người sau PIR → thêm cảnh báo xác nhận.

Camera **bổ sung** cảm biến khói MQ135 ("MQ135 hoặc camera"):

| Camera thấy | Xử lý |
|-------------|-------|
| **Lửa** + MQ135 có khói | ESP32 (subscribe thẳng `sensor/camera`) chuyển `fire`: tắt quạt, phun sương, bật đèn — dù nhiệt độ chưa tăng |
| **Chỉ lửa** (MQ135 bình thường) | ai-agent: cảnh báo `camera_fire` critical + bật đèn + chụp ảnh; không tự đổi quạt / phun sương |
| **Khói** | ai-agent: cảnh báo `camera_smoke` warning + chụp ảnh; không đổi thiết bị |

Camera kém khi thiếu sáng / bị che, có thể nhầm đèn vàng / nắng / màn hình với lửa, hơi nước / sương với khói — không thay thế hệ thống báo cháy và an ninh chuyên dụng.

```
Camera ─► luồng đọc (giữ khung mới nhất) ─► YOLO người + YOLO lửa/khói (VISION_INFER_FPS khung/s, GPU FP16)
                                              │
                    xác nhận người / lửa / khói (N khung liên tiếp / hết sau N giây)
                    │                                   │
          MQTT warehouse/sensor/camera          ảnh JPEG có khung ─► HTTP nội bộ (127.0.0.1)
          (5s/lần + khi đổi trạng thái)                                /stream.mjpg, /snapshot.jpg
                    │                                                       │
       ai-agent (tầng luật) + Java BE (lưu) + ESP32 (fire)     Java BE /api/camera/* ─► web / app
```

## Chạy

```bash
conda env create -f vision/environment.yml      # lần đầu (PyTorch có CUDA ~3 GB)
cd vision
conda run --no-capture-output -n iot-vision python -m app      # 127.0.0.1:8100
```

- Lần đầu chạy tự tải model người (`VISION_PERSON_MODEL`, mặc định `yolo26n.pt`, ~5 MB) vào `vision/models/` (không commit).
- Model lửa / khói **tự train, không tự tải được**: chép `yolo26s_fasddcv.pt` vào `vision/models/` (không commit, ~60 MB). Thiếu file / sai class → log lỗi, service **vẫn chạy** phát hiện người (bản tin không có trường `fire` / `smoke`).
- **Demo lửa không cần đốt lửa thật:** `VISION_CAMERA=/đường/dẫn/video_lua.mp4` → phát đúng tốc độ video và lặp lại. Hoặc mở video lửa trên điện thoại rồi đưa trước webcam.
- Cần tài khoản MQTT `vision` trong broker: thêm `MQTT_VISION_USER` / `MQTT_VISION_PASSWORD` vào `.env` → `./tools/gen_mqtt_passwd.sh` → `docker kill -s HUP warehouse-mosquitto` (nạp lại không ngắt kết nối ESP32).
- Đã có một bản đang chạy (cổng bận) → bản mới thoát ngay, **không** đụng camera và không gửi `offline` đè lên bản đang chạy.
- Dừng (Ctrl+C): tự gửi `warehouse/status/camera = offline` (retained); luồng MJPEG đang mở bị cắt sau tối đa 3 giây.
- Thiếu camera / bị che / app khác đang dùng: service vẫn chạy, gửi `{"error":"camera_unavailable"}` và tự mở lại camera (chờ tăng dần tới 10s).

Test (không cần camera / GPU — camera và YOLO giả): `conda run -n iot-vision python -m pytest -q` (27 test).

## Cấu hình (`.env` ở thư mục gốc)

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `VISION_PORT` | 8100 | HTTP nội bộ, chỉ nghe 127.0.0.1 |
| `VISION_CAMERA` | `0` | Số = `/dev/videoN`; URL (`rtsp://…`, `http://…`) cho camera IP; hoặc đường dẫn file video (phát lặp — demo) |
| `VISION_CAMERA_WIDTH` / `_HEIGHT` | 640 / 480 | Độ phân giải yêu cầu |
| `VISION_PERSON_MODEL` | `yolo26n.pt` | Tên model Ultralytics (tự tải) hoặc đường dẫn `.pt` |
| `VISION_DEVICE` | `auto` | `auto` (GPU nếu có) \| `cuda:0` \| `cpu` |
| `VISION_IMGSZ` | 640 | Kích thước ảnh đưa vào model |
| `VISION_CONF` | 0.5 | Ngưỡng tin cậy của từng khung bao |
| `VISION_INFER_FPS` | 10 | Số khung phân tích / giây — giới hạn tải GPU |
| `VISION_CONFIRM_FRAMES` | 3 | Thấy người N khung **liên tiếp** mới tính "có người" (chống báo giả) |
| `VISION_CLEAR_S` | 3 | Không thấy người liên tục N giây → "hết người" (người khuất thoáng qua không làm nhảy trạng thái) |
| `VISION_PUBLISH_S` | 5 | Gửi `sensor/camera` định kỳ (ngoài lúc đổi trạng thái) |
| `VISION_JPEG_QUALITY` | 75 | Chất lượng JPEG của hình gửi đi |
| `VISION_FIRE_MODEL` | `yolo26s_fasddcv.pt` | Model lửa / khói (class `fire`, `smoke`) trong `vision/models/` hoặc đường dẫn `.pt`. Trống = tắt |
| `VISION_FIRE_CONF` / `VISION_SMOKE_CONF` | 0.45 / 0.45 | Ngưỡng tin cậy khung bao lửa / khói (tăng nếu báo giả) |
| `VISION_FIRE_CONFIRM_FRAMES` | 5 | Thấy lửa / khói N khung **liên tiếp** mới tính |
| `VISION_FIRE_CLEAR_S` | 10 | Không thấy liên tục N giây → hết lửa / khói |
| `MQTT_VISION_USER` / `_PASSWORD` | `vision` / `vision` | Tài khoản MQTT |
| `INTERNAL_API_KEY` | — | Java BE gọi HTTP bằng header `X-Internal-Key` |

## Chọn model (đo trên RTX 3050 Laptop 6 GB, ảnh 640×480 từ webcam, FP16)

| Model | Thời gian / khung (trung vị) | VRAM đỉnh | Ảnh mẫu `bus.jpg` (4 người) @640 / @480 |
|-------|------------------------------|-----------|------------------------------------------|
| `yolo11n.pt` | 4.1 ms | 41 MB | 4 / 3 người |
| **`yolo26n.pt`** (mặc định) | 4.7 ms | 47 MB | 4 / 4 người |
| `yolo11s.pt` | 6.1 ms | 66 MB | — |
| `yolo26s_fasddcv.pt` (lửa / khói) | 5.5 ms | 63 MB | ảnh đống lửa: `fire 0.87` |

Chạy cả 2 model: ~12.5 ms / khung. Ở 10 khung/giây, GPU vẫn rảnh phần lớn thời gian (≈ 13%). Thực tế tốc độ bị giới hạn bởi camera (webcam laptop trong phòng tối chỉ ~5–8 khung/giây do tự kéo dài thời gian phơi sáng).

Ultralytics dùng giấy phép **AGPL-3.0** — ổn cho demo / đồ án; đóng gói thương mại cần cân nhắc (hoặc đổi sang model giấy phép thoáng như RT-DETR, YOLOX).

## MQTT

| Topic | Retained | Payload |
|-------|----------|---------|
| `warehouse/sensor/camera` | không | `{"person":true,"personCount":2,"personConf":0.91,"fire":false,"fireConf":null,"smoke":true,"smokeConf":0.62,"fps":9.8}` · lỗi: `{"error":"camera_unavailable"}` \| `{"error":"detector_failed"}` |
| `warehouse/status/camera` | **có** (LWT) | `{"status":"online","model":"yolo26n.pt","fireModel":"yolo26s_fasddcv.pt","device":"cuda:0"}` \| `{"status":"offline"}` |

`personCount` / `personConf` lấy ở khung gần nhất có người. Số người đổi (khi đang có người) → gửi tối đa 1 lần / giây. Có / hết người, lửa, khói → gửi ngay. Không bật model lửa → **không có** trường `fire` / `smoke` (khác `false`).

## HTTP nội bộ (chỉ Java BE gọi — header `X-Internal-Key`)

| Path | Trả về |
|------|--------|
| `GET /health` | `{"status":"ok"}` (không cần khóa) |
| `GET /status` | `uptimeS`, `camera{source,opened,error,width,height}`, `model{name,device,half,imgsz,conf,inferFps,fire{name,fireConf,smokeConf,…} \| {name,error} \| null}`, `detection{person,personCount,personConf,fireEnabled,fire,fireConf,smoke,smokeConf,detections,fps,inferMs,frames,error}`, `mqttConnected`, `viewers` |
| `GET /snapshot.jpg` | Ảnh mới nhất có khung YOLO · 503 `no_frame` |
| `GET /stream.mjpg?fps=15` | MJPEG `multipart/x-mixed-replace; boundary=frame` (fps 1–30) |

Ảnh vẽ khung (xanh = `person`, cam = `fire`, xám = `smoke`) + nhãn `person 0.87`, dòng trên cùng `PERSON: 2 | FIRE | SMOKE | 9.8 fps | 13 ms | 19:44:00` (chữ ASCII — OpenCV không vẽ được tiếng Việt). Không lưu ảnh / video; ảnh làm bằng chứng do **Java BE** chụp khi có cảnh báo đột nhập / cháy / camera thấy lửa, khói.

## Cấu trúc

| File | Nội dung |
|------|----------|
| `app/camera.py` | Luồng đọc camera, giữ khung mới nhất, tự mở lại khi lỗi; file video: phát đúng tốc độ, lặp lại |
| `app/detector.py` | `PersonDetector` (class `person`), `FireSmokeDetector` (class `fire`, `smoke`), vẽ khung, mã hóa JPEG |
| `app/presence.py` | Xác nhận có / hết (người, lửa, khói — mỗi loại 1 bộ đếm; thuần Python, có test) |
| `app/pipeline.py` | Vòng xử lý: khung → 2 model YOLO → xác nhận → JPEG + MQTT |
| `app/mqtt.py` | Gửi MQTT, LWT `status/camera` |
| `app/main.py` | FastAPI: `/status`, `/snapshot.jpg`, `/stream.mjpg` |
