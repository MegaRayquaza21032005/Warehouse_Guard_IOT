#pragma once
// Cấu hình phần cứng + giá trị mặc định. File này được commit — KHÔNG để bí mật ở đây.
// WiFi + MQTT nằm trong secrets.h (không commit; mẫu: secrets.example.h).

#define DEVICE_ID      "esp32-warehouse-01"

// ================== Chân GPIO ==================
#define PIN_MQ2    34   // MQ2 AO  (ADC1, chỉ input) — qua cầu chia áp xuống <= 3.3V
#define PIN_DHT    4    // DHT11 DATA (D4)
#define PIN_PIR    27   // PIR OUT (D27)
#define PIN_FAN    26   // Relay 1 kênh -> quạt (D26)
#define PIN_MIST   25   // Relay 2 kênh IN1 -> phun sương
#define PIN_LIGHT  33   // Relay 2 kênh IN2 -> đèn

// Mức kích từng kênh relay. true = kích mức thấp (LOW = đóng relay) — loại phổ biến nhất.
// Thiết bị chạy ngược (lệnh off mà bật) -> đổi kênh đó thành false.
#define FAN_ACTIVE_LOW    true
#define MIST_ACTIVE_LOW   true
#define LIGHT_ACTIVE_LOW  true

// Đóng / ngắt từng relay cách nhau (ms) để tránh sụt áp khi cấp nguồn bằng USB laptop
#define RELAY_STAGGER_MS  200UL

// ================== Ngưỡng MẶC ĐỊNH ==================
// Chỉ dùng khi flash chưa có cấu hình. Giá trị thực tế chỉnh trong .env rồi chạy
// tools/push_config.py (gửi qua warehouse/cmd/config, ESP32 lưu vào flash).
#define DEF_MQ2_WARNING         1500    // ADC thô 0..4095
#define DEF_MQ2_DANGER          2500
#define DEF_TEMP_HIGH           38.0f   // °C
#define DEF_HUM_HIGH            80.0f   // %
#define DEF_TEMP_RISE_C         3.0f    // nhiệt độ tăng >= X°C ...
#define DEF_TEMP_RISE_WIN_MIN   5       // ... trong Y phút => "tăng nhanh"
#define DEF_MIST_FIRE_MAX_MIN   10      // phun sương khi cháy: tối đa X phút
#define DEF_MIST_COOL_MAX_MIN   5       // phun sương làm mát: tối đa X phút mỗi lần
#define DEF_MIST_COOLDOWN_MIN   15      // nghỉ X phút giữa 2 lần làm mát
#define DEF_MIST_HUM_MAX        70.0f   // chỉ phun làm mát khi độ ẩm < X%
#define DEF_HUM_FAN_CHECK_MIN   30      // quạt chạy vì ẩm X phút ...
#define DEF_HUM_FAN_MIN_DROP    3.0f    // ... mà ẩm giảm < Y% => thông gió không hiệu quả

// ================== Hằng số cố định ==================
#define MQ2_HYSTERESIS_RAW      150
#define TEMP_HUM_HYSTERESIS     2.0f
#define SAFETY_EXIT_HOLD_MS     120000UL  // hết nguy hiểm liên tục 2 phút mới hạ trạng thái
#define HUM_FAN_LOCK_MS         3600000UL // tạm dừng luật "ẩm -> quạt" 60 phút khi không hiệu quả
#define TEMP_HISTORY_SAMPLE_MS  30000UL   // lấy mẫu nhiệt độ cho phát hiện tăng nhanh

#define MQ2_WARMUP_MS           60000UL   // bỏ qua cảnh báo khi MQ2 đang làm nóng
#define PIR_WARMUP_MS           30000UL   // HC-SR501 cần ~30-60s ổn định

// Phát hiện lỗi cảm biến
#define MQ2_FAULT_LOW_RAW       10        // <= giá trị này liên tục => đứt dây
#define MQ2_FAULT_HIGH_RAW      4090      // >= giá trị này liên tục => bão hòa
#define MQ2_FAULT_MS            10000UL
#define DHT_FAULT_COUNT         5         // lỗi đọc liên tiếp => hỏng

// ================== Chu kỳ ==================
#define MQ2_READ_MS          1000UL
#define DHT_READ_MS          2500UL    // DHT11 đọc tối đa ~1 lần/giây
#define SENSOR_PUBLISH_MS    5000UL
#define DEVICE_STATUS_MS     30000UL
#define WIFI_RETRY_MS        15000UL
#define MQTT_RETRY_MS        5000UL
