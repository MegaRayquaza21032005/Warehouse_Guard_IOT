"""Dọn dữ liệu cũ — chạy khi khởi động rồi 6 giờ/lần (CLAUDE.md mục 7, 8).

- Checkpoint (short-term memory) của hội thoại / sự cố không hoạt động quá CHECKPOINT_TTL_DAYS -> xóa. Thông tin
  đáng giữ đã nằm ở long-term memory; lịch sử hiển thị (agent.chat_messages) vẫn giữ. Tiếp tục hội thoại đã hết
  hạn = bắt đầu lại ngữ cảnh LLM từ đầu.
- agent.tool_call_logs: tool đọc giữ TOOL_LOG_READ_DAYS, tool ghi giữ TOOL_LOG_WRITE_DAYS.
"""

import asyncio
from typing import Any

from app.logging_setup import get_logger

log = get_logger("MAINTAIN")
INTERVAL_S = 6 * 3600


async def expired_threads(cp_pool: Any, days: int) -> list[str]:
    async with cp_pool.connection() as conn:
        cur = await conn.execute(
            """SELECT thread_id FROM agent.checkpoints
               GROUP BY thread_id
               HAVING max((checkpoint ->> 'ts')::timestamptz) < now() - make_interval(days => %s)""", (days,))
        return [r["thread_id"] if isinstance(r, dict) else r[0] for r in await cur.fetchall()]


async def run_once(settings: Any, pool: Any, cp_pool: Any, checkpointer: Any) -> dict[str, int]:
    out = {"threads": 0, "tool_logs": 0}
    if cp_pool is not None and checkpointer is not None:
        for tid in await expired_threads(cp_pool, settings.checkpoint_ttl_days):
            await checkpointer.adelete_thread(tid)
            out["threads"] += 1
    if pool is not None:
        async with pool.connection() as conn:
            cur = await conn.execute(
                """DELETE FROM agent.tool_call_logs
                   WHERE (NOT is_write AND started_at < now() - make_interval(days => %s))
                      OR (is_write AND started_at < now() - make_interval(days => %s))""",
                (settings.tool_log_read_days, settings.tool_log_write_days))
            out["tool_logs"] = cur.rowcount or 0
    if any(out.values()):
        log.info("Đã dọn: %d checkpoint quá %d ngày, %d dòng nhật ký tool", out["threads"],
                 settings.checkpoint_ttl_days, out["tool_logs"])
    return out


async def loop(settings: Any, pool: Any, cp_pool: Any, checkpointer: Any) -> None:
    await asyncio.sleep(30)
    while True:
        try:
            await run_once(settings, pool, cp_pool, checkpointer)
        except Exception as e:  # noqa: BLE001
            log.warning("Dọn dữ liệu cũ lỗi: %s", e)
        await asyncio.sleep(INTERVAL_S)
