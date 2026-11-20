"""AgentService + PostgreSQL thật (checkpointer, hội thoại, nhật ký) với LLM giả. Bỏ qua nếu docker chưa chạy."""

import json
import uuid

import pytest
from langchain_core.messages import AIMessage

from app.agents.graph import build_graph
from app.agents.llm import LLMCaller
from app.agents.service import AgentService, ApiError
from app.agents.tools import Services
from app.config import get_settings
from app.observability.langfuse import Tracer
from app.observability.tool_logger import ToolCallLogger
from app.observability.usage import UsageRecorder
from tests.test_agent_graph import FakeBackend, FakeDispatcher, FakeMqtt, FakeRuntime, ScriptedLLM, call, say

pytestmark = pytest.mark.integration


@pytest.fixture
async def db():
    from app.db import migrate, open_checkpointer, open_pool
    s = get_settings()
    try:
        pool = await open_pool(s.postgres_conninfo)
    except Exception:  # noqa: BLE001
        pytest.skip("PostgreSQL (docker compose) chưa chạy")
    await migrate(pool)
    cp_pool, saver = await open_checkpointer(s.postgres_conninfo)
    yield pool, saver
    await cp_pool.close()
    await pool.close()


async def collect(events) -> list[tuple[str, dict]]:
    return [(e["event"], json.loads(e["data"])) async for e in events]


def make_service(db, sup, wrk, engine_env):
    pool, saver = db
    s = get_settings().model_copy(update={"langfuse_enabled": False, "openai_api_key": "test",
                                          "cmd_ack_timeout_s": 1})
    engine, mqtt = engine_env
    services = Services(settings=s, backend=FakeBackend(), mqtt=mqtt, engine=engine, runtime=FakeRuntime(),
                        dispatcher=FakeDispatcher(), logger=ToolCallLogger(pool), pool=pool)
    g = build_graph(services, LLMCaller(UsageRecorder(pool)), ScriptedLLM(sup), "sup", ScriptedLLM(wrk), "wrk", saver)
    tracer = Tracer(s)
    return AgentService(s, g, tracer, pool, engine, saver)


@pytest.fixture
def engine_env():
    import time
    from datetime import time as dtime
    from zoneinfo import ZoneInfo

    from app.rules.engine import RuleConfig, RuleEngine
    from app.rules.schedule import WorkSchedule
    eng = RuleEngine(RuleConfig(), WorkSchedule(dtime(8), dtime(17, 30), frozenset({1}), ZoneInfo("Asia/Ho_Chi_Minh")))
    eng.online = True
    eng.climate.append((time.time(), 30.0, 60.0))
    return eng, FakeMqtt()


async def test_chat_confirm_flow_persists_everything(db, engine_env):
    user = 900_000 + uuid.uuid4().int % 99_999
    svc = make_service(db, [call("ask_control", {"task": "bật quạt"}, "h1"), say("Đã bật quạt.")],
                       [call("control_fan", {"state": "on"}, "w1"), say("Đề xuất bật quạt")], engine_env)
    pool = db[0]
    try:
        ev = await collect(await svc.start_chat(user_id=user, username="an", thread_id=None, message="Bật quạt",
                                                input_mode="voice"))
        names = [e for e, _ in ev]
        assert names[0] == "meta" and names[-1] == "confirmation" and "status" in names
        thread_id, trace_id = ev[0][1]["thread_id"], ev[0][1]["trace_id"]
        assert ev[-1][1]["proposals"][0]["tool"] == "control_fan"

        # đang chờ xác nhận -> không nhận tin nhắn mới; người khác không thấy hội thoại
        with pytest.raises(ApiError) as e:
            await svc.start_chat(user_id=user, username="an", thread_id=thread_id, message="hi")
        assert e.value.code == "confirmation_pending"
        with pytest.raises(ApiError) as e:
            await svc.get_thread(user + 1, thread_id)
        assert e.value.status == 404

        ev2 = await collect(await svc.start_confirm(user_id=user, thread_id=thread_id, approved=True))
        assert [e for e, _ in ev2] == ["meta", "result", "done"]
        assert ev2[-1][1]["message"] == "Đã bật quạt." and ev2[0][1]["trace_id"] == trace_id
        assert engine_env[1].sent[0][1]["user_id"] == str(user)

        t = await svc.get_thread(user, thread_id)
        assert [m["kind"] for m in t["messages"]] == ["text", "confirmation", "decision", "text"]
        assert t["messages"][0]["input_mode"] == "voice" and t["pending"] is None
        assert [x["id"] for x in await svc.list_threads(user)] == [thread_id]

        async with pool.connection() as conn:
            rows = await (await conn.execute(
                "SELECT agent, tool, status, confirmed_by FROM agent.tool_call_logs WHERE trace_id = %s "
                "ORDER BY started_at", (trace_id,))).fetchall()
        assert ("control", "control_fan", "success", user) in rows
        assert ("supervisor", "ask_control", "success", None) in rows
    finally:
        async with pool.connection() as conn:
            await conn.execute("DELETE FROM agent.tool_call_logs WHERE user_id = %s", (user,))
        for t in await svc.list_threads(user):
            await svc.delete_thread(user, t["id"])
    assert await svc.list_threads(user) == []


async def test_llm_error_reports_error_event(db, engine_env):
    class Boom(ScriptedLLM):
        async def ainvoke(self, *a, **k):
            raise ConnectionError("openai down")

    svc = make_service(db, [], [], engine_env)
    svc.graph = build_graph(Services(settings=svc.s, backend=FakeBackend(), mqtt=engine_env[1], engine=engine_env[0],
                                     runtime=FakeRuntime(), dispatcher=FakeDispatcher(),
                                     logger=ToolCallLogger(db[0]), pool=db[0]),
                            LLMCaller(UsageRecorder(None)), Boom([]), "sup", Boom([]), "wrk", db[1])
    user = 900_000 + uuid.uuid4().int % 99_999
    try:
        ev = await collect(await svc.start_chat(user_id=user, username=None, thread_id=None, message="hi"))
        assert ev[-1][0] == "error" and ev[-1][1]["code"] == "agent_error"
    finally:
        for t in await svc.list_threads(user):
            await svc.delete_thread(user, t["id"])


async def test_incident_enrich_returns_agent_message(db, engine_env):
    from app.rules.actions import Alert
    svc = make_service(db, [call("ask_notification", {"task": "gửi"}, "h1"), say("Đã gửi.")],
                       [call("publish_alert", {"message": "Nhiệt độ cao kéo dài, kiểm tra thông gió."}, "w1"),
                        say("ok")], engine_env)
    inc = f"inc-test-{uuid.uuid4().hex[:6]}"
    try:
        res = await svc.enrich(Alert("temp_high_prolonged", "info", "Nóng kéo dài", inc, {"temp": 39}))
        assert res["message"].startswith("Nhiệt độ cao") and res["details"]["agent_trace_id"].startswith("i-")
        assert await svc.enrich(Alert("escalation", "critical", "x", inc)) is None
    finally:
        await svc.checkpointer.adelete_thread(inc)
        async with db[0].connection() as conn:
            await conn.execute("DELETE FROM agent.tool_call_logs WHERE thread_id = %s", (inc,))
