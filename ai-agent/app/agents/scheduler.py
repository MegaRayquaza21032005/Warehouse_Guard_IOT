"""Lệnh thiết bị hẹn giờ / nối chuỗi (chatbot) — vd. "bật phun sương 30s, xong bật quạt 30s".

- Người dùng bấm [Đồng ý] một lần cho cả chuỗi. Lệnh không có delay_s chạy ngay; lệnh có delay_s được hẹn
  (tính từ lúc bấm Đồng ý) và chạy trong tiến trình ai-agent.
- Đến giờ: Safety Guard kiểm tra LẠI với tình hình lúc đó rồi mới gửi MQTT (source=user, user_id người đã đồng ý).
- Lệnh thủ công MỚI của người dùng cho cùng thiết bị (nút trên app/web hoặc yêu cầu chat khác) -> hủy lịch đang chờ
  của thiết bị đó (lệnh mới nhất thắng, tránh lịch cũ bất ngờ đè lên).
- Lịch chỉ nằm trong RAM: ai-agent khởi động lại thì mất — nhật ký ghi `cancelled` kèm lý do (xem main.py).
- Mọi thay đổi đều ghi `agent.tool_call_logs` (cùng dòng với đề xuất): scheduled -> success / error /
  blocked_by_policy / cancelled.
"""

import asyncio
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from app.agents.tools import ActionExecutor, RunContext, Services, _describe_device
from app.logging_setup import get_logger
from app.observability.tool_logger import ToolCall

log = get_logger("SCHEDULE")
VN = ZoneInfo("Asia/Ho_Chi_Minh")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, VN).isoformat(timespec="seconds")


@dataclass
class ScheduledCommand:
    id: str                       # = id của đề xuất / dòng agent.tool_call_logs
    device: str
    args: dict[str, Any]          # tham số lệnh thiết bị (đã bỏ delay_s)
    description: str
    run_at: float
    created_at: float
    ctx: RunContext
    confirmed_by: int | None
    agent: str
    tool: str
    task: asyncio.Task | None = None

    def public(self) -> dict[str, Any]:
        a = self.args          # mô tả KHÔNG kèm "Sau …" (danh sách đã có đồng hồ đếm ngược)
        action = _describe_device(self.device, a.get("state"), a.get("mode"), a.get("duration_s"))
        return {"id": self.id, "device": self.device, "description": action, "run_at": _iso(self.run_at),
                "created_at": _iso(self.created_at), "remaining_s": max(0, round(self.run_at - time.time())),
                "user_id": self.confirmed_by, "trace_id": self.ctx.trace_id, "thread_id": self.ctx.thread_id}


class Scheduler:
    def __init__(self, services: Services):
        self.s = services
        self.executor = ActionExecutor(services)
        self.items: dict[str, ScheduledCommand] = {}

    def pending(self) -> int:
        return len(self.items)

    def list(self) -> list[dict[str, Any]]:
        return [i.public() for i in sorted(self.items.values(), key=lambda i: i.run_at)]

    def schedule(self, proposal: dict[str, Any], ctx: RunContext, confirmed_by: int | None) -> dict[str, Any]:
        """Hẹn một đề xuất thiết bị đã được người dùng đồng ý. Trả outcome (status=scheduled)."""
        args = dict(proposal["args"])
        delay = int(args.pop("delay_s"))
        now = time.time()
        item = ScheduledCommand(id=proposal["id"], device=args["device"], args=args,
                                description=proposal["description"], run_at=now + delay, created_at=now, ctx=ctx,
                                confirmed_by=confirmed_by, agent=proposal.get("agent", "control"),
                                tool=proposal["tool"])
        item.task = asyncio.create_task(self._run(item), name=f"schedule-{item.id[:8]}")
        self.items[item.id] = item
        at = datetime.fromtimestamp(item.run_at, VN).strftime("%H:%M:%S")
        log.info("HẸN %s lúc %s (sau %ds) — %s · trace=%s", item.device, at, delay, item.description, ctx.trace_id)
        return {"status": "scheduled", "text": f"chạy lúc {at} — {item.description}",
                "run_at": _iso(item.run_at), "scheduled_id": item.id}

    def _call(self, item: ScheduledCommand) -> ToolCall:
        call = ToolCall(item.ctx.trace_id, item.ctx.flow, item.agent, item.tool, item.args, is_write=True,
                        thread_id=item.ctx.thread_id, user_id=item.ctx.user_id, started=0, logged=True)
        call.id = uuid.UUID(item.id)
        return call

    async def _run(self, item: ScheduledCommand) -> None:
        try:
            await asyncio.sleep(max(0.0, item.run_at - time.time()))
        except asyncio.CancelledError:
            return
        if self.items.pop(item.id, None) is None:          # vừa bị hủy
            return
        res = await self.executor.run("device", item.args, item.ctx, confirmed_by=item.confirmed_by)
        log.info("CHẠY %s -> %s: %s", item.device, res["status"], res.get("text"))
        try:
            await self.s.logger.update(self._call(item), res["status"], result=res, error=res.get("error"),
                                       confirmed_by=item.confirmed_by)
        except Exception:  # noqa: BLE001 — lệnh đã gửi; lỗi ghi log không được làm hỏng vòng hẹn giờ
            log.exception("Không cập nhật được nhật ký lệnh hẹn giờ %s", item.id)

    async def cancel(self, item_id: str, *, reason: str, by: int | None = None) -> bool:
        item = self.items.pop(item_id, None)
        if item is None:
            return False
        if item.task is not None:
            item.task.cancel()
        who = f" (người dùng {by})" if by is not None else ""
        log.info("HỦY lịch %s — %s: %s%s", item.device, item.description, reason, who)
        try:
            await self.s.logger.update(self._call(item), "cancelled", error=f"{reason}{who}")
        except Exception:  # noqa: BLE001
            log.exception("Không cập nhật được nhật ký khi hủy lịch %s", item_id)
        return True

    def on_command(self, topic: str, data: dict[str, Any]) -> None:
        """Bản tin warehouse/cmd/<thiết bị> (từ mọi nguồn). Lệnh thủ công MỚI của người dùng -> hủy lịch đang chờ
        của thiết bị đó. Bỏ qua lệnh thuộc cùng yêu cầu với lịch (trace_id = <trace yêu cầu>-xxxx)."""
        device = topic.rsplit("/", 1)[-1]
        if not isinstance(data, dict) or (data.get("source") or "user") != "user":
            return
        trace = str(data.get("trace_id") or "")
        for item in list(self.items.values()):
            if item.device == device and not trace.startswith(item.ctx.trace_id + "-"):
                asyncio.create_task(self.cancel(item.id, reason="Có lệnh thủ công mới cho thiết bị này"))

    async def shutdown(self) -> None:
        for item_id in list(self.items):
            await self.cancel(item_id, reason="ai-agent dừng — lịch hẹn trong RAM bị hủy")
