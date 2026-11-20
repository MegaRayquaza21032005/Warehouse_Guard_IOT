"""API của ai-agent chỉ dành cho Java BE: xác thực bằng header X-Internal-Key (INTERNAL_API_KEY)."""

import hmac

from fastapi import Header, HTTPException, status

from app.config import get_settings


async def require_internal_key(x_internal_key: str | None = Header(default=None)) -> None:
    expected = get_settings().internal_api_key
    if not expected or not x_internal_key or not hmac.compare_digest(expected, x_internal_key):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            detail={"error": "invalid_internal_key", "message": "Sai hoặc thiếu X-Internal-Key"})
