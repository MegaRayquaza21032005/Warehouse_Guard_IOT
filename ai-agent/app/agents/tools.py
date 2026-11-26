"""Tools của 4 worker (CLAUDE.md mục 8) — MỌI tool đều tạo qua make_tool() nên đều có nhật ký bắt buộc.

| Worker       | Tools                                                                                    | Loại |
|--------------|------------------------------------------------------------------------------------------|------|
| monitor      | get_current_state, get_sensor_history, get_device_status, get_device_logs,               | đọc  |
|              | get_alert_history, get_statistics                                                        |      |
| analyst      | search_incidents, search_warehouse_facts, search_feedback                                | đọc  |
| control      | control_fan, control_mist, control_light, update_thresholds                              | GHI  |
| notification | publish_alert                                                                            | GHI  |
| supervisor   | save_memory (personal: lưu ngay; warehouse: cần người dùng xác nhận)                     | GHI  |

Tool GHI:
- Luồng chat: Safety Guard -> bị chặn: log `blocked_by_policy`; được phép: log `pending_confirmation` + tạo
  ĐỀ XUẤT (chưa gửi gì). Người dùng bấm Đồng ý -> ActionExecutor.execute() kiểm tra Safety Guard LẦN NỮA rồi gửi.
- Luồng sự cố: chỉ hành động trong danh sách cho phép (bật đèn, bật quạt khi có khí), chạy ngay, source=agent.
- Không ghi được nhật ký -> KHÔNG thực thi (ToolLogUnavailable).
"""

import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Literal
from zoneinfo import ZoneInfo

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from app.agents import safety_guard as guard
from app.logging_setup import get_logger
from app.observability.tool_logger import ToolCall, ToolCallLogger, ToolLogUnavailable
from app.rules.actions import Alert
from app.rules.alert_policy import alert_payload

log = get_logger("TOOL")
MAX_TOOL_TEXT = 3500            # kết quả tool đưa vào LLM tối đa (ký tự)
VN = ZoneInfo("Asia/Ho_Chi_Minh")
DEVICE_VERB = {"on": "Bật", "off": "Tắt"}


# ============================================================================================ ngữ cảnh 1 lần chạy
@dataclass
class RunContext:
    trace_id: str
    thread_id: str
    flow: str                                  # chat | incident
    user_id: int | None = None
    alert: dict[str, Any] | None = None        # luồng sự cố: cảnh báo đang xử lý
    proposals: list[dict[str, Any]] = field(default_factory=list)
    alert_content: dict[str, Any] | None = None
    current_call_id: str | None = None         # tool_call_id của lệnh giao việc đang chạy
    tool_calls: int = 0                        # số tool worker đã gọi (phát hiện "nói đã làm mà không gọi tool")


@dataclass
class Services:
    """Phụ thuộc dùng chung (tạo 1 lần trong main.py)."""
    settings: Any
    backend: Any                 # BackendClient
    mqtt: Any                    # MqttBridge
    engine: Any                  # RuleEngine (trạng thái trong RAM cho Safety Guard)
    runtime: Any                 # RuleRuntime (chờ ack)
    dispatcher: Any              # AlertDispatcher
    logger: ToolCallLogger
    pool: Any = None
    memory: Any = None           # MemoryService (giai đoạn 5); None = chưa có long-term memory

    def guard_context(self) -> guard.GuardContext:
        e = self.engine
        c = e.latest_climate()
        return guard.GuardContext(safety=e.safety, temp=c[1] if c else None, hum=c[2] if c else None,
                                  climate_age_s=(time.time() - c[0]) if c else None,
                                  hum_high=float(e.thresholds.get("humHigh", 80)), online=e.online)

    def current_config(self) -> dict[str, Any]:
        return {**guard.CONFIG_DEFAULTS, **{k: v for k, v in self.engine.device_config.items()
                                            if k in guard.CONFIG_RULES}}


# ============================================================================================ tiện ích
def to_text(value: Any) -> str:
    s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return s if len(s) <= MAX_TOOL_TEXT else s[:MAX_TOOL_TEXT] + " …(đã cắt bớt)"


def localize(value: Any) -> Any:
    """Đổi mọi chuỗi thời gian UTC (…Z / +00:00) sang giờ Việt Nam cho LLM dễ đọc."""
    if isinstance(value, dict):
        return {k: localize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [localize(v) for v in value]
    if isinstance(value, str) and len(value) >= 19 and value[4] == "-" and "T" in value:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if dt.tzinfo is not None:
                return dt.astimezone(VN).isoformat(timespec="seconds")
        except ValueError:
            pass
    return value


def _new_cmd_trace(ctx: RunContext) -> str:
    return f"{ctx.trace_id}-{uuid.uuid4().hex[:4]}"


def _describe_device(device: str, state: str | None, mode: str | None, duration_s: int | None) -> str:
    name = guard.DEVICE_VI[device]
    text = f"Trả {name} về chế độ tự động" if mode == "auto" else f"{DEVICE_VERB[state]} {name} (thủ công)"
    if duration_s:
        text += f" trong {duration_s // 60} phút" if duration_s % 60 == 0 else f" trong {duration_s} giây"
    return text


# ============================================================================================ tạo tool có log
def make_read_tool(services: Services, ctx: RunContext, agent: str, name: str, description: str,
                   schema: type[BaseModel], fn: Callable[..., Awaitable[Any]]) -> StructuredTool:
    async def run(**kwargs: Any) -> str:
        call = ToolCall(trace_id=ctx.trace_id, flow=ctx.flow, agent=agent, tool=name, args=kwargs,
                        thread_id=ctx.thread_id, user_id=ctx.user_id)
        try:
            async with services.logger.track(call) as h:
                res = localize(await fn(**kwargs))
                h["result"] = res          # nhật ký tự cắt ngắn (MAX_RESULT_CHARS)
            return to_text(res)
        except Exception as e:  # noqa: BLE001 — tool đọc lỗi -> báo lỗi cho agent, không làm hỏng luồng
            return f"LỖI khi gọi {name}: {type(e).__name__}: {e}"

    return StructuredTool.from_function(coroutine=run, name=name, description=description, args_schema=schema)


@dataclass
class WritePlan:
    """Kết quả bước chuẩn bị của tool ghi (chưa gửi gì)."""
    kind: str                         # device | config | alert
    verdict: guard.Verdict
    args: dict[str, Any]              # tham số đã chuẩn hóa để thực thi
    description: str
    needs_confirmation: bool = True   # luồng chat: False = thực thi ngay (vd. ghi nhớ sở thích cá nhân)


def make_write_tool(services: Services, ctx: RunContext, executor: "ActionExecutor", agent: str, name: str,
                    description: str, schema: type[BaseModel], plan: Callable[..., WritePlan]) -> StructuredTool:
    async def run(**kwargs: Any) -> str:
        args = {k: v for k, v in kwargs.items() if v is not None}
        call = ToolCall(trace_id=ctx.trace_id, flow=ctx.flow, agent=agent, tool=name, args=args, is_write=True,
                        thread_id=ctx.thread_id, user_id=ctx.user_id)
        try:
            p = plan(**args)
        except Exception as e:  # noqa: BLE001
            p = WritePlan("invalid", guard.Verdict.block(f"Tham số không hợp lệ: {e}"), args, name)
        lg = services.logger
        try:
            if not p.verdict.allowed:
                await lg.start(call)
                await lg.update(call, "blocked_by_policy", error=p.verdict.reason)
                return f"BỊ CHẶN bởi Safety Guard: {p.verdict.reason}"

            if ctx.flow == "chat" and p.needs_confirmation:
                await lg.start(call, status="pending_confirmation")
                proposal = {"id": str(call.id), "agent": agent, "tool": name, "kind": p.kind, "args": p.args,
                            "description": p.description, "note": p.verdict.note, "call_id": ctx.current_call_id,
                            "created_at": time.time()}
                ctx.proposals.append(proposal)
                note = f" Lưu ý: {p.verdict.note}." if p.verdict.note else ""
                return (f"ĐÃ TẠO ĐỀ XUẤT (chưa thực hiện): {p.description}.{note} Hệ thống sẽ hiện nút "
                        f"[Đồng ý]/[Hủy] cho người dùng.")

            # luồng sự cố (hoặc hành động không cần xác nhận): thực thi ngay
            await lg.start(call)
            outcome = await executor.run(p.kind, p.args, ctx, confirmed_by=ctx.user_id if ctx.flow == "chat" else None)
            await lg.update(call, outcome["status"], result=outcome, error=outcome.get("error"))
            return f"{outcome['status'].upper()}: {outcome['text']}"
        except ToolLogUnavailable as e:
            log.error("%s.%s KHÔNG thực thi vì không ghi được nhật ký: %s", agent, name, e)
            return "LỖI: không ghi được nhật ký nên KHÔNG thực hiện hành động này."

    return StructuredTool.from_function(coroutine=run, name=name, description=description, args_schema=schema)


# ============================================================================================ thực thi tool ghi
class ActionExecutor:
    """Gửi lệnh thật (MQTT). Luôn kiểm tra Safety Guard ngay trước khi gửi."""

    def __init__(self, services: Services):
        self.s = services

    async def run(self, kind: str, args: dict[str, Any], ctx: RunContext, confirmed_by: int | None
                  ) -> dict[str, Any]:
        try:
            if kind == "device":
                return await self._device(args, ctx, confirmed_by)
            if kind == "config":
                return await self._config(args)
            if kind == "alert":
                return self._alert(args, ctx)
            if kind == "memory":
                return await self._memory(args, ctx)
            if kind == "incident_alert":
                ctx.alert_content = {"message": args["message"], "push": args.get("push", True)}
                return {"status": "success", "text": "Đã giao nội dung cho bộ gửi cảnh báo của tầng luật"}
            return {"status": "error", "text": f"Không rõ loại hành động {kind}", "error": "unknown_kind"}
        except Exception as e:  # noqa: BLE001
            return {"status": "error", "text": f"Lỗi khi thực hiện: {e}", "error": f"{type(e).__name__}: {e}"}

    async def _device(self, a: dict[str, Any], ctx: RunContext, confirmed_by: int | None) -> dict[str, Any]:
        device, state, mode, dur = a["device"], a.get("state"), a.get("mode"), a.get("duration_s")
        gctx = self.s.guard_context()
        check = guard.check_device if ctx.flow == "chat" else guard.check_incident_action
        v = check(device, gctx, state=state, mode=mode, duration_s=dur)
        if not v.allowed:
            return {"status": "blocked_by_policy", "text": f"Bị chặn lúc thực thi: {v.reason}", "error": v.reason}
        trace = _new_cmd_trace(ctx)
        payload: dict[str, Any] = {"state": state} if state else {"mode": "auto"}
        if ctx.flow == "chat":     # người dùng đã xác nhận -> source=user (CLAUDE.md mục 6)
            payload.update(source="user", user_id=str(confirmed_by) if confirmed_by is not None else None)
        else:
            payload.update(source="agent", reason=a.get("reason") or "agent")
        payload["trace_id"] = trace
        if dur:
            payload["duration_s"] = dur
        topic = f"warehouse/cmd/{device}"
        if not self.s.mqtt.publish(topic, payload):
            return {"status": "error", "text": "Không gửi được lệnh (mất kết nối broker)", "error": "mqtt_unavailable",
                    "trace_id": trace}
        log.info("-> %s %s", topic, json.dumps(payload, ensure_ascii=False))
        wait = min(self.s.settings.cmd_ack_timeout_s, 8)
        ack = await self.s.runtime.wait_ack(trace, wait)
        desc = _describe_device(device, state, mode, dur)
        if ack is None:
            text = f"Đã gửi lệnh: {desc}; ESP32 chưa xác nhận sau {wait}s"
        elif ack == "applied":
            text = f"ESP32 đã thực hiện: {desc}"
        elif ack == "ignored_user_priority":
            text = f"ESP32 bỏ qua lệnh vì thiết bị đang do người dùng điều khiển thủ công: {desc}"
        else:
            text = f"ESP32 từ chối lệnh ({ack}): {desc}"
        return {"status": "success" if ack in (None, "applied") else "error", "text": text, "trace_id": trace,
                "ack": ack, "payload": payload, **({} if ack in (None, "applied") else {"error": f"ack={ack}"})}

    async def _config(self, a: dict[str, Any]) -> dict[str, Any]:
        v, merged = guard.check_config(a["changes"], self.s.current_config())
        if not v.allowed:
            return {"status": "blocked_by_policy", "text": f"Bị chặn lúc thực thi: {v.reason}", "error": v.reason}
        if not self.s.mqtt.publish("warehouse/cmd/config", merged, retain=True):
            return {"status": "error", "text": "Không gửi được cấu hình (mất kết nối broker)",
                    "error": "mqtt_unavailable"}
        log.info("-> warehouse/cmd/config %s", json.dumps(a["changes"], ensure_ascii=False))
        return {"status": "success", "text": f"Đã gửi ngưỡng mới xuống ESP32: {a['changes']}", "config": merged}

    async def _memory(self, a: dict[str, Any], ctx: RunContext) -> dict[str, Any]:
        from app.memory.store import NS_FACTS, NS_FEEDBACK, ns_profile
        mem = self.s.memory
        if mem is None:
            return {"status": "error", "text": "Chưa bật long-term memory", "error": "memory_disabled"}
        v = guard.check_memory(a["text"])
        if not v.allowed:
            return {"status": "blocked_by_policy", "text": f"Không lưu: {v.reason}", "error": v.reason}
        ns, kind, where = {"warehouse": (NS_FACTS, "fact", "kiến thức chung về kho"),
                           "feedback": (NS_FEEDBACK, "feedback", "phản hồi về cảnh báo")}.get(
            a["scope"], (ns_profile(ctx.user_id), "preference", "hồ sơ cá nhân"))
        if await mem.is_duplicate(ns, a["text"]):
            return {"status": "success", "text": "Đã có ghi nhớ gần giống, không lưu lại", "duplicate": True}
        key = await mem.put(ns, a["text"], kind=kind, created_by=ctx.user_id, source="chat",
                            extra={"trace_id": ctx.trace_id})
        return {"status": "success", "text": f"Đã ghi nhớ vào {where}: “{a['text']}”", "key": key}

    def _alert(self, a: dict[str, Any], ctx: RunContext) -> dict[str, Any]:
        alert = Alert("manual_notice", a["level"], a["message"], None,
                      {"by_user_id": ctx.user_id, "trace_id": ctx.trace_id, "push": a.get("push", True)})
        payload = alert_payload(alert, source="agent")
        payload = self.s.dispatcher.publish(payload, " (từ chatbot)")
        return {"status": "success", "text": f"Đã phát thông báo mức {a['level']}", "uid": payload["uid"]}


# ============================================================================================ schema tham số
class NoArgs(BaseModel):
    pass


class SensorHistoryArgs(BaseModel):
    kind: Literal["mq135", "climate", "motion", "safety", "health", "device-states"] = Field(
        description="mq135 = khói / khí; climate = nhiệt độ + độ ẩm; motion = chuyển động; safety = trạng thái an toàn; "
                    "health = online/wifi; device-states = trạng thái quạt/phun sương/đèn")
    from_time: str | None = Field(None, description="ISO-8601, vd. 2026-11-20T08:00:00+07:00. Mặc định 1 giờ trước")
    to_time: str | None = Field(None, description="ISO-8601. Mặc định bây giờ")
    limit: int = Field(30, ge=1, le=200, description="Số dòng tối đa (mới nhất trước)")


class DeviceLogArgs(BaseModel):
    device: Literal["fan", "mist", "light"] | None = None
    source: Literal["esp32_local", "rule", "agent", "user"] | None = None
    from_time: str | None = Field(None, description="ISO-8601. Mặc định 7 ngày trước")
    to_time: str | None = None
    limit: int = Field(20, ge=1, le=100)


class AlertHistoryArgs(BaseModel):
    level: Literal["info", "warning", "critical"] | None = None
    unacked_only: bool = Field(False, description="Chỉ cảnh báo chưa ai bấm 'Đã xem'")
    limit: int = Field(20, ge=1, le=100)


class StatsArgs(BaseModel):
    metric: Literal["temp", "hum", "mq135", "motion_count", "threshold_exceeded_pct", "device_on_minutes",
                    "command_count", "device_state"] = Field(
        description="device_state = lịch sử bật/tắt (timeline, cần device)")
    from_time: str = Field(description="ISO-8601 có múi giờ, vd. 2026-11-19T00:00:00+07:00")
    to_time: str = Field(description="ISO-8601 có múi giờ")
    interval: Literal["5m", "1h", "1d", "1w"] = "1h"
    agg: str = Field("avg,min,max", description="avg,min,max,sum,count (cho temp/hum/mq135)")
    group_by: str | None = Field(None, description="work_hours | reason | source | hour_of_day,day_of_week")
    device: Literal["fan", "mist", "light"] | None = Field(None, description="Bắt buộc với device_on_minutes, "
                                                                             "device_state")


class SearchArgs(BaseModel):
    query: str = Field("", description="Nội dung cần tìm")
    limit: int = Field(5, ge=1, le=20)


class DeviceCmdArgs(BaseModel):
    state: Literal["on", "off"] | None = Field(None, description="Bật / tắt (chế độ thủ công)")
    mode: Literal["auto"] | None = Field(None, description="Trả về chế độ tự động (không dùng chung với state)")
    duration_s: int | None = Field(None, ge=1, le=86400, description="Tự về auto sau N giây (tùy chọn)")


class ThresholdArgs(BaseModel):
    mq135Warning: int | None = Field(None, description="Ngưỡng cảnh báo MQ135 (ADC 150–4095)")
    mq135Danger: int | None = Field(None, description="Ngưỡng nguy hiểm MQ135 (> mq135Warning + 150)")
    tempHigh: float | None = Field(None, description="Nhiệt độ cao (°C)")
    humHigh: float | None = Field(None, description="Độ ẩm cao (%)")
    tempRiseC: float | None = Field(None, description="Mức tăng nhiệt nghi cháy (°C)")
    tempRiseWindowMin: int | None = Field(None, description="Cửa sổ tính tăng nhiệt (phút, 1–15)")
    mistFireMaxMin: int | None = Field(None, description="Phun sương tối đa khi cháy (phút)")
    mistCoolMaxMin: int | None = Field(None, description="Phun làm mát tối đa (phút)")
    mistCooldownMin: int | None = Field(None, description="Nghỉ giữa 2 lần phun làm mát (phút)")
    mistHumMax: float | None = Field(None, description="Chỉ phun làm mát khi độ ẩm dưới mức này (%)")
    humFanCheckMin: int | None = Field(None, description="Sau bao lâu kiểm tra quạt hút ẩm có hiệu quả (phút)")
    humFanMinDrop: float | None = Field(None, description="Độ ẩm phải giảm tối thiểu (%)")


class ChatAlertArgs(BaseModel):
    message: str = Field(description="Nội dung thông báo (tiếng Việt)")
    level: Literal["info", "warning", "critical"] = "info"
    push: bool = Field(True, description="Đẩy thông báo lên điện thoại")


class SaveMemoryArgs(BaseModel):
    text: str = Field(description="Câu ngắn, tự đủ nghĩa, tiếng Việt (tối đa 500 ký tự)")
    scope: Literal["personal", "warehouse", "feedback"] = Field(
        description="personal = sở thích của chính người dùng (lưu ngay); warehouse = kiến thức chung về kho "
                    "(người dùng phải bấm Đồng ý); feedback = người dùng khẳng định một cảnh báo đúng / báo giả")


class IncidentAlertArgs(BaseModel):
    message: str = Field(description="Nội dung cảnh báo cuối cùng (tiếng Việt, 1–3 câu)")
    push: bool = Field(True, description="false = chỉ hiện trong app (chỉ cho mức info)")


# ============================================================================================ cài đặt tool đọc
def _summarize_series(points: list[dict[str, Any]], max_points: int = 24) -> dict[str, Any]:
    vals = [p["v"] for p in points if isinstance(p.get("v"), (int, float))]
    out: dict[str, Any] = {"n": len(points)}
    if vals:
        out.update(min=round(min(vals), 2), max=round(max(vals), 2), avg=round(sum(vals) / len(vals), 2))
        imax = max(range(len(points)), key=lambda i: points[i].get("v") if isinstance(points[i].get("v"),
                                                                                       (int, float)) else float("-inf"))
        out["max_at"] = points[imax].get("t")
    step = max(1, len(points) // max_points)
    out["points"] = [[p.get("t"), round(p["v"], 2) if isinstance(p.get("v"), float) else p.get("v")]
                     for p in points[::step]]
    return out


def _compact_state(j: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, val in j.items():
        if isinstance(val, dict) and "data" in val:
            out[key] = {"value": val.get("data"), "updated": val.get("updatedAt")}
        elif isinstance(val, dict):
            out[key] = {k: ({"value": v.get("data"), "updated": v.get("updatedAt")}
                            if isinstance(v, dict) and "data" in v else v) for k, v in val.items()}
        else:
            out[key] = val
    return out


def build_monitor_tools(s: Services, ctx: RunContext) -> list[StructuredTool]:
    b = s.backend

    async def get_current_state() -> Any:
        try:
            state = _compact_state(await b.get("/api/state"))
        except Exception as e:  # noqa: BLE001 — Java BE lỗi -> dùng dữ liệu tầng luật trong RAM
            snap = s.engine.snapshot()
            return {"source": "tang_luat_ai_agent (Java BE không phản hồi: %s)" % type(e).__name__,
                    "safety": snap["safety"], "latest": snap["latest"], "online": snap["online"],
                    "motion": snap["motion"], "devices": snap.get("devices"), "thresholds": snap["thresholds"]}
        state["now"] = datetime.now(VN).isoformat(timespec="seconds")
        return state

    async def get_sensor_history(kind: str, from_time: str | None = None, to_time: str | None = None,
                                 limit: int = 30) -> Any:
        rows = await b.get(f"/api/readings/{kind}", **{"from": from_time, "to": to_time, "limit": limit})
        return {"kind": kind, "rows": rows}

    async def get_device_status() -> Any:
        return await b.get("/api/devices")

    async def get_device_logs(device: str | None = None, source: str | None = None, from_time: str | None = None,
                              to_time: str | None = None, limit: int = 20) -> Any:
        return await b.get("/api/device-logs", device=device, source=source, size=limit,
                           **{"from": from_time, "to": to_time})

    async def get_alert_history(level: str | None = None, unacked_only: bool = False, limit: int = 20) -> Any:
        rows = await b.get("/api/alerts", level=level, unacked="true" if unacked_only else None, size=limit)
        return [{k: r.get(k) for k in ("id", "ts", "type", "level", "message", "source", "acked", "ackedAt",
                                       "feedback", "incidentId") if k in r} for r in rows]

    async def get_statistics(metric: str, from_time: str, to_time: str, interval: str = "1h",
                             agg: str = "avg,min,max", group_by: str | None = None, device: str | None = None) -> Any:
        query: dict[str, Any] = {"metric": metric, "from": from_time, "to": to_time}
        if metric == "device_state":
            if not device:
                return "LỖI: device_state cần device"
            query["device"] = device
            segs = await b.get("/api/stats/timeline", device=device, **{"from": from_time, "to": to_time})
            on_min = 0.0
            for sg in segs:
                if sg.get("state") == "on" and sg.get("start") and sg.get("end"):
                    st = datetime.fromisoformat(str(sg["start"]).replace("Z", "+00:00"))
                    en = datetime.fromisoformat(str(sg["end"]).replace("Z", "+00:00"))
                    on_min += (en - st).total_seconds() / 60
            return {"query": query, "chart": "timeline", "segments": len(segs), "on_minutes": round(on_min, 1),
                    "segments_sample": segs[:15]}
        query.update(interval=interval)
        if metric in ("temp", "hum", "mq135"):
            query["agg"] = [a.strip() for a in agg.split(",") if a.strip()]
        if group_by:
            query["group_by"] = group_by
        if device:
            query["device"] = device
        params = {"metric": metric, "from": from_time, "to": to_time, "interval": interval,
                  "agg": ",".join(query.get("agg", [])) or None, "group_by": group_by, "device": device}
        res = await b.get("/api/stats", **params)
        out: dict[str, Any] = {"query": query,
                               "series": {sr["name"]: _summarize_series(sr.get("points", []))
                                          for sr in res.get("series", [])}}
        cells = res.get("cells") or []
        if cells:
            top = sorted([c for c in cells if isinstance(c.get("v"), (int, float))], key=lambda c: -c["v"])[:8]
            out["heatmap_top_cells"] = top
        return out

    T = make_read_tool
    return [
        T(s, ctx, "monitor", "get_current_state",
          "Số liệu cảm biến mới nhất, trạng thái an toàn, quạt/phun sương/đèn, ESP32 online, cấu hình ngưỡng.",
          NoArgs, get_current_state),
        T(s, ctx, "monitor", "get_sensor_history", "Dữ liệu thô của cảm biến trong một khoảng thời gian.",
          SensorHistoryArgs, get_sensor_history),
        T(s, ctx, "monitor", "get_device_status", "Trạng thái hiện tại của quạt, phun sương, đèn (state, mode, "
          "reason, source).", NoArgs, get_device_status),
        T(s, ctx, "monitor", "get_device_logs", "Nhật ký lệnh thiết bị từ MỌI nguồn (esp32_local, rule, agent, user) "
          "— trả lời 'ai / cái gì đã bật quạt lúc …'.", DeviceLogArgs, get_device_logs),
        T(s, ctx, "monitor", "get_alert_history", "Lịch sử cảnh báo (mới nhất trước).", AlertHistoryArgs,
          get_alert_history),
        T(s, ctx, "monitor", "get_statistics", "Thống kê do Java BE tính bằng SQL (avg/min/max theo khoảng thời "
          "gian, đếm chuyển động, thời gian chạy thiết bị...). Trả về khối query để vẽ biểu đồ.", StatsArgs,
          get_statistics),
    ]


def build_analyst_tools(s: Services, ctx: RunContext) -> list[StructuredTool]:
    from app.memory.store import NS_FACTS, NS_FEEDBACK, NS_INCIDENTS

    async def recent_incidents(limit: int) -> list[dict[str, Any]]:
        if s.pool is None:
            return []
        async with s.pool.connection() as conn:
            cur = await conn.execute(
                """SELECT id, kind, level, state, opened_at, closed_at, jsonb_array_length(events) AS n_events
                   FROM agent.incidents ORDER BY opened_at DESC LIMIT %s""", (limit,))
            cols = [c.name for c in cur.description]
            rows = [dict(zip(cols, r)) for r in await cur.fetchall()]
        for r in rows:
            if r["closed_at"]:
                r["duration_min"] = round((r["closed_at"] - r["opened_at"]).total_seconds() / 60, 1)
            r["opened_at"] = r["opened_at"].astimezone(VN).isoformat(timespec="seconds")
            r["closed_at"] = r["closed_at"].astimezone(VN).isoformat(timespec="seconds") if r["closed_at"] else None
        return rows

    def clean(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        keep = ("text", "score", "created_at", "kind", "verdict", "alert_type", "level", "state", "opened_at",
                "duration_min")
        return [{k: it[k] for k in keep if k in it} for it in items]

    async def search_incidents(query: str = "", limit: int = 5) -> Any:
        if s.memory is not None and query.strip():
            found = clean(await s.memory.search(NS_INCIDENTS, query, limit=limit))
            if found:
                return {"results": found, "note": "Tóm tắt sự cố đã đóng, xếp theo độ liên quan"}
        return {"results": await recent_incidents(limit),
                "note": "Không có tóm tắt liên quan — đây là các sự cố gần nhất (chưa tóm tắt)"}

    async def search_warehouse_facts(query: str = "", limit: int = 5) -> Any:
        if s.memory is None:
            return {"results": [], "note": "Chưa bật long-term memory"}
        items = await (s.memory.search(NS_FACTS, query, limit=limit) if query.strip()
                       else s.memory.list_items(NS_FACTS, limit=limit))
        return {"results": clean(items)}

    async def search_feedback(query: str = "", limit: int = 5) -> Any:
        if s.memory is None:
            return {"results": [], "note": "Chưa bật long-term memory"}
        items = await (s.memory.search(NS_FEEDBACK, query, limit=limit) if query.strip()
                       else s.memory.list_items(NS_FEEDBACK, limit=limit))
        return {"results": clean(items)}

    T = make_read_tool
    return [
        T(s, ctx, "analyst", "search_incidents", "Sự cố cũ đã đóng (cháy, khí, đột nhập, offline): diễn biến, thời "
          "điểm, thời gian kéo dài. Tìm theo ngữ nghĩa.", SearchArgs, search_incidents),
        T(s, ctx, "analyst", "search_warehouse_facts", "Kiến thức đã ghi nhớ về kho (giờ làm, hàng hóa, thói quen như "
          "hàn kim loại...). Tìm theo ngữ nghĩa.", SearchArgs, search_warehouse_facts),
        T(s, ctx, "analyst", "search_feedback", "Phản hồi của người dùng về cảnh báo cũ (đúng / báo giả + lý do).",
          SearchArgs, search_feedback),
    ]


def build_control_tools(s: Services, ctx: RunContext, ex: ActionExecutor) -> list[StructuredTool]:
    def device_plan(device: str):
        def plan(state: str | None = None, mode: str | None = None, duration_s: int | None = None) -> WritePlan:
            g = s.guard_context()
            check = guard.check_device if ctx.flow == "chat" else guard.check_incident_action
            v = check(device, g, state=state, mode=mode, duration_s=duration_s)
            args = {"device": device, "state": state, "mode": mode, "duration_s": duration_s}
            return WritePlan("device", v, {k: x for k, x in args.items() if x is not None},
                             _describe_device(device, state, mode, duration_s) if v.allowed else device)
        return plan

    def threshold_plan(**changes: Any) -> WritePlan:
        changes = {k: v for k, v in changes.items() if v is not None}
        if ctx.flow != "chat":
            return WritePlan("config", guard.Verdict.block("Luồng sự cố KHÔNG BAO GIỜ tự đổi ngưỡng"), changes, "")
        v, _ = guard.check_config(changes, s.current_config())
        cur = s.current_config()
        desc = "Đổi ngưỡng: " + ", ".join(f"{k} {cur.get(k)} → {val}" for k, val in changes.items())
        return WritePlan("config", v, {"changes": changes}, desc)

    W = make_write_tool
    tools = [W(s, ctx, ex, "control", f"control_{d}", f"Điều khiển {guard.DEVICE_VI[d]}: state on/off hoặc mode auto.",
               DeviceCmdArgs, device_plan(d)) for d in guard.DEVICES]
    tools.append(W(s, ctx, ex, "control", "update_thresholds",
                   "Đổi ngưỡng cảnh báo của ESP32 (chỉ gửi khóa cần đổi). Chỉ trong luồng chat, cần xác nhận.",
                   ThresholdArgs, threshold_plan))
    return tools


def build_notification_tools(s: Services, ctx: RunContext, ex: ActionExecutor) -> list[StructuredTool]:
    if ctx.flow == "incident":
        level = (ctx.alert or {}).get("level", "info")

        def plan(message: str, push: bool = True) -> WritePlan:
            if not message.strip():
                return WritePlan("incident_alert", guard.Verdict.block("Nội dung trống"), {}, "")
            if not push and level != "info":   # LLM không được hạ cảnh báo warning/critical (CLAUDE.md 5.4)
                push = True
            return WritePlan("incident_alert", guard.Verdict.ok(), {"message": message.strip(), "push": push},
                             "Gửi cảnh báo")
        schema: type[BaseModel] = IncidentAlertArgs
        desc = f"Gửi nội dung cảnh báo cho sự cố đang xử lý (mức {level}, không đổi được)."
    else:
        def plan(message: str, level: str = "info", push: bool = True) -> WritePlan:  # type: ignore[misc]
            if not message.strip():
                return WritePlan("alert", guard.Verdict.block("Nội dung trống"), {}, "")
            return WritePlan("alert", guard.Verdict.ok(), {"message": message.strip(), "level": level, "push": push},
                             f"Phát thông báo mức {level}: “{message.strip()[:120]}”")
        schema = ChatAlertArgs
        desc = "Phát thông báo / cảnh báo tới mọi người dùng (cần người dùng xác nhận)."
    return [make_write_tool(s, ctx, ex, "notification", "publish_alert", desc, schema, plan)]


def build_supervisor_tools(s: Services, ctx: RunContext, ex: ActionExecutor) -> list[StructuredTool]:
    """Supervisor chỉ có MỘT tool không phải giao việc: save_memory (CLAUDE.md mục 7)."""
    def plan(text: str, scope: str = "personal") -> WritePlan:
        if s.memory is None:
            return WritePlan("memory", guard.Verdict.block("Chưa bật long-term memory"), {}, "")
        v = guard.check_memory(text)
        where = {"warehouse": "kiến thức chung về kho (mọi người dùng)",
                 "feedback": "phản hồi về cảnh báo"}.get(scope, "hồ sơ cá nhân của bạn")
        return WritePlan("memory", v, {"text": text.strip(), "scope": scope}, f"Ghi nhớ vào {where}: “{text.strip()}”",
                         needs_confirmation=(scope == "warehouse"))
    return [make_write_tool(s, ctx, ex, "supervisor", "save_memory",
                            "Ghi nhớ lâu dài theo yêu cầu của người dùng.", SaveMemoryArgs, plan)]


def tools_for(worker: str, s: Services, ctx: RunContext, ex: ActionExecutor) -> list[StructuredTool]:
    """Quyền tối thiểu: mỗi worker chỉ nhận đúng bộ tool của mình."""
    if worker == "monitor":
        return build_monitor_tools(s, ctx)
    if worker == "analyst":
        return build_analyst_tools(s, ctx)
    if worker == "control":
        return build_control_tools(s, ctx, ex)
    if worker == "notification":
        return build_notification_tools(s, ctx, ex)
    raise ValueError(worker)


def iso_vn(dt: datetime | None = None) -> str:
    return (dt or datetime.now(timezone.utc)).astimezone(VN).strftime("%Y-%m-%d %H:%M:%S %A")

