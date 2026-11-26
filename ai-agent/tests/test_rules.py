"""Test tầng luật bằng đồng hồ giả — không cần MQTT / DB."""

from datetime import datetime, time
from zoneinfo import ZoneInfo

import pytest

from app.rules.actions import Alert, Command, IncidentEvent
from app.rules.engine import RuleConfig, RuleEngine
from app.rules.schedule import WorkSchedule

TZ = ZoneInfo("Asia/Ho_Chi_Minh")


def at(hh: int, mm: int = 0, ss: int = 0, day: int = 5) -> float:
    """Thời điểm trong ngày thứ Hai 05/01/2026 (day=5) hoặc ngày khác, giờ Việt Nam."""
    return datetime(2026, 1, day, hh, mm, ss, tzinfo=TZ).timestamp()


@pytest.fixture
def eng() -> RuleEngine:
    sched = WorkSchedule(time(8, 0), time(17, 30), frozenset({1, 2, 3, 4, 5, 6}), TZ)
    counter = iter(range(1, 10_000))
    return RuleEngine(RuleConfig(), sched, new_id=lambda: f"id{next(counter)}")


def alerts(acts) -> list[Alert]:
    return [a for a in acts if isinstance(a, Alert)]


def types(acts) -> list[str]:
    return [a.type for a in alerts(acts)]


def safety(eng, state, now, faults=()):
    return eng.on_message("warehouse/status/safety", {"state": state, "faults": list(faults)}, now)


# ---------------------------------------------------------------- an toàn
def test_fire_is_critical_immediately_and_opens_incident(eng):
    t = at(10)
    acts = safety(eng, "fire", t)
    a = alerts(acts)
    assert [x.type for x in a] == ["fire"] and a[0].level == "critical"
    opens = [e for e in acts if isinstance(e, IncidentEvent) and e.action == "open"]
    assert opens and opens[0].kind == "safety" and a[0].incident_id == opens[0].incident_id


def test_fire_with_recent_motion_reports_people(eng):
    t = at(10)
    eng.on_message("warehouse/sensor/pir", {"motion": True}, t)
    eng.on_message("warehouse/sensor/pir", {"motion": False}, t + 30)
    assert types(safety(eng, "fire", t + 60)) == ["fire_people"]


def test_motion_during_fire_alerts_people_once(eng):
    t = at(10)
    safety(eng, "fire", t)
    assert types(eng.on_message("warehouse/sensor/pir", {"motion": True}, t + 5)) == ["fire_people"]
    eng.on_message("warehouse/sensor/pir", {"motion": False}, t + 10)
    assert types(eng.on_message("warehouse/sensor/pir", {"motion": True}, t + 15)) == []


def test_gas_waits_for_confirmation(eng):
    t = at(10)
    assert types(safety(eng, "gas", t)) == []
    assert types(eng.tick(t + 5)) == []
    a = alerts(eng.tick(t + 10))
    assert [x.type for x in a] == ["gas"] and a[0].level == "warning"
    assert types(eng.tick(t + 20)) == []          # chỉ báo 1 lần


def test_short_gas_blip_is_not_reported(eng):
    t = at(10)
    safety(eng, "gas", t)
    acts = safety(eng, "normal", t + 3)
    assert "gas" not in types(acts) and "gas" not in types(eng.tick(t + 20))


def test_gas_escalating_to_fire_same_incident(eng):
    t = at(10)
    safety(eng, "gas", t)
    eng.tick(t + 10)
    acts = safety(eng, "fire", t + 30)
    assert types(acts) == ["fire"]
    assert any(isinstance(e, IncidentEvent) and e.action == "update" for e in acts)
    # hạ từ fire về gas: không báo khí lại
    assert types(safety(eng, "gas", t + 300)) == [] and types(eng.tick(t + 400)) == []


def test_recovery_closes_incident_with_info(eng):
    t = at(10)
    safety(eng, "gas_danger", t)
    acts = safety(eng, "normal", t + 600)
    a = alerts(acts)
    assert [x.type for x in a] == ["recovered"] and a[0].level == "info"
    assert "10 phút" in a[0].message and "gas_danger" in a[0].message
    assert any(isinstance(e, IncidentEvent) and e.action == "close" for e in acts)
    assert "safety" not in eng.incidents


def test_critical_is_never_suppressed_by_cooldown(eng):
    t = at(10)
    for i in range(3):
        assert types(safety(eng, "fire", t + i * 20)) == ["fire"]
        safety(eng, "normal", t + i * 20 + 10)


def test_warning_cooldown(eng):
    t = at(10)
    safety(eng, "gas", t); eng.tick(t + 10)
    safety(eng, "normal", t + 60)
    safety(eng, "gas", t + 120)
    assert types(eng.tick(t + 130)) == []                   # còn cooldown 10 phút
    safety(eng, "normal", t + 200)
    safety(eng, "gas", t + 700)
    assert types(eng.tick(t + 710)) == ["gas"]              # hết cooldown


def test_sensor_faults(eng):
    t = at(10)
    a = alerts(safety(eng, "normal", t, faults=["dht_failed"]))
    assert [x.type for x in a] == ["sensor_fault"] and a[0].details["fault"] == "dht_failed"
    assert types(safety(eng, "normal", t + 5, faults=["dht_failed"])) == []   # lỗi cũ không báo lại


# ---------------------------------------------------------------- đột nhập
def test_motion_after_hours_alerts_and_turns_light_on(eng):
    t = at(22)
    acts = eng.on_message("warehouse/sensor/pir", {"motion": True}, t)
    assert types(acts) == ["intrusion"] and alerts(acts)[0].level == "critical"
    cmds = [c for c in acts if isinstance(c, Command)]
    assert len(cmds) == 1 and cmds[0].device == "light"
    p = cmds[0].payload
    assert p["state"] == "on" and p["source"] == "rule" and p["reason"] == "motion_after_hours"
    assert p["duration_s"] == 300 and p["trace_id"].startswith("rule-")


def test_continued_motion_same_incident_light_refresh_limited(eng):
    t = at(22)
    eng.on_message("warehouse/sensor/pir", {"motion": True}, t)
    eng.on_message("warehouse/sensor/pir", {"motion": False}, t + 10)
    acts = eng.on_message("warehouse/sensor/pir", {"motion": True}, t + 20)
    assert types(acts) == [] and not [c for c in acts if isinstance(c, Command)]
    eng.on_message("warehouse/sensor/pir", {"motion": False}, t + 30)
    acts = eng.on_message("warehouse/sensor/pir", {"motion": True}, t + 90)
    assert len([c for c in acts if isinstance(c, Command)]) == 1        # làm mới đèn sau 60s


def test_intrusion_closes_after_quiet_period(eng):
    t = at(22)
    eng.on_message("warehouse/sensor/pir", {"motion": True}, t)
    eng.on_message("warehouse/sensor/pir", {"motion": False}, t + 10)
    for s in range(15, 600, 5):                       # ESP32 vẫn gửi dữ liệu đều
        eng.on_message("warehouse/sensor/mq135", {"raw": 800}, t + s)
    assert types(eng.tick(t + 300)) == []
    a = alerts(eng.tick(t + 600))
    assert [x.type for x in a] == ["recovered"] and a[0].details["kind"] == "intrusion"


def test_motion_during_work_hours_is_normal(eng):
    acts = eng.on_message("warehouse/sensor/pir", {"motion": True}, at(9))
    assert acts == []


def test_sunday_is_after_hours(eng):
    assert types(eng.on_message("warehouse/sensor/pir", {"motion": True}, at(10, day=11))) == ["intrusion"]


# ---------------------------------------------------------------- kết nối & thiết bị
def test_offline_and_back_online(eng):
    t = at(10)
    eng.on_message("warehouse/status/online", {"status": "online"}, t)
    acts = eng.on_message("warehouse/status/online", {"status": "offline"}, t + 5)
    assert types(acts) == ["device_offline"]
    assert types(eng.tick(t + 200)) == []                    # không báo thêm "no_data"
    assert types(eng.on_message("warehouse/status/online", {"status": "online"}, t + 300)) == ["recovered"]


def test_no_data_timeout(eng):
    t = at(10)
    eng.on_message("warehouse/status/online", {"status": "online"}, t)
    eng.on_message("warehouse/sensor/mq135", {"raw": 800}, t)
    assert types(eng.tick(t + 60)) == []
    assert types(eng.tick(t + 61)) == ["no_data"]
    assert types(eng.tick(t + 120)) == []
    assert types(eng.on_message("warehouse/sensor/mq135", {"raw": 800}, t + 130)) == ["recovered"]


def test_command_without_ack_alerts_device_no_response(eng):
    t = at(10)
    eng.on_message("warehouse/status/online", {"status": "online"}, t)
    eng.on_message("warehouse/cmd/fan", {"state": "on", "source": "user", "trace_id": "t1"}, t)
    eng.on_message("warehouse/cmd/light", {"state": "on", "source": "user", "trace_id": "t2"}, t)
    eng.on_message("warehouse/sensor/mq135", {"raw": 800}, t + 5)
    eng.on_message("warehouse/status/light", {"state": "on", "ack": {"trace_id": "t2", "result": "applied"}}, t + 1)
    a = alerts(eng.tick(t + 10))
    assert [x.type for x in a] == ["device_no_response"] and a[0].details["device"] == "fan"


def test_mist_max_time_and_ventilation_ineffective(eng):
    t = at(10)
    safety(eng, "fire", t)
    acts = eng.on_message("warehouse/status/mist", {"state": "off", "reason": "fire_max_time"}, t + 600)
    assert types(acts) == ["mist_fire_max_time"] and alerts(acts)[0].level == "critical"
    assert types(eng.on_message("warehouse/status/mist", {"state": "off", "reason": "fire_max_time"}, t + 605)) == []
    acts = eng.on_message("warehouse/status/fan", {"state": "off", "reason": "hum_ineffective"}, t + 700)
    assert types(acts) == ["ventilation_ineffective"] and alerts(acts)[0].level == "info"


# ---------------------------------------------------------------- môi trường
def test_prolonged_heat_uses_thresholds_from_config(eng):
    t = at(10)
    eng.on_message("warehouse/status/config", {"tempHigh": 35, "humHigh": 80}, t)
    for i in range(0, 15 * 60 + 1, 60):
        acts = eng.on_message("warehouse/sensor/dht11", {"temp": 36.0, "hum": 60.0}, t + i)
    assert types(acts) == ["temp_high_prolonged"]
    # vẫn nóng: không báo lại; dưới (ngưỡng - 2) rồi nóng lại 15 phút: báo lại (sau cooldown)
    assert types(eng.on_message("warehouse/sensor/dht11", {"temp": 36.0, "hum": 60.0}, t + 1000)) == []


def test_ignores_garbage(eng):
    assert eng.on_message("other/topic", {"x": 1}, at(10)) == []
    assert eng.on_message("warehouse/sensor/dht11", {"error": "read_failed"}, at(10)) == []
    assert eng.on_message("warehouse/status/safety", {"state": "weird"}, at(10)) == []
