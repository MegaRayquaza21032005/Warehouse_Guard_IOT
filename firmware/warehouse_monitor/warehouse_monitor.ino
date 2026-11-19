/*
 * Warehouse Monitor - ESP32 (firmware v2)
 *
 * Cảm biến: MQ2 (GPIO34), DHT11 (GPIO4), PIR (GPIO27)
 * Thiết bị: quạt (GPIO26), phun sương (GPIO25), đèn (GPIO33) qua relay
 *
 * Logic an toàn (CLAUDE.md mục 5) nằm trong logic.h — test trên máy tính bằng
 * firmware/tests/run_tests.sh. File này lo phần cứng, MQTT, lưu cấu hình.
 *
 * Thư viện (Library Manager): PubSubClient, DHT sensor library (Adafruit)
 * + Adafruit Unified Sensor, ArduinoJson v7.
 *
 * Hợp đồng MQTT: CLAUDE.md mục 4.
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include "secrets.h"
#include "config.h"
#include "logic.h"

using namespace wm;

// ---------------- Topics ----------------
static const char* T_MQ2        = "warehouse/sensor/mq2";
static const char* T_DHT        = "warehouse/sensor/dht11";
static const char* T_PIR        = "warehouse/sensor/pir";
static const char* T_ONLINE     = "warehouse/status/online";
static const char* T_DEVICE     = "warehouse/status/device";
static const char* T_CONFIG     = "warehouse/status/config";
static const char* T_SAFETY     = "warehouse/status/safety";
static const char* T_CMD_CONFIG = "warehouse/cmd/config";

static const char* ONLINE_MSG   = "{\"status\":\"online\"}";
static const char* OFFLINE_MSG  = "{\"status\":\"offline\"}";

static const uint16_t CONFIG_VERSION = 2;

// ---------------- Thiết bị chấp hành ----------------
struct Device {
  const char* name;
  const char* cmdTopic;
  const char* statusTopic;
  uint8_t     pin;
  bool        activeLow;
  bool        actual = false;    // trạng thái relay thực tế
  bool        desired = false;   // trạng thái logic muốn
  Decision    dec = {false, "idle", false};
  ManualCtl   manual;
  // Bản đã publish (chỉ publish khi có thay đổi)
  bool        published = false;
  bool        pubOn = false;
  bool        pubManual = false;
  char        pubReason[24] = "";
  char        pubSource[12] = "";
  // Xác nhận lệnh gần nhất
  bool        ackPending = false;
  char        ackTrace[40] = "";
  const char* ackResult = "applied";
};

enum { DEV_FAN = 0, DEV_MIST = 1, DEV_LIGHT = 2, DEV_COUNT = 3 };
Device devices[DEV_COUNT];

// ---------------- Đối tượng ----------------
WiFiClient   wifiClient;
PubSubClient mqtt(wifiClient);
DHT          dht(PIN_DHT, DHT11);
Preferences  prefs;

// ---------------- Trạng thái ----------------
Config        cfg;
SafetyTracker safety;
HumFanTracker humFan;
MistTracker   mistTracker;
TempHistory   tempHistory;

unsigned long bootAt = 0;

int     mq2Raw = 0, mq2MilliV = 0;
MqLevel mqLevel = MQ_NORMAL;
bool    mq2LowPending = false, mq2HighPending = false;
unsigned long mq2LowSince = 0, mq2HighSince = 0;

float   temperature = NAN, humidity = NAN, tempRise = 0;
uint8_t dhtFailCount = 0;
bool    tempHot = false, humHighFlag = false;

bool    motion = false;
uint8_t faults = 0;

bool        safetyPublished = false;
SafetyState pubSafety = SAFE_NORMAL;
uint8_t     pubFaults = 0;

unsigned long lastMq2Read = 0, lastDhtRead = 0, lastHistSample = 0, lastSensorPublish = 0;
unsigned long lastDeviceStatus = 0, lastWifiRetry = 0, lastMqttRetry = 0, lastRelaySwitch = 0;
bool histSampled = false;

// ================================================================
// Tiện ích
// ================================================================
bool mq2Ready() { return millis() - bootAt >= MQ2_WARMUP_MS; }
bool pirReady() { return millis() - bootAt >= PIR_WARMUP_MS; }
bool dhtFaulted() { return faults & FAULT_DHT_FAILED; }

bool publishJson(const char* topic, JsonDocument& doc, bool retained = false) {
  if (!mqtt.connected()) return false;
  char buf[512];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  return mqtt.publish(topic, (const uint8_t*)buf, n, retained);
}

void copyStr(char* dst, size_t size, const char* src) {
  strncpy(dst, src ? src : "", size - 1);
  dst[size - 1] = '\0';
}

void writeRelay(const Device& d, bool on) {
  bool level = d.activeLow ? !on : on;
  digitalWrite(d.pin, level ? HIGH : LOW);
}

// ================================================================
// Cấu hình (flash)
// ================================================================
void loadConfig() {
  prefs.begin("cfg", true);
  Config stored;
  bool ok = prefs.getUShort("ver", 0) == CONFIG_VERSION &&
            prefs.getBytesLength("data") == sizeof(Config) &&
            prefs.getBytes("data", &stored, sizeof(Config)) == sizeof(Config) &&
            validateConfig(stored) == nullptr;
  prefs.end();
  cfg = ok ? stored : Config();
  Serial.printf("[CFG] %s: mq2 %ld/%ld, temp %.1f, hum %.1f, rise %.1f°C/%umin\n",
                ok ? "loaded" : "defaults", (long)cfg.mq2Warning, (long)cfg.mq2Danger,
                cfg.tempHigh, cfg.humHigh, cfg.tempRiseC, cfg.tempRiseWindowMin);
}

void saveConfig() {
  prefs.begin("cfg", false);
  prefs.putBytes("data", &cfg, sizeof(Config));
  prefs.putUShort("ver", CONFIG_VERSION);
  prefs.end();
}

void publishConfig(const char* error = nullptr) {
  JsonDocument doc;
  doc["mq2Warning"]        = cfg.mq2Warning;
  doc["mq2Danger"]         = cfg.mq2Danger;
  doc["tempHigh"]          = cfg.tempHigh;
  doc["humHigh"]           = cfg.humHigh;
  doc["tempRiseC"]         = cfg.tempRiseC;
  doc["tempRiseWindowMin"] = cfg.tempRiseWindowMin;
  doc["mistFireMaxMin"]    = cfg.mistFireMaxMin;
  doc["mistCoolMaxMin"]    = cfg.mistCoolMaxMin;
  doc["mistCooldownMin"]   = cfg.mistCooldownMin;
  doc["mistHumMax"]        = cfg.mistHumMax;
  doc["humFanCheckMin"]    = cfg.humFanCheckMin;
  doc["humFanMinDrop"]     = cfg.humFanMinDrop;
  if (error) doc["error"] = error;
  publishJson(T_CONFIG, doc, true);
}

void handleConfigCmd(JsonDocument& doc) {
  // Trường nào không gửi thì giữ giá trị cũ
  Config c = cfg;
  c.mq2Warning        = doc["mq2Warning"]        | c.mq2Warning;
  c.mq2Danger         = doc["mq2Danger"]         | c.mq2Danger;
  c.tempHigh          = doc["tempHigh"]          | c.tempHigh;
  c.humHigh           = doc["humHigh"]           | c.humHigh;
  c.tempRiseC         = doc["tempRiseC"]         | c.tempRiseC;
  c.tempRiseWindowMin = doc["tempRiseWindowMin"] | c.tempRiseWindowMin;
  c.mistFireMaxMin    = doc["mistFireMaxMin"]    | c.mistFireMaxMin;
  c.mistCoolMaxMin    = doc["mistCoolMaxMin"]    | c.mistCoolMaxMin;
  c.mistCooldownMin   = doc["mistCooldownMin"]   | c.mistCooldownMin;
  c.mistHumMax        = doc["mistHumMax"]        | c.mistHumMax;
  c.humFanCheckMin    = doc["humFanCheckMin"]    | c.humFanCheckMin;
  c.humFanMinDrop     = doc["humFanMinDrop"]     | c.humFanMinDrop;

  const char* err = validateConfig(c);
  if (err) {
    Serial.printf("[CFG] rejected: %s\n", err);
    publishConfig(err);
    return;
  }
  if (memcmp(&c, &cfg, sizeof(Config)) != 0) {
    cfg = c;
    saveConfig();
    Serial.println("[CFG] updated + saved");
  }
  publishConfig();
}

// ================================================================
// Publish
// ================================================================
void publishMq2() {
  JsonDocument doc;
  doc["raw"]       = mq2Raw;
  doc["mv"]        = mq2MilliV;
  doc["level"]     = mqLevelStr(mqLevel);
  doc["warmingUp"] = !mq2Ready();
  publishJson(T_MQ2, doc);
}

void publishDht() {
  JsonDocument doc;
  if (!isnan(temperature) && dhtFailCount == 0) {
    doc["temp"]     = serialized(String(temperature, 1));
    doc["hum"]      = serialized(String(humidity, 1));
    doc["tempRise"] = serialized(String(tempRise, 1));
  } else {
    doc["error"]     = "read_failed";
    doc["failCount"] = dhtFailCount;
  }
  publishJson(T_DHT, doc);
}

void publishPir() {
  JsonDocument doc;
  doc["motion"] = motion;
  publishJson(T_PIR, doc);
}

void publishSafety() {
  JsonDocument doc;
  doc["state"]    = safetyStr(safety.state);
  doc["mq2Level"] = mqLevelStr(mqLevel);
  doc["tempRise"] = serialized(String(tempRise, 1));
  JsonArray arr = doc["faults"].to<JsonArray>();
  if (faults & FAULT_MQ2_DISCONNECTED) arr.add("mq2_disconnected");
  if (faults & FAULT_MQ2_SATURATED)    arr.add("mq2_saturated");
  if (faults & FAULT_DHT_FAILED)       arr.add("dht_failed");
  if (publishJson(T_SAFETY, doc, true)) {
    safetyPublished = true; pubSafety = safety.state; pubFaults = faults;
  }
}

void publishDeviceStatus() {
  JsonDocument doc;
  doc["id"]     = DEVICE_ID;
  doc["uptime"] = millis() / 1000;
  doc["rssi"]   = WiFi.RSSI();
  doc["ip"]     = WiFi.localIP().toString();
  publishJson(T_DEVICE, doc);
}

const char* deviceSource(const Device& d) {
  return d.dec.fromManual ? d.manual.source : "esp32_local";
}

void publishDevice(Device& d) {
  JsonDocument doc;
  doc["state"]  = d.actual ? "on" : "off";
  doc["mode"]   = d.manual.active ? "manual" : "auto";
  doc["reason"] = d.dec.reason;
  doc["source"] = deviceSource(d);
  if (d.dec.fromManual && d.manual.traceId[0]) doc["trace_id"] = d.manual.traceId;
  else                                         doc["trace_id"] = nullptr;
  if (d.ackPending) {
    JsonObject ack = doc["ack"].to<JsonObject>();
    ack["trace_id"] = d.ackTrace;
    ack["result"]   = d.ackResult;
  }
  if (publishJson(d.statusTopic, doc, true)) {
    d.published = true;
    d.pubOn = d.actual;
    d.pubManual = d.manual.active;
    copyStr(d.pubReason, sizeof(d.pubReason), d.dec.reason);
    copyStr(d.pubSource, sizeof(d.pubSource), deviceSource(d));
    d.ackPending = false;
  }
}

// Publish khi relay đã ổn định (actual == desired) và có gì đó thay đổi
void publishDeviceChanges() {
  for (Device& d : devices) {
    if (d.actual != d.desired) continue;
    bool changed = !d.published || d.pubOn != d.actual || d.pubManual != d.manual.active ||
                   strcmp(d.pubReason, d.dec.reason) != 0 ||
                   strcmp(d.pubSource, deviceSource(d)) != 0;
    if (changed || d.ackPending) publishDevice(d);
  }
}

// ================================================================
// Cảm biến
// ================================================================
void readMq2(unsigned long now) {
  const int samples = 10;
  long sumRaw = 0, sumMv = 0;
  for (int i = 0; i < samples; i++) {
    sumRaw += analogRead(PIN_MQ2);
    sumMv  += analogReadMilliVolts(PIN_MQ2);
    delayMicroseconds(200);
  }
  mq2Raw    = sumRaw / samples;
  mq2MilliV = sumMv / samples;

  // Lỗi cảm biến: 0 liên tục = đứt dây (cầu chia áp kéo về GND); 4095 liên tục = bão hòa
  if (mq2Raw <= MQ2_FAULT_LOW_RAW) {
    if (!mq2LowPending) { mq2LowPending = true; mq2LowSince = now; }
    else if (now - mq2LowSince >= MQ2_FAULT_MS) faults |= FAULT_MQ2_DISCONNECTED;
  } else { mq2LowPending = false; faults &= ~FAULT_MQ2_DISCONNECTED; }

  if (mq2Raw >= MQ2_FAULT_HIGH_RAW) {
    if (!mq2HighPending) { mq2HighPending = true; mq2HighSince = now; }
    else if (now - mq2HighSince >= MQ2_FAULT_MS) faults |= FAULT_MQ2_SATURATED;
  } else { mq2HighPending = false; faults &= ~FAULT_MQ2_SATURATED; }

  // Bão hòa vẫn được tính là nguy hiểm (có thể là khí rất nhiều)
  MqLevel lvl = mq2Ready() ? evalMq(mq2Raw, mqLevel, cfg) : MQ_NORMAL;
  if (lvl != mqLevel) {
    Serial.printf("[MQ2] %s -> %s (raw=%d)\n", mqLevelStr(mqLevel), mqLevelStr(lvl), mq2Raw);
    mqLevel = lvl;
    publishMq2();
  }
}

void readDht(unsigned long now) {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) {
    if (dhtFailCount < 255) dhtFailCount++;
    if (dhtFailCount >= DHT_FAULT_COUNT && !dhtFaulted()) {
      faults |= FAULT_DHT_FAILED;
      tempHot = false; humHighFlag = false; tempRise = 0;
      tempHistory.clear(); histSampled = false;
      Serial.println("[DHT] FAULT: đọc lỗi liên tiếp");
    }
    return;
  }
  if (dhtFaulted()) Serial.println("[DHT] phục hồi");
  dhtFailCount = 0;
  faults &= ~FAULT_DHT_FAILED;
  temperature = t;
  humidity = h;

  tempHot     = hystHigh(tempHot, t, cfg.tempHigh, TEMP_HUM_HYSTERESIS);
  humHighFlag = hystHigh(humHighFlag, h, cfg.humHigh, TEMP_HUM_HYSTERESIS);

  if (!histSampled || now - lastHistSample >= TEMP_HISTORY_SAMPLE_MS) {
    tempHistory.add(now, t);
    lastHistSample = now; histSampled = true;
  }
  tempRise = tempHistory.riseOver(now, (uint32_t)cfg.tempRiseWindowMin * 60000UL, t);
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
// An toàn + quyết định thiết bị
// ================================================================
void updateSafety(unsigned long now) {
  const bool heatKnown  = !dhtFaulted() && !isnan(temperature);
  const bool tempRising = heatKnown && tempRise >= cfg.tempRiseC;
  SafetyState prev = safety.state;
  SafetyState target = computeTarget(mqLevel, heatKnown, tempHot, tempRising, safety.state);
  safety.update(target, now, SAFETY_EXIT_HOLD_MS);
  if (safety.state != prev) {
    Serial.printf("[SAFETY] %s -> %s\n", safetyStr(prev), safetyStr(safety.state));
  }
  if (!safetyPublished || safety.state != pubSafety || faults != pubFaults) publishSafety();
}

void updateDevices(unsigned long now) {
  Inputs in;
  in.now      = now;
  in.safety   = safety.state;
  in.tempHot  = tempHot;
  in.humHigh  = humHighFlag;
  in.humKnown = !dhtFaulted() && !isnan(humidity);
  in.hum      = in.humKnown ? humidity : 0;

  for (Device& d : devices) d.manual.tick(now);

  devices[DEV_FAN].dec   = decideFan(in, devices[DEV_FAN].manual, humFan, cfg);
  devices[DEV_MIST].dec  = decideMist(in, devices[DEV_MIST].manual, mistTracker, cfg);
  devices[DEV_LIGHT].dec = decideLight(in, devices[DEV_LIGHT].manual);
  for (Device& d : devices) d.desired = d.dec.on;
}

// Mỗi lần chỉ đóng/ngắt MỘT relay, cách nhau RELAY_STAGGER_MS. Ưu tiên TẮT trước.
void applyRelays(unsigned long now) {
  if (now - lastRelaySwitch < RELAY_STAGGER_MS) return;
  Device* pick = nullptr;
  for (Device& d : devices) if (d.actual && !d.desired) { pick = &d; break; }
  if (!pick) for (Device& d : devices) if (!d.actual && d.desired) { pick = &d; break; }
  if (!pick) return;
  writeRelay(*pick, pick->desired);
  pick->actual = pick->desired;
  lastRelaySwitch = now;
  Serial.printf("[RELAY] %s %s (%s)\n", pick->name, pick->actual ? "ON" : "OFF", pick->dec.reason);
}

// ================================================================
// Lệnh MQTT
// ================================================================
bool validSource(const char* s) {
  return strcmp(s, "user") == 0 || strcmp(s, "rule") == 0 || strcmp(s, "agent") == 0;
}

void setAck(Device& d, const char* trace, const char* result) {
  d.ackPending = true;
  copyStr(d.ackTrace, sizeof(d.ackTrace), trace);
  d.ackResult = result;
}

void handleDeviceCmd(Device& d, JsonDocument& doc) {
  const char* source = doc["source"]   | "user";
  const char* trace  = doc["trace_id"] | "";
  const char* mode   = doc["mode"];
  const char* state  = doc["state"];

  if (!validSource(source)) { setAck(d, trace, "invalid_source"); return; }

  // Lệnh của người dùng ưu tiên hơn rule / agent
  if (strcmp(source, "user") != 0 && d.manual.setByUser()) {
    Serial.printf("[CMD] %s: bỏ qua lệnh %s (người dùng đang điều khiển)\n", d.name, source);
    setAck(d, trace, "ignored_user_priority");
    return;
  }

  if (mode && strcmp(mode, "auto") == 0) {
    d.manual.clear();
  } else if (state && (strcmp(state, "on") == 0 || strcmp(state, "off") == 0)) {
    long durS = doc["duration_s"] | 0L;   // 0 = không hết hạn
    if (durS < 0) durS = 0;
    if (durS > 86400) durS = 86400;
    d.manual.active     = true;
    d.manual.on         = strcmp(state, "on") == 0;
    d.manual.start      = millis();
    d.manual.durationMs = (uint32_t)durS * 1000UL;
    copyStr(d.manual.source,  sizeof(d.manual.source),  source);
    copyStr(d.manual.reason,  sizeof(d.manual.reason),  doc["reason"] | "manual");
    copyStr(d.manual.traceId, sizeof(d.manual.traceId), trace);
  } else {
    setAck(d, trace, "invalid_command");
    return;
  }
  Serial.printf("[CMD] %s: %s %s (source=%s)\n", d.name,
                d.manual.active ? "manual" : "auto",
                d.manual.active ? (d.manual.on ? "on" : "off") : "", source);
  setAck(d, trace, "applied");
}

void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, len);
  if (err) {
    Serial.printf("[CMD] invalid JSON on %s: %s\n", topic, err.c_str());
    return;
  }
  if (strcmp(topic, T_CMD_CONFIG) == 0) { handleConfigCmd(doc); return; }
  for (Device& d : devices) {
    if (strcmp(topic, d.cmdTopic) == 0) { handleDeviceCmd(d, doc); return; }
  }
}

// ================================================================
// Mạng
// ================================================================
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
    mqtt.subscribe(T_CMD_CONFIG, 1);
    for (Device& d : devices) { mqtt.subscribe(d.cmdTopic, 1); d.published = false; }
    safetyPublished = false;
    publishConfig();
    publishSafety();
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
void initDevice(Device& d, const char* name, const char* cmd, const char* status,
                uint8_t pin, bool activeLow) {
  d.name = name; d.cmdTopic = cmd; d.statusTopic = status;
  d.pin = pin; d.activeLow = activeLow;
  // Đặt mức "tắt" trước khi bật OUTPUT để relay không nhấp lúc khởi động
  writeRelay(d, false);
  pinMode(pin, OUTPUT);
  writeRelay(d, false);
}

void setup() {
  Serial.begin(115200);
  bootAt = millis();

  initDevice(devices[DEV_FAN],   "fan",   "warehouse/cmd/fan",   "warehouse/status/fan",   PIN_FAN,   FAN_ACTIVE_LOW);
  initDevice(devices[DEV_MIST],  "mist",  "warehouse/cmd/mist",  "warehouse/status/mist",  PIN_MIST,  MIST_ACTIVE_LOW);
  initDevice(devices[DEV_LIGHT], "light", "warehouse/cmd/light", "warehouse/status/light", PIN_LIGHT, LIGHT_ACTIVE_LOW);

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
  mqtt.setBufferSize(1024);
  mqtt.setSocketTimeout(3);

  Serial.printf("\n[BOOT] %s v2 - MQ2 warm-up %lus, PIR warm-up %lus\n",
                DEVICE_ID, MQ2_WARMUP_MS / 1000, PIR_WARMUP_MS / 1000);
}

void loop() {
  unsigned long now = millis();

  // --- Luôn chạy, kể cả khi mất mạng ---
  if (now - lastMq2Read >= MQ2_READ_MS) { lastMq2Read = now; readMq2(now); }
  if (now - lastDhtRead >= DHT_READ_MS) { lastDhtRead = now; readDht(now); }
  readPir();
  updateSafety(now);
  updateDevices(now);
  applyRelays(now);

  // --- Mạng ---
  ensureWifi();
  ensureMqtt();
  mqtt.loop();
  publishDeviceChanges();

  if (now - lastSensorPublish >= SENSOR_PUBLISH_MS) {
    lastSensorPublish = now;
    publishMq2();
    publishDht();
    Serial.printf("[DATA] mq2=%d(%s) temp=%.1f hum=%.1f rise=%.1f safety=%s fan=%d mist=%d light=%d\n",
                  mq2Raw, mqLevelStr(mqLevel), temperature, humidity, tempRise,
                  safetyStr(safety.state), devices[DEV_FAN].actual,
                  devices[DEV_MIST].actual, devices[DEV_LIGHT].actual);
  }
  if (now - lastDeviceStatus >= DEVICE_STATUS_MS) {
    lastDeviceStatus = now;
    publishDeviceStatus();
  }
}
