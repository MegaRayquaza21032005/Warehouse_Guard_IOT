"""Ghi token / chi phí mỗi lần gọi LLM, STT, TTS, embedding -> agent.llm_usage + terminal. Dùng từ giai đoạn 4."""

from psycopg_pool import AsyncConnectionPool

from app.logging_setup import get_logger

log = get_logger("LLM")


class UsageRecorder:
    def __init__(self, pool: AsyncConnectionPool | None):
        self.pool = pool

    async def record(self, *, model: str, agent: str | None = None, trace_id: str | None = None,
                     kind: str = "chat", input_tokens: int | None = None, output_tokens: int | None = None,
                     audio_seconds: float | None = None, cost_usd: float | None = None) -> None:
        log.info("%s %s agent=%s in=%s out=%s%s", kind, model, agent, input_tokens, output_tokens,
                 f" ${cost_usd:.5f}" if cost_usd is not None else "")
        if self.pool is None:
            return
        try:
            async with self.pool.connection() as conn:
                await conn.execute(
                    """INSERT INTO agent.llm_usage (trace_id, agent, model, kind, input_tokens, output_tokens,
                                                    audio_seconds, cost_usd)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                    (trace_id, agent, model, kind, input_tokens, output_tokens, audio_seconds, cost_usd))
        except Exception as e:  # noqa: BLE001
            log.error("Không ghi được llm_usage: %s", e)
