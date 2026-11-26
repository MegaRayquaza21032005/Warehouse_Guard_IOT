"""Tầng luật: camera YOLO (warehouse/sensor/camera) BỔ SUNG PIR — không hạ mức, không chặn cảnh báo của PIR."""

from datetime import datetime, time
from zoneinfo import ZoneInfo

import pytest

from app.rules.actions import Alert, Command, IncidentEvent
from app.rules.engine import RuleConfig, RuleEngine
from app.rules.schedule import WorkSchedule

TZ = ZoneInfo("Asia/Ho_Chi_Minh")
CAM = "warehouse/sensor/camera"
PIR = "warehouse/sensor/pir"


def at(hh: int, mm: int = 0, ss: int = 0, day: int = 5) -> float:
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


def lights(acts) -> list[Command]:
    return [c for c in acts if isinstance(c, Command) and c.device == "light"]


def person(n=1, conf=0.9):
    return {"person": True, "personCount": n, "personConf": conf, "fps": 9.8}


NOBODY = {"person": False, "personCount": 0, "personConf": None, "fps": 9.8}


# ---------------------------------------------------------------- đột nhập
def test_camera_alone_opens_intrusion_and_turns_light_on(eng):
    acts = eng.on_message(CAM, person(2), at(22))
    a = alerts(acts)
    assert [x.type for x in a] == ["intrusion"] and a[0].level == "critical"
    assert "Camera phát hiện 2 người" in a[0].message
    assert a[0].details["evidence"] == ["camera"] and a[0].details["person_count"] == 2
    assert len(lights(acts)) == 1
    opened = [e for e in acts if isinstance(e, IncidentEvent) and e.action == "open"]
    assert opened and opened[0].kind == "intrusion" and opened[0].state == "person"


def test_pir_then_camera_sends_one_confirmation(eng):
    t = at(22)
    a = alerts(eng.on_message(PIR, {"motion": True}, t))
    assert [x.type for x in a] == ["intrusion"] and a[0].details["evidence"] == ["pir"]
    assert "camera" not in a[0].message.lower()
    acts = eng.on_message(CAM, person(1), t + 5)
    a = alerts(acts)
    assert [x.type for x in a] == ["intrusion_confirmed"] and a[0].level == "critical"
    assert a[0].incident_id == eng.incidents["intrusion"].id
    assert a[0].details["evidence"] == ["pir", "camera"]
    assert types(eng.on_message(CAM, person(2), t + 10)) == []           # chỉ xác nhận 1 lần / sự cố


def test_pir_when_camera_already_sees_person_mentions_both_no_extra_confirm(eng):
    t = at(22)
    eng.on_message(CAM, person(1), t)                                    # mở sự cố bằng camera
    assert types(eng.on_message(PIR, {"motion": True}, t + 2)) == []     # PIR sau đó: không báo thêm
    eng2_acts = eng.on_message(CAM, person(1), t + 4)
    assert types(eng2_acts) == []


def test_pir_alert_not_downgraded_when_camera_sees_nobody(eng):
    eng.on_message(CAM, NOBODY, at(21, 59))
    a = alerts(eng.on_message(PIR, {"motion": True}, at(22)))
    assert [x.type for x in a] == ["intrusion"] and a[0].level == "critical"


def test_camera_person_refreshes_light_at_most_once_a_minute(eng):
    t = at(22)
    assert len(lights(eng.on_message(CAM, person(), t))) == 1
    assert lights(eng.on_message(CAM, person(), t + 5)) == []            # nhịp 5s của vision
    assert len(lights(eng.on_message(CAM, person(), t + 61))) == 1


def test_camera_during_work_hours_is_normal(eng):
    assert eng.on_message(CAM, person(3), at(9)) == []


def test_intrusion_stays_open_while_camera_sees_person(eng):
    t = at(22)
    eng.on_message(PIR, {"motion": True}, t)
    eng.on_message(PIR, {"motion": False}, t + 10)
    for s in range(15, 1600, 5):
        eng.on_message("warehouse/sensor/mq135", {"raw": 800}, t + s)    # ESP32 vẫn gửi dữ liệu
        if s < 900:
            eng.on_message(CAM, person(), t + s)                         # người đứng yên: PIR im, camera vẫn thấy
        elif s == 905:
            eng.on_message(CAM, NOBODY, t + s)
    assert types(eng.tick(t + 900)) == [] and "intrusion" in eng.incidents   # PIR im đã 890s > 600s
    assert types(eng.tick(t + 905 + 300)) == []
    a = alerts(eng.tick(t + 900 + 600))
    assert [x.type for x in a] == ["recovered"] and "intrusion" not in eng.incidents


def test_camera_messages_do_not_count_as_esp32_data(eng):
    t = at(10)
    eng.on_message("warehouse/sensor/mq135", {"raw": 800}, t)
    for s in range(5, 120, 5):
        eng.on_message(CAM, NOBODY, t + s)
    assert types(eng.tick(t + 61)) == ["no_data"]


# ---------------------------------------------------------------- cháy có người
def test_fire_with_camera_person_reports_people(eng):
    t = at(10)
    eng.on_message(CAM, person(2), t)
    a = alerts(eng.on_message("warehouse/status/safety", {"state": "fire", "faults": []}, t + 30))
    assert [x.type for x in a] == ["fire_people"]
    assert "camera thấy 2 người" in a[0].message and a[0].details["evidence"] == ["camera"]


def test_camera_person_during_fire_alerts_people_once(eng):
    t = at(10)
    eng.on_message("warehouse/status/safety", {"state": "fire", "faults": []}, t)
    assert types(eng.on_message(CAM, person(1), t + 5)) == ["fire_people"]
    assert types(eng.on_message(PIR, {"motion": True}, t + 6)) == []
    assert types(eng.on_message(CAM, person(1), t + 10)) == []


def test_fire_people_via_pir_still_works_without_camera(eng):
    t = at(10)
    eng.on_message(PIR, {"motion": True}, t)
    a = alerts(eng.on_message("warehouse/status/safety", {"state": "fire", "faults": []}, t + 5))
    assert [x.type for x in a] == ["fire_people"] and "chuyển động" in a[0].message


# ---------------------------------------------------------------- lỗi / mất kết nối camera
def test_camera_error_warns_once_then_recovers(eng):
    t = at(10)
    a = alerts(eng.on_message(CAM, {"error": "camera_unavailable"}, t))
    assert [x.type for x in a] == ["camera_fault"] and a[0].level == "warning"
    assert types(eng.on_message(CAM, {"error": "camera_unavailable"}, t + 5)) == []
    eng.on_message(CAM, NOBODY, t + 10)
    assert eng.camera_error is None


def test_camera_error_clears_person(eng):
    t = at(22)
    eng.on_message(CAM, person(), t)
    eng.on_message(CAM, {"error": "camera_unavailable"}, t + 5)
    assert eng.camera_person is False


def test_camera_offline_only_after_being_online(eng):
    t = at(10)
    assert eng.on_message("warehouse/status/camera", {"status": "offline"}, t) == []   # retained lúc khởi động
    eng.on_message("warehouse/status/camera", {"status": "online", "model": "yolo26n.pt"}, t + 1)
    a = alerts(eng.on_message("warehouse/status/camera", {"status": "offline"}, t + 2))
    assert [x.type for x in a] == ["camera_offline"] and a[0].level == "warning"


def test_snapshot_includes_camera(eng):
    eng.on_message(CAM, person(2), at(9))
    cam = eng.snapshot()["camera"]
    assert cam["person"] is True and cam["count"] == 2
