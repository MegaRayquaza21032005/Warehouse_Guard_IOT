#pragma once

// ================== WiFi + MQTT (bí mật) ==================
// WIFI_SSID, WIFI_PASSWORD, MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASSWORD
// nằm trong secrets.h (KHÔNG commit). Tạo từ mẫu: copy secrets.example.h -> secrets.h
#include "secrets.h"

#define DEVICE_ID      "esp32-warehouse-01"

// ================== Chân GPIO ==================
#define PIN_MQ2    34   // MQ2 AO  (ADC1, chỉ input)
#define PIN_DHT    4    // DHT11 DATA (D4)
#define PIN_PIR    27   // PIR OUT (D27)
#define PIN_RELAY  26   // Relay IN (D26)

// Đa số module relay 1 kênh kích mức thấp (LOW = đóng relay).
// Nếu quạt chạy ngược (lệnh off thì bật), đổi thành false.
#define RELAY_ACTIVE_LOW  true

// ================== Ngưỡng MẶC ĐỊNH ==================
// Đây chỉ là giá trị dùng khi flash chưa có cấu hình.
// Ngưỡng thực tế chỉnh trong file .env ở thư mục gốc, rồi chạy
// tools/push_config.py để gửi xuống ESP32 qua MQTT (không cần nạp lại code).
// MQ2: giá trị ADC thô 0..4095.
#define MQ2_WARMUP_MS        60000UL   // bỏ qua cảnh báo trong lúc cảm biến làm nóng
#define MQ2_WARNING_RAW      1500
#define MQ2_DANGER_RAW       2500
#define MQ2_HYSTERESIS_RAW   150       // tránh bật/tắt liên tục quanh ngưỡng

#define TEMP_HIGH_C          38.0f
#define HUM_HIGH_PCT         80.0f
#define TEMP_HUM_HYSTERESIS  2.0f

#define PIR_WARMUP_MS        30000UL   // HC-SR501 cần ~30-60s ổn định sau khi cấp nguồn

// ================== Chu kỳ ==================
#define MQ2_READ_MS          1000UL
#define DHT_READ_MS          2500UL    // DHT11 đọc tối đa ~1 lần/giây
#define SENSOR_PUBLISH_MS    5000UL
#define DEVICE_STATUS_MS     30000UL
#define WIFI_RETRY_MS        15000UL
#define MQTT_RETRY_MS        5000UL
