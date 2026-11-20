"""Tracing bằng Langfuse — TÙY CHỌN, song song với log terminal.

Tắt (LANGFUSE_ENABLED=false) hoặc lỗi kết nối -> mọi hàm thành no-op, KHÔNG làm hỏng luồng chính.
Giai đoạn 3: ghi sự kiện của tầng luật (cảnh báo, lệnh, sự cố), gom theo sự cố (trace id sinh từ incident id).
Giai đoạn 4: thêm callback handler cho LangGraph.
"""

from typing import Any

from app.config import Settings
from app.logging_setup import get_logger
from app.observability.redact import redact

log = get_logger("LANGFUSE")


class Tracer:
    def __init__(self, settings: Settings):
        self.client = None
        self.host = settings.langfuse_host
        if not settings.langfuse_enabled:
            log.info("Tắt (LANGFUSE_ENABLED=false) — chỉ log ra terminal")
            return
        if not settings.langfuse_public_key or not settings.langfuse_secret_key:
            log.warning("LANGFUSE_ENABLED=true nhưng thiếu LANGFUSE_PUBLIC_KEY / SECRET_KEY — tắt Langfuse")
            return
        try:
            from langfuse import Langfuse
            self.client = Langfuse(public_key=settings.langfuse_public_key, secret_key=settings.langfuse_secret_key,
                                   host=settings.langfuse_host)
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

    def shutdown(self) -> None:
        if self.client:
            try:
                self.client.flush()
                self.client.shutdown()
            except Exception:  # noqa: BLE001
                pass
