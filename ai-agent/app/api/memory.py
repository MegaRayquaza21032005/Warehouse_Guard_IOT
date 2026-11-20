"""API long-term memory — CHỈ Java BE gọi (X-Internal-Key), user_id do Java BE lấy từ JWT (CLAUDE.md mục 7).

- Người dùng xem / xóa được memory CÁ NHÂN của mình (không xem được của người khác).
- Kiến thức chung về kho: ai cũng xem được; xóa được nếu là người tạo hoặc ADMIN.
- Phản hồi "Đúng / Báo giả" từ app -> ("warehouse", "feedback").
"""

from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from app.api.deps import require_internal_key
from app.memory.store import NS_FACTS, SHARED, ns_profile

router = APIRouter(prefix="/memory", dependencies=[Depends(require_internal_key)])


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code, "message": message})


def _mem(request: Request):
    return request.app.state.memory


@router.get("")
async def list_personal(request: Request, user_id: int, limit: int = 100):
    mem = _mem(request)
    if mem is None:
        return _err(503, "memory_disabled", "Chưa bật long-term memory")
    return await mem.list_items(ns_profile(user_id), limit=max(1, min(limit, 500)))


@router.delete("/{key}", status_code=204)
async def delete_personal(key: str, request: Request, user_id: int):
    mem = _mem(request)
    if mem is None:
        return _err(503, "memory_disabled", "Chưa bật long-term memory")
    if not await mem.delete(ns_profile(user_id), key):
        return _err(404, "memory_not_found", "Không tìm thấy ghi nhớ")
    return Response(status_code=204)


@router.get("/warehouse")
async def list_shared(request: Request, kind: Literal["facts", "incidents", "feedback"] = "facts",
                      limit: int = 100, offset: int = 0):
    mem = _mem(request)
    if mem is None:
        return _err(503, "memory_disabled", "Chưa bật long-term memory")
    return await mem.list_items(SHARED[kind], limit=max(1, min(limit, 500)), offset=max(0, offset))


@router.delete("/warehouse/{key}", status_code=204)
async def delete_fact(key: str, request: Request, user_id: int, is_admin: bool = False):
    mem = _mem(request)
    if mem is None:
        return _err(503, "memory_disabled", "Chưa bật long-term memory")
    item = await mem.get(NS_FACTS, key)
    if item is None:
        return _err(404, "memory_not_found", "Không tìm thấy kiến thức này")
    if not is_admin and str(item.get("created_by")) != str(user_id):
        return _err(403, "not_owner", "Chỉ người tạo hoặc quản trị viên được xóa kiến thức dùng chung")
    await mem.delete(NS_FACTS, key)
    return Response(status_code=204)


class FeedbackRequest(BaseModel):
    user_id: int
    alert: dict[str, Any] = Field(description="Cảnh báo đã lưu ở Java BE: id, type, level, message, ts")
    feedback: Literal["true_alarm", "false_alarm"]
    note: str | None = Field(None, max_length=1000)


@router.post("/feedback")
async def feedback(req: FeedbackRequest, request: Request) -> Any:
    ex = request.app.state.extractor
    if ex is None:
        return _err(503, "memory_disabled", "Chưa bật long-term memory")
    key = await ex.save_alert_feedback(user_id=req.user_id, alert=req.alert, feedback=req.feedback, note=req.note)
    if key is None:
        return _err(500, "feedback_not_saved", "Không lưu được phản hồi vào bộ nhớ")
    return {"key": key}
