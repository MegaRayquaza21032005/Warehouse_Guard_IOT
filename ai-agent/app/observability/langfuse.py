"""Tracing bằng Langfuse — TÙY CHỌN, song song với log terminal.

Tắt (LANGFUSE_ENABLED=false) hoặc lỗi kết nối -> mọi hàm thành no-op, KHÔNG làm hỏng luồng chính.
Giai đoạn 3: ghi sự kiện của tầng luật (cảnh báo, lệnh, sự cố), gom theo sự cố (trace id sinh từ incident id).
Giai đoạn 4: callback handler cho LangGraph (cây trace Supervisor -> worker -> tool, token, độ trễ);
trace của một yêu cầu gắn trace_id hệ thống (seed), session = thread_id, user = user_id.
"""

from contextlib import nullcontext
from typing import Any

from app.config import Settings
from app.logging_setup import get_logger
from app.observability.redact import redact

log = get_logger("LANGFUSE")


class Tracer:
    def __init__(self, settings: Settings):
        self.client = None
        self.host = settings.langfuse_host
        self.public_key = settings.langfuse_public_key
        if not settings.langfuse_enabled:
            log.info("Tắt (LANGFUSE_ENABLED=false) — chỉ log ra terminal")
            return
        if not settings.langfuse_public_key or not settings.langfuse_secret_key:
            log.warning("LANGFUSE_ENABLED=true nhưng thiếu LANGFUSE_PUBLIC_KEY / SECRET_KEY — tắt Langfuse")
            return
        try:
            from langfuse import Langfuse
            self.client = Langfuse(public_key=settings.langfuse_public_key, secret_key=settings.langfuse_secret_key,
                                   host=settings.langfuse_host,
                                   mask=lambda *, data, **_: redact(data))   # che bí mật trước khi gửi
        except Exception as e:  # noqa: BLE001 — Langfuse lỗi không được làm hỏng agent
            log.error("Không khởi tạo được Langfuse: %s", e)
            self.client = None

    @property
    def enabled(self) -> bool:
        return self.client is not None

    def check(self) -> bool:
        if not self.client:
            return False
        try:
            ok = bool(self.client.auth_check())
            log.info("Kết nối %s: %s", self.host, "OK" if ok else "SAI KHÓA")
            return ok
        except Exception as e:  # noqa: BLE001
            log.error("Kiểm tra kết nối %s lỗi: %s", self.host, e)
            return False

    def event(self, name: str, *, input: Any = None, output: Any = None, metadata: dict | None = None,
              level: str = "DEFAULT", group: str | None = None) -> None:
        """Ghi một sự kiện. group (vd. incident id) -> các sự kiện cùng group nằm chung một trace."""
        if not self.client:
            return
        try:
            kwargs: dict[str, Any] = {"name": name, "input": redact(input), "output": redact(output),
                                      "metadata": redact(metadata), "level": level}
            if group:
                kwargs["trace_context"] = {"trace_id": self.client.create_trace_id(seed=group)}
            self.client.create_event(**kwargs)
        except Exception as e:  # noqa: BLE001
            log.debug("Gửi sự kiện %s lỗi: %s", name, e)

    def langchain_handler(self, trace_seed: str) -> Any | None:
        """Callback handler cho LangChain/LangGraph; None nếu tắt / lỗi."""
        if not self.client:
            return None
        try:
            from langfuse.langchain import CallbackHandler
            return CallbackHandler(public_key=self.public_key,
                                   trace_context={"trace_id": self.client.create_trace_id(seed=trace_seed)})
        except Exception as e:  # noqa: BLE001
            log.debug("Không tạo được CallbackHandler: %s", e)
            return None

    def attributes(self, *, user_id: str | None, session_id: str | None, trace_name: str,
                   metadata: dict[str, str] | None = None):
        """Context manager gắn user / session / metadata cho mọi span bên trong (no-op nếu tắt)."""
        if not self.client:
            return nullcontext()
        try:
            from langfuse import propagate_attributes
            return propagate_attributes(user_id=user_id, session_id=session_id, trace_name=trace_name,
                                        metadata=metadata)
        except Exception as e:  # noqa: BLE001
            log.debug("propagate_attributes lỗi: %s", e)
            return nullcontext()

    def shutdown(self) -> None:
        if self.client:
            try:
                self.client.flush()
                self.client.shutdown()
            except Exception:  # noqa: BLE001
                pass
