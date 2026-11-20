"""MemoryService + InMemoryStore (embedding giả) — logic tìm / lưu / ngữ cảnh, không cần DB."""

import pytest
from langgraph.store.memory import InMemoryStore

from app.config import Settings
from app.memory.store import NS_FACTS, NS_FEEDBACK, MemoryService, format_context, ns_profile
from tests.fakes import make_fake_embed


@pytest.fixture
def mem() -> MemoryService:
    store = InMemoryStore(index={"dims": 256, "embed": make_fake_embed(256), "fields": ["text"]})
    return MemoryService(store, Settings(_env_file=None, memory_min_score=0.1))


async def test_put_search_dedupe_delete(mem):
    await mem.put(NS_FACTS, "Chiều thứ 6 kho hay hàn kim loại", kind="fact", created_by=1, source="chat")
    await mem.put(NS_FACTS, "Kho chứa giấy và bìa carton", kind="fact", created_by=2, source="chat")
    found = await mem.search(NS_FACTS, "khói chiều thứ 6 có thể do hàn kim loại")
    assert found[0]["text"].startswith("Chiều thứ 6") and found[0]["created_by"] == 1
    assert await mem.is_duplicate(NS_FACTS, "Chiều thứ 6 kho hay hàn kim loại")
    assert not await mem.is_duplicate(NS_FACTS, "Nhân viên nghỉ trưa từ 12 giờ")
    key = found[0]["key"]
    assert await mem.delete(NS_FACTS, key) and not await mem.delete(NS_FACTS, key)
    assert len(await mem.list_items(NS_FACTS)) == 1


async def test_profile_is_per_user(mem):
    await mem.put(ns_profile(1), "Thích trả lời ngắn", kind="preference", created_by=1, source="chat")
    await mem.put(ns_profile(2), "Muốn được gọi là chị Lan", kind="preference", created_by=2, source="chat")
    ctx = await mem.context_for_chat(1, "kho thế nào")
    assert [p["text"] for p in ctx["profile"]] == ["Thích trả lời ngắn"]       # không lẫn của user 2


async def test_incident_context_and_format(mem):
    await mem.put(NS_FACTS, "Chiều thứ 6 kho hay hàn kim loại", kind="fact", created_by=1, source="chat")
    await mem.put(NS_FEEDBACK, "Cảnh báo gas chiều thứ 6 là báo giả do hàn", kind="feedback", created_by=1,
                  source="app")
    ctx = await mem.context_for_incident("gas: Phát hiện khí / khói. Lúc chiều Thứ Sáu hàn")
    text = format_context(ctx)
    assert "hàn kim loại" in text and "báo giả" in text and "### Kiến thức về kho" in text
    assert format_context({"facts": [], "feedback": []}) == ""
