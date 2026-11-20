"""Bước trích xuất memory — chạy NỀN, KHÔNG phải agent (CLAUDE.md mục 7): không tool, không trò chuyện.

- Sau mỗi lượt chat (đã trả lời xong — không làm chậm câu trả lời): 1 lần gọi LLM rút sở thích cá nhân và phản
  hồi đúng / báo giả. KHÔNG tự lưu kiến thức chung về kho (cần người dùng xác nhận qua save_memory).
- Khi sự cố đóng: tóm tắt diễn biến -> ("warehouse", "incidents"). LLM lỗi -> tóm tắt dạng mẫu (không mất dữ liệu).
- Phản hồi từ nút "Đúng / Báo giả" trên app -> ("warehouse", "feedback").
Mọi thao tác ghi: agent.tool_call_logs với agent = memory_extractor, ghi TRƯỚC khi lưu.
"""

import asyncio
import json
import uuid
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from langchain_core.messages import HumanMessage, SystemMessage

from app.agents import prompts
from app.agents.graph import WEEKDAY_VI, text_of
from app.agents.llm import LLMCaller
from app.agents.safety_guard import check_memory
from app.logging_setup import get_logger
from app.memory.store import NS_FEEDBACK, NS_INCIDENTS, MemoryService, ns_profile
from app.observability.tool_logger import ToolCall, ToolCallLogger, ToolLogUnavailable

log = get_logger("MEMORY")
VN = ZoneInfo("Asia/Ho_Chi_Minh")
AGENT = "memory_extractor"
MIN_MESSAGE_CHARS = 8
FEEDBACK_VI = {"false_alarm": "BÁO GIẢ", "true_alarm": "ĐÚNG (sự cố thật)"}
KIND_VI = {"safety": "Sự cố an toàn (khí / khói / cháy)", "intrusion": "Đột nhập ngoài giờ",
           "offline": "ESP32 mất kết nối"}


def vn_time(v: Any) -> str:
    if v is None:
        return "?"
    dt = v if isinstance(v, datetime) else datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    dt = dt.astimezone(VN)
    return f"{WEEKDAY_VI[dt.weekday()]} {dt.strftime('%d/%m/%Y %H:%M')}"


class MemoryExtractor:
    def __init__(self, memory: MemoryService, logger: ToolCallLogger, caller: LLMCaller | None, llm_json: Any,
                 llm_text: Any, model_name: str, pool: Any, settings: Any):
        self.memory = memory
        self.logger = logger
        self.caller = caller
        self.llm = llm_json                # model trả JSON (response_format json_object) — trích xuất sau chat
        self.llm_text = llm_text           # model trả chữ — tóm tắt sự cố
        self.model_name = model_name
        self.pool = pool
        self.s = settings
        self._bg: set[asyncio.Task] = set()

    def spawn(self, coro) -> None:
        """Chạy nền; lỗi chỉ ghi log."""
        t = asyncio.create_task(coro)
        self._bg.add(t)
        t.add_done_callback(self._done)

    def _done(self, t: asyncio.Task) -> None:
        self._bg.discard(t)
        if not t.cancelled() and t.exception():
            log.error("Bước trích xuất memory lỗi: %s", t.exception())

    async def save(self, ns: tuple[str, ...], text: str, *, kind: str, created_by: Any, source: str, trace_id: str,
                   flow: str, tool: str, thread_id: str | None = None, user_id: int | None = None,
                   key: str | None = None, extra: dict[str, Any] | None = None, dedupe: bool = True) -> str | None:
        """Ghi 1 mục memory có nhật ký (tool ghi: không ghi được log thì không lưu)."""
        call = ToolCall(trace_id, flow, AGENT, tool, {"namespace": "/".join(ns), "text": text[:300]}, is_write=True,
                        thread_id=thread_id, user_id=user_id)
        try:
            await self.logger.start(call)
        except ToolLogUnavailable as e:
            log.error("Không lưu memory vì không ghi được nhật ký: %s", e)
            return None
        try:
            v = check_memory(text) if ns != NS_INCIDENTS else None
            if v is not None and not v.allowed:
                await self.logger.update(call, "blocked_by_policy", error=v.reason)
                return None
            if dedupe and await self.memory.is_duplicate(ns, text):
                await self.logger.update(call, "success", result={"duplicate": True})
                return None
            k = await self.memory.put(ns, text, kind=kind, created_by=created_by, source=source, key=key, extra=extra)
            await self.logger.update(call, "success", result={"key": k})
            return k
        except Exception as e:  # noqa: BLE001
            await self.logger.update(call, "error", error=f"{type(e).__name__}: {e}")
            return None

    # ------------------------------------------------------------------------------------------ sau lượt chat
    async def after_chat(self, *, user_id: int, thread_id: str, trace_id: str, user_text: str,
                         assistant_text: str) -> int:
        if self.caller is None or len(user_text.strip()) < MIN_MESSAGE_CHARS:
            return 0
        known = [i["text"] for i in await self.memory.list_items(ns_profile(user_id), limit=30)]
        msgs = [SystemMessage(prompts.MEMORY_EXTRACT),
                HumanMessage(f"Đã ghi nhớ về người dùng này: {json.dumps(known, ensure_ascii=False)}\n\n"
                             f"Người dùng: {user_text[:2000]}\n\nTrợ lý: {assistant_text[:2000]}")]
        ai = await self.caller.call(self.llm, msgs, agent=AGENT, trace_id=trace_id, model_name=self.model_name,
                                    tags=[AGENT, "nostream"])
        try:
            data = json.loads(text_of(ai) or "{}")
        except json.JSONDecodeError:
            log.warning("Trích xuất memory: LLM không trả JSON hợp lệ (trace=%s)", trace_id)
            return 0
        n = 0
        for p in (data.get("profile") or [])[:5]:
            if isinstance(p, str) and p.strip():
                n += bool(await self.save(ns_profile(user_id), p.strip(), kind="preference", created_by=user_id,
                                          source="chat_extract", trace_id=trace_id, flow="chat", tool="save_profile",
                                          thread_id=thread_id, user_id=user_id))
        for f in (data.get("feedback") or [])[:3]:
            if isinstance(f, dict) and isinstance(f.get("text"), str) and f["text"].strip():
                verdict = f.get("verdict") if f.get("verdict") in FEEDBACK_VI else None
                n += bool(await self.save(NS_FEEDBACK, f["text"].strip(), kind="feedback", created_by=user_id,
                                          source="chat_extract", trace_id=trace_id, flow="chat",
                                          tool="save_feedback", thread_id=thread_id, user_id=user_id,
                                          extra={"verdict": verdict}))
        if n:
            log.info("Trích xuất %d mục memory từ lượt chat %s", n, trace_id)
        return n

    # ------------------------------------------------------------------------------------------ khi đóng sự cố
    async def on_incident_closed(self, incident_id: str) -> str | None:
        if self.pool is None:
            return None
        async with self.pool.connection() as conn:
            row = await (await conn.execute(
                "SELECT id, kind, level, state, opened_at, closed_at, events FROM agent.incidents WHERE id = %s",
                (incident_id,))).fetchone()
        if row is None:
            return None
        _, kind, level, state, opened, closed, events = row
        duration = round((closed - opened).total_seconds() / 60, 1) if closed else None
        trace_id = f"m-{uuid.uuid4().hex[:12]}"
        base = {"incident_id": incident_id, "loai": KIND_VI.get(kind, kind), "muc_cao_nhat": level,
                "trang_thai": state, "mo_luc": vn_time(opened), "dong_luc": vn_time(closed),
                "keo_dai_phut": duration, "dien_bien": events[-30:] if isinstance(events, list) else events}
        text = None
        if self.caller is not None:
            try:
                ai = await self.caller.call(self.llm_text, [SystemMessage(prompts.INCIDENT_SUMMARY),
                                                            HumanMessage(json.dumps(base, ensure_ascii=False,
                                                                                    default=str))],
                                            agent=AGENT, trace_id=trace_id, model_name=self.model_name,
                                            tags=[AGENT, "nostream"])
                text = text_of(ai).strip() or None
            except Exception as e:  # noqa: BLE001 — LLM lỗi -> tóm tắt mẫu
                log.warning("Tóm tắt sự cố %s bằng LLM lỗi (%s) — dùng mẫu", incident_id, type(e).__name__)
        if not text:
            text = (f"{KIND_VI.get(kind, kind)}, mức cao nhất {level}"
                    f"{f', trạng thái {state}' if state and state != 'closed' else ''}, "
                    f"từ {vn_time(opened)} đến {vn_time(closed)}"
                    f"{f' ({duration} phút)' if duration is not None else ''}; {len(events or [])} sự kiện.")
        return await self.save(NS_INCIDENTS, text, kind="incident_summary", created_by=None, source="incident",
                               trace_id=trace_id, flow="incident", tool="save_incident_summary", thread_id=incident_id,
                               key=incident_id, dedupe=False,
                               extra={"incident_kind": kind, "level": level, "state": state,
                                      "opened_at": opened.isoformat() if opened else None,
                                      "duration_min": duration})

    # ------------------------------------------------------------------------------------------ phản hồi từ app
    async def save_alert_feedback(self, *, user_id: int, alert: dict[str, Any], feedback: str,
                                  note: str | None) -> str | None:
        text = (f"Cảnh báo {alert.get('type')} ({alert.get('level')}) lúc {vn_time(alert.get('ts'))}: "
                f"“{str(alert.get('message') or '')[:200]}” — người dùng đánh giá {FEEDBACK_VI.get(feedback, feedback)}"
                + (f". Ghi chú: {note.strip()[:200]}" if note and note.strip() else ""))
        return await self.save(NS_FEEDBACK, text, kind="feedback", created_by=user_id, source="app",
                               trace_id=f"f-{uuid.uuid4().hex[:12]}", flow="chat", tool="save_feedback",
                               user_id=user_id, key=f"alert-{alert.get('id')}-u{user_id}", dedupe=False,
                               extra={"verdict": feedback, "alert_id": alert.get("id"),
                                      "alert_type": alert.get("type"), "level": alert.get("level")})

