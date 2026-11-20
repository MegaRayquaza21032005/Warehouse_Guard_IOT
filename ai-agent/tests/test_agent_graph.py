"""Đồ thị multi-agent với LLM GIẢ (kịch bản cố định) — không gọi OpenAI, không cần DB / MQTT.

Kiểm tra: xác nhận / hủy lệnh, Safety Guard chặn, quyền tối thiểu, luồng sự cố, mọi tool call chung trace_id.
"""

import time
from datetime import time as dtime
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from app.agents.graph import build_graph, sanitize, split_for_summary
from app.agents.llm import LLMCaller
from app.agents.tools import Services
from app.config import Settings
from app.observability.tool_logger import ToolCallLogger
from app.observability.usage import UsageRecorder
from app.rules.engine import RuleConfig, RuleEngine
from app.rules.schedule import WorkSchedule


# ------------------------------------------------------------------------------------------------ đồ giả
class ScriptedLLM:
    """Trả lần lượt các AIMessage soạn sẵn; ghi lại tool đã bind để kiểm tra quyền tối thiểu."""

    def __init__(self, responses: list[AIMessage]):
        self.responses = list(responses)
        self.bound: list[list[str]] = []
        self.inputs: list[list[Any]] = []

    def bind_tools(self, tools, **kw):
        self.bound.append([getattr(t, "name", None) or t.__name__ for t in tools])
        return self

    async def ainvoke(self, messages, config=None, **kw):
        self.inputs.append(messages)
        assert self.responses, "LLM giả hết kịch bản"
        return self.responses.pop(0)


def call(name: str, args: dict, cid: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": cid, "type": "tool_call"}])


def say(text: str) -> AIMessage:
    return AIMessage(content=text)


class FakeMqtt:
    def __init__(self):
        self.sent: list[tuple[str, dict, bool]] = []
        self.connected = True

    def publish(self, topic, payload, retain=False):
        self.sent.append((topic, payload, retain))
        return True


class FakeRuntime:
    async def wait_ack(self, trace_id, timeout_s):
        return "applied"


class MemLogger(ToolCallLogger):
    """Nhật ký trong RAM (giống DB: id -> bản ghi)."""

    def __init__(self):
        super().__init__(pool=None)
        self.rows: dict[str, dict] = {}

    async def start(self, call, status="requested"):
        self.rows[str(call.id)] = {"trace_id": call.trace_id, "agent": call.agent, "tool": call.tool,
                                   "status": status, "is_write": call.is_write, "args": call.args,
                                   "history": [status]}
        call.logged = True

    async def update(self, call, status, *, result=None, error=None, confirmed_by=None):
        r = self.rows[str(call.id)]
        r["status"] = status
        r["history"].append(status)
        r["error"] = error
        if confirmed_by is not None:
            r["confirmed_by"] = confirmed_by


class FakeBackend:
    async def get(self, path, **params):
        if path == "/api/state":
            return {"sensors": {"dht11": {"data": {"temp": 30.5, "hum": 60}, "updatedAt": "2026-11-20T03:00:00Z"}}}
        return []


class FakeDispatcher:
    def __init__(self):
        self.published: list[dict] = []

    def publish(self, payload, note=""):
        self.published.append(payload)
        return payload


@pytest.fixture
def env():
    settings = Settings(_env_file=None, openai_api_key="test", langfuse_enabled=False, agent_max_steps=4,
                        worker_max_steps=3, worker_timeout_s=5, cmd_ack_timeout_s=1)
    sched = WorkSchedule(dtime(8, 0), dtime(17, 30), frozenset({1, 2, 3, 4, 5, 6}), ZoneInfo("Asia/Ho_Chi_Minh"))
    engine = RuleEngine(RuleConfig(), sched)
    engine.online = True
    engine.climate.append((time.time(), 30.0, 60.0))
    mqtt, logger, dispatcher = FakeMqtt(), MemLogger(), FakeDispatcher()
    services = Services(settings=settings, backend=FakeBackend(), mqtt=mqtt, engine=engine, runtime=FakeRuntime(),
                        dispatcher=dispatcher, logger=logger)

    def make(sup: list[AIMessage], wrk: list[AIMessage]):
        s_llm, w_llm = ScriptedLLM(sup), ScriptedLLM(wrk)
        g = build_graph(services, LLMCaller(UsageRecorder(None)), s_llm, "sup", w_llm, "wrk", InMemorySaver())
        return g, s_llm, w_llm

    return {"make": make, "mqtt": mqtt, "logger": logger, "engine": engine, "dispatcher": dispatcher}


def chat_input(text: str, trace: str = "c-test1", thread: str = "t-1") -> dict:
    return {"messages": [HumanMessage(text)], "mode": "chat", "user_id": 7, "username": "an", "trace_id": trace,
            "thread_id": thread, "steps": 0, "pending": None, "alert": None, "alert_content": None}


CFG = {"configurable": {"thread_id": "t-1"}}


# ------------------------------------------------------------------------------------------------ chat
async def test_read_question_uses_monitor_tool(env):
    g, s_llm, w_llm = env["make"](
        [call("ask_monitor", {"task": "trạng thái hiện tại"}, "h1"), say("Kho 30.5°C, ẩm 60%.")],
        [call("get_current_state", {}, "w1"), say("Nhiệt độ 30.5, ẩm 60")])
    out = await g.ainvoke(chat_input("Kho đang thế nào?"), CFG)
    assert out["messages"][-1].content == "Kho 30.5°C, ẩm 60%."
    # quyền tối thiểu: Supervisor chỉ có tool giao việc; Monitor không có tool ghi
    assert set(s_llm.bound[0]) == {"ask_monitor", "ask_analyst", "ask_control", "ask_notification"}
    assert "control_fan" not in w_llm.bound[0] and "get_statistics" in w_llm.bound[0]
    rows = list(env["logger"].rows.values())
    assert {(r["agent"], r["tool"]) for r in rows} == {("supervisor", "ask_monitor"), ("monitor", "get_current_state")}
    assert all(r["trace_id"] == "c-test1" and r["status"] == "success" for r in rows)
    # kết quả tool được đưa lại cho worker (đã đổi giờ UTC -> giờ VN)
    tool_msg = [m for m in w_llm.inputs[1] if isinstance(m, ToolMessage)][0]
    assert "30.5" in tool_msg.content and "+07:00" in tool_msg.content


async def test_fan_on_requires_confirmation_then_executes(env):
    g, _, _ = env["make"](
        [call("ask_control", {"task": "bật quạt 10 phút"}, "h1"), say("Đã bật quạt 10 phút.")],
        [call("control_fan", {"state": "on", "duration_s": 600}, "w1"), say("Đã tạo đề xuất bật quạt")])
    out = await g.ainvoke(chat_input("Bật quạt 10 phút"), CFG)
    intr = out["__interrupt__"][0].value
    assert intr["type"] == "confirmation" and intr["proposals"][0]["description"].startswith("Bật quạt")
    assert env["mqtt"].sent == []                                   # CHƯA gửi gì trước khi đồng ý
    row = next(r for r in env["logger"].rows.values() if r["tool"] == "control_fan")
    assert row["status"] == "pending_confirmation" and row["is_write"]

    out = await g.ainvoke(Command(resume={"approved": True, "user_id": 7}), CFG)
    topic, payload, _ = env["mqtt"].sent[0]
    assert topic == "warehouse/cmd/fan"
    assert payload["state"] == "on" and payload["source"] == "user" and payload["user_id"] == "7"
    assert payload["duration_s"] == 600 and payload["trace_id"].startswith("c-test1-")
    assert row["history"] == ["pending_confirmation", "approved", "success"] and row["confirmed_by"] == 7
    assert out["messages"][-1].content == "Đã bật quạt 10 phút."
    # Supervisor nhận kết quả xác nhận trong ToolMessage
    tm = [m for m in out["messages"] if isinstance(m, ToolMessage)][-1]
    assert "NGƯỜI DÙNG ĐỒNG Ý" in tm.content and "ESP32 đã thực hiện" in tm.content


async def test_cancel_does_nothing_but_is_logged(env):
    g, _, _ = env["make"](
        [call("ask_control", {"task": "tắt đèn"}, "h1"), say("Đã hủy, không tắt đèn.")],
        [call("control_light", {"state": "off"}, "w1"), say("Đề xuất tắt đèn")])
    await g.ainvoke(chat_input("Tắt đèn"), CFG)
    out = await g.ainvoke(Command(resume={"approved": False, "user_id": 7}), CFG)
    assert env["mqtt"].sent == []
    row = next(r for r in env["logger"].rows.values() if r["tool"] == "control_light")
    assert row["history"] == ["pending_confirmation", "rejected"]
    assert out["outcomes"][0]["status"] == "rejected"


async def test_mist_on_when_humid_is_blocked_by_policy(env):
    env["engine"].climate.append((time.time(), 31.0, 88.0))
    g, _, _ = env["make"](
        [call("ask_control", {"task": "bật phun sương"}, "h1"), say("Không bật được: độ ẩm quá cao.")],
        [call("control_mist", {"state": "on"}, "w1"), say("Bị chặn vì độ ẩm 88%")])
    out = await g.ainvoke(chat_input("Bật phun sương"), CFG)
    assert "__interrupt__" not in out and env["mqtt"].sent == []
    row = next(r for r in env["logger"].rows.values() if r["tool"] == "control_mist")
    assert row["status"] == "blocked_by_policy" and "88" in row["error"]


async def test_guard_rechecked_at_execution_time(env):
    g, _, _ = env["make"](
        [call("ask_control", {"task": "bật quạt"}, "h1"), say("Không bật được quạt vì đang nghi cháy.")],
        [call("control_fan", {"state": "on"}, "w1"), say("Đề xuất bật quạt")])
    await g.ainvoke(chat_input("Bật quạt"), CFG)
    env["engine"].safety = "fire"                     # tình hình đổi trong lúc chờ người dùng bấm
    await g.ainvoke(Command(resume={"approved": True, "user_id": 7}), CFG)
    assert env["mqtt"].sent == []
    row = next(r for r in env["logger"].rows.values() if r["tool"] == "control_fan")
    assert row["history"][-1] == "blocked_by_policy"


async def test_threshold_change_needs_confirmation_and_sends_full_config(env):
    g, _, _ = env["make"](
        [call("ask_control", {"task": "tempHigh 36"}, "h1"), say("Đã đổi.")],
        [call("update_thresholds", {"tempHigh": 36}, "w1"), say("Đề xuất đổi ngưỡng")])
    await g.ainvoke(chat_input("Đổi ngưỡng nóng thành 36"), CFG)
    await g.ainvoke(Command(resume={"approved": True, "user_id": 7}), CFG)
    topic, payload, retain = env["mqtt"].sent[0]
    assert topic == "warehouse/cmd/config" and retain and payload["tempHigh"] == 36.0 and payload["mq2Warning"] == 1500


async def test_worker_cannot_use_other_workers_tools(env):
    g, _, _ = env["make"](
        [call("ask_monitor", {"task": "bật quạt"}, "h1"), say("Monitor không điều khiển được.")],
        [call("control_fan", {"state": "on"}, "w1"), say("Không có quyền")])
    await g.ainvoke(chat_input("x"), CFG)
    row = next(r for r in env["logger"].rows.values() if r["tool"] == "control_fan")
    assert row["agent"] == "monitor" and row["status"] == "error" and env["mqtt"].sent == []


async def test_step_limit_forces_final_answer(env):
    sup = [call("ask_analyst", {"task": f"lần {i}"}, f"h{i}") for i in range(4)] + [say("Chưa hoàn tất.")]
    wrk = [say("ok")] * 4
    g, s_llm, _ = env["make"](sup, wrk)
    out = await g.ainvoke(chat_input("phân tích"), CFG)
    assert out["messages"][-1].content == "Chưa hoàn tất." and out["steps"] == 5
    assert len(s_llm.bound) == 4                      # lần cuối gọi KHÔNG kèm tool


# ------------------------------------------------------------------------------------------------ sự cố
def incident_input(level: str = "warning", trace: str = "i-test1") -> dict:
    return {"messages": [HumanMessage("Cảnh báo gas")], "mode": "incident", "user_id": None, "username": "",
            "trace_id": trace, "thread_id": "inc-1", "steps": 0, "pending": None,
            "alert": {"type": "gas", "level": level, "message": "Có khí"}, "alert_content": None}


async def test_incident_notification_returns_content_and_auto_actions_are_limited(env):
    env["engine"].safety = "gas"
    g, _, _ = env["make"](
        [AIMessage(content="", tool_calls=[
            {"name": "ask_control", "args": {"task": "bật quạt, đổi ngưỡng"}, "id": "h1", "type": "tool_call"},
            {"name": "ask_notification", "args": {"task": "gửi"}, "id": "h2", "type": "tool_call"}]),
         say("Đã gửi cảnh báo.")],
        [AIMessage(content="", tool_calls=[
            {"name": "control_fan", "args": {"state": "on"}, "id": "w1", "type": "tool_call"},
            {"name": "update_thresholds", "args": {"mq2Warning": 3000}, "id": "w2", "type": "tool_call"},
            {"name": "control_mist", "args": {"state": "on"}, "id": "w3", "type": "tool_call"}]),
         say("Quạt đã bật; đổi ngưỡng và phun sương bị chặn"),
         call("publish_alert", {"message": "Phát hiện khí, có thể do hàn. Kiểm tra nguồn khí.", "push": False}, "w4"),
         say("Đã gửi")])
    out = await g.ainvoke(incident_input("warning"), {"configurable": {"thread_id": "inc-1"}})
    assert "__interrupt__" not in out                                 # luồng sự cố không chờ xác nhận
    assert out["alert_content"]["message"].startswith("Phát hiện khí")
    assert out["alert_content"]["push"] is True                       # warning không được tắt push
    topics = [t for t, _, _ in env["mqtt"].sent]
    assert topics == ["warehouse/cmd/fan"] and env["mqtt"].sent[0][1]["source"] == "agent"
    st = {r["tool"]: r["status"] for r in env["logger"].rows.values()}
    assert st["control_fan"] == "success" and st["update_thresholds"] == "blocked_by_policy"
    assert st["control_mist"] == "blocked_by_policy" and st["publish_alert"] == "success"
    assert {r["trace_id"] for r in env["logger"].rows.values()} == {"i-test1"}


# ------------------------------------------------------------------------------------------------ tiện ích
def test_sanitize_drops_dangling_tool_calls():
    msgs = [HumanMessage("a", id="1"), call("ask_monitor", {"task": "x"}, "h1"), HumanMessage("b", id="2"),
            call("ask_monitor", {"task": "y"}, "h2"), ToolMessage("ok", tool_call_id="h2")]
    out = sanitize(msgs)
    assert [type(m).__name__ for m in out] == ["HumanMessage", "HumanMessage", "AIMessage", "ToolMessage"]


def test_split_for_summary_starts_at_user_message():
    msgs = [HumanMessage("q1"), call("ask_monitor", {"task": "x"}, "h1"), ToolMessage("r", tool_call_id="h1"),
            say("a1"), HumanMessage("q2"), say("a2")]
    assert split_for_summary(msgs, keep=3) == 4
    assert split_for_summary(msgs, keep=10) == 0
