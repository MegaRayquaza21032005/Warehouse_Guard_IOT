"""Gọi REST Java BE bằng X-Internal-Key (AI Agent không đọc thẳng schema app — CLAUDE.md mục 3)."""

from typing import Any

import httpx

from app.config import Settings
from app.logging_setup import get_logger

log = get_logger("BACKEND")


class BackendClient:
    def __init__(self, settings: Settings):
        self.client = httpx.AsyncClient(base_url=settings.backend_base_url, timeout=5.0,
                                        headers={"X-Internal-Key": settings.internal_api_key})

    async def close(self) -> None:
        await self.client.aclose()

    async def get(self, path: str, **params: Any) -> Any:
        r = await self.client.get(path, params={k: v for k, v in params.items() if v is not None})
        r.raise_for_status()
        return r.json()

    async def unacked_critical_alerts(self) -> list[dict[str, Any]]:
        return await self.get("/api/alerts", level="critical", unacked="true", size=100)

    async def reachable(self) -> bool:
        try:
            r = await self.client.get("/actuator/health")
            return r.status_code == 200
        except httpx.HTTPError:
            return False
