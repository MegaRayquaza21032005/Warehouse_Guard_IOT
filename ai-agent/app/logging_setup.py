"""Log ra terminal — luôn bật, song song với Langfuse (người dùng theo dõi cả hai).

Định dạng mặc định dễ đọc, có màu khi chạy trong terminal:
    10:21:08 WARN  [ALERT]    warning gas — Phát hiện khí/khói ...
LOG_FORMAT=json -> mỗi dòng một JSON (để gom log sau này).
"""

import json
import logging
import sys
from datetime import datetime

_COLORS = {"DEBUG": "\033[90m", "INFO": "\033[0m", "WARNING": "\033[33m", "ERROR": "\033[31m",
           "CRITICAL": "\033[1;31m"}
_RESET = "\033[0m"
_SHORT = {"WARNING": "WARN", "CRITICAL": "CRIT"}


def _tag_for(logger_name: str) -> str:
    # logger "uvicorn.error" của uvicorn thực ra ghi cả log INFO -> đặt nhãn SERVER cho khỏi nhầm
    if logger_name.startswith("uvicorn"):
        return "SERVER"
    return logger_name.rsplit(".", 1)[-1].upper()


class TextFormatter(logging.Formatter):
    def __init__(self, color: bool):
        super().__init__()
        self.color = color

    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created).strftime("%H:%M:%S")
        level = _SHORT.get(record.levelname, record.levelname)
        tag = getattr(record, "tag", None) or _tag_for(record.name)
        line = f"{ts} {level:<5} [{tag}]".ljust(26) + " " + record.getMessage()
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        if self.color:
            line = _COLORS.get(record.levelname, "") + line + _RESET
        return line


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data = {"ts": datetime.fromtimestamp(record.created).isoformat(timespec="milliseconds"),
                "level": record.levelname, "tag": getattr(record, "tag", None) or _tag_for(record.name),
                "msg": record.getMessage()}
        extra = getattr(record, "data", None)
        if extra:
            data["data"] = extra
        if record.exc_info:
            data["exc"] = self.formatException(record.exc_info)
        return json.dumps(data, ensure_ascii=False, default=str)


def setup_logging(level: str = "INFO", fmt: str = "text") -> None:
    handler = logging.StreamHandler(sys.stdout)
    if fmt == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(TextFormatter(color=sys.stdout.isatty()))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # Bớt ồn từ thư viện
    for noisy in ("httpx", "httpx2", "httpcore", "openai", "langfuse", "uvicorn.access", "psycopg.pool"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(tag: str) -> logging.LoggerAdapter:
    """Logger gắn nhãn, vd. get_logger("ALERT").info("...") -> [ALERT] ..."""
    return logging.LoggerAdapter(logging.getLogger(f"agent.{tag.lower()}"), {"tag": tag})
