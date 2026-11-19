#pragma once
// Mẫu thông tin bí mật cho firmware.
// Copy file này thành secrets.h (cùng thư mục) rồi điền giá trị thật.
// secrets.h đã nằm trong .gitignore — KHÔNG commit.

// ===== WiFi (chỉ hỗ trợ 2.4GHz) =====
#define WIFI_SSID      "YOUR_WIFI_SSID"
#define WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"

// ===== MQTT =====
// MQTT_HOST: IP LAN của máy chạy Docker (Linux: ip -4 addr), KHÔNG dùng "localhost"
#define MQTT_HOST      "192.168.1.100"
#define MQTT_PORT      1883
// Tài khoản esp32 trong .env: MQTT_ESP32_USER / MQTT_ESP32_PASSWORD
#define MQTT_USER      "esp32"
#define MQTT_PASSWORD  "esp32"
