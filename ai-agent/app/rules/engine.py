"""Tầng luật — KHÔNG dùng LLM (CLAUDE.md mục 5.3, 5.4, 8).

Nhận từng bản tin MQTT (đẩy tới, không polling) + nhịp tick mỗi giây, trả về danh sách việc cần làm
(cảnh báo, lệnh thiết bị, mở/đóng sự cố). Không tự gửi MQTT / ghi DB -> test được bằng đồng hồ giả.

ESP32 đã tự đánh giá an toàn (status/safety: normal | gas | gas_danger | fire, có hysteresis và giữ
2 phút trước khi hạ mức). Tầng luật phản ứng khi trạng thái đó đổi, và tự lo những gì ESP32 không biết:
giờ làm việc, mất kết nối, thiết bị không phản hồi, nóng/ẩm kéo dài, chống spam cảnh báo.

Phát hiện người = PIR (chuyển động) BỔ SUNG camera YOLO (service vision, warehouse/sensor/camera): một trong
hai báo là đủ mở sự cố đột nhập / báo cháy có người; camera thấy người sau PIR -> thêm cảnh báo xác nhận.
Camera không bao giờ làm hạ mức hay chặn cảnh báo của PIR.

Lửa / khói từ camera (model YOLO lửa / khói, cùng bản tin sensor/camera) — đã chốt với người dùng 2026-11-26:
- Camera thấy LỬA + MQ135 có khói: ESP32 tự chuyển `fire` (subscribe thẳng sensor/camera) -> cảnh báo `fire`
  như thường. Tầng luật chỉ tự báo `camera_fire` nếu ESP32 không chuyển `fire` sau CAMERA_FIRE_ESP_GRACE_S.
- Chỉ camera thấy LỬA (MQ135 bình thường): `camera_fire` critical + bật đèn, KHÔNG đụng quạt / phun sương.
- Camera thấy KHÓI: `camera_smoke` warning (không đụng thiết bị; bỏ qua nếu MQ135 đã báo khí / đang thấy lửa).
"""

from collections import deque
from dataclasses import dataclass
from typing import Any, Callable
from uuid import uuid4

from app.logging_setup import get_logger
from app.rules.actions import Action, Alert, Command, IncidentEvent
from app.rules.schedule import WorkSchedule

log = get_logger("RULE")

SAFETY_RANK = {"normal": 0, "gas": 1, "gas_danger": 2, "fire": 3}
LEVEL_RANK = {"info": 0, "warning": 1, "critical": 2}
DEVICE_NAMES = {"fan": "Quạt", "mist": "Phun sương", "light": "Đèn"}
FAULT_MESSAGES = {
    "mq135_disconnected": "Cảm biến khói MQ135 có thể bị đứt dây (đọc ≈ 0). Hệ thống KHÔNG phát hiện được khói cho tới khi sửa.",
    "mq135_saturated": "Cảm biến MQ135 bão hòa (đọc ≈ 4095): có thể khí rất nhiều hoặc chập dây. Vẫn được tính là nguy hiểm.",
    "dht_failed": "Cảm biến nhiệt độ / độ ẩm DHT11 không đọc được. Phát hiện cháy chỉ còn dựa vào khói.",
}
WINDOW_S = 3600            # bộ đệm 60 phút
MOTION_RECENT_S = 120      # chuyển động trong 2 phút gần nhất = "có người"
LIGHT_REFRESH_S = 60       # chuyển động tiếp tục -> gửi lại lệnh bật đèn tối đa 1 lần / phút
VENT_COOLDOWN_S = 3600
CAMERA_FIRE_ESP_GRACE_S = 5   # camera thấy lửa khi MQ135 đang có khói: chờ ESP32 tự chuyển "fire" tối đa N giây
CAMERA_CLEAR_S = 120          # camera hết lửa / khói liên tục N giây -> đóng sự cố camera (như ESP32 giữ 2 phút)
ENV_HYSTERESIS = 2.0


@dataclass
class RuleConfig:
    offline_timeout_s: int = 60
    alert_cooldown_s: int = 600
    gas_confirm_s: int = 10
    env_prolonged_s: int = 900
    light_on_s: int = 300
    intrusion_clear_s: int = 600
    cmd_ack_timeout_s: int = 10

    @classmethod
    def from_settings(cls, s) -> "RuleConfig":
        return cls(offline_timeout_s=s.offline_timeout_s, alert_cooldown_s=s.alert_cooldown_min * 60,
                   gas_confirm_s=s.gas_confirm_s, env_prolonged_s=s.env_prolonged_min * 60,
                   light_on_s=s.light_on_after_hours_s, intrusion_clear_s=s.intrusion_clear_min * 60,
                   cmd_ack_timeout_s=s.cmd_ack_timeout_s)


@dataclass
class Incident:
    id: str
    kind: str                 # safety | intrusion | offline
    level: str
    state: str | None
    opened_at: float
    worst_state: str | None = None
    people_alerted: bool = False
    mist_max_alerted: bool = False
    camera_confirmed: bool = False       # đột nhập: camera đã thấy người (đã báo xác nhận)
    camera_fire_alerted: bool = False    # sự cố camera: đã báo camera_fire (lửa chập chờn không báo lại)


class RuleEngine:
    def __init__(self, cfg: RuleConfig, schedule: WorkSchedule,
                 new_id: Callable[[], str] = lambda: uuid4().hex[:12]):
        self.cfg = cfg
        self.schedule = schedule
        self.new_id = new_id
        self.thresholds = {"tempHigh": 38.0, "humHigh": 80.0}
        self.device_config: dict[str, Any] = {}     # status/config đầy đủ (Safety Guard dùng)

        self.safety = "normal"
        self.faults: set[str] = set()
        self.online: bool | None = None
        self.last_data_at: float | None = None
        self.no_data_flagged = False

        self.motion = False
        self.last_motion_at: float | None = None
        self.last_light_cmd_at: float | None = None

        # Camera (service vision): có người / số người / lỗi / trực tuyến
        self.camera_person = False
        self.camera_count = 0
        self.camera_conf: float | None = None
        self.last_person_at: float | None = None
        self.camera_online: bool | None = None
        self.camera_error: str | None = None
        # Lửa / khói từ camera (None = vision không có model lửa / khói)
        self.camera_fire_enabled = False
        self.camera_fire = False
        self.camera_fire_conf: float | None = None
        self.camera_smoke = False
        self.camera_smoke_conf: float | None = None
        self.camera_fire_pending_since: float | None = None    # chờ ESP32 chuyển fire
        self.camera_smoke_since: float | None = None
        self.camera_hazard_at: float | None = None             # lần cuối camera thấy lửa / khói
        self.esp_camera_fire = False                           # status/safety.cameraFire (ESP32 đang dùng)

        self.climate: deque[tuple[float, float, float]] = deque()   # (ts, temp, hum)
        self.mq135: deque[tuple[float, int]] = deque()
        self.hot = False
        self.hot_since: float | None = None
        self.hot_alerted = False
        self.humid = False
        self.humid_since: float | None = None
        self.humid_alerted = False

        self.gas_pending_since: float | None = None
        self.gas_alerted = False

        self.devices: dict[str, dict[str, Any]] = {}
        self.pending_cmds: dict[str, tuple[str, float, str]] = {}    # trace_id -> (device, ts, source)
        self.last_sent: dict[str, float] = {}
        self.incidents: dict[str, Incident] = {}

    # ================================================================== nhận bản tin
    def on_message(self, topic: str, data: dict[str, Any], now: float) -> list[Action]:
        acts: list[Action] = []
        parts = topic.split("/")
        if len(parts) != 3 or parts[0] != "warehouse":
            return acts
        _, group, name = parts

        if group == "sensor" and name == "camera":
            self._on_camera(data, now, acts)          # không phải dữ liệu ESP32 -> không tính vào "mất dữ liệu"
        elif group == "sensor":
            self._on_data(now, acts)
            if name == "mq135" and isinstance(data.get("raw"), (int, float)):
                self.mq135.append((now, int(data["raw"])))
            elif name == "dht11" and _num(data.get("temp")) is not None and _num(data.get("hum")) is not None:
                self._on_climate(float(data["temp"]), float(data["hum"]), now, acts)
            elif name == "pir" and isinstance(data.get("motion"), bool):
                self._on_motion(data["motion"], now, acts)
        elif group == "status":
            if name == "safety":
                self._on_safety(data, now, acts)
            elif name == "online":
                self._on_online(data.get("status") == "online", now, acts)
            elif name == "camera":
                self._on_camera_online(data.get("status") == "online", now, acts)
            elif name == "config" and "error" not in data:
                self.device_config = dict(data)
                for k in ("tempHigh", "humHigh"):
                    if _num(data.get(k)) is not None:
                        self.thresholds[k] = float(data[k])
            elif name in DEVICE_NAMES:
                self._on_device_status(name, data, now, acts)
        elif group == "cmd" and name in DEVICE_NAMES:
            trace = data.get("trace_id")
            if trace:
                self.pending_cmds[trace] = (name, now, str(data.get("source", "user")))

        self._trim(now)
        return acts

    # ================================================================== nhịp 1 giây
    def tick(self, now: float) -> list[Action]:
        acts: list[Action] = []

        # Khí nhẹ phải giữ đủ GAS_CONFIRM_S mới cảnh báo (chống báo giả)
        if (self.safety == "gas" and self.gas_pending_since is not None and not self.gas_alerted
                and now - self.gas_pending_since >= self.cfg.gas_confirm_s):
            self.gas_alerted = True
            self._alert(acts, now, "gas", "warning",
                        "Phát hiện khí / khói trong kho (chưa có dấu hiệu cháy). Quạt đã bật để thông gió.",
                        incident=self.incidents.get("safety"))

        # Không nhận dữ liệu cảm biến
        if (self.last_data_at is not None and not self.no_data_flagged and self.online is not False
                and now - self.last_data_at > self.cfg.offline_timeout_s):
            self.no_data_flagged = True
            inc = self._open_or_update("offline", "warning", "no_data", now, {"event": "no_data"}, acts)
            self._alert(acts, now, "no_data", "warning",
                        f"Không nhận được dữ liệu cảm biến hơn {self.cfg.offline_timeout_s} giây — "
                        "ESP32 có thể bị treo hoặc mất WiFi.", incident=inc)

        # Lệnh không được ESP32 xác nhận
        for trace, (device, ts, source) in list(self.pending_cmds.items()):
            if now - ts >= self.cfg.cmd_ack_timeout_s:
                del self.pending_cmds[trace]
                if self.online is False or self.no_data_flagged:
                    continue   # đã có cảnh báo mất kết nối
                self._alert(acts, now, "device_no_response", "warning",
                            f"{DEVICE_NAMES[device]} không phản hồi lệnh sau {self.cfg.cmd_ack_timeout_s} giây "
                            "— kiểm tra relay / ESP32.",
                            key=f"device_no_response:{device}",
                            details={"device": device, "trace_id": trace, "source": source})

        # Camera thấy lửa khi MQ135 có khói mà ESP32 không chuyển "fire" (firmware cũ / không nhận được bản tin)
        if (self.camera_fire_pending_since is not None
                and now - self.camera_fire_pending_since >= CAMERA_FIRE_ESP_GRACE_S):
            self.camera_fire_pending_since = None
            if self.camera_fire and self.safety != "fire":
                self._camera_fire_alert(now, acts, esp_missed=True)

        # Camera thấy khói giữ đủ GAS_CONFIRM_S mới cảnh báo (như khí MQ135)
        if (self.camera_smoke and self.camera_smoke_since is not None
                and now - self.camera_smoke_since >= self.cfg.gas_confirm_s):
            self.camera_smoke_since = None
            if not self.camera_fire and self.safety == "normal":
                inc = self._open_or_update("vision", "warning", "smoke", now, {"event": "camera_smoke"}, acts)
                self._alert(acts, now, "camera_smoke", "warning",
                            "Camera phát hiện KHÓI trong kho (cảm biến MQ135 chưa báo — khói có thể chưa tới cảm "
                            "biến, hoặc là hơi nước / bụi). Xem camera trực tiếp để kiểm tra.",
                            incident=inc, details=self._camera_hazard_details())

        # Camera không còn thấy lửa / khói đủ lâu -> đóng sự cố camera
        inc = self.incidents.get("vision")
        if (inc and not self.camera_fire and not self.camera_smoke and self.camera_hazard_at is not None
                and now - self.camera_hazard_at >= CAMERA_CLEAR_S):
            self._close(inc, now, acts, "Camera không còn thấy lửa / khói.")

        # Hết chuyển động VÀ camera không còn thấy người đủ lâu (hoặc đã vào giờ làm) -> đóng sự cố đột nhập
        inc = self.incidents.get("intrusion")
        last = max((t for t in (self.last_motion_at, self.last_person_at) if t is not None), default=None)
        if inc and not self.motion and not self.camera_person and last is not None and (
                now - last >= self.cfg.intrusion_clear_s or self.schedule.is_work_time(now)):
            self._close(inc, now, acts, "Không còn chuyển động / người trong kho.")
        return acts

    # ================================================================== xử lý từng loại
    def _on_data(self, now: float, acts: list[Action]) -> None:
        self.last_data_at = now
        if self.no_data_flagged:
            self.no_data_flagged = False
            inc = self.incidents.get("offline")
            if inc and self.online is not False:
                self._close(inc, now, acts, "ESP32 đã gửi dữ liệu trở lại.")

    def _on_climate(self, temp: float, hum: float, now: float, acts: list[Action]) -> None:
        self.climate.append((now, temp, hum))
        th, hh = self.thresholds["tempHigh"], self.thresholds["humHigh"]
        self.hot = temp > th - ENV_HYSTERESIS if self.hot else temp >= th
        self.humid = hum > hh - ENV_HYSTERESIS if self.humid else hum >= hh

        if not self.hot:
            self.hot_since, self.hot_alerted = None, False
        elif self.hot_since is None:
            self.hot_since = now
        elif not self.hot_alerted and now - self.hot_since >= self.cfg.env_prolonged_s:
            self.hot_alerted = True
            self._alert(acts, now, "temp_high_prolonged", "info",
                        f"Nhiệt độ kho {temp:.1f}°C, vượt ngưỡng {th:.0f}°C liên tục "
                        f"{self.cfg.env_prolonged_s // 60} phút.", details={"temp": temp})

        if not self.humid:
            self.humid_since, self.humid_alerted = None, False
        elif self.humid_since is None:
            self.humid_since = now
        elif not self.humid_alerted and now - self.humid_since >= self.cfg.env_prolonged_s:
            self.humid_alerted = True
            self._alert(acts, now, "hum_high_prolonged", "info",
                        f"Độ ẩm kho {hum:.0f}%, vượt ngưỡng {hh:.0f}% liên tục "
                        f"{self.cfg.env_prolonged_s // 60} phút — có nguy cơ ẩm mốc hàng hóa.",
                        details={"hum": hum})

    def _on_motion(self, motion: bool, now: float, acts: list[Action]) -> None:
        self.motion = motion
        if not motion:
            return
        self.last_motion_at = now
        self._on_presence("pir", now, acts)

    def _on_camera(self, data: dict[str, Any], now: float, acts: list[Action]) -> None:
        err = data.get("error")
        if isinstance(err, str) and err:
            self.camera_person, self.camera_count = False, 0
            self._reset_camera_hazard(now)
            if self.camera_error != err:
                self.camera_error = err
                self._alert(acts, now, "camera_fault", "warning",
                            "Camera không có hình (bị che, rút cáp hoặc ứng dụng khác đang dùng) — phát hiện người "
                            "chỉ còn dựa vào cảm biến chuyển động PIR.", key="camera_fault", details={"error": err})
            return
        person = data.get("person")
        if not isinstance(person, bool):
            return
        if self.camera_error:
            log.info("Camera có hình trở lại")
            self.camera_error = None
        count = data.get("personCount")
        self.camera_count = int(count) if person and isinstance(count, (int, float)) and count > 0 else int(person)
        self.camera_conf = _num(data.get("personConf")) if person else None
        prev, self.camera_person = self.camera_person, person
        if person and not prev:
            log.info("Camera thấy %d người", self.camera_count)
        if person:
            self.last_person_at = now
            self._on_presence("camera", now, acts)
        if isinstance(data.get("fire"), bool) and isinstance(data.get("smoke"), bool):
            self.camera_fire_enabled = True
            self._on_camera_hazard(data["fire"], _num(data.get("fireConf")), data["smoke"],
                                   _num(data.get("smokeConf")), now, acts)

    def _on_camera_hazard(self, fire: bool, fire_conf: float | None, smoke: bool, smoke_conf: float | None,
                          now: float, acts: list[Action]) -> None:
        prev_fire, prev_smoke = self.camera_fire, self.camera_smoke
        self.camera_fire, self.camera_fire_conf = fire, fire_conf if fire else None
        self.camera_smoke, self.camera_smoke_conf = smoke, smoke_conf if smoke else None
        if fire or smoke:
            self.camera_hazard_at = now
        if smoke and not prev_smoke:
            log.warning("Camera thấy KHÓI (%.2f)", smoke_conf or 0)
            self.camera_smoke_since = now
        elif not smoke:
            self.camera_smoke_since = None
            if prev_smoke:
                log.info("Camera hết thấy khói")

        if not fire:
            self.camera_fire_pending_since = None
            if prev_fire:
                log.info("Camera hết thấy lửa")
            return
        if not prev_fire:
            log.warning("Camera thấy LỬA (%.2f) — an toàn ESP32: %s", fire_conf or 0, self.safety)
            if self.safety == "fire":
                inc = self.incidents.get("safety")
                if inc:     # đã báo cháy (cảm biến) -> chỉ ghi diễn biến, không báo trùng
                    self._open_or_update("safety", "critical", "fire", now, {"event": "camera_fire"}, acts)
            elif self.safety in ("gas", "gas_danger") and self.online is not False:
                # MQ135 có khói + camera thấy lửa -> ESP32 sẽ tự chuyển "fire" (tắt quạt, phun sương). Chờ một chút
                # để báo một lần ("fire") thay vì hai cảnh báo critical liền nhau.
                self.camera_fire_pending_since = now
            else:
                self._camera_fire_alert(now, acts)
        if self.safety != "fire" and (not prev_fire or self.last_light_cmd_at is None
                                      or now - self.last_light_cmd_at >= LIGHT_REFRESH_S):
            # Đèn: camera vừa thấy lửa -> bật NGAY (ESP32 tự bật khi "fire"); làm mới mỗi phút khi lửa còn
            self.last_light_cmd_at = now
            acts.append(Command("light", {"state": "on", "source": "rule", "reason": "camera_fire",
                                          "duration_s": self.cfg.light_on_s, "trace_id": f"rule-{self.new_id()}"}))

    def _camera_fire_alert(self, now: float, acts: list[Action], esp_missed: bool = False) -> None:
        inc = self._open_or_update("vision", "critical", "fire", now, {"event": "camera_fire"}, acts)
        if inc.camera_fire_alerted:      # lửa chập chờn trong cùng sự cố -> chỉ ghi diễn biến (đã báo critical)
            log.info("Camera thấy lửa lại (sự cố %s đã báo) — không báo trùng", inc.id)
            return
        inc.camera_fire_alerted = True
        pir, cam = self._people(now)
        n = max(1, self.camera_count)
        people = (f" Camera đang thấy {n} người trong kho — kiểm tra và sơ tán ngay." if self.camera_person else
                  f" Camera vừa thấy {n} người trong kho (trong 2 phút) — kiểm tra và sơ tán ngay." if cam else
                  " Vừa có chuyển động — có thể có người trong kho." if pir else "")
        if esp_missed:
            body = ("Camera phát hiện LỬA và cảm biến MQ135 đang báo khói, nhưng ESP32 CHƯA chuyển sang trạng thái "
                    "cháy (quạt có thể vẫn chạy). Tắt quạt và kiểm tra kho ngay.")
        else:
            body = ("Camera phát hiện LỬA trong kho (cảm biến khói / nhiệt chưa báo). Đã bật đèn; quạt và phun sương "
                    "KHÔNG tự đổi — xem camera trực tiếp, cháy thật thì bật phun sương / gọi cứu hỏa.")
        d = self._camera_hazard_details()
        d.update(self._people_details(now))
        self._alert(acts, now, "camera_fire", "critical", body + people, incident=inc, details=d)

    def _camera_hazard_details(self) -> dict[str, Any]:
        d: dict[str, Any] = {"evidence": ["camera"], "camera_fire": self.camera_fire,
                             "camera_smoke": self.camera_smoke}
        if self.camera_fire_conf is not None:
            d["fire_conf"] = self.camera_fire_conf
        if self.camera_smoke_conf is not None:
            d["smoke_conf"] = self.camera_smoke_conf
        return d

    def _reset_camera_hazard(self, now: float) -> None:
        """Camera lỗi / vision mất kết nối: không còn biết có lửa / khói hay không."""
        if self.camera_fire or self.camera_smoke:
            log.info("Mất hình camera — bỏ trạng thái lửa / khói từ camera")
        self.camera_fire = self.camera_smoke = False
        self.camera_fire_conf = self.camera_smoke_conf = None
        self.camera_fire_pending_since = self.camera_smoke_since = None

    def _on_camera_online(self, online: bool, now: float, acts: list[Action]) -> None:
        prev, self.camera_online = self.camera_online, online
        if online:
            if prev is False:
                log.info("Camera / service vision kết nối lại")
            return
        self.camera_person, self.camera_count = False, 0
        self._reset_camera_hazard(now)
        if prev is True:     # chỉ báo khi đang chạy mà mất (không báo lúc ai-agent khởi động thấy retained offline)
            self._alert(acts, now, "camera_offline", "warning",
                        "Camera / service nhận dạng người mất kết nối — phát hiện người chỉ còn dựa vào cảm biến "
                        "chuyển động PIR.", key="camera_offline")

    def _people(self, now: float) -> tuple[bool, bool]:
        """(PIR có chuyển động gần đây, camera đang / vừa thấy người)."""
        pir = self.motion or (self.last_motion_at is not None and now - self.last_motion_at <= MOTION_RECENT_S)
        cam = self.camera_person or (self.last_person_at is not None and now - self.last_person_at <= MOTION_RECENT_S)
        return pir, cam

    def _people_details(self, now: float) -> dict[str, Any]:
        pir, cam = self._people(now)
        d: dict[str, Any] = {"evidence": [e for e, ok in (("pir", pir), ("camera", cam)) if ok]}
        if cam:
            d["person_count"] = max(1, self.camera_count)
        return d

    def _on_presence(self, via: str, now: float, acts: list[Action]) -> None:
        """PIR có chuyển động hoặc camera thấy người (via = "pir" | "camera")."""
        pir, cam = self._people(now)
        n = max(1, self.camera_count)

        # Đang nghi cháy mà có người -> có thể có người trong kho
        safety_inc = self.incidents.get("safety")
        if self.safety == "fire" and safety_inc and not safety_inc.people_alerted:
            safety_inc.people_alerted = True
            head = (f"NGHI CHÁY VÀ CÓ NGƯỜI TRONG KHO (camera thấy {n} người)" if cam
                    else "NGHI CHÁY VÀ CÓ THỂ CÓ NGƯỜI TRONG KHO (vừa phát hiện chuyển động)")
            self._alert(acts, now, "fire_people", "critical", f"{head}. Kiểm tra và sơ tán ngay.",
                        incident=safety_inc, details=self._people_details(now))

        if self.schedule.is_work_time(now):
            return
        inc = self.incidents.get("intrusion")
        if inc is None:
            inc = self._open_or_update("intrusion", "critical", "motion" if via == "pir" else "person", now,
                                       {"event": "motion" if via == "pir" else "person"}, acts)
            inc.camera_confirmed = cam
            if via == "camera":
                msg = f"Camera phát hiện {n} người NGOÀI GIỜ LÀM VIỆC trong kho" + (
                    " (cảm biến chuyển động cũng báo)" if pir else "") + ". Đã bật đèn."
            else:
                msg = "Phát hiện chuyển động NGOÀI GIỜ LÀM VIỆC trong kho" + (
                    f" — camera thấy {n} người" if cam else "") + ". Đã bật đèn."
            self._alert(acts, now, "intrusion", "critical", msg, incident=inc, details=self._people_details(now))
        elif via == "camera" and not inc.camera_confirmed:
            inc.camera_confirmed = True
            self._open_or_update("intrusion", "critical", "person", now, {"event": "camera_confirmed"}, acts)
            self._alert(acts, now, "intrusion_confirmed", "critical",
                        f"Camera XÁC NHẬN có {n} người trong kho ngoài giờ làm việc (cảm biến chuyển động đã báo "
                        "trước đó). Kiểm tra ngay.", incident=inc, details=self._people_details(now))
        if self.last_light_cmd_at is None or now - self.last_light_cmd_at >= LIGHT_REFRESH_S:
            self.last_light_cmd_at = now
            acts.append(Command("light", {"state": "on", "source": "rule", "reason": "motion_after_hours",
                                          "duration_s": self.cfg.light_on_s, "trace_id": f"rule-{self.new_id()}"}))

    def _on_safety(self, data: dict[str, Any], now: float, acts: list[Action]) -> None:
        faults = {str(f) for f in data.get("faults") or []}
        for f in sorted(faults - self.faults):
            self._alert(acts, now, "sensor_fault", "warning", FAULT_MESSAGES.get(f, f"Lỗi cảm biến: {f}"),
                        key=f"sensor_fault:{f}", details={"fault": f})
        for f in sorted(self.faults - faults):
            log.info("Lỗi cảm biến %s đã hết", f)
        self.faults = faults
        cam_fire = data.get("cameraFire") is True
        if cam_fire != self.esp_camera_fire:
            log.info("ESP32 %s dùng 'camera thấy lửa' khi đánh giá an toàn", "đang" if cam_fire else "thôi")
        self.esp_camera_fire = cam_fire

        state = data.get("state")
        if state not in SAFETY_RANK or state == self.safety:
            return
        prev, self.safety = self.safety, state
        log.info("An toàn %s -> %s %s", prev, state, self._sensor_summary())

        if state == "normal":
            self.gas_pending_since, self.gas_alerted = None, False
            inc = self.incidents.get("safety")
            if inc:
                self._close(inc, now, acts, "Hết khí / khói, nhiệt độ bình thường.")
            return

        level = "warning" if state == "gas" else "critical"
        inc = self._open_or_update("safety", level, state, now, {"event": "safety", "from": prev, "to": state}, acts)
        if state == "fire":
            self.camera_fire_pending_since = None      # ESP32 đã chuyển "fire" -> không cần báo camera_fire riêng
            pir, cam = self._people(now)
            if pir or cam:
                inc.people_alerted = True
                head = (f"NGHI CHÁY VÀ CÓ NGƯỜI TRONG KHO (camera thấy {max(1, self.camera_count)} người)" if cam
                        else "NGHI CHÁY VÀ CÓ THỂ CÓ NGƯỜI TRONG KHO (cảm biến chuyển động vừa phát hiện)")
                d = self._people_details(now)
                if cam_fire:
                    d["camera_fire"] = True
                self._alert(acts, now, "fire_people", "critical",
                            f"{head}{' — camera thấy lửa' if cam_fire else ''}. Quạt đã tắt, phun sương và đèn đã "
                            "bật. Kiểm tra và sơ tán ngay.", incident=inc, details=d)
            elif cam_fire:
                self._alert(acts, now, "fire", "critical",
                            "NGHI CHÁY: camera thấy LỬA và cảm biến MQ135 báo khói. Quạt đã tắt, phun sương và đèn "
                            "đã bật. Kiểm tra kho ngay.", incident=inc,
                            details={**self._camera_hazard_details(), "evidence": ["mq135", "camera"]})
            else:
                self._alert(acts, now, "fire", "critical",
                            "NGHI CHÁY: khói / khí kèm nhiệt độ cao hoặc tăng nhanh. Quạt đã tắt, phun sương và "
                            "đèn đã bật. Kiểm tra kho ngay.", incident=inc)
        elif state == "gas_danger":
            self._alert(acts, now, "gas_danger", "critical",
                        "Nồng độ khí / khói RẤT CAO (nghi rò rỉ khí). Quạt và đèn đã bật. Không bật lửa, "
                        "kiểm tra nguồn rò rỉ.", incident=inc)
        elif SAFETY_RANK[prev] < SAFETY_RANK["gas"]:
            # Khí nhẹ: chờ xác nhận ở tick(); hạ từ gas_danger/fire xuống gas thì không báo lại
            self.gas_pending_since = now

    def _on_online(self, online: bool, now: float, acts: list[Action]) -> None:
        prev, self.online = self.online, online
        if not online and prev is not False:
            inc = self._open_or_update("offline", "warning", "offline", now, {"event": "offline"}, acts)
            self._alert(acts, now, "device_offline", "warning",
                        "ESP32 mất kết nối — hệ thống không còn nhận dữ liệu cảm biến. Luật an toàn trên ESP32 "
                        "vẫn chạy nếu thiết bị còn điện.", incident=inc)
        elif online and prev is False:
            self.last_data_at, self.no_data_flagged = now, False
            inc = self.incidents.get("offline")
            if inc:
                self._close(inc, now, acts, "ESP32 đã kết nối lại.")

    def _on_device_status(self, device: str, data: dict[str, Any], now: float, acts: list[Action]) -> None:
        ack = data.get("ack")
        if isinstance(ack, dict) and ack.get("trace_id"):
            self.pending_cmds.pop(ack["trace_id"], None)
            if ack.get("result") != "applied":
                log.info("%s từ chối lệnh %s: %s", DEVICE_NAMES[device], ack["trace_id"], ack.get("result"))

        reason = data.get("reason")
        prev_reason = self.devices.get(device, {}).get("reason")
        self.devices[device] = data
        if reason == prev_reason:
            return
        if device == "mist" and reason == "fire_max_time":
            inc = self.incidents.get("safety")
            if inc is None or not inc.mist_max_alerted:
                if inc:
                    inc.mist_max_alerted = True
                self._alert(acts, now, "mist_fire_max_time", "critical",
                            "Phun sương đã chạy hết thời gian tối đa khi nghi cháy và đã tự tắt. "
                            "Cần người kiểm tra hiện trường ngay.", incident=inc)
        elif device == "fan" and reason == "hum_ineffective":
            self._alert(acts, now, "ventilation_ineffective", "info",
                        "Quạt chạy lâu nhưng độ ẩm không giảm (không khí bên ngoài có thể còn ẩm hơn). "
                        "Đã tạm dừng chạy quạt theo độ ẩm.", cooldown_s=VENT_COOLDOWN_S)

    # ================================================================== tiện ích
    def _alert(self, acts: list[Action], now: float, type_: str, level: str, message: str,
               key: str | None = None, cooldown_s: int | None = None, incident: Incident | None = None,
               details: dict[str, Any] | None = None) -> bool:
        """Thêm cảnh báo. info / warning bị chặn nếu cùng loại vừa gửi trong cooldown; critical KHÔNG BAO GIỜ bị chặn."""
        k = key or type_
        if level != "critical":
            last = self.last_sent.get(k)
            cd = cooldown_s if cooldown_s is not None else self.cfg.alert_cooldown_s
            if last is not None and now - last < cd:
                log.info("Bỏ qua cảnh báo %s (cooldown, còn %ds)", k, int(cd - (now - last)))
                return False
        self.last_sent[k] = now
        d = self._sensor_snapshot()
        d.update(details or {})
        acts.append(Alert(type_, level, message, incident.id if incident else None, d))
        return True

    def _open_or_update(self, kind: str, level: str, state: str | None, now: float, event: dict[str, Any],
                        acts: list[Action]) -> Incident:
        inc = self.incidents.get(kind)
        if inc is None:
            inc = Incident(f"inc-{kind}-{self.new_id()}", kind, level, state, now, worst_state=state)
            self.incidents[kind] = inc
            acts.append(IncidentEvent("open", inc.id, kind, level, state, now, event))
            return inc
        if LEVEL_RANK[level] > LEVEL_RANK[inc.level]:
            inc.level = level
        if kind == "safety" and SAFETY_RANK.get(state or "", 0) > SAFETY_RANK.get(inc.worst_state or "", 0):
            inc.worst_state = state
        inc.state = state
        acts.append(IncidentEvent("update", inc.id, kind, inc.level, state, now, event))
        return inc

    def _close(self, inc: Incident, now: float, acts: list[Action], reason: str) -> None:
        self.incidents.pop(inc.kind, None)
        minutes = max(1, round((now - inc.opened_at) / 60))
        acts.append(IncidentEvent("close", inc.id, inc.kind, inc.level, "closed", now, {"event": "close"}))
        label = {"safety": f"sự cố {inc.worst_state or inc.state}", "intrusion": "sự cố đột nhập",
                 "offline": "mất kết nối", "vision": "camera thấy lửa / khói"}.get(inc.kind, inc.kind)
        self._alert(acts, now, "recovered", "info", f"Đã trở lại bình thường sau {minutes} phút ({label}). {reason}",
                    key=f"recovered:{inc.id}", incident=inc, details={"duration_min": minutes, "kind": inc.kind})

    def _trim(self, now: float) -> None:
        for dq in (self.climate, self.mq135):
            while dq and now - dq[0][0] > WINDOW_S:
                dq.popleft()

    def _sensor_snapshot(self) -> dict[str, Any]:
        d: dict[str, Any] = {"safety": self.safety}
        if self.climate:
            d["temp"], d["hum"] = self.climate[-1][1], self.climate[-1][2]
        if self.mq135:
            d["mq135"] = self.mq135[-1][1]
        if self.faults:
            d["faults"] = sorted(self.faults)
        return d

    def _sensor_summary(self) -> str:
        s = self._sensor_snapshot()
        parts = [f"{k}={s[k]}" for k in ("mq135", "temp", "hum") if k in s]
        return f"({', '.join(parts)})" if parts else ""

    def snapshot(self) -> dict[str, Any]:
        """Trạng thái tầng luật (API /rules/state, debug)."""
        return {
            "safety": self.safety, "faults": sorted(self.faults), "online": self.online,
            "lastDataAgoS": None, "motion": self.motion, "thresholds": self.thresholds,
            "camera": {"online": self.camera_online, "person": self.camera_person, "count": self.camera_count,
                       "error": self.camera_error, "fireEnabled": self.camera_fire_enabled,
                       "fire": self.camera_fire, "smoke": self.camera_smoke, "espCameraFire": self.esp_camera_fire},
            "hot": self.hot, "humid": self.humid,
            "incidents": {k: {"id": v.id, "level": v.level, "state": v.state, "openedAt": v.opened_at}
                          for k, v in self.incidents.items()},
            "pendingCommands": len(self.pending_cmds),
            "window": {"climate": len(self.climate), "mq135": len(self.mq135)},
            "latest": self._sensor_snapshot(),
            "devices": {k: {f: v.get(f) for f in ("state", "mode", "reason", "source")} for k, v in self.devices.items()},
        }

    def latest_climate(self) -> tuple[float, float, float] | None:
        """(ts, temp, hum) gần nhất hoặc None."""
        return self.climate[-1] if self.climate else None


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
