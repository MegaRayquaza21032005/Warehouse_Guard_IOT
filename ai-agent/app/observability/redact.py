"""Che thông tin bí mật trước khi ghi log / gửi Langfuse (CLAUDE.md mục 8)."""

import re
from typing import Any

SECRET_KEYS = re.compile(r"(pass(word)?|secret|token|api[_-]?key|authorization|jwt|credential)", re.I)
SECRET_VALUES = [
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),                                     # OpenAI key
    re.compile(r"(pk|sk)-lf-[A-Za-z0-9\-]{8,}"),                                # Langfuse key
    re.compile(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),  # JWT
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{8,}"),
]
MASK = "***"


def redact(value: Any, _depth: int = 0) -> Any:
    if _depth > 10:
        return MASK
    if isinstance(value, dict):
        return {k: (MASK if isinstance(k, str) and SECRET_KEYS.search(k) else redact(v, _depth + 1))
                for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v, _depth + 1) for v in value]
    if isinstance(value, str):
        for pat in SECRET_VALUES:
            value = pat.sub(MASK, value)
        return value
    return value
