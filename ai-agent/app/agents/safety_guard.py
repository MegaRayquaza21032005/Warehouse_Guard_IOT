"""Safety Guard — kiểm tra chính sách BẰNG CODE cho mọi tool ghi thiết bị / cấu hình (CLAUDE.md mục 5, 8).

Không phụ thuộc prompt hay LLM: tool ghi gọi check_*() trước khi tạo đề xuất VÀ kiểm tra lại ngay trước khi
gửi MQTT (tình hình có thể đã đổi trong lúc chờ người dùng bấm Đồng ý). Bị chặn -> tool trả lỗi cho agent,
nhật ký ghi `blocked_by_policy`. Luật cục bộ ESP32 vẫn là lớp cuối cùng.
Logic thuần (không I/O) -> test trực tiếp trong tests/test_safety_guard.py.
"""

from dataclasses import dataclass
from typing import Any

DEVICES = ("fan", "mist", "light")
DEVICE_VI = {"fan": "quạt", "mist": "phun sương", "light": "đèn"}
MAX_DURATION_S = 86400
CLIMATE_STALE_S = 120       # số liệu nhiệt/ẩm cũ hơn -> coi như không biết

# Giống firmware (logic.h validateConfig) và Java BE (ConfigService): khóa -> (min, max, số nguyên?)
CONFIG_RULES: dict[str, tuple[float, float, bool]] = {
    "mq2Warning": (150, 4095, True),
    "mq2Danger": (150, 4095, True),
    "tempHigh": (0, 80, False),
    "humHigh": (10, 100, False),
    "tempRiseC": (0.5, 20, False),
    "tempRiseWindowMin": (1, 15, True),
    "mistFireMaxMin": (1, 60, True),
    "mistCoolMaxMin": (1, 60, True),
    "mistCooldownMin": (0, 240, True),
    "mistHumMax": (10, 100, False),
    "humFanCheckMin": (5, 240, True),
    "humFanMinDrop": (0.5, 50, False),
}
CONFIG_DEFAULTS: dict[str, float] = {
    "mq2Warning": 1500, "mq2Danger": 2500, "tempHigh": 38, "humHigh": 80, "tempRiseC": 3, "tempRiseWindowMin": 5,
    "mistFireMaxMin": 10, "mistCoolMaxMin": 5, "mistCooldownMin": 15, "mistHumMax": 70, "humFanCheckMin": 30,
    "humFanMinDrop": 3,
}


@dataclass(frozen=True)
class GuardContext:
    """Tình hình hiện tại (lấy từ tầng luật trong RAM — nhanh, không phụ thuộc Java BE)."""
    safety: str = "normal"                  # normal | gas | gas_danger | fire
    temp: float | None = None
    hum: float | None = None
    climate_age_s: float | None = None
    hum_high: float = 80.0
    online: bool | None = None              # None = chưa biết (mới khởi động)

    @property
    def hum_known(self) -> float | None:
        if self.hum is None or self.climate_age_s is None or self.climate_age_s > CLIMATE_STALE_S:
            return None
        return self.hum


@dataclass(frozen=True)
class Verdict:
    allowed: bool
    reason: str = ""        # lý do chặn (tiếng Việt, hiển thị cho agent / người dùng)
    note: str = ""          # lưu ý khi vẫn cho phép

    @staticmethod
    def ok(note: str = "") -> "Verdict":
        return Verdict(True, note=note)

    @staticmethod
    def block(reason: str) -> "Verdict":
        return Verdict(False, reason=reason)


def check_device(device: str, ctx: GuardContext, *, state: str | None = None, mode: str | None = None,
                 duration_s: int | None = None) -> Verdict:
    """Lệnh quạt / phun sương / đèn (chat hoặc sự cố)."""
    if device not in DEVICES:
        return Verdict.block(f"Thiết bị không hợp lệ: {device}")
    if (state is None) == (mode is None):
        return Verdict.block("Phải có đúng một trong hai: state (on/off) hoặc mode (auto)")
    if mode is not None and mode != "auto":
        return Verdict.block("mode chỉ nhận 'auto'")
    if state is not None and state not in ("on", "off"):
        return Verdict.block("state chỉ nhận 'on' hoặc 'off'")
    if duration_s is not None and (not isinstance(duration_s, int) or not 1 <= duration_s <= MAX_DURATION_S):
        return Verdict.block(f"duration_s phải là số nguyên 1–{MAX_DURATION_S}")
    if ctx.online is False:
        return Verdict.block("ESP32 đang mất kết nối — không gửi được lệnh")

    if mode == "auto":
        return Verdict.ok()

    s = ctx.safety
    if device == "fan":
        if state == "on" and s == "fire":
            return Verdict.block("Đang NGHI CHÁY: không bật quạt (thổi thêm oxy, thổi bay hơi sương)")
        if state == "off" and s == "gas_danger":
            return Verdict.block("Khí nồng độ cao: quạt phải chạy để thông gió (ESP32 cũng sẽ giữ quạt bật)")
        if state == "off" and s == "gas":
            return Verdict.ok("Đang có khí/khói — tắt quạt sẽ giảm thông gió")
    elif device == "mist" and state == "on":
        if s in ("gas", "gas_danger"):
            return Verdict.block("Đang có khí/khói nhưng không nóng: không phun sương")
        hum = ctx.hum_known
        if hum is None:
            return Verdict.block("Không có số liệu độ ẩm gần đây — không bật phun sương")
        if hum >= ctx.hum_high:
            return Verdict.block(f"Độ ẩm {hum:.0f}% ≥ ngưỡng {ctx.hum_high:.0f}%: cấm bật phun sương")
    elif device == "light" and state == "off" and s in ("fire", "gas_danger"):
        return Verdict.block("Đang có nguy hiểm: đèn thoát hiểm phải sáng (ESP32 cũng sẽ giữ đèn bật)")
    return Verdict.ok()


def check_incident_action(device: str, ctx: GuardContext, *, state: str | None = None,
                          mode: str | None = None, duration_s: int | None = None) -> Verdict:
    """Luồng sự cố: Control Agent chỉ được TỰ ĐỘNG làm hành động trong danh sách cho phép (CLAUDE.md mục 8)."""
    allowed = (device == "light" and state == "on") or \
              (device == "fan" and state == "on" and ctx.safety in ("gas", "gas_danger"))
    if not allowed:
        return Verdict.block("Luồng sự cố chỉ được tự động bật đèn, hoặc bật quạt khi có khí "
                             "— hành động khác cần người dùng ra lệnh")
    return check_device(device, ctx, state=state, mode=mode, duration_s=duration_s)


def check_config(patch: dict[str, Any], current: dict[str, Any]) -> tuple[Verdict, dict[str, Any]]:
    """Đổi ngưỡng: kiểm tra như firmware. Trả (verdict, cấu hình đầy đủ sau khi ghép)."""
    if not patch:
        return Verdict.block("Không có trường nào để cập nhật"), {}
    merged: dict[str, Any] = {**CONFIG_DEFAULTS, **{k: v for k, v in current.items() if k in CONFIG_RULES}}
    for k, v in patch.items():
        rule = CONFIG_RULES.get(k)
        if rule is None:
            return Verdict.block(f"Khóa không hợp lệ: {k}. Hợp lệ: {', '.join(CONFIG_RULES)}"), {}
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return Verdict.block(f"{k} phải là số"), {}
        lo, hi, integer = rule
        if integer and float(v) != round(float(v)):
            return Verdict.block(f"{k} phải là số nguyên"), {}
        if not lo <= v <= hi:
            return Verdict.block(f"{k} phải trong khoảng {lo:g} – {hi:g}"), {}
        merged[k] = int(round(v)) if integer else float(v)
    if merged["mq2Danger"] <= merged["mq2Warning"] + 150:
        return Verdict.block("mq2Danger phải lớn hơn mq2Warning + 150"), {}
    if merged["mistHumMax"] >= merged["humHigh"]:
        return Verdict.block("mistHumMax phải nhỏ hơn humHigh"), {}
    return Verdict.ok(), merged
