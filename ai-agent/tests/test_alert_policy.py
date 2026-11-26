"""critical gửi ngay; warning / info chờ LLM tối đa N giây, quá hạn / lỗi -> bản cơ bản."""

import asyncio

from app.rules.actions import Alert
from app.rules.alert_policy import AlertDispatcher


class FakeMqtt:
    def __init__(self):
        self.sent = []

    def publish(self, topic, payload, retain=False):
        self.sent.append((topic, payload))
        return True


class NoTracer:
    enabled = False

    def event(self, *a, **k):
        pass


async def test_without_llm_everything_is_sent_immediately():
    mqtt = FakeMqtt()
    d = AlertDispatcher(mqtt, NoTracer(), llm_timeout_s=15)
    await d.dispatch(Alert("gas", "warning", "Khí", "inc-1", {"mq135": 1800}))
    topic, p = mqtt.sent[0]
    assert topic == "warehouse/alert"
    assert p["type"] == "gas" and p["level"] == "warning" and p["source"] == "rule"
    assert p["incident_id"] == "inc-1" and p["details"] == {"mq135": 1800} and p["uid"] and p["ts"]


async def test_critical_is_not_delayed_by_slow_llm_and_gets_follow_up():
    mqtt = FakeMqtt()

    async def slow_llm(alert):
        await asyncio.sleep(0.2)
        return {"message": "Phân tích: khói tăng dần 5 phút"}

    d = AlertDispatcher(mqtt, NoTracer(), llm_timeout_s=15, enricher=slow_llm)
    await d.dispatch(Alert("fire", "critical", "NGHI CHÁY", "inc-1"))
    assert [p["type"] for _, p in mqtt.sent] == ["fire"]          # gửi ngay, không chờ
    await asyncio.sleep(0.3)
    assert [p["type"] for _, p in mqtt.sent] == ["fire", "fire_analysis"]
    assert mqtt.sent[1][1]["source"] == "agent" and mqtt.sent[1][1]["level"] == "critical"


async def test_warning_uses_llm_text_but_keeps_level():
    mqtt = FakeMqtt()

    async def llm(alert):
        return {"message": "Có khí, có thể do hàn chiều thứ 6", "details": {"note": "welding"}, "level": "info"}

    d = AlertDispatcher(mqtt, NoTracer(), llm_timeout_s=15, enricher=llm)
    await d.dispatch(Alert("gas", "warning", "Khí", None, {"mq135": 1800}))
    p = mqtt.sent[0][1]
    assert p["message"].startswith("Có khí") and p["source"] == "agent"
    assert p["level"] == "warning"                                  # LLM không hạ được mức
    assert p["details"] == {"mq135": 1800, "note": "welding"}


async def test_warning_falls_back_on_timeout_and_error():
    mqtt = FakeMqtt()

    async def hang(alert):
        await asyncio.sleep(5)

    d = AlertDispatcher(mqtt, NoTracer(), llm_timeout_s=0.1, enricher=hang)
    await d.dispatch(Alert("gas", "warning", "Khí"))
    assert mqtt.sent[0][1]["message"] == "Khí" and mqtt.sent[0][1]["source"] == "rule"

    async def boom(alert):
        raise RuntimeError("OpenAI 500")

    d.enricher = boom
    await d.dispatch(Alert("hum_high_prolonged", "info", "Ẩm"))
    assert mqtt.sent[1][1]["message"] == "Ẩm"
