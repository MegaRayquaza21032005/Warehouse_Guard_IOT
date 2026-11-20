"""Long-term memory với PostgreSQL thật (AsyncPostgresStore, halfvec 3072) + embedding giả. Bỏ qua nếu docker tắt."""

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi import FastAPI
from langchain_core.messages import AIMessage

from app.agents.llm import LLMCaller
from app.api.memory import router as memory_router
from app.config import get_settings
from app.memory.extractor import MemoryExtractor
from app.memory.store import NS_FACTS, NS_FEEDBACK, NS_INCIDENTS, MemoryService, index_config, ns_profile
from app.observability.tool_logger import ToolCallLogger
from app.observability.usage import UsageRecorder
from tests.fakes import make_fake_embed
from tests.test_agent_graph import ScriptedLLM

pytestmark = pytest.mark.integration


@pytest.fixture
async def env():
    from langgraph.store.postgres.aio import AsyncPostgresStore

    from app.db import migrate, open_checkpointer, open_pool
    s = get_settings()
    try:
        pool = await open_pool(s.postgres_conninfo)
    except Exception:  # noqa: BLE001
        pytest.skip("PostgreSQL (docker compose) chưa chạy")
    await migrate(pool)
    cp_pool, saver = await open_checkpointer(s.postgres_conninfo)
    store = AsyncPostgresStore(cp_pool, index=index_config(make_fake_embed(s.embedding_dims), s.embedding_dims))
    await store.setup()
    mem = MemoryService(store, s.model_copy(update={"memory_min_score": 0.0}))
    created: list[tuple[tuple[str, ...], str]] = []
    real_put = mem.put

    async def tracking_put(ns, text, **kw):
        k = await real_put(ns, text, **kw)
        created.append((ns, k))
        return k
    mem.put = tracking_put
    yield {"s": s, "pool": pool, "cp_pool": cp_pool, "saver": saver, "mem": mem, "created": created}
    for ns, k in created:
        await store.adelete(ns, k)
    async with pool.connection() as conn:
        await conn.execute("DELETE FROM agent.tool_call_logs WHERE agent = 'memory_extractor' AND "
                           "started_at > now() - interval '10 minutes'")
        await conn.execute("DELETE FROM agent.incidents WHERE id LIKE 'inc-memtest-%'")
    await cp_pool.close()
    await pool.close()


def extractor(env, llm_json=None, llm_text=None) -> MemoryExtractor:
    caller = LLMCaller(UsageRecorder(None)) if (llm_json or llm_text) else None
    return MemoryExtractor(env["mem"], ToolCallLogger(env["pool"]), caller, llm_json, llm_text, "wrk", env["pool"],
                           env["s"])


async def test_after_chat_extracts_profile_and_feedback_with_logs(env):
    uid = 800_000 + uuid.uuid4().int % 99_999
    js = ('{"profile": ["Thích câu trả lời ngắn gọn"], '
          '"feedback": [{"text": "Cảnh báo khói chiều nay là báo giả do hàn", "verdict": "false_alarm"}]}')
    ex = extractor(env, llm_json=ScriptedLLM([AIMessage(js), AIMessage(js)]))
    n = await ex.after_chat(user_id=uid, thread_id="t-x", trace_id="c-memtest", user_text="Trả lời ngắn thôi nhé, "
                            "cảnh báo khói chiều nay là do hàn", assistant_text="Vâng")
    assert n == 2
    assert [i["text"] for i in await env["mem"].list_items(ns_profile(uid))] == ["Thích câu trả lời ngắn gọn"]
    fb = await env["mem"].search(NS_FEEDBACK, "báo giả do hàn", limit=1)
    assert fb[0]["verdict"] == "false_alarm"
    # chạy lại -> trùng, không lưu thêm
    assert await ex.after_chat(user_id=uid, thread_id="t-x", trace_id="c-memtest", user_text="Trả lời ngắn thôi nhé",
                               assistant_text="Vâng") == 0
    async with env["pool"].connection() as conn:
        rows = await (await conn.execute(
            "SELECT tool, status, is_write FROM agent.tool_call_logs WHERE trace_id = 'c-memtest' "
            "AND agent = 'memory_extractor' ORDER BY started_at")).fetchall()
    assert ("save_profile", "success", True) in rows and ("save_feedback", "success", True) in rows


async def test_incident_summary_on_close(env):
    inc = f"inc-memtest-{uuid.uuid4().hex[:6]}"
    opened = datetime.now(timezone.utc) - timedelta(minutes=12)
    async with env["pool"].connection() as conn:
        await conn.execute(
            """INSERT INTO agent.incidents (id, kind, level, state, opened_at, closed_at, events)
               VALUES (%s, 'safety', 'warning', 'gas', %s, now(), '[{"event": "gas"}, {"event": "recovered"}]')""",
            (inc, opened))
    # LLM lỗi / không có -> tóm tắt mẫu, vẫn lưu
    key = await extractor(env).on_incident_closed(inc)
    item = await env["mem"].get(NS_INCIDENTS, key)
    env["created"].append((NS_INCIDENTS, inc))
    assert key == inc and "Sự cố an toàn" in item["text"] and item["duration_min"] == pytest.approx(12, abs=0.2)
    # có LLM -> tóm tắt của LLM (ghi đè cùng key)
    ex = extractor(env, llm_text=ScriptedLLM([AIMessage("Rò rỉ khí mức cảnh báo, kéo dài 12 phút, quạt tự bật.")]))
    await ex.on_incident_closed(inc)
    assert (await env["mem"].get(NS_INCIDENTS, inc))["text"].startswith("Rò rỉ khí")


async def test_memory_api_and_app_feedback(env):
    app = FastAPI()
    app.include_router(memory_router)
    uid, other = 810_001, 810_002
    app.state.memory, app.state.extractor = env["mem"], extractor(env)
    k1 = await env["mem"].put(ns_profile(uid), "Muốn được gọi là anh Thanh", kind="preference", created_by=uid,
                              source="chat")
    kf = await env["mem"].put(NS_FACTS, "Kho có xe nâng chạy dầu (memtest)", kind="fact", created_by=uid,
                              source="chat")
    h = {"X-Internal-Key": env["s"].internal_api_key}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/memory", params={"user_id": uid}, headers=h)
        assert [i["key"] for i in r.json()] == [k1]
        assert (await c.get("/memory", params={"user_id": other}, headers=h)).json() == []
        assert (await c.delete(f"/memory/{k1}", params={"user_id": other}, headers=h)).status_code == 404
        assert (await c.get("/memory", params={"user_id": uid})).status_code == 401           # thiếu khóa nội bộ
        r = await c.get("/memory/warehouse", params={"kind": "facts"}, headers=h)
        assert kf in [i["key"] for i in r.json()]
        r = await c.delete(f"/memory/warehouse/{kf}", params={"user_id": other}, headers=h)
        assert r.status_code == 403 and r.json()["error"] == "not_owner"
        assert (await c.delete(f"/memory/warehouse/{kf}", params={"user_id": other, "is_admin": "true"},
                               headers=h)).status_code == 204
        assert (await c.delete(f"/memory/{k1}", params={"user_id": uid}, headers=h)).status_code == 204
        r = await c.post("/memory/feedback", headers=h, json={
            "user_id": uid, "feedback": "false_alarm", "note": "đang hàn",
            "alert": {"id": 991, "type": "gas", "level": "warning", "message": "Phát hiện khí",
                      "ts": "2026-11-20T08:00:00Z"}})
        assert r.status_code == 200 and r.json()["key"] == f"alert-991-u{uid}"
        env["created"].append((NS_FEEDBACK, r.json()["key"]))
    fb = await env["mem"].get(NS_FEEDBACK, f"alert-991-u{uid}")
    assert "BÁO GIẢ" in fb["text"] and "Thứ Sáu 20/11/2026 15:00" in fb["text"] and "đang hàn" in fb["text"]


async def test_maintenance_deletes_expired_checkpoints(env):
    from langgraph.checkpoint.base import empty_checkpoint

    from app.maintenance import run_once
    tid = f"t-memtest-{uuid.uuid4().hex[:6]}"
    cp = empty_checkpoint()
    cp["ts"] = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
    await env["saver"].aput({"configurable": {"thread_id": tid, "checkpoint_ns": ""}}, cp, {}, {})
    out = await run_once(env["s"], env["pool"], env["cp_pool"], env["saver"])
    assert out["threads"] >= 1
    assert await env["saver"].aget_tuple({"configurable": {"thread_id": tid}}) is None
