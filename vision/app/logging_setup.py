"""Log ra terminal dễ đọc (giống ai-agent): `10:21:08 INFO  [PERSON]   Có người: 2 ...`."""

import logging
import sys
from datetime import datetime

_COLORS = {"DEBUG": "\033[90m", "INFO": "\033[0m", "WARNING": "\033[33m", "ERROR": "\033[31m",
           "CRITICAL": "\033[1;31m"}
_RESET = "\033[0m"
_SHORT = {"WARNING": "WARN", "CRITICAL": "CRIT"}


class TextFormatter(logging.Formatter):
    def __init__(self, color: bool):
        super().__init__()
        self.color = color

    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created).strftime("%H:%M:%S")
        level = _SHORT.get(record.levelname, record.levelname)
        tag = "SERVER" if record.name.startswith("uvicorn") else record.name.rsplit(".", 1)[-1].upper()
        line = f"{ts} {level:<5} [{tag}]".ljust(26) + " " + record.getMessage()
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return _COLORS.get(record.levelname, "") + line + _RESET if self.color else line


def setup_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(TextFormatter(color=sys.stdout.isatty()))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)   # không log từng request MJPEG
    logging.getLogger("ultralytics").setLevel(logging.WARNING)


def get_logger(tag: str) -> logging.Logger:
    return logging.getLogger(f"vision.{tag.lower()}")
