"""Tách khối biểu đồ (```chart {...}```) khỏi câu trả lời của Supervisor (CLAUDE.md mục 6).

Khối biểu đồ chứa CÂU TRUY VẤN, không chứa số liệu — frontend tự gọi /api/stats (hoặc /api/stats/timeline)
rồi vẽ. Khối sai định dạng bị bỏ (ghi log), phần chữ vẫn giữ.
"""

import json
import re
from typing import Any

from app.logging_setup import get_logger

log = get_logger("AGENT")
CHART_RE = re.compile(r"```chart\s*\n(.*?)```", re.S)
CHART_TYPES = {"line", "bar", "stacked_bar", "heatmap", "timeline", "stat"}
METRICS = {"temp", "hum", "mq2", "motion_count", "threshold_exceeded_pct", "device_on_minutes", "command_count",
           "device_state"}


def _valid_chart(obj: Any) -> dict[str, Any] | None:
    if not isinstance(obj, dict) or obj.get("chart") not in CHART_TYPES:
        return None
    q = obj.get("query")
    if not isinstance(q, dict) or q.get("metric") not in METRICS or not q.get("from") or not q.get("to"):
        return None
    if q["metric"] in ("device_on_minutes", "device_state") and q.get("device") not in ("fan", "mist", "light"):
        return None
    if isinstance(q.get("agg"), str):
        q["agg"] = [a.strip() for a in q["agg"].split(",") if a.strip()]
    block: dict[str, Any] = {"type": "chart", "chart": obj["chart"], "title": str(obj.get("title") or ""),
                             "query": q}
    if isinstance(obj.get("thresholds"), list):
        block["thresholds"] = [t for t in obj["thresholds"] if isinstance(t, dict) and "value" in t]
    return block


def parse_blocks(text: str) -> tuple[list[dict[str, Any]], str]:
    """-> (blocks, chữ thuần không có khối biểu đồ — dùng cho đọc thành tiếng)."""
    blocks: list[dict[str, Any]] = []
    plain: list[str] = []
    pos = 0
    for m in CHART_RE.finditer(text):
        before = text[pos:m.start()].strip()
        if before:
            blocks.append({"type": "text", "text": before})
            plain.append(before)
        try:
            chart = _valid_chart(json.loads(m.group(1)))
        except json.JSONDecodeError:
            chart = None
        if chart:
            blocks.append(chart)
        else:
            log.warning("Bỏ khối biểu đồ sai định dạng: %s", m.group(1)[:200])
        pos = m.end()
    rest = text[pos:].strip()
    if rest:
        blocks.append({"type": "text", "text": rest})
        plain.append(rest)
    return blocks, "\n\n".join(plain)
