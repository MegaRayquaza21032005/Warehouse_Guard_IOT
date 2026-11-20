"""Nhật ký MỌI tool call của agent -> agent.tool_call_logs + terminal (CLAUDE.md mục 8). Dùng từ giai đoạn 4.

Quy tắc:
- Tool ĐỌC: lỗi ghi log không được làm hỏng tool.
- Tool GHI (điều khiển, cấu hình, phát cảnh báo, lưu memory): ghi log TRƯỚC khi chạy; không ghi được
  log thì KHÔNG chạy (ném ToolLogUnavailable).
"""

import json
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from psycopg_pool import AsyncConnectionPool

from app.logging_setup import get_logger
from app.observability.redact import redact

log = get_logger("TOOL")
MAX_RESULT_CHARS = 4000


class ToolLogUnavailable(RuntimeError):
    """Không ghi được nhật ký cho tool ghi -> không được thực thi."""


@dataclass
class ToolCall:
    trace_id: str
    flow: str                       # chat | incident
    agent: str
    tool: str
    args: dict[str, Any]
    is_write: bool = False
    thread_id: str | None = None
    user_id: int | None = None
    id: uuid.UUID = field(default_factory=uuid.uuid4)
    started: float = field(default_factory=time.monotonic)
    logged: bool = False


def _json(v: Any) -> str:
    s = json.dumps(redact(v), ensure_ascii=False, default=str)
    if len(s) > MAX_RESULT_CHARS:
        s = json.dumps({"truncated": s[:MAX_RESULT_CHARS]}, ensure_ascii=False)
    return s


class ToolCallLogger:
    def __init__(self, pool: AsyncConnectionPool | None):
        self.pool = pool

    async def start(self, call: ToolCall, status: str = "requested") -> None:
        log.info("%s.%s %s %s", call.agent, call.tool, status, _json(call.args)[:300])
        if self.pool is None:
            if call.is_write:
                raise ToolLogUnavailable("Chưa có kết nối DB để ghi nhật ký tool ghi")
            return
        try:
            async with self.pool.connection() as conn:
                await conn.execute(
                    """INSERT INTO agent.tool_call_logs (id, trace_id, thread_id, flow, agent, tool, args, status,
                                                         user_id, is_write)
                       VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s)""",
                    (call.id, call.trace_id, call.thread_id, call.flow, call.agent, call.tool, _json(call.args),
                     status, call.user_id, call.is_write))
            call.logged = True
        except Exception as e:  # noqa: BLE001
            log.error("Không ghi được nhật ký %s.%s: %s", call.agent, call.tool, e)
            if call.is_write:
                raise ToolLogUnavailable(str(e)) from e

    async def update(self, call: ToolCall, status: str, *, result: Any = None, error: str | None = None,
                     confirmed_by: int | None = None) -> None:
        # started = 0: ToolCall dựng lại sau khi người dùng xác nhận -> tính thời gian từ started_at trong DB
        ms = int((time.monotonic() - call.started) * 1000) if call.started else None
        (log.error if status in ("error", "blocked_by_policy") else log.info)(
            "%s.%s %s%s%s", call.agent, call.tool, status, f" ({ms}ms)" if ms is not None else "",
            f" — {error}" if error else "")
        if self.pool is None or not call.logged:
            return
        try:
            async with self.pool.connection() as conn:
                await conn.execute(
                    """UPDATE agent.tool_call_logs
                       SET status = %s, result = COALESCE(%s::jsonb, result), error = %s,
                           confirmed_by = COALESCE(%s, confirmed_by), finished_at = now(),
                           duration_ms = COALESCE(%s, (EXTRACT(EPOCH FROM now() - started_at) * 1000)::int)
                       WHERE id = %s""",
                    (status, None if result is None else _json(result), error, confirmed_by, ms, call.id))
        except Exception as e:  # noqa: BLE001
            log.error("Không cập nhật được nhật ký %s.%s: %s", call.agent, call.tool, e)

    @asynccontextmanager
    async def track(self, call: ToolCall):
        """async with logger.track(call) as c: ... ; ném lỗi -> status error; bình thường -> success."""
        await self.start(call)
        holder: dict[str, Any] = {"result": None}
        try:
            yield holder
        except Exception as e:
            await self.update(call, "error", error=f"{type(e).__name__}: {e}")
            raise
        await self.update(call, "success", result=holder["result"])
