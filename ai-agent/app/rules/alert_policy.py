"""Gửi cảnh báo theo mức (CLAUDE.md mục 5.4):

- critical: gửi NGAY bản cơ bản; nếu có LLM (giai đoạn 4) thì phân tích sau và gửi thêm bản bổ sung.
- warning / info: đưa LLM viết lại trước, chờ tối đa LLM_ALERT_TIMEOUT_S; quá hạn / lỗi / chưa có LLM
  -> gửi bản cơ bản của tầng luật.
LLM chỉ được sửa NỘI DUNG; không được bỏ hay hạ mức cảnh báo.
"""

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from app.logging_setup import get_logger
from app.mqtt.client import MqttBridge
from app.observability.langfuse import Tracer
from app.rules.actions import Alert

log = get_logger("ALERT")
ALERT_TOPIC = "warehouse/alert"

# Giai đoạn 4: hàm nhận Alert, trả nội dung mới {"message": ..., "details": {...}} (hoặc None = giữ nguyên)
Enricher = Callable[[Alert], Awaitable[dict[str, Any] | None]]


def alert_payload(alert: Alert, source: str = "rule") -> dict[str, Any]:
    return {
        "uid": uuid.uuid4().hex,
        "type": alert.type,
        "level": alert.level,
        "message": alert.message,
        "source": source,
        "incident_id": alert.incident_id,
        "details": alert.details,
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


class AlertDispatcher:
    def __init__(self, mqtt: MqttBridge, tracer: Tracer, llm_timeout_s: int, enricher: Enricher | None = None):
        self.mqtt = mqtt
        self.tracer = tracer
        self.llm_timeout_s = llm_timeout_s
        self.enricher = enricher
        self.sent = 0

    async def dispatch(self, alert: Alert) -> dict[str, Any]:
        if alert.level == "critical" or self.enricher is None:
            note = "" if alert.level == "critical" else " (chưa có LLM — gửi bản của tầng luật)"
            payload = self._send(alert_payload(alert), note)
            if alert.level == "critical" and self.enricher is not None:
                asyncio.create_task(self._follow_up(alert))
            return payload

        try:
            new = await asyncio.wait_for(self.enricher(alert), timeout=self.llm_timeout_s)
        except asyncio.TimeoutError:
            log.warning("LLM quá %ss — gửi bản cơ bản: %s", self.llm_timeout_s, alert.type)
            return self._send(alert_payload(alert), " (LLM quá hạn)")
        except Exception as e:  # noqa: BLE001
            log.error("LLM lỗi (%s) — gửi bản cơ bản: %s", e, alert.type)
            return self._send(alert_payload(alert), " (LLM lỗi)")
        payload = alert_payload(alert, source="agent" if new else "rule")
        if new:
            payload["message"] = new.get("message") or alert.message
            payload["details"] = {**alert.details, **(new.get("details") or {})}
        return self._send(payload, "")

    async def _follow_up(self, alert: Alert) -> None:
        """critical: LLM phân tích sau, gửi bản bổ sung (giai đoạn 4)."""
        try:
            new = await self.enricher(alert)  # type: ignore[misc]
        except Exception as e:  # noqa: BLE001
            log.error("Phân tích bổ sung cho %s lỗi: %s", alert.type, e)
            return
        if new and new.get("message"):
            payload = alert_payload(alert, source="agent")
            payload.update(type=f"{alert.type}_analysis", message=new["message"],
                           details={**alert.details, **(new.get("details") or {})})
            self._send(payload, " (phân tích bổ sung)")

    def _send(self, payload: dict[str, Any], note: str) -> dict[str, Any]:
        ok = self.mqtt.publish(ALERT_TOPIC, payload)
        fn = {"critical": log.critical, "warning": log.warning}.get(payload["level"], log.info)
        fn("%s %s — %s%s%s", payload["level"].upper(), payload["type"], payload["message"], note,
           "" if ok else "  [GỬI THẤT BẠI: mất kết nối broker]")
        self.sent += 1
        self.tracer.event(f"alert.{payload['type']}", input=payload["details"], output=payload["message"],
                          metadata={"level": payload["level"], "source": payload["source"], "sent": ok,
                                    "incident_id": payload["incident_id"]},
                          level={"critical": "ERROR", "warning": "WARNING"}.get(payload["level"], "DEFAULT"),
                          group=payload["incident_id"])
        return payload
