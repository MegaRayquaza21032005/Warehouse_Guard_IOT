"""Tạo model OpenAI + gọi LLM có ghi token vào agent.llm_usage (CLAUDE.md mục 8)."""

import asyncio
from typing import Any, Protocol, Sequence

from langchain_core.messages import AIMessage, BaseMessage

from app.config import Settings
from app.observability.usage import UsageRecorder


class ChatModel(Protocol):
    """Tối thiểu cần có (ChatOpenAI, hoặc model giả trong test)."""
    def bind_tools(self, tools: Sequence[Any], **kw: Any) -> Any: ...
    async def ainvoke(self, input: Any, config: Any = None, **kw: Any) -> Any: ...


def make_chat_model(settings: Settings, model: str) -> ChatModel:
    from langchain_openai import ChatOpenAI

    effort = settings.openai_reasoning_effort
    kwargs: dict[str, Any] = dict(model=model, api_key=settings.openai_api_key, timeout=settings.openai_timeout_s,
                                  max_retries=1, stream_usage=True, reasoning_effort=effort)
    # effort khác "none" + tool -> phải dùng Responses API (chat completions không hỗ trợ)
    if effort and effort != "none":
        kwargs["use_responses_api"] = True
    return ChatOpenAI(**kwargs)


def format_prompt(template: str, **values: Any) -> str:
    """str.format nhưng thiếu biến thì để trống (mỗi prompt dùng một phần biến)."""
    class _Safe(dict):
        def __missing__(self, key: str) -> str:
            return ""
    return template.format_map(_Safe(values))


class LLMCaller:
    """Gọi LLM + ghi token. Ghi usage chạy nền, lỗi ghi không ảnh hưởng câu trả lời."""

    def __init__(self, usage: UsageRecorder):
        self.usage = usage
        self._bg: set[asyncio.Task] = set()

    async def call(self, llm: Any, messages: list[BaseMessage], *, agent: str, trace_id: str | None,
                   model_name: str, tools: Sequence[Any] | None = None, tags: list[str] | None = None) -> AIMessage:
        runnable = llm.bind_tools(tools) if tools else llm
        config = {"tags": tags or [agent], "metadata": {"agent": agent}}
        msg: AIMessage = await runnable.ainvoke(messages, config=config)
        u = getattr(msg, "usage_metadata", None) or {}
        if u:
            t = asyncio.create_task(self.usage.record(model=model_name, agent=agent, trace_id=trace_id, kind="chat",
                                                      input_tokens=u.get("input_tokens"),
                                                      output_tokens=u.get("output_tokens")))
            self._bg.add(t)
            t.add_done_callback(self._bg.discard)
        return msg
