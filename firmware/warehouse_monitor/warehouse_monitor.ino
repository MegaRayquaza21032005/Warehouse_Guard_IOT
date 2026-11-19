/*
 * Warehouse Monitor - ESP32
 *
 * Cảm biến: MQ2 (GPIO34), DHT11 (GPIO4), PIR (GPIO27)
 * Chấp hành: Relay 1 kênh -> quạt (GPIO26)
 *
 * Thư viện cần cài (Library Manager):
 *   - PubSubClient      (Nick O'Leary)
 *   - DHT sensor library (Adafruit) + Adafruit Unified Sensor
 *   - ArduinoJson        (Benoit Blanchon, v7.x)
 *
 * MQTT topics:
 *   publish   warehouse/sensor/mq2      {"raw":..,"mv":..,"level":"normal|warning|danger","warmingUp":bool}
 *   publish   warehouse/sensor/dht11    {"temp":..,"hum":..}  hoặc {"error":"read_failed"}
 *   publish   warehouse/sensor/pir      {"motion":bool}        (khi thay đổi)
 *   publish   warehouse/status/fan      {"state":"on|off","mode":"auto|manual","reason":".."}  (retained)
 *   publish   warehouse/status/online   {"status":"online"} | {"status":"offline"}  (retained, LWT)
 *   publish   warehouse/status/device   {"id":..,"uptime":..,"rssi":..,"ip":".."}
 *   publish   warehouse/status/config   {"mq2Warning":..,"mq2Danger":..,"tempHigh":..,"humHigh":..}  (retained)
 *   subscribe warehouse/cmd/fan         {"state":"on"} | {"state":"off"} | {"mode":"auto"}
 *   subscribe warehouse/cmd/config      {"mq2Warning":1500, ...}  (gửi trường nào đổi trường đó, lưu vào flash)
 *
 * Luật quạt:
 *   1. Khói mức DANGER  -> luôn BẬT quạt (ghi đè cả chế độ manual).
 *   2. Chế độ MANUAL    -> theo lệnh on/off từ server.
 *   3. Chế độ AUTO      -> bật nếu khói WARNING, nhiệt độ cao hoặc độ ẩm cao.
 *   Các luật này chạy cục bộ, vẫn hoạt động khi mất WiFi/MQTT.
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include "config.h"

// ---------------- Topics ----------------
static const char* T_MQ2        = "warehouse/sensor/mq2";
static const char* T_DHT        = "warehouse/sensor/dht11";
static const char* T_PIR        = "warehouse/sensor/pir";
static const char* T_FAN_STATUS = "warehouse/status/fan";
static const char* T_ONLINE     = "warehouse/status/online";
static const char* T_DEVICE     = "warehouse/status/device";
static const char* T_CMD_FAN    = "warehouse/cmd/fan";
static const char* T_CONFIG     = "warehouse/status/config";
static const char* T_CMD_CONFIG = "warehouse/cmd/config";

static const char* ONLINE_MSG   = "{\"status\":\"online\"}";
static const char* OFFLINE_MSG  = "{\"status\":\"offline\"}";

// ---------------- Kiểu dữ liệu ----------------
enum SmokeLevel { SMOKE_NORMAL, SMOKE_WARNING, SMOKE_DANGER };
enum FanMode    { FAN_AUTO, FAN_MANUAL };

// ---------------- Đối tượng ----------------
WiFiClient   wifiClient;
PubSubClient mqtt(wifiClient);
DHT          dht(PIN_DHT, DHT11);
Preferences  prefs;

// ---------------- Ngưỡng (đổi được qua MQTT, lưu flash) ----------------
int   cfgMq2Warning = MQ2_WARNING_RAW;
int   cfgMq2Danger  = MQ2_DANGER_RAW;
float cfgTempHigh   = TEMP_HIGH_C;
float cfgHumHigh    = HUM_HIGH_PCT;

// ---------------- Trạng thái ----------------
unsigned long bootAt = 0;

int        mq2Raw     = 0;
int        mq2MilliV  = 0;
SmokeLevel smokeLevel = SMOKE_NORMAL;

float temperature = NAN;
float humidity    = NAN;
bool  dhtOk       = false;
bool  tempHigh    = false;
bool  humHigh     = false;

bool motion = false;

bool        fanOn       = false;
FanMode     fanMode     = FAN_AUTO;
bool        manualFanOn = false;
const char* fanReason   = "idle";

unsigned long lastMq2Read = 0, lastDhtRead = 0, lastSensorPublish = 0;
unsigned long lastDeviceStatus = 0, lastWifiRetry = 0, lastMqttRetry = 0;

// ================================================================
// Tiện ích
// ================================================================
const char* smokeLevelStr(SmokeLevel l) {
  switch (l) {
    case SMOKE_WARNING: return "warning";
    case SMOKE_DANGER:  return "danger";
    default:            return "normal";
  }
}

bool mq2Ready() { return millis() - bootAt >= MQ2_WARMUP_MS; }
bool pirReady() { return millis() - bootAt >= PIR_WARMUP_MS; }

void publishJson(const char* topic, JsonDocument& doc, bool retained = false) {
  if (!mqtt.connected()) return;
  char buf[256];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topic, (const uint8_t*)buf, n, retained);
}

void writeRelay(bool on) {
  bool level = RELAY_ACTIVE_LOW ? !on : on;
  digitalWrite(PIN_RELAY, level ? HIGH : LOW);
}

// ================================================================
// Publish
// ================================================================
void publishMq2() {
  JsonDocument doc;
  doc["raw"]       = mq2Raw;
  doc["mv"]        = mq2MilliV;
  doc["level"]     = smokeLevelStr(smokeLevel);
  doc["warmingUp"] = !mq2Ready();
  publishJson(T_MQ2, doc);
}

void publishDht() {
  JsonDocument doc;
  if (dhtOk) {
    doc["temp"] = serialized(String(temperature, 1));
    doc["hum"]  = serialized(String(humidity, 1));
  } else {
    doc["error"] = "read_failed";
  }
  publishJson(T_DHT, doc);
}

void publishPir() {
  JsonDocument doc;
  doc["motion"] = motion;
  publishJson(T_PIR, doc);
}

void publishFanStatus() {
  JsonDocument doc;
  doc["state"]  = fanOn ? "on" : "off";
  doc["mode"]   = fanMode == FAN_AUTO ? "auto" : "manual";
  doc["reason"] = fanReason;
  publishJson(T_FAN_STATUS, doc, true);
}

void publishConfig(const char* error = nullptr) {
  JsonDocument doc;
  doc["mq2Warning"] = cfgMq2Warning;
  doc["mq2Danger"]  = cfgMq2Danger;
  doc["tempHigh"]   = cfgTempHigh;
  doc["humHigh"]    = cfgHumHigh;
  if (error) doc["error"] = error;
  publishJson(T_CONFIG, doc, true);
}

void publishDeviceStatus() {
  JsonDocument doc;
  doc["id"]     = DEVICE_ID;
  doc["uptime"] = millis() / 1000;
  doc["rssi"]   = WiFi.RSSI();
  doc["ip"]     = WiFi.localIP().toString();
  publishJson(T_DEVICE, doc);
}

// ================================================================
// Quạt
// ================================================================
void updateFan(bool forcePublish = false) {
  bool want;
  const char* reason;

  if (smokeLevel == SMOKE_DANGER) {
    want = true;  reason = "smoke_danger";          // an toàn: ghi đè mọi chế độ
  } else if (fanMode == FAN_MANUAL) {
    want = manualFanOn; reason = "manual";
  } else if (smokeLevel == SMOKE_WARNING) {
    want = true;  reason = "smoke_warning";
  } else if (tempHigh) {
    want = true;  reason = "temp_high";
  } else if (humHigh) {
    want = true;  reason = "hum_high";
  } else {
    want = false; reason = "idle";
  }

  bool changed = (want != fanOn) || (strcmp(reason, fanReason) != 0);
  if (want != fanOn) writeRelay(want);
  fanOn = want;
  fanReason = reason;

  if (changed) {
    Serial.printf("[FAN] %s (mode=%s, reason=%s)\n", fanOn ? "ON" : "OFF",
                  fanMode == FAN_AUTO ? "auto" : "manual", fanReason);
  }
  if (changed || forcePublish) publishFanStatus();
}

// ================================================================
// Cảm biến
// ================================================================
SmokeLevel evalSmoke(int raw, SmokeLevel cur) {
  const int warnOff   = cfgMq2Warning - MQ2_HYSTERESIS_RAW;
  const int dangerOff = cfgMq2Danger  - MQ2_HYSTERESIS_RAW;

  switch (cur) {
    case SMOKE_NORMAL:
      if (raw >= cfgMq2Danger)  return SMOKE_DANGER;
      if (raw >= cfgMq2Warning) return SMOKE_WARNING;
      return SMOKE_NORMAL;
    case SMOKE_WARNING:
      if (raw >= cfgMq2Danger) return SMOKE_DANGER;
      if (raw < warnOff)         return SMOKE_NORMAL;
      return SMOKE_WARNING;
    case SMOKE_DANGER:
      if (raw < warnOff)   return SMOKE_NORMAL;
      if (raw < dangerOff) return SMOKE_WARNING;
      return SMOKE_DANGER;
  }
  return SMOKE_NORMAL;
}

void readMq2() {
  const int samples = 10;
  long sumRaw = 0, sumMv = 0;
  for (int i = 0; i < samples; i++) {
    sumRaw += analogRead(PIN_MQ2);
    sumMv  += analogReadMilliVolts(PIN_MQ2);
    delayMicroseconds(200);
  }
  mq2Raw    = sumRaw / samples;
  mq2MilliV = sumMv / samples;

  SmokeLevel newLevel = mq2Ready() ? evalSmoke(mq2Raw, smokeLevel) : SMOKE_NORMAL;
  if (newLevel != smokeLevel) {
    Serial.printf("[MQ2] level %s -> %s (raw=%d)\n",
                  smokeLevelStr(smokeLevel), smokeLevelStr(newLevel), mq2Raw);
    smokeLevel = newLevel;
    publishMq2();   // báo ngay khi đổi mức, không chờ chu kỳ
  }
}

void readDht() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) {
    dhtOk = false;
    Serial.println("[DHT] read failed");
    return;   // giữ nguyên tempHigh/humHigh cũ
  }
  dhtOk = true;
  temperature = t;
  humidity = h;

  tempHigh = tempHigh ? (t > cfgTempHigh - TEMP_HUM_HYSTERESIS) : (t >= cfgTempHigh);
  humHigh  = humHigh  ? (h > cfgHumHigh  - TEMP_HUM_HYSTERESIS) : (h >= cfgHumHigh);
}

void readPir() {
  if (!pirReady()) return;
  bool m = digitalRead(PIN_PIR) == HIGH;
  if (m != motion) {
    motion = m;
    Serial.printf("[PIR] motion=%s\n", motion ? "true" : "false");
    publishPir();
  }
}

// ================================================================
// MQTT
// ================================================================
void loadConfig() {
  prefs.begin("cfg", true);
  cfgMq2Warning = prefs.getInt("mq2w", MQ2_WARNING_RAW);
  cfgMq2Danger  = prefs.getInt("mq2d", MQ2_DANGER_RAW);
  cfgTempHigh   = prefs.getFloat("temp", TEMP_HIGH_C);
  cfgHumHigh    = prefs.getFloat("hum", HUM_HIGH_PCT);
  prefs.end();
  Serial.printf("[CFG] mq2Warning=%d mq2Danger=%d tempHigh=%.1f humHigh=%.1f\n",
                cfgMq2Warning, cfgMq2Danger, cfgTempHigh, cfgHumHigh);
}

void handleConfigCmd(JsonDocument& doc) {
  // Trường nào không gửi thì giữ giá trị cũ
  int   w = doc["mq2Warning"] | cfgMq2Warning;
  int   d = doc["mq2Danger"]  | cfgMq2Danger;
  float t = doc["tempHigh"]   | cfgTempHigh;
  float h = doc["humHigh"]    | cfgHumHigh;

  if (w < MQ2_HYSTERESIS_RAW || d > 4095 || d <= w + MQ2_HYSTERESIS_RAW) {
    Serial.println("[CFG] rejected: cần mq2Warning < mq2Danger <= 4095");
    publishConfig("invalid_mq2_threshold");
    return;
  }
  if (t < 0 || t > 80 || h < 0 || h > 100) {
    Serial.println("[CFG] rejected: tempHigh/humHigh ngoài khoảng");
    publishConfig("invalid_temp_hum_threshold");
    return;
  }

  bool changed = w != cfgMq2Warning || d != cfgMq2Danger || t != cfgTempHigh || h != cfgHumHigh;
  if (changed) {
    cfgMq2Warning = w; cfgMq2Danger = d; cfgTempHigh = t; cfgHumHigh = h;
    prefs.begin("cfg", false);
    prefs.putInt("mq2w", w);
    prefs.putInt("mq2d", d);
    prefs.putFloat("temp", t);
    prefs.putFloat("hum", h);
    prefs.end();
    Serial.printf("[CFG] updated: mq2Warning=%d mq2Danger=%d tempHigh=%.1f humHigh=%.1f\n", w, d, t, h);
  }
  publishConfig();
}

void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, len);
  if (err) {
    Serial.printf("[CMD] invalid JSON on %s: %s\n", topic, err.c_str());
    return;
  }

  if (strcmp(topic, T_CMD_CONFIG) == 0) {
    handleConfigCmd(doc);
    return;
  }
  if (strcmp(topic, T_CMD_FAN) != 0) return;

  const char* mode  = doc["mode"];
  const char* state = doc["state"];

  if (mode && strcmp(mode, "auto") == 0) {
    fanMode = FAN_AUTO;
  } else if (state && strcmp(state, "on") == 0) {
    fanMode = FAN_MANUAL; manualFanOn = true;
  } else if (state && strcmp(state, "off") == 0) {
    fanMode = FAN_MANUAL; manualFanOn = false;
  } else {
    Serial.println("[CMD] unknown command");
    return;
  }

  Serial.printf("[CMD] fan mode=%s manual=%s\n",
                fanMode == FAN_AUTO ? "auto" : "manual", manualFanOn ? "on" : "off");
  updateFan(true);   // luôn publish trạng thái để server biết lệnh đã được nhận
}

void ensureMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (millis() - lastMqttRetry < MQTT_RETRY_MS) return;
  lastMqttRetry = millis();

  Serial.printf("[MQTT] connecting to %s:%d ...\n", MQTT_HOST, MQTT_PORT);
  const char* user = strlen(MQTT_USER) ? MQTT_USER : nullptr;
  const char* pass = strlen(MQTT_USER) ? MQTT_PASSWORD : nullptr;

  if (mqtt.connect(DEVICE_ID, user, pass, T_ONLINE, 1, true, OFFLINE_MSG)) {
    Serial.println("[MQTT] connected");
    mqtt.publish(T_ONLINE, ONLINE_MSG, true);
    mqtt.subscribe(T_CMD_FAN, 1);
    mqtt.subscribe(T_CMD_CONFIG, 1);
    publishConfig();
    publishFanStatus();
    publishDeviceStatus();
    publishMq2();
    publishDht();
    publishPir();
  } else {
    Serial.printf("[MQTT] failed, rc=%d\n", mqtt.state());
  }
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiRetry < WIFI_RETRY_MS) return;
  lastWifiRetry = millis();
  Serial.println("[WiFi] reconnecting ...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// ================================================================
// Setup / Loop
// ================================================================
void setup() {
  Serial.begin(115200);
  bootAt = millis();

  // Đặt mức "tắt" trước khi bật OUTPUT để relay không bị nhấp lúc khởi động
  writeRelay(false);
  pinMode(PIN_RELAY, OUTPUT);
  writeRelay(false);

  pinMode(PIN_PIR, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_MQ2, ADC_11db);
  dht.begin();
  loadConfig();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiRetry = millis();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(512);
  mqtt.setSocketTimeout(3);

  Serial.printf("\n[BOOT] %s - MQ2 warm-up %lus, PIR warm-up %lus\n",
                DEVICE_ID, MQ2_WARMUP_MS / 1000, PIR_WARMUP_MS / 1000);
}

void loop() {
  unsigned long now = millis();

  // --- Luôn chạy, kể cả khi mất mạng ---
  if (now - lastMq2Read >= MQ2_READ_MS) { lastMq2Read = now; readMq2(); }
  if (now - lastDhtRead >= DHT_READ_MS) { lastDhtRead = now; readDht(); }
  readPir();
  updateFan();

  // --- Mạng ---
  ensureWifi();
  ensureMqtt();
  mqtt.loop();

  if (now - lastSensorPublish >= SENSOR_PUBLISH_MS) {
    lastSensorPublish = now;
    publishMq2();
    publishDht();
    Serial.printf("[DATA] mq2=%d (%dmV, %s) temp=%.1f hum=%.1f motion=%d fan=%s\n",
                  mq2Raw, mq2MilliV, smokeLevelStr(smokeLevel),
                  temperature, humidity, motion, fanOn ? "on" : "off");
  }
  if (now - lastDeviceStatus >= DEVICE_STATUS_MS) {
    lastDeviceStatus = now;
    publishDeviceStatus();
  }
}
