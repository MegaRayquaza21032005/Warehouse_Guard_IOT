#pragma once
// Logic an toàn & quyết định thiết bị — C++ THUẦN, không phụ thuộc Arduino,
// để test được trên máy tính (firmware/tests/test_logic.cpp).
// Đặc tả: CLAUDE.md mục 5. Mọi thời gian tính bằng millis(), so sánh bằng phép trừ
// (an toàn khi millis() tràn sau ~49 ngày).

#include <stdint.h>
#include <string.h>
#include "config.h"

namespace wm {

// ------------------------------------------------------------------
// Kiểu dữ liệu
// ------------------------------------------------------------------
enum MqLevel : uint8_t { MQ_NORMAL = 0, MQ_WARNING = 1, MQ_DANGER = 2 };

// Thứ tự tăng dần mức nguy hiểm — dùng để so sánh lên / xuống
enum SafetyState : uint8_t { SAFE_NORMAL = 0, SAFE_GAS = 1, SAFE_GAS_DANGER = 2, SAFE_FIRE = 3 };

enum Fault : uint8_t {
  FAULT_MQ135_DISCONNECTED = 1 << 0,
  FAULT_MQ135_SATURATED    = 1 << 1,
  FAULT_DHT_FAILED       = 1 << 2,
};

inline const char* mqLevelStr(MqLevel l) {
  return l == MQ_DANGER ? "danger" : l == MQ_WARNING ? "warning" : "normal";
}
inline const char* safetyStr(SafetyState s) {
  switch (s) {
    case SAFE_GAS:        return "gas";
    case SAFE_GAS_DANGER: return "gas_danger";
    case SAFE_FIRE:       return "fire";
    default:              return "normal";
  }
}

// Cấu hình chỉnh được qua MQTT (lưu flash)
struct Config {
  int32_t  mq135Warning        = DEF_MQ135_WARNING;
  int32_t  mq135Danger         = DEF_MQ135_DANGER;
  float    tempHigh          = DEF_TEMP_HIGH;
  float    humHigh           = DEF_HUM_HIGH;
  float    tempRiseC         = DEF_TEMP_RISE_C;
  uint16_t tempRiseWindowMin = DEF_TEMP_RISE_WIN_MIN;
  uint16_t mistFireMaxMin    = DEF_MIST_FIRE_MAX_MIN;
  uint16_t mistCoolMaxMin    = DEF_MIST_COOL_MAX_MIN;
  uint16_t mistCooldownMin   = DEF_MIST_COOLDOWN_MIN;
  float    mistHumMax        = DEF_MIST_HUM_MAX;
  uint16_t humFanCheckMin    = DEF_HUM_FAN_CHECK_MIN;
  float    humFanMinDrop     = DEF_HUM_FAN_MIN_DROP;
};

// Trả về nullptr nếu hợp lệ, ngược lại là mã lỗi
inline const char* validateConfig(const Config& c) {
  if (c.mq135Warning < MQ135_HYSTERESIS_RAW || c.mq135Danger > 4095 ||
      c.mq135Danger <= c.mq135Warning + MQ135_HYSTERESIS_RAW)        return "invalid_mq135_threshold";
  if (c.tempHigh < 0 || c.tempHigh > 80)                       return "invalid_temp_high";
  if (c.humHigh < 10 || c.humHigh > 100)                       return "invalid_hum_high";
  if (c.tempRiseC < 0.5f || c.tempRiseC > 20)                  return "invalid_temp_rise";
  if (c.tempRiseWindowMin < 1 || c.tempRiseWindowMin > 15)     return "invalid_temp_rise_window";
  if (c.mistFireMaxMin < 1 || c.mistFireMaxMin > 60)           return "invalid_mist_fire_max";
  if (c.mistCoolMaxMin < 1 || c.mistCoolMaxMin > 60)           return "invalid_mist_cool_max";
  if (c.mistCooldownMin > 240)                                 return "invalid_mist_cooldown";
  if (c.mistHumMax < 10 || c.mistHumMax >= c.humHigh)          return "invalid_mist_hum_max";
  if (c.humFanCheckMin < 5 || c.humFanCheckMin > 240)          return "invalid_hum_fan_check";
  if (c.humFanMinDrop < 0.5f || c.humFanMinDrop > 50)          return "invalid_hum_fan_drop";
  return nullptr;
}

// ------------------------------------------------------------------
// Ngưỡng có hysteresis
// ------------------------------------------------------------------
inline bool hystHigh(bool cur, float v, float threshold, float hyst) {
  return cur ? (v > threshold - hyst) : (v >= threshold);
}

inline MqLevel evalMq(int raw, MqLevel cur, const Config& c) {
  const int warnOff   = c.mq135Warning - MQ135_HYSTERESIS_RAW;
  const int dangerOff = c.mq135Danger  - MQ135_HYSTERESIS_RAW;
  switch (cur) {
    case MQ_NORMAL:
      if (raw >= c.mq135Danger)  return MQ_DANGER;
      if (raw >= c.mq135Warning) return MQ_WARNING;
      return MQ_NORMAL;
    case MQ_WARNING:
      if (raw >= c.mq135Danger) return MQ_DANGER;
      if (raw < warnOff)      return MQ_NORMAL;
      return MQ_WARNING;
    case MQ_DANGER:
      if (raw < warnOff)   return MQ_NORMAL;
      if (raw < dangerOff) return MQ_WARNING;
      return MQ_DANGER;
  }
  return MQ_NORMAL;
}

// ------------------------------------------------------------------
// Lịch sử nhiệt độ — phát hiện "tăng nhanh"
// ------------------------------------------------------------------
struct TempHistory {
  static const uint8_t CAP = 32;  // 32 mẫu x 30s = 16 phút (đủ cho cửa sổ tối đa 15 phút)
  float    v[CAP];
  uint32_t t[CAP];
  uint8_t  n = 0, head = 0;

  void clear() { n = 0; head = 0; }

  void add(uint32_t now, float temp) {
    v[head] = temp; t[head] = now;
    head = (head + 1) % CAP;
    if (n < CAP) n++;
  }

  // Mức tăng = nhiệt độ hiện tại - nhiệt độ thấp nhất trong cửa sổ (>= 0)
  float riseOver(uint32_t now, uint32_t windowMs, float current) const {
    bool found = false;
    float minV = current;
    for (uint8_t i = 0; i < n; i++) {
      if (now - t[i] <= windowMs) {
        if (!found || v[i] < minV) minV = v[i];
        found = true;
      }
    }
    float r = current - minV;
    return r > 0 ? r : 0;
  }
};

// ------------------------------------------------------------------
// Trạng thái an toàn
// ------------------------------------------------------------------
// heatKnown = false khi DHT11 hỏng: không biết nhiệt độ. Nếu đang "fire" thì GIỮ "fire"
// (cảm biến có thể hỏng chính vì cháy) — tránh hạ xuống gas_danger rồi bật quạt thổi thêm oxy.
// cameraFire: camera (YOLO lửa / khói) đang thấy LỬA — tính là bằng chứng "nóng" như nhiệt độ cao:
//   MQ135 có khói + camera thấy lửa => fire (tắt quạt) dù DHT11 ở xa đám cháy chưa thấy nóng.
//   Chỉ camera thấy lửa (MQ135 bình thường) KHÔNG đổi trạng thái — tầng luật ai-agent cảnh báo + bật đèn.
//   Camera thấy KHÓI không tính (hơi sương của máy phun / hơi nước dễ bị nhận nhầm là khói).
inline SafetyState computeTarget(MqLevel mq, bool heatKnown, bool tempHot, bool tempRising,
                                 SafetyState current, bool cameraFire = false) {
  if (mq < MQ_WARNING) return SAFE_NORMAL;
  bool heat = cameraFire || (heatKnown ? (tempHot || tempRising) : (current == SAFE_FIRE));
  if (heat)            return SAFE_FIRE;
  if (mq == MQ_DANGER) return SAFE_GAS_DANGER;
  return SAFE_GAS;
}

// Camera thấy lửa (warehouse/sensor/camera, service vision trên laptop). Bằng chứng tự HẾT HẠN sau ttlMs
// kể từ bản tin cuối (vision gửi 5s/lần) — vision chết / mất mạng thì ESP32 quay về chỉ dùng cảm biến của mình.
struct CameraFireTracker {
  bool     fire = false;
  bool     seen = false;
  uint32_t lastMsg = 0;

  // fireField: 1 = "fire":true, 0 = "fire":false, -1 = không có trường fire / có "error" (không biết)
  void onMessage(int fireField, uint32_t now) {
    seen = true; lastMsg = now;
    fire = (fireField == 1);
  }
  bool active(uint32_t now, uint32_t ttlMs) const {
    return seen && fire && (now - lastMsg) < ttlMs;
  }
};

// Lên mức nguy hiểm hơn: NGAY. Xuống mức thấp hơn: chỉ khi mức mới giữ liên tục holdMs.
struct SafetyTracker {
  SafetyState state = SAFE_NORMAL;
  bool        lowerPending = false;
  uint32_t    lowerSince = 0;

  SafetyState update(SafetyState target, uint32_t now, uint32_t holdMs) {
    if (target > state) {
      state = target; lowerPending = false;
    } else if (target < state) {
      if (!lowerPending) { lowerPending = true; lowerSince = now; }
      else if (now - lowerSince >= holdMs) { state = target; lowerPending = false; }
    } else {
      lowerPending = false;
    }
    return state;
  }
};

// ------------------------------------------------------------------
// Điều khiển thủ công (lệnh từ user / rule / agent)
// ------------------------------------------------------------------
struct ManualCtl {
  bool     active = false;
  bool     on = false;
  uint32_t start = 0;
  uint32_t durationMs = 0;      // 0 = không hết hạn
  char     source[8] = "user";  // user | rule | agent
  char     reason[24] = "manual";
  char     traceId[40] = "";

  void clear() { active = false; }

  // Hết hạn -> quay về auto
  void tick(uint32_t now) {
    if (active && durationMs > 0 && now - start >= durationMs) active = false;
  }

  bool setByUser() const { return active && strcmp(source, "user") == 0; }
};

// Kết quả quyết định cho một thiết bị
struct Decision {
  bool        on;
  const char* reason;
  bool        fromManual;   // true -> trạng thái do lệnh thủ công quyết định
};

// Đầu vào chung cho mọi quyết định
struct Inputs {
  uint32_t    now;
  SafetyState safety;
  bool        tempHot;    // nhiệt độ >= tempHigh (có hysteresis); false nếu DHT hỏng
  bool        humHigh;    // độ ẩm >= humHigh (có hysteresis); false nếu DHT hỏng
  bool        humKnown;   // DHT đọc được
  float       hum;
};

// ------------------------------------------------------------------
// Quạt — CLAUDE.md mục 5.2
// ------------------------------------------------------------------
// Theo dõi "thông gió không hiệu quả": quạt chạy vì ẩm humFanCheckMin phút mà ẩm giảm
// < humFanMinDrop -> tạm khóa luật "ẩm -> quạt" HUM_FAN_LOCK_MS.
struct HumFanTracker {
  bool     tracking = false;
  uint32_t start = 0;
  float    startHum = 0;
  bool     locked = false;
  uint32_t lockStart = 0;

  bool isLocked(uint32_t now) {
    if (locked && now - lockStart >= HUM_FAN_LOCK_MS) locked = false;
    return locked;
  }
};

inline Decision decideFan(const Inputs& in, const ManualCtl& m, HumFanTracker& hf, const Config& c) {
  if (in.safety == SAFE_FIRE)       { hf.tracking = false; return {false, "fire_off", false}; }
  if (in.safety == SAFE_GAS_DANGER) { hf.tracking = false; return {true, "gas_danger", false}; }
  if (m.active)                     { hf.tracking = false; return {m.on, m.reason, true}; }
  if (in.safety == SAFE_GAS)        { hf.tracking = false; return {true, "gas", false}; }

  if (in.humHigh) {
    if (!hf.isLocked(in.now)) {
      if (!hf.tracking) { hf.tracking = true; hf.start = in.now; hf.startHum = in.hum; }
      if (in.now - hf.start >= (uint32_t)c.humFanCheckMin * 60000UL) {
        if (hf.startHum - in.hum < c.humFanMinDrop) {
          hf.locked = true; hf.lockStart = in.now; hf.tracking = false;
        } else {
          hf.start = in.now; hf.startHum = in.hum;  // có hiệu quả -> đo tiếp chu kỳ mới
        }
      }
      if (!hf.locked) return {true, "hum_high", false};
    }
    // Đang khóa: chỉ còn luật nóng
    if (in.tempHot) return {true, "temp_high", false};
    return {false, "hum_ineffective", false};
  }

  hf.tracking = false;
  if (in.tempHot) return {true, "temp_high", false};
  return {false, "idle", false};
}

// ------------------------------------------------------------------
// Phun sương — CLAUDE.md mục 5.2
// ------------------------------------------------------------------
struct MistTracker {
  SafetyState lastSafety = SAFE_NORMAL;
  uint32_t    fireStart = 0;
  bool        fireExpired = false;
  bool        coolRunning = false;
  uint32_t    coolStart = 0;
  bool        coolingDown = false;
  uint32_t    cooldownStart = 0;
};

// m không const: khi bắt đầu cháy, xóa chế độ thủ công cũ để phun sương chắc chắn chạy.
inline Decision decideMist(const Inputs& in, ManualCtl& m, MistTracker& mt, const Config& c) {
  const bool enteringFire = (in.safety == SAFE_FIRE && mt.lastSafety != SAFE_FIRE);
  mt.lastSafety = in.safety;

  if (in.safety == SAFE_FIRE) {
    if (enteringFire) { m.clear(); mt.fireStart = in.now; mt.fireExpired = false; mt.coolRunning = false; }
    if (m.active) return {m.on, m.reason, true};  // người dùng tắt / bật lại trong lúc cháy
    if (mt.fireExpired || in.now - mt.fireStart >= (uint32_t)c.mistFireMaxMin * 60000UL) {
      mt.fireExpired = true;
      return {false, "fire_max_time", false};
    }
    return {true, "fire", false};
  }
  mt.fireExpired = false;

  if (in.safety == SAFE_GAS || in.safety == SAFE_GAS_DANGER) {
    mt.coolRunning = false;
    return {false, "blocked_gas", false};      // chỉ có khí/khói, không nóng -> không phun
  }
  if (in.humKnown && in.hum >= c.humHigh) {
    mt.coolRunning = false;
    return {false, "blocked_hum_high", false}; // cấm, kể cả thủ công
  }
  if (m.active) { mt.coolRunning = false; return {m.on, m.reason, true}; }

  // Làm mát: nóng + độ ẩm còn thấp, có thời gian chạy tối đa và thời gian nghỉ
  if (mt.coolingDown) {
    if (in.now - mt.cooldownStart < (uint32_t)c.mistCooldownMin * 60000UL) return {false, "cooldown", false};
    mt.coolingDown = false;
  }
  const bool wantCool = in.tempHot && in.humKnown && in.hum < c.mistHumMax;
  if (mt.coolRunning) {
    if (!wantCool || in.now - mt.coolStart >= (uint32_t)c.mistCoolMaxMin * 60000UL) {
      mt.coolRunning = false; mt.coolingDown = true; mt.cooldownStart = in.now;
      return {false, "cooldown", false};
    }
    return {true, "cooling", false};
  }
  if (wantCool) { mt.coolRunning = true; mt.coolStart = in.now; return {true, "cooling", false}; }
  return {false, "idle", false};
}

// ------------------------------------------------------------------
// Đèn — CLAUDE.md mục 5.2
// ------------------------------------------------------------------
inline Decision decideLight(const Inputs& in, const ManualCtl& m) {
  if (in.safety == SAFE_FIRE)       return {true, "fire", false};
  if (in.safety == SAFE_GAS_DANGER) return {true, "gas_danger", false};
  if (m.active)                     return {m.on, m.reason, true};
  return {false, "idle", false};
}

}  // namespace wm
