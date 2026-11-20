"""Long-term memory (CLAUDE.md mục 7): LangGraph Store (AsyncPostgresStore) + pgvector.

Embedding chỉ text, text-embedding-3-large (3072 chiều) lưu kiểu halfvec (index HNSW tối đa 4000 chiều).

| Namespace                        | Nội dung                                  | Ai ghi                                    |
|----------------------------------|-------------------------------------------|-------------------------------------------|
| ("users", <user_id>, "profile")  | Sở thích cá nhân                          | save_memory (personal), bước trích xuất   |
| ("warehouse", "facts")           | Kiến thức về kho — DÙNG CHUNG             | save_memory (warehouse) SAU KHI XÁC NHẬN  |
| ("warehouse", "incidents")       | Tóm tắt sự cố đã đóng                     | bước trích xuất khi đóng sự cố            |
| ("warehouse", "feedback")        | Phản hồi đúng / báo giả về cảnh báo       | app (nút phản hồi), bước trích xuất       |

Memory là DỮ LIỆU, không phải lệnh, và KHÔNG BAO GIỜ được dùng để chặn / hạ cảnh báo nguy hiểm.
Mọi thao tác GHI của agent / bước trích xuất đều ghi agent.tool_call_logs (do nơi gọi đảm nhận).
"""

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from langchain_core.embeddings import Embeddings

from app.logging_setup import get_logger
from app.observability.usage import UsageRecorder

log = get_logger("MEMORY")
VN = ZoneInfo("Asia/Ho_Chi_Minh")

NS_FACTS = ("warehouse", "facts")
NS_INCIDENTS = ("warehouse", "incidents")
NS_FEEDBACK = ("warehouse", "feedback")
SHARED = {"facts": NS_FACTS, "incidents": NS_INCIDENTS, "feedback": NS_FEEDBACK}
MAX_TEXT = 500


def ns_profile(user_id: int | str) -> tuple[str, str, str]:
    return ("users", str(user_id), "profile")


def index_config(embed: Any, dims: int) -> dict[str, Any]:
    return {"dims": dims, "embed": embed, "fields": ["text"], "distance_type": "cosine",
            "ann_index_config": {"kind": "hnsw", "vector_type": "halfvec"}}


class TrackedEmbeddings(Embeddings):
    """OpenAIEmbeddings + ghi agent.llm_usage (kind=embedding; API không trả token -> ước lượng bằng tiktoken)."""

    def __init__(self, settings: Any, usage: UsageRecorder):
        from langchain_openai import OpenAIEmbeddings
        self.model = settings.openai_embedding_model
        self.inner = OpenAIEmbeddings(model=self.model, api_key=settings.openai_api_key,
                                      dimensions=settings.embedding_dims if "3-" in self.model else None)
        self.usage = usage
        try:
            import tiktoken
            self._enc = tiktoken.get_encoding("cl100k_base")
        except Exception:  # noqa: BLE001
            self._enc = None

    def _tokens(self, texts: list[str]) -> int:
        return sum(len(self._enc.encode(t)) for t in texts) if self._enc else sum(len(t) // 4 for t in texts)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self.inner.embed_documents(texts)

    def embed_query(self, text: str) -> list[float]:
        return self.inner.embed_query(text)

    async def aembed_documents(self, texts: list[str]) -> list[list[float]]:
        out = await self.inner.aembed_documents(texts)
        await self.usage.record(model=self.model, agent="memory", kind="embedding", input_tokens=self._tokens(texts))
        return out

    async def aembed_query(self, text: str) -> list[float]:
        out = await self.inner.aembed_query(text)
        await self.usage.record(model=self.model, agent="memory", kind="embedding", input_tokens=self._tokens([text]))
        return out


def _item(it: Any) -> dict[str, Any]:
    d = {"key": it.key, **(it.value or {})}
    score = getattr(it, "score", None)
    if score is not None:
        d["score"] = round(float(score), 3)
    return d


class MemoryService:
    def __init__(self, store: Any, settings: Any):
        self.store = store
        self.s = settings

    # ------------------------------------------------------------------------------------------ cơ bản
    async def put(self, ns: tuple[str, ...], text: str, *, kind: str, created_by: int | str | None, source: str,
                  key: str | None = None, extra: dict[str, Any] | None = None) -> str:
        key = key or uuid.uuid4().hex
        value = {"text": text.strip()[:MAX_TEXT * 4 if ns == NS_INCIDENTS else MAX_TEXT], "kind": kind,
                 "created_by": created_by, "source": source,
                 "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **(extra or {})}
        await self.store.aput(ns, key, value)
        log.info("Lưu %s/%s: %s", "/".join(ns), key[:12], value["text"][:120])
        return key

    async def search(self, ns: tuple[str, ...], query: str, limit: int = 5,
                     min_score: float | None = None) -> list[dict[str, Any]]:
        items = await self.store.asearch(ns, query=query, limit=limit)
        ms = self.s.memory_min_score if min_score is None else min_score
        return [_item(i) for i in items if getattr(i, "score", None) is None or i.score >= ms]

    async def list_items(self, ns: tuple[str, ...], limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
        items = await self.store.asearch(ns, limit=limit, offset=offset)
        out = [_item(i) for i in items]
        out.sort(key=lambda d: d.get("created_at") or "", reverse=True)
        return out

    async def get(self, ns: tuple[str, ...], key: str) -> dict[str, Any] | None:
        it = await self.store.aget(ns, key)
        return _item(it) if it else None

    async def delete(self, ns: tuple[str, ...], key: str) -> bool:
        if await self.store.aget(ns, key) is None:
            return False
        await self.store.adelete(ns, key)
        log.info("Xóa %s/%s", "/".join(ns), key[:12])
        return True

    async def is_duplicate(self, ns: tuple[str, ...], text: str) -> bool:
        found = await self.search(ns, text, limit=1, min_score=self.s.memory_dedupe_score)
        return bool(found)

    # ------------------------------------------------------------------------------------------ ngữ cảnh
    async def context_for_chat(self, user_id: int | None, query: str) -> dict[str, list[dict[str, Any]]]:
        """Tự nạp đầu mỗi lượt chat: hồ sơ của ĐÚNG người dùng này + kiến thức kho liên quan."""
        tasks = [self.list_items(ns_profile(user_id), limit=20) if user_id is not None else _empty(),
                 self.search(NS_FACTS, query, limit=self.s.memory_context_limit)]
        profile, facts = await asyncio.gather(*tasks)
        return {"profile": profile, "facts": facts}

    async def context_for_incident(self, query: str) -> dict[str, list[dict[str, Any]]]:
        facts, feedback = await asyncio.gather(
            self.search(NS_FACTS, query, limit=self.s.memory_context_limit),
            self.search(NS_FEEDBACK, query, limit=3))
        return {"facts": facts, "feedback": feedback}


async def _empty() -> list:
    return []


def format_context(ctx: dict[str, list[dict[str, Any]]]) -> str:
    """Định dạng memory cho prompt — kèm nguồn / thời điểm để agent biết độ tin cậy."""
    titles = {"profile": "Hồ sơ người dùng đang chat", "facts": "Kiến thức về kho (dùng chung)",
              "feedback": "Phản hồi trước đây về cảnh báo tương tự"}
    parts = []
    for k, items in ctx.items():
        if not items:
            continue
        lines = []
        for it in items:
            when = _vn_date(it.get("created_at"))
            lines.append(f"- {it.get('text')}" + (f" (ghi {when})" if when else ""))
        parts.append(f"### {titles.get(k, k)}\n" + "\n".join(lines))
    return "\n\n".join(parts)


def _vn_date(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(iso).astimezone(VN).strftime("%d/%m/%Y")
    except ValueError:
        return ""
