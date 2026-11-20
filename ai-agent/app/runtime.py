"""Vận hành tầng luật: nhận MQTT -> RuleEngine -> thực thi action (gửi cảnh báo, lệnh, lưu sự cố).

Ba vòng lặp chạy song song trong cùng tiến trình FastAPI:
  consume()   — xử lý từng bản tin MQTT ngay khi tới
  ticker()    — nhịp 1 giây cho các luật theo thời gian (xác nhận khí, mất dữ liệu, lệnh không phản hồi...)
  escalator() — 30 giây/lần hỏi Java BE: cảnh báo critical chưa ai xem quá ESCALATION_MIN -> leo thang
"""

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import Any

from psycopg_pool import AsyncConnectionPool

from app.backend_client import BackendClient
from app.config import Settings
from app.logging_setup import get_logger
from app.mqtt.client import MqttBridge
from app.observability.langfuse import Tracer
from app.rules.actions import Action, Alert, Command, IncidentEvent
from app.rules.alert_policy import AlertDispatcher
from app.rules.engine import RuleEngine

log = get_logger("RUNTIME")
cmd_log = get_logger("CMD")
inc_log = get_logger("INCIDENT")
esc_log = get_logger("ESCALATE")
mqtt_log = get_logger("MQTT")

ESCALATION_POLL_S = 30


class RuleRuntime:
    def __init__(self, settings: Settings, engine: RuleEngine, mqtt: MqttBridge, dispatcher: AlertDispatcher,
                 tracer: Tracer, backend: BackendClient, pool: AsyncConnectionPool | None):
        self.s = settings
        self.engine = engine
        self.mqtt = mqtt
        self.dispatcher = dispatcher
        self.tracer = tracer
        self.backend = backend
        self.pool = pool
        self.escalated: set[int] = set()
        self.messages = 0
        self.started_at = time.time()
        self._tasks: list[asyncio.Task] = []

    def start(self) -> None:
        self._tasks = [asyncio.create_task(self.consume(), name="rules-consume"),
                       asyncio.create_task(self.ticker(), name="rules-tick"),
                       asyncio.create_task(self.escalator(), name="rules-escalate")]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # ------------------------------------------------------------------ vòng lặp
    async def consume(self) -> None:
        while True:
            topic, data, retained = await self.mqtt.queue.get()
            self.messages += 1
            mqtt_log.debug("<- %s%s %s", topic, " (retained)" if retained else "",
                           json.dumps(data, ensure_ascii=False)[:200])
            try:
                await self.execute(self.engine.on_message(topic, data, time.time()))
            except Exception:  # noqa: BLE001 — một bản tin lỗi không được làm dừng tầng luật
                log.exception("Lỗi xử lý %s", topic)

    async def ticker(self) -> None:
        while True:
            await asyncio.sleep(1)
            try:
                await self.execute(self.engine.tick(time.time()))
            except Exception:  # noqa: BLE001
                log.exception("Lỗi tick")

    async def escalator(self) -> None:
        await asyncio.sleep(10)
        while True:
            try:
                await self.escalate_once()
            except Exception as e:  # noqa: BLE001
                esc_log.warning("Không kiểm tra được cảnh báo chưa xem (Java BE: %s): %s",
                                self.s.backend_base_url, e)
            await asyncio.sleep(ESCALATION_POLL_S)

    # ------------------------------------------------------------------ thực thi
    async def execute(self, actions: list[Action]) -> None:
        for a in actions:
            if isinstance(a, Alert):
                await self.dispatcher.dispatch(a)
            elif isinstance(a, Command):
                topic = f"warehouse/cmd/{a.device}"
                ok = self.mqtt.publish(topic, a.payload)
                cmd_log.info("-> %s %s%s", topic, json.dumps(a.payload, ensure_ascii=False),
                             "" if ok else "  [GỬI THẤT BẠI]")
                self.tracer.event(f"command.{a.device}", input=a.payload, metadata={"sent": ok})
            elif isinstance(a, IncidentEvent):
                await self.save_incident(a)

    async def save_incident(self, e: IncidentEvent) -> None:
        verb = {"open": "MỞ", "update": "cập nhật", "close": "ĐÓNG"}[e.action]
        inc_log.info("%s %s (%s, %s%s)", verb, e.incident_id, e.kind, e.level, f", {e.state}" if e.state else "")
        self.tracer.event(f"incident.{e.action}", input=e.event,
                          metadata={"kind": e.kind, "level": e.level, "state": e.state}, group=e.incident_id)
        if self.pool is None:
            return
        ts = datetime.fromtimestamp(e.ts, timezone.utc)
        event = json.dumps([{**e.event, "ts": ts.isoformat(timespec="seconds")}], ensure_ascii=False)
        try:
            async with self.pool.connection() as conn:
                if e.action == "open":
                    await conn.execute(
                        """INSERT INTO agent.incidents (id, kind, level, state, opened_at, events)
                           VALUES (%s, %s, %s, %s, %s, %s::jsonb) ON CONFLICT (id) DO NOTHING""",
                        (e.incident_id, e.kind, e.level, e.state, ts, event))
                else:
                    await conn.execute(
                        """UPDATE agent.incidents
                           SET level = %s, state = COALESCE(%s, state), events = events || %s::jsonb,
                               closed_at = CASE WHEN %s THEN %s ELSE closed_at END
                           WHERE id = %s""",
                        (e.level, None if e.action == "close" else e.state, event, e.action == "close", ts,
                         e.incident_id))
        except Exception as ex:  # noqa: BLE001
            inc_log.error("Không lưu được sự cố %s: %s", e.incident_id, ex)

    async def escalate_once(self) -> int:
        """Cảnh báo critical chưa ai bấm "Đã xem" quá ESCALATION_MIN phút -> gửi cảnh báo leo thang (1 lần / cảnh báo)."""
        alerts = await self.backend.unacked_critical_alerts()
        now = datetime.now(timezone.utc)
        n = 0
        for a in alerts:
            if a.get("type") == "escalation" or a["id"] in self.escalated:
                continue
            ts = datetime.fromisoformat(str(a["ts"]).replace("Z", "+00:00"))
            age_min = (now - ts).total_seconds() / 60
            if age_min < self.s.escalation_min:
                continue
            self.escalated.add(a["id"])
            esc_log.critical("Cảnh báo #%s (%s) chưa ai xem sau %d phút", a["id"], a.get("type"), int(age_min))
            await self.dispatcher.dispatch(Alert(
                "escalation", "critical",
                f"CHƯA AI XEM sau {int(age_min)} phút: {a.get('message')}",
                a.get("incidentId"),
                {"original_alert_id": a["id"], "original_type": a.get("type"), "minutes": int(age_min)}))
            n += 1
        return n

    def status(self) -> dict[str, Any]:
        snap = self.engine.snapshot()
        if self.engine.last_data_at:
            snap["lastDataAgoS"] = round(time.time() - self.engine.last_data_at, 1)
        return {"uptimeS": round(time.time() - self.started_at), "messages": self.messages,
                "alertsSent": self.dispatcher.sent, "escalated": len(self.escalated), "engine": snap}
