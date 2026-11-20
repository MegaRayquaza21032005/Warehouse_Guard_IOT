"""Safety Guard — chính sách bằng code cho tool ghi (CLAUDE.md mục 5, 8)."""

from app.agents.safety_guard import GuardContext, check_config, check_device, check_incident_action


def ctx(**kw) -> GuardContext:
    base = dict(safety="normal", temp=30.0, hum=60.0, climate_age_s=5, hum_high=80.0, online=True)
    base.update(kw)
    return GuardContext(**base)


def test_fan_on_blocked_when_fire():
    v = check_device("fan", ctx(safety="fire"), state="on")
    assert not v.allowed and "CHÁY" in v.reason


def test_fan_off_blocked_in_gas_danger_but_warns_in_gas():
    assert not check_device("fan", ctx(safety="gas_danger"), state="off").allowed
    v = check_device("fan", ctx(safety="gas"), state="off")
    assert v.allowed and v.note


def test_mist_blocked_when_humid_smoke_or_unknown_humidity():
    assert not check_device("mist", ctx(hum=85.0), state="on").allowed
    assert not check_device("mist", ctx(safety="gas"), state="on").allowed
    assert not check_device("mist", ctx(hum=None, climate_age_s=None), state="on").allowed
    assert not check_device("mist", ctx(climate_age_s=600), state="on").allowed      # số liệu cũ
    assert check_device("mist", ctx(hum=50.0), state="on").allowed
    assert check_device("mist", ctx(safety="fire", hum=50.0), state="on").allowed
    assert check_device("mist", ctx(hum=95.0), state="off").allowed                   # tắt luôn được


def test_light_off_blocked_in_danger_and_auto_always_ok():
    assert not check_device("light", ctx(safety="fire"), state="off").allowed
    assert check_device("light", ctx(safety="fire"), mode="auto").allowed
    assert check_device("fan", ctx(safety="fire"), mode="auto").allowed


def test_invalid_args_and_offline():
    assert not check_device("pump", ctx(), state="on").allowed
    assert not check_device("fan", ctx(), state="on", mode="auto").allowed
    assert not check_device("fan", ctx()).allowed
    assert not check_device("fan", ctx(), state="on", duration_s=0).allowed
    assert not check_device("fan", ctx(), state="on", duration_s=90000).allowed
    assert not check_device("fan", ctx(online=False), state="on").allowed
    assert check_device("fan", ctx(online=None), state="on", duration_s=600).allowed


def test_incident_allowlist():
    assert check_incident_action("light", ctx(), state="on").allowed
    assert check_incident_action("fan", ctx(safety="gas"), state="on").allowed
    assert not check_incident_action("fan", ctx(), state="on").allowed           # không có khí
    assert not check_incident_action("fan", ctx(safety="fire"), state="on").allowed
    assert not check_incident_action("mist", ctx(), state="on").allowed
    assert not check_incident_action("light", ctx(), state="off").allowed


def test_config_validation_like_firmware():
    v, merged = check_config({"tempHigh": 36}, {})
    assert v.allowed and merged["tempHigh"] == 36.0 and merged["mq2Warning"] == 1500
    assert not check_config({}, {})[0].allowed
    assert not check_config({"foo": 1}, {})[0].allowed
    assert not check_config({"mq2Warning": 2400}, {})[0].allowed             # danger 2500 <= 2400 + 150
    assert not check_config({"mistHumMax": 85}, {})[0].allowed              # >= humHigh 80
    assert not check_config({"tempRiseWindowMin": 20}, {})[0].allowed
    assert not check_config({"tempRiseWindowMin": 2.5}, {})[0].allowed      # phải nguyên
    assert not check_config({"tempHigh": True}, {})[0].allowed
    v, merged = check_config({"mq2Warning": 1000}, {"mq2Danger": 2000, "unknown": 1})
    assert v.allowed and merged["mq2Danger"] == 2000 and "unknown" not in merged
