"""STT / TTS phía server — DỰ PHÒNG khi thiết bị không nhận dạng / đọc được tiếng Việt (CLAUDE.md mục 6).

- Không lưu file âm thanh (chỉ xử lý trong RAM).
- Mỗi lần gọi ghi vào agent.llm_usage (kind = stt | tts) để theo dõi chi phí.
"""

import re
import time
from typing import Any

from app.agents.charts import CHART_RE
from app.logging_setup import get_logger
from app.observability.usage import UsageRecorder

log = get_logger("VOICE")
MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_TTS_CHARS = 2000


class VoiceService:
    def __init__(self, settings: Any, usage: UsageRecorder):
        self.s = settings
        self.usage = usage
        self._client = None

    @property
    def client(self):
        if self._client is None:
            from openai import AsyncOpenAI
            self._client = AsyncOpenAI(api_key=self.s.openai_api_key, timeout=self.s.openai_timeout_s)
        return self._client

    async def stt(self, audio: bytes, filename: str, content_type: str, user_id: int | None,
                  language: str = "vi") -> str:
        t = time.monotonic()
        r = await self.client.audio.transcriptions.create(model=self.s.openai_stt_model,
                                                          file=(filename or "audio.webm", audio, content_type),
                                                          language=language)
        u = getattr(r, "usage", None)
        await self.usage.record(model=self.s.openai_stt_model, agent="voice", kind="stt",
                                input_tokens=getattr(u, "input_tokens", None),
                                output_tokens=getattr(u, "output_tokens", None),
                                audio_seconds=getattr(u, "seconds", None))
        log.info("STT user=%s %d KB -> %d ký tự (%.1fs)", user_id, len(audio) // 1024, len(r.text),
                 time.monotonic() - t)
        return r.text

    async def tts(self, text: str, user_id: int | None) -> bytes:
        text = CHART_RE.sub("", text)                      # không đọc khối biểu đồ
        text = re.sub(r"[*_`#>|]+", " ", text).strip()[:MAX_TTS_CHARS]
        t = time.monotonic()
        r = await self.client.audio.speech.create(model=self.s.openai_tts_model, voice=self.s.openai_tts_voice,
                                                  input=text, response_format="mp3",
                                                  instructions="Đọc bằng tiếng Việt, giọng tự nhiên, rõ ràng.")
        audio = r.content
        await self.usage.record(model=self.s.openai_tts_model, agent="voice", kind="tts",
                                input_tokens=len(text))   # TTS không trả token -> ghi số ký tự
        log.info("TTS user=%s %d ký tự -> %d KB (%.1fs)", user_id, len(text), len(audio) // 1024,
                 time.monotonic() - t)
        return audio
