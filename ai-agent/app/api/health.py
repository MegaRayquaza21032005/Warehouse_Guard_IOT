from typing import Any

from fastapi import APIRouter, Depends, Request

from app.api.deps import require_internal_key

router = APIRouter()


@router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    st = request.app.state
    db_ok = False
    if st.pool is not None:
        try:
            async with st.pool.connection() as conn:
                await conn.execute("SELECT 1")
            db_ok = True
        except Exception:  # noqa: BLE001
            db_ok = False
    return {"status": "ok" if st.mqtt.connected and db_ok else "degraded",
            "mqtt": st.mqtt.connected, "db": db_ok, "langfuse": st.tracer.enabled,
            "agent": st.agent is not None, "memory": st.memory is not None}


@router.get("/rules/state", dependencies=[Depends(require_internal_key)])
async def rules_state(request: Request) -> dict[str, Any]:
    """Trạng thái tầng luật: an toàn, sự cố đang mở, ngưỡng, số bản tin đã xử lý..."""
    return request.app.state.runtime.status()


@router.get("/incidents", dependencies=[Depends(require_internal_key)])
async def incidents(request: Request, open_only: bool = False, limit: int = 50) -> list[dict[str, Any]]:
    pool = request.app.state.pool
    if pool is None:
        return []
    sql = ("SELECT id, kind, level, state, opened_at, closed_at, events FROM agent.incidents"
           + (" WHERE closed_at IS NULL" if open_only else "") + " ORDER BY opened_at DESC LIMIT %s")
    async with pool.connection() as conn:
        cur = await conn.execute(sql, (max(1, min(limit, 500)),))
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in await cur.fetchall()]
