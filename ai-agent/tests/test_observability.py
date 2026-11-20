import uuid

import pytest

from app.config import get_settings
from app.observability.redact import MASK, redact
from app.observability.tool_logger import ToolCall, ToolCallLogger, ToolLogUnavailable


def test_redact_keys_and_values():
    data = {"password": "abc", "nested": {"api_key": "x", "note": "key sk-proj-ABCDEFGHIJKLMNOPQRSTUV end"},
            "list": ["Bearer abcdefghijklmnop", "ok"], "Authorization": "Bearer zzz"}
    r = redact(data)
    assert r["password"] == MASK and r["nested"]["api_key"] == MASK and r["Authorization"] == MASK
    assert "sk-proj" not in r["nested"]["note"] and r["list"][0] == MASK and r["list"][1] == "ok"


async def test_write_tool_refuses_without_db():
    logger = ToolCallLogger(pool=None)
    with pytest.raises(ToolLogUnavailable):
        await logger.start(ToolCall("t", "chat", "control", "control_fan", {"state": "on"}, is_write=True))
    # tool đọc vẫn chạy được khi không có DB
    await logger.start(ToolCall("t", "chat", "monitor", "get_current_state", {}))


@pytest.fixture
async def pool():
    from app.db import migrate, open_pool
    try:
        p = await open_pool(get_settings().postgres_conninfo)
    except Exception:  # noqa: BLE001
        pytest.skip("PostgreSQL (docker compose) chưa chạy")
    await migrate(p)
    yield p
    await p.close()


@pytest.mark.integration
async def test_tool_call_is_logged_to_db(pool):
    trace = f"test-{uuid.uuid4().hex[:8]}"
    logger = ToolCallLogger(pool)
    call = ToolCall(trace, "chat", "control", "control_fan", {"state": "on", "token": "secret"}, is_write=True,
                    user_id=1)
    async with logger.track(call) as h:
        h["result"] = {"ok": True}
    failing = ToolCall(trace, "chat", "monitor", "get_statistics", {"metric": "temp"})
    with pytest.raises(ValueError):
        async with logger.track(failing):
            raise ValueError("bad metric")
    try:
        async with pool.connection() as conn:
            rows = await (await conn.execute(
                "SELECT tool, status, args->>'token', result->>'ok', is_write, duration_ms IS NOT NULL, error "
                "FROM agent.tool_call_logs WHERE trace_id = %s ORDER BY started_at", (trace,))).fetchall()
        assert rows[0][:6] == ("control_fan", "success", MASK, "true", True, True)
        assert rows[1][1] == "error" and "bad metric" in rows[1][6]
    finally:
        async with pool.connection() as conn:
            await conn.execute("DELETE FROM agent.tool_call_logs WHERE trace_id = %s", (trace,))
