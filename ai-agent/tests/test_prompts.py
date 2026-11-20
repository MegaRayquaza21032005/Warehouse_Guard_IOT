"""Prompt: bản gốc trong code, file .md sinh ra phải khớp (người dùng đọc prompt ở cả hai nơi)."""

import json

from app.agents import prompts
from app.agents.llm import format_prompt


def test_markdown_in_sync_with_code():
    for name in prompts.ALL_PROMPTS:
        path = prompts.PROMPTS_DIR / f"{name}.md"
        assert path.exists(), f"Thiếu {path} — chạy: python -m app.agents.prompts"
        assert path.read_text(encoding="utf-8") == prompts.render_markdown(name), (
            f"{path.name} lệch với app/agents/prompts.py — chạy: python -m app.agents.prompts")


def test_prompts_format_without_errors():
    for name, tpl in prompts.ALL_PROMPTS.items():
        out = format_prompt(tpl, now="2026-11-20 10:00", work_hours="08:00–17:30", username="an",
                            thresholds="{}", mode_note="x")
        assert "{now}" not in out and out.strip(), name


def test_chart_example_in_supervisor_prompt_is_valid_json():
    out = format_prompt(prompts.SUPERVISOR_CHAT)
    block = out.split("```chart", 1)[1].split("```", 1)[0]
    block = block.replace("<ISO-8601 +07:00>", "2026-11-20T00:00:00+07:00")
    assert json.loads(block)["chart"] == "line"
