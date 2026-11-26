"""Tầng luật: lửa / khói từ camera (YOLO fine-tune, cùng bản tin warehouse/sensor/camera) BỔ SUNG MQ135.

Đã chốt với người dùng (2026-11-26):
- Camera thấy lửa + MQ135 có khói -> ESP32 tự chuyển "fire"; tầng luật không báo trùng.
- Chỉ camera thấy lửa -> camera_fire critical + bật đèn, không đụng quạt / phun sương.
- Camera thấy khói -> camera_smoke warning, không đụng thiết bị.
"""

from datetime import datetime, time
from zoneinfo import ZoneInfo

import pytest

from app.agents import safety_guard as guard
from app.rules.actions import Alert, Command, IncidentEvent
from app.rules.engine import CAMERA_CLEAR_S, CAMERA_FIRE_ESP_GRACE_S, RuleConfig, RuleEngine
from app.rules.schedule import WorkSchedule

TZ = ZoneInfo("Asia/Ho_Chi_Minh")
CAM = "warehouse/sensor/camera"
SAFETY = "warehouse/status/safety"
ONLINE = "warehouse/status/online"


def at(hh: int, mm: int = 0, ss: int = 0, day: int = 5) -> float:
    return datetime(2026, 1, day, hh, mm, ss, tzinfo=TZ).timestamp()


@pytest.fixture
def eng() -> RuleEngine:
    sched = WorkSchedule(time(8, 0), time(17, 30), frozenset({1, 2, 3, 4, 5, 6}), TZ)
    counter = iter(range(1, 10_000))
    e = RuleEngine(RuleConfig(), sched, new_id=lambda: f"id{next(counter)}")
    e.on_message(ONLINE, {"status": "online"}, at(10))
    return e


def alerts(acts) -> list[Alert]:
    return [a for a in acts if isinstance(a, Alert)]


def types(acts) -> list[str]:
    return [a.type for a in alerts(acts)]


def cmds(acts, device=None) -> list[Command]:
    return [c for c in acts if isinstance(c, Command) and (device is None or c.device == device)]


def cam(fire=False, smoke=False, person=False, n=0):
    return {"person": person, "personCount": n, "personConf": 0.9 if person else None,
            "fire": fire, "fireConf": 0.8 if fire else None, "smoke": smoke, "smokeConf": 0.6 if smoke else None,
            "fps": 9.8}


def safety(state, camera_fire=False):
    return {"state": state, "mq135Level": "warning" if state != "normal" else "normal", "tempRise": 0.2,
            "faults": [], "cameraFire": camera_fire}


def run_ticks(eng, start, seconds):
    acts = []
    for i in range(1, seconds + 1):
        acts += eng.tick(start + i)
    return acts


# ---------------------------------------------------------------- chỉ camera thấy lửa
def test_camera_fire_alone_is_critical_with_light_but_no_fan_or_mist(eng):
    acts = eng.on_message(CAM, cam(fire=True), at(14))
    a = alerts(acts)
    assert [x.type for x in a] == ["camera_fire"] and a[0].level == "critical"
    assert "LỬA" in a[0].message and a[0].details["fire_conf"] == 0.8
    assert [c.payload["state"] for c in cmds(acts, "light")] == ["on"]
    assert cmds(acts, "light")[0].payload["reason"] == "camera_fire"
    assert not cmds(acts, "fan") and not cmds(acts, "mist")
    opened = [e for e in acts if isinstance(e, IncidentEvent) and e.action == "open"]
    assert opened[0].kind == "vision" and opened[0].level == "critical"


def test_camera_fire_repeated_heartbeat_does_not_realert_but_refreshes_light(eng):
    t = at(14)
    eng.on_message(CAM, cam(fire=True), t)
    acts = eng.on_message(CAM, cam(fire=True), t + 5)
    assert types(acts) == [] and not cmds(acts)
    acts = eng.on_message(CAM, cam(fire=True), t + 65)
    assert types(acts) == [] and len(cmds(acts, "light")) == 1        # làm mới đèn mỗi phút


def test_camera_fire_with_people_mentions_them(eng):
    acts = eng.on_message(CAM, cam(fire=True, person=True, n=2), at(14))
    a = [x for x in alerts(acts) if x.type == "camera_fire"][0]
    assert "đang thấy 2 người" in a.message and a.details["person_count"] == 2


def test_camera_fire_with_person_seen_recently_says_recently(eng):
    t = at(14)
    eng.on_message(CAM, cam(person=True, n=1), t)
    eng.on_message(CAM, cam(), t + 30)                        # người đã ra khỏi khung hình
    acts = eng.on_message(CAM, cam(fire=True), t + 60)
    a = [x for x in alerts(acts) if x.type == "camera_fire"][0]
    assert "vừa thấy 1 người" in a.message and "đang thấy" not in a.message


def test_first_fire_turns_light_on_even_right_after_intrusion_light(eng):
    t = at(22)
    acts = eng.on_message(CAM, cam(person=True, n=1), t)      # đột nhập -> lệnh đèn motion_after_hours
    assert [c.payload["reason"] for c in cmds(acts, "light")] == ["motion_after_hours"]
    acts = eng.on_message(CAM, cam(fire=True, person=True, n=1), t + 10)
    assert [c.payload["reason"] for c in cmds(acts, "light")] == ["camera_fire"]


def test_flickering_fire_in_same_incident_alerts_once(eng):
    t = at(14)
    assert types(eng.on_message(CAM, cam(fire=True), t)) == ["camera_fire"]
    eng.on_message(CAM, cam(), t + 20)                        # lửa khuất
    acts = eng.on_message(CAM, cam(fire=True), t + 40)        # thấy lại, sự cố chưa đóng
    assert "camera_fire" not in types(acts)
    assert any(isinstance(e, IncidentEvent) and e.event == {"event": "camera_fire"} for e in acts)
    # sự cố đã đóng -> lần lửa sau là sự cố mới, báo lại
    eng.on_message(CAM, cam(), t + 50)
    assert "recovered" in types(run_ticks(eng, t + 50, CAMERA_CLEAR_S + 5))
    assert types(eng.on_message(CAM, cam(fire=True), t + 50 + CAMERA_CLEAR_S + 10)) == ["camera_fire"]


def test_camera_fire_closes_after_clear_period(eng):
    t = at(14)
    eng.on_message(CAM, cam(fire=True), t)
    eng.on_message(CAM, cam(), t + 10)                      # lửa cuối cùng thấy lúc t
    assert "recovered" not in types(run_ticks(eng, t + 10, CAMERA_CLEAR_S - 20))
    assert "vision" in eng.incidents
    acts = run_ticks(eng, t + CAMERA_CLEAR_S - 10, 20)
    assert "recovered" in types(acts)
    assert "vision" not in eng.incidents


# ---------------------------------------------------------------- camera thấy lửa + MQ135 có khói
def test_camera_fire_during_gas_waits_for_esp32_fire_and_does_not_duplicate(eng):
    t = at(14)
    eng.on_message(SAFETY, safety("gas"), t)
    acts = eng.on_message(CAM, cam(fire=True), t + 20)
    assert "camera_fire" not in types(acts)                            # chờ ESP32 chuyển fire
    acts = eng.on_message(SAFETY, safety("fire", camera_fire=True), t + 21)
    a = alerts(acts)
    assert [x.type for x in a] == ["fire"]
    assert "camera thấy LỬA" in a[0].message and a[0].details["evidence"] == ["mq135", "camera"]
    assert "camera_fire" not in types(run_ticks(eng, t + 21, CAMERA_FIRE_ESP_GRACE_S + 2))
    assert eng.esp_camera_fire is True


def test_camera_fire_during_gas_alerts_if_esp32_does_not_react(eng):
    t = at(14)
    eng.on_message(SAFETY, safety("gas_danger"), t)
    eng.on_message(CAM, cam(fire=True), t + 20)
    acts = run_ticks(eng, t + 20, CAMERA_FIRE_ESP_GRACE_S)
    a = [x for x in alerts(acts) if x.type == "camera_fire"]
    assert len(a) == 1 and "CHƯA chuyển" in a[0].message


def test_camera_fire_when_esp32_already_fire_only_logs_incident_event(eng):
    t = at(14)
    eng.on_message(SAFETY, safety("fire"), t)
    acts = eng.on_message(CAM, cam(fire=True), t + 5)
    assert types(acts) == [] and not cmds(acts)
    ev = [e for e in acts if isinstance(e, IncidentEvent)]
    assert ev and ev[0].kind == "safety" and ev[0].event == {"event": "camera_fire"}


def test_camera_fire_when_esp32_offline_alerts_immediately(eng):
    t = at(14)
    eng.on_message(SAFETY, safety("gas"), t)
    eng.on_message(ONLINE, {"status": "offline"}, t + 1)
    acts = eng.on_message(CAM, cam(fire=True), t + 5)
    assert "camera_fire" in types(acts)


# ---------------------------------------------------------------- khói
def test_camera_smoke_is_warning_after_confirm_and_no_device_action(eng):
    t = at(14)
    acts = eng.on_message(CAM, cam(smoke=True), t)
    assert types(acts) == [] and not cmds(acts)
    acts = run_ticks(eng, t, eng.cfg.gas_confirm_s)
    a = alerts(acts)
    assert [x.type for x in a] == ["camera_smoke"] and a[0].level == "warning"
    assert not cmds(acts)


def test_brief_camera_smoke_is_not_alerted(eng):
    t = at(14)
    eng.on_message(CAM, cam(smoke=True), t)
    eng.on_message(CAM, cam(), t + 3)
    assert "camera_smoke" not in types(run_ticks(eng, t + 3, 30))


def test_camera_smoke_ignored_when_mq135_already_reports_gas(eng):
    t = at(14)
    eng.on_message(SAFETY, safety("gas"), t)
    eng.on_message(CAM, cam(smoke=True), t + 1)
    assert "camera_smoke" not in types(run_ticks(eng, t + 1, 30))


def test_camera_smoke_has_cooldown(eng):
    t = at(14)
    eng.on_message(CAM, cam(smoke=True), t)
    assert "camera_smoke" in types(run_ticks(eng, t, 15))
    eng.on_message(CAM, cam(), t + 30)
    eng.on_message(CAM, cam(smoke=True), t + 40)
    assert "camera_smoke" not in types(run_ticks(eng, t + 40, 15))   # trong cooldown 10 phút


# ---------------------------------------------------------------- camera lỗi / không có model lửa
def test_camera_error_or_offline_clears_fire_state(eng):
    t = at(14)
    eng.on_message(CAM, cam(fire=True, smoke=True), t)
    eng.on_message(CAM, {"error": "camera_unavailable"}, t + 5)
    assert eng.camera_fire is False and eng.camera_smoke is False
    eng.on_message("warehouse/status/camera", {"status": "online"}, t + 6)
    eng.on_message(CAM, cam(fire=True), t + 7)
    eng.on_message("warehouse/status/camera", {"status": "offline"}, t + 8)
    assert eng.camera_fire is False


def test_payload_without_fire_fields_keeps_fire_detection_unknown(eng):
    acts = eng.on_message(CAM, {"person": False, "personCount": 0, "personConf": None, "fps": 9.8}, at(14))
    assert acts == [] and eng.camera_fire_enabled is False
    assert eng.snapshot()["camera"]["fireEnabled"] is False


# ---------------------------------------------------------------- Safety Guard
def test_guard_blocks_fan_on_and_light_off_when_camera_sees_fire():
    ctx = guard.GuardContext(safety="normal", hum=50, climate_age_s=5, online=True, camera_fire=True)
    assert not guard.check_device("fan", ctx, state="on").allowed
    assert not guard.check_device("light", ctx, state="off").allowed
    assert guard.check_device("fan", ctx, state="off").allowed
    assert guard.check_device("mist", ctx, state="on").allowed       # người dùng tự bật phun sương được
    gas = guard.GuardContext(safety="gas", online=True, camera_fire=True)
    assert not guard.check_incident_action("fan", gas, state="on").allowed
