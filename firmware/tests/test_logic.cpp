// Test logic an toàn của firmware trên máy tính (không cần ESP32).
// Chạy:  ./firmware/tests/run_tests.sh
#include <cstdio>
#include <cstring>
#include "../warehouse_monitor/logic.h"

using namespace wm;

static int g_fail = 0, g_pass = 0;
#define CHECK(cond) do { if (cond) g_pass++; else { g_fail++; \
  std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_DEC(d, expOn, expReason) do { CHECK((d).on == (expOn)); \
  if (std::strcmp((d).reason, (expReason)) != 0) { g_fail++; \
    std::printf("  FAIL %s:%d  reason=%s, expected %s\n", __FILE__, __LINE__, (d).reason, (expReason)); } \
  else g_pass++; } while (0)

static const uint32_t MIN = 60000UL;

static Inputs mk(uint32_t now, SafetyState s, bool hot = false, float hum = 50, const Config& c = Config()) {
  Inputs in;
  in.now = now; in.safety = s; in.tempHot = hot;
  in.humKnown = true; in.hum = hum; in.humHigh = hum >= c.humHigh;
  return in;
}

static void setManual(ManualCtl& m, bool on, const char* src = "user", uint32_t now = 0, uint32_t dur = 0) {
  m.active = true; m.on = on; m.start = now; m.durationMs = dur;
  std::strncpy(m.source, src, sizeof(m.source) - 1);
  std::strcpy(m.reason, "manual");
}

static void test_config() {
  std::printf("config\n");
  Config c;
  CHECK(validateConfig(c) == nullptr);
  Config bad = c; bad.mq2Danger = bad.mq2Warning + 100;      CHECK(validateConfig(bad) != nullptr);
  bad = c; bad.mistHumMax = bad.humHigh;                      CHECK(validateConfig(bad) != nullptr);
  bad = c; bad.tempRiseWindowMin = 20;                        CHECK(validateConfig(bad) != nullptr);
  CHECK(c.mq2Warning == 1500);
}

static void test_mq_level() {
  std::printf("mq2 level + hysteresis\n");
  Config c;
  CHECK(evalMq(1000, MQ_NORMAL, c) == MQ_NORMAL);
  CHECK(evalMq(1500, MQ_NORMAL, c) == MQ_WARNING);
  CHECK(evalMq(2600, MQ_NORMAL, c) == MQ_DANGER);
  CHECK(evalMq(1400, MQ_WARNING, c) == MQ_WARNING);   // trong vùng hysteresis
  CHECK(evalMq(1340, MQ_WARNING, c) == MQ_NORMAL);
  CHECK(evalMq(2400, MQ_DANGER, c) == MQ_DANGER);
  CHECK(evalMq(2300, MQ_DANGER, c) == MQ_WARNING);
  CHECK(evalMq(4095, MQ_NORMAL, c) == MQ_DANGER);     // bão hòa vẫn là nguy hiểm
}

static void test_temp_history() {
  std::printf("temp rise\n");
  TempHistory h;
  h.add(0, 30);
  h.add(2 * MIN, 31);
  h.add(4 * MIN, 32);
  CHECK(h.riseOver(5 * MIN, 5 * MIN, 33.5f) > 3.4f);   // 33.5 - 30
  CHECK(h.riseOver(7 * MIN, 5 * MIN, 33.5f) < 2.6f);   // mẫu 30°C đã ra khỏi cửa sổ
  h.clear();
  CHECK(h.riseOver(0, 5 * MIN, 40) == 0);
  CHECK(h.riseOver(0, 5 * MIN, 40) == 0);
}

static void test_safety_target() {
  std::printf("safety target\n");
  CHECK(computeTarget(MQ_NORMAL, true, true, true, SAFE_NORMAL) == SAFE_NORMAL); // nóng mà không khói
  CHECK(computeTarget(MQ_WARNING, true, false, false, SAFE_NORMAL) == SAFE_GAS);
  CHECK(computeTarget(MQ_DANGER, true, false, false, SAFE_NORMAL) == SAFE_GAS_DANGER);
  CHECK(computeTarget(MQ_WARNING, true, true, false, SAFE_NORMAL) == SAFE_FIRE);  // khói + nóng
  CHECK(computeTarget(MQ_WARNING, true, false, true, SAFE_NORMAL) == SAFE_FIRE);  // khói + tăng nhanh
  CHECK(computeTarget(MQ_DANGER, true, true, false, SAFE_NORMAL) == SAFE_FIRE);
  // DHT hỏng: đang cháy thì giữ cháy, chưa cháy thì không tự suy ra cháy
  CHECK(computeTarget(MQ_DANGER, false, false, false, SAFE_FIRE) == SAFE_FIRE);
  CHECK(computeTarget(MQ_DANGER, false, false, false, SAFE_GAS) == SAFE_GAS_DANGER);
}

static void test_safety_tracker() {
  std::printf("safety tracker (lên ngay, xuống sau 2 phút)\n");
  SafetyTracker t;
  CHECK(t.update(SAFE_FIRE, 0, SAFETY_EXIT_HOLD_MS) == SAFE_FIRE);
  CHECK(t.update(SAFE_NORMAL, 1000, SAFETY_EXIT_HOLD_MS) == SAFE_FIRE);
  CHECK(t.update(SAFE_NORMAL, 60000, SAFETY_EXIT_HOLD_MS) == SAFE_FIRE);
  CHECK(t.update(SAFE_GAS, 61000, SAFETY_EXIT_HOLD_MS) == SAFE_FIRE);   // vẫn đang chờ hạ
  CHECK(t.update(SAFE_FIRE, 62000, SAFETY_EXIT_HOLD_MS) == SAFE_FIRE);  // nguy hiểm lại -> reset chờ
  CHECK(t.update(SAFE_NORMAL, 63000, SAFETY_EXIT_HOLD_MS) == SAFE_FIRE);
  CHECK(t.update(SAFE_NORMAL, 63000 + SAFETY_EXIT_HOLD_MS, SAFETY_EXIT_HOLD_MS) == SAFE_NORMAL);
  // millis() tràn số
  SafetyTracker w;
  uint32_t base = 0xFFFFFF00UL;
  w.update(SAFE_GAS, base, SAFETY_EXIT_HOLD_MS);
  w.update(SAFE_NORMAL, base + 10, SAFETY_EXIT_HOLD_MS);
  CHECK(w.update(SAFE_NORMAL, base + 10 + SAFETY_EXIT_HOLD_MS, SAFETY_EXIT_HOLD_MS) == SAFE_NORMAL);
}

static void test_fan() {
  std::printf("fan\n");
  Config c; ManualCtl m; HumFanTracker hf;
  CHECK_DEC(decideFan(mk(0, SAFE_FIRE, true), m, hf, c), false, "fire_off");
  setManual(m, true);
  CHECK_DEC(decideFan(mk(0, SAFE_FIRE), m, hf, c), false, "fire_off");      // cháy ghi đè thủ công
  setManual(m, false);
  CHECK_DEC(decideFan(mk(0, SAFE_GAS_DANGER), m, hf, c), true, "gas_danger"); // khí nhiều ghi đè thủ công
  CHECK_DEC(decideFan(mk(0, SAFE_GAS), m, hf, c), false, "manual");         // khí nhẹ: thủ công thắng
  m.clear();
  CHECK_DEC(decideFan(mk(0, SAFE_GAS), m, hf, c), true, "gas");
  CHECK_DEC(decideFan(mk(0, SAFE_NORMAL, true), m, hf, c), true, "temp_high");
  CHECK_DEC(decideFan(mk(0, SAFE_NORMAL), m, hf, c), false, "idle");
}

static void test_fan_hum_ineffective() {
  std::printf("fan: thông gió không hiệu quả\n");
  Config c; ManualCtl m; HumFanTracker hf;
  CHECK_DEC(decideFan(mk(0, SAFE_NORMAL, false, 85), m, hf, c), true, "hum_high");
  CHECK_DEC(decideFan(mk(29 * MIN, SAFE_NORMAL, false, 84), m, hf, c), true, "hum_high");
  // 30 phút giảm 1% < 3% -> khóa
  CHECK_DEC(decideFan(mk(30 * MIN, SAFE_NORMAL, false, 84), m, hf, c), false, "hum_ineffective");
  CHECK_DEC(decideFan(mk(31 * MIN, SAFE_NORMAL, true, 84), m, hf, c), true, "temp_high"); // khóa ẩm nhưng nóng vẫn bật
  CHECK_DEC(decideFan(mk(60 * MIN, SAFE_NORMAL, false, 84), m, hf, c), false, "hum_ineffective");
  // hết 60 phút khóa -> thử lại
  CHECK_DEC(decideFan(mk(91 * MIN, SAFE_NORMAL, false, 84), m, hf, c), true, "hum_high");

  // Trường hợp có hiệu quả: không khóa
  HumFanTracker ok;
  decideFan(mk(0, SAFE_NORMAL, false, 90), m, ok, c);
  CHECK_DEC(decideFan(mk(30 * MIN, SAFE_NORMAL, false, 85), m, ok, c), true, "hum_high");
  CHECK(!ok.locked);
}

static void test_mist() {
  std::printf("mist\n");
  Config c; ManualCtl m; MistTracker mt;
  setManual(m, false);  // người dùng tắt từ trước
  CHECK_DEC(decideMist(mk(0, SAFE_FIRE, true, 85), m, mt, c), true, "fire");   // cháy: xóa thủ công cũ, phun kể cả ẩm cao
  CHECK(!m.active);
  setManual(m, false);  // người dùng tắt trong lúc cháy
  CHECK_DEC(decideMist(mk(MIN, SAFE_FIRE), m, mt, c), false, "manual");
  m.clear();
  CHECK_DEC(decideMist(mk(9 * MIN, SAFE_FIRE), m, mt, c), true, "fire");
  CHECK_DEC(decideMist(mk(10 * MIN, SAFE_FIRE), m, mt, c), false, "fire_max_time");
  CHECK_DEC(decideMist(mk(11 * MIN, SAFE_FIRE), m, mt, c), false, "fire_max_time");
  setManual(m, true);   // người dùng bật lại thủ công
  CHECK_DEC(decideMist(mk(12 * MIN, SAFE_FIRE), m, mt, c), true, "manual");

  ManualCtl m2; MistTracker mt2;
  setManual(m2, true);
  CHECK_DEC(decideMist(mk(0, SAFE_GAS), m2, mt2, c), false, "blocked_gas");        // chỉ khói: không phun
  CHECK_DEC(decideMist(mk(0, SAFE_GAS_DANGER), m2, mt2, c), false, "blocked_gas");
  CHECK_DEC(decideMist(mk(0, SAFE_NORMAL, false, 81), m2, mt2, c), false, "blocked_hum_high");
  CHECK_DEC(decideMist(mk(0, SAFE_NORMAL, false, 50), m2, mt2, c), true, "manual");
}

static void test_mist_cooling() {
  std::printf("mist: làm mát + cooldown\n");
  Config c; ManualCtl m; MistTracker mt;
  CHECK_DEC(decideMist(mk(0, SAFE_NORMAL, true, 50), m, mt, c), true, "cooling");
  CHECK_DEC(decideMist(mk(4 * MIN, SAFE_NORMAL, true, 55), m, mt, c), true, "cooling");
  CHECK_DEC(decideMist(mk(5 * MIN, SAFE_NORMAL, true, 56), m, mt, c), false, "cooldown"); // hết 5 phút
  CHECK_DEC(decideMist(mk(10 * MIN, SAFE_NORMAL, true, 56), m, mt, c), false, "cooldown");
  CHECK_DEC(decideMist(mk(20 * MIN, SAFE_NORMAL, true, 56), m, mt, c), true, "cooling");  // hết 15 phút nghỉ
  CHECK_DEC(decideMist(mk(21 * MIN, SAFE_NORMAL, true, 71), m, mt, c), false, "cooldown"); // ẩm chạm 70% -> dừng
  MistTracker mt2;
  CHECK_DEC(decideMist(mk(0, SAFE_NORMAL, true, 75), m, mt2, c), false, "idle");        // ẩm đã >= 70%
  CHECK_DEC(decideMist(mk(0, SAFE_NORMAL, false, 50), m, mt2, c), false, "idle");       // không nóng
}

static void test_light() {
  std::printf("light\n");
  ManualCtl m;
  setManual(m, false);
  CHECK_DEC(decideLight(mk(0, SAFE_FIRE), m), true, "fire");
  CHECK_DEC(decideLight(mk(0, SAFE_GAS_DANGER), m), true, "gas_danger");
  CHECK_DEC(decideLight(mk(0, SAFE_GAS), m), false, "manual");
  m.clear();
  CHECK_DEC(decideLight(mk(0, SAFE_NORMAL), m), false, "idle");
}

static void test_manual_expiry() {
  std::printf("lệnh có thời hạn\n");
  ManualCtl m;
  setManual(m, true, "rule", 1000, 5 * MIN);
  std::strcpy(m.reason, "motion_after_hours");
  CHECK_DEC(decideLight(mk(2000, SAFE_NORMAL), m), true, "motion_after_hours");
  m.tick(1000 + 5 * MIN - 1); CHECK(m.active);
  m.tick(1000 + 5 * MIN);     CHECK(!m.active);
  CHECK_DEC(decideLight(mk(1000 + 5 * MIN, SAFE_NORMAL), m), false, "idle");
  setManual(m, true, "user");
  CHECK(m.setByUser());
  setManual(m, true, "agent");
  CHECK(!m.setByUser());
}

int main() {
  test_config();
  test_mq_level();
  test_temp_history();
  test_safety_target();
  test_safety_tracker();
  test_fan();
  test_fan_hum_ineffective();
  test_mist();
  test_mist_cooling();
  test_light();
  test_manual_expiry();
  std::printf("\n%d passed, %d failed\n", g_pass, g_fail);
  return g_fail ? 1 : 0;
}
