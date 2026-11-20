from app.agents.charts import parse_blocks


def test_parse_text_and_chart_blocks():
    text = ('Nhiệt độ ổn định.\n\n```chart\n{"chart":"line","title":"Nhiệt độ","query":{"metric":"temp",'
            '"from":"2026-11-19T00:00:00+07:00","to":"2026-11-20T00:00:00+07:00","interval":"1h","agg":"avg,max"}}\n'
            '```\n\nKhông vượt ngưỡng.')
    blocks, speech = parse_blocks(text)
    assert [b["type"] for b in blocks] == ["text", "chart", "text"]
    assert blocks[1]["query"]["agg"] == ["avg", "max"]
    assert "chart" not in speech and "Không vượt ngưỡng" in speech


def test_invalid_chart_dropped():
    blocks, _ = parse_blocks('A\n```chart\n{"chart":"pie","query":{"metric":"temp"}}\n```\nB')
    assert [b["type"] for b in blocks] == ["text", "text"]
    blocks, _ = parse_blocks('```chart\nnot json\n```')
    assert blocks == []
    blocks, _ = parse_blocks('```chart\n{"chart":"timeline","query":{"metric":"device_state","from":"a","to":"b"}}\n```')
    assert blocks == []      # timeline thiết bị cần device


def test_plain_text_only():
    blocks, speech = parse_blocks("Xin chào")
    assert blocks == [{"type": "text", "text": "Xin chào"}] and speech == "Xin chào"
