"""API chat / giọng nói / nhật ký tool call — CHỈ Java BE gọi (X-Internal-Key). Java BE gửi user_id đã xác thực."""

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from app.agents.service import AgentService, ApiError
from app.agents.voice import MAX_AUDIO_BYTES, MAX_TTS_CHARS
from app.api.deps import require_internal_key

router = APIRouter(dependencies=[Depends(require_internal_key)])


def _svc(request: Request) -> AgentService:
    svc = request.app.state.agent
    if svc is None:
        raise HTTPException(503, detail={"error": "agent_unavailable", "message": "Multi-agent chưa sẵn sàng"})
    return svc


def _err(e: ApiError) -> JSONResponse:
    return JSONResponse(status_code=e.status, content={"error": e.code, "message": e.message})


class ChatRequest(BaseModel):
    user_id: int
    username: str | None = None
    thread_id: str | None = Field(None, max_length=64)
    message: str = Field(min_length=1, max_length=2000)
    input_mode: Literal["text", "voice"] = "text"


class ConfirmRequest(BaseModel):
    user_id: int
    approved: bool


class TtsRequest(BaseModel):
    user_id: int | None = None
    text: str = Field(min_length=1, max_length=MAX_TTS_CHARS * 2)


# ------------------------------------------------------------------------------------------------ chat
@router.post("/chat")
async def chat(req: ChatRequest, request: Request):
    """Stream SSE. Sự kiện: meta, status, token, discard, confirmation, result, done, error."""
    try:
        events = await _svc(request).start_chat(user_id=req.user_id, username=req.username,
                                                thread_id=req.thread_id, message=req.message,
                                                input_mode=req.input_mode)
    except ApiError as e:
        return _err(e)
    return EventSourceResponse(events, ping=15)


@router.post("/chat/{thread_id}/confirm")
async def confirm(thread_id: str, req: ConfirmRequest, request: Request):
    try:
        events = await _svc(request).start_confirm(user_id=req.user_id, thread_id=thread_id, approved=req.approved)
    except ApiError as e:
        return _err(e)
    return EventSourceResponse(events, ping=15)


@router.get("/chat/threads")
async def threads(request: Request, user_id: int, limit: int = 50):
    try:
        return await _svc(request).list_threads(user_id, limit)
    except ApiError as e:
        return _err(e)


@router.get("/chat/threads/{thread_id}")
async def thread(thread_id: str, request: Request, user_id: int):
    try:
        return await _svc(request).get_thread(user_id, thread_id)
    except ApiError as e:
        return _err(e)


@router.delete("/chat/threads/{thread_id}", status_code=204)
async def delete_thread(thread_id: str, request: Request, user_id: int):
    try:
        await _svc(request).delete_thread(user_id, thread_id)
    except ApiError as e:
        return _err(e)
    return Response(status_code=204)


# ------------------------------------------------------------------------------------------------ giọng nói
@router.post("/voice/stt")
async def stt(request: Request, file: UploadFile = File(...), user_id: int | None = Form(None),
              language: str = Form("vi")):
    if not request.app.state.settings.llm_enabled:
        return _err(ApiError(503, "llm_disabled", "Chưa cấu hình OPENAI_API_KEY"))
    audio = await file.read(MAX_AUDIO_BYTES + 1)
    if not audio:
        return _err(ApiError(400, "empty_audio", "File âm thanh trống"))
    if len(audio) > MAX_AUDIO_BYTES:
        return _err(ApiError(413, "audio_too_large", "File âm thanh tối đa 10 MB"))
    try:
        text = await request.app.state.voice.stt(audio, file.filename or "audio.webm",
                                                 file.content_type or "application/octet-stream", user_id, language)
    except Exception as e:  # noqa: BLE001
        return _err(ApiError(502, "stt_failed", f"Không nhận dạng được giọng nói: {type(e).__name__}"))
    return {"text": text}


@router.post("/voice/tts")
async def tts(req: TtsRequest, request: Request):
    if not request.app.state.settings.llm_enabled:
        return _err(ApiError(503, "llm_disabled", "Chưa cấu hình OPENAI_API_KEY"))
    try:
        audio = await request.app.state.voice.tts(req.text, req.user_id)
    except Exception as e:  # noqa: BLE001
        return _err(ApiError(502, "tts_failed", f"Không tạo được giọng đọc: {type(e).__name__}"))
    return Response(content=audio, media_type="audio/mpeg")


# ------------------------------------------------------------------------------------------------ nhật ký
@router.get("/logs/tool-calls")
async def tool_calls(request: Request, trace_id: str | None = None, thread_id: str | None = None,
                     user_id: int | None = None, viewer_id: int | None = None, agent: str | None = None,
                     tool: str | None = None, status: str | None = None, flow: str | None = None,
                     from_: datetime | None = Query(None, alias="from"), to: datetime | None = None,
                     limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
    """Lọc nhật ký tool call. viewer_id: người dùng thường chỉ thấy tool call của chính mình + luồng sự cố."""
    pool = request.app.state.pool
    if pool is None:
        raise HTTPException(503, detail={"error": "db_unavailable", "message": "Chưa kết nối PostgreSQL"})
    where, params = [], []
    for col, val in (("trace_id", trace_id), ("thread_id", thread_id), ("user_id", user_id), ("agent", agent),
                     ("tool", tool), ("status", status), ("flow", flow)):
        if val is not None:
            where.append(f"{col} = %s")
            params.append(val)
    if viewer_id is not None:
        where.append("(user_id = %s OR flow = 'incident')")
        params.append(viewer_id)
    if from_ is not None:
        where.append("started_at >= %s")
        params.append(from_)
    if to is not None:
        where.append("started_at < %s")
        params.append(to)
    sql = ("SELECT id, trace_id, thread_id, flow, agent, tool, args, result, status, error, user_id, confirmed_by, "
           "is_write, started_at, finished_at, duration_ms FROM agent.tool_call_logs"
           + (" WHERE " + " AND ".join(where) if where else "")
           + " ORDER BY started_at DESC LIMIT %s OFFSET %s")
    params += [max(1, min(limit, 500)), max(0, offset)]
    async with pool.connection() as conn:
        cur = await conn.execute(sql, params)
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, r)) for r in await cur.fetchall()]
