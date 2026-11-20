"""python -m app — chạy ai-agent bằng uvicorn, chỉ nghe 127.0.0.1 (không public — CLAUDE.md mục 3)."""

import uvicorn

from app.config import get_settings

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=get_settings().agent_port, log_config=None)
