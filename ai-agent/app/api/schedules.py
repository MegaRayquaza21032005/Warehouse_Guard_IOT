"""Lệnh thiết bị hẹn giờ đang chờ (tạo từ chatbot) — CHỈ Java BE gọi (X-Internal-Key)."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api.deps import require_internal_key

router = APIRouter(prefix="/schedules", dependencies=[Depends(require_internal_key)])


def _scheduler(request: Request):
    sch = getattr(request.app.state, "scheduler", None)
    if sch is None:
        raise HTTPException(503, detail={"error": "scheduler_unavailable", "message": "Chưa bật bộ hẹn giờ"})
    return sch


@router.get("")
async def list_schedules(request: Request) -> list[dict[str, Any]]:
    """Mọi lệnh hẹn giờ đang chờ (thiết bị dùng chung nên mọi người dùng đều thấy), sớm nhất trước."""
    return _scheduler(request).list()


@router.delete("/{item_id}", status_code=204)
async def cancel_schedule(item_id: str, request: Request, user_id: int | None = None) -> None:
    if not await _scheduler(request).cancel(item_id, reason="Người dùng hủy lịch", by=user_id):
        raise HTTPException(404, detail={"error": "not_found", "message": "Không có lệnh hẹn giờ này (đã chạy / đã hủy)"})
