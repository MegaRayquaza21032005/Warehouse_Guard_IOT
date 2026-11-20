"""Kết quả của tầng luật: việc cần làm. Engine chỉ TRẢ VỀ action; runtime mới thực thi (MQTT, DB, log)."""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Alert:
    type: str                     # fire | fire_people | gas_danger | gas | intrusion | device_offline | ...
    level: str                    # info | warning | critical
    message: str
    incident_id: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class Command:
    device: str                   # fan | mist | light
    payload: dict[str, Any]       # đã có source="rule", trace_id


@dataclass
class IncidentEvent:
    action: str                   # open | update | close
    incident_id: str
    kind: str                     # safety | intrusion | offline
    level: str
    state: str | None
    ts: float
    event: dict[str, Any] = field(default_factory=dict)


Action = Alert | Command | IncidentEvent
