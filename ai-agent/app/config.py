"""Cấu hình ai-agent — đọc từ file .env ở thư mục gốc dự án (CLAUDE.md mục 9)."""

from datetime import time
from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    # --- Dịch vụ ---
    agent_port: int = 8000
    log_level: str = "INFO"
    log_format: str = "text"            # text | json
    timezone: str = "Asia/Ho_Chi_Minh"

    # --- PostgreSQL (tài khoản agent, schema agent) ---
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "warehouse"
    postgres_agent_user: str = "agent"
    postgres_agent_password: str = "agent"

    # --- MQTT (tài khoản agent) ---
    mqtt_host: str = "localhost"
    mqtt_port: int = 1883
    mqtt_agent_user: str = "agent"
    mqtt_agent_password: str = "agent"

    # --- Java BE ---
    backend_port: int = 8080
    backend_url: str = ""               # trống => http://localhost:<BACKEND_PORT>
    internal_api_key: str = ""

    # --- Giờ làm việc ---
    work_hours_start: time = time(8, 0)
    work_hours_end: time = time(17, 30)
    work_days: str = "1,2,3,4,5,6"       # 1 = thứ Hai ... 7 = Chủ nhật

    # --- Tầng luật (CLAUDE.md mục 5.4) ---
    offline_timeout_s: int = 60
    alert_cooldown_min: int = 10
    gas_confirm_s: int = 10
    env_prolonged_min: int = 15
    light_on_after_hours_s: int = 300
    intrusion_clear_min: int = 10
    cmd_ack_timeout_s: int = 10
    escalation_min: int = 5
    llm_alert_timeout_s: int = 15

    # --- OpenAI (giai đoạn 4) ---
    openai_api_key: str = ""
    openai_model: str = "gpt-5.4-mini"            # Supervisor
    openai_model_worker: str = ""                 # trống = dùng openai_model
    openai_reasoning_effort: str = "none"         # none = nhanh, dùng được tool qua chat completions
    openai_stt_model: str = "gpt-4o-mini-transcribe"
    openai_tts_model: str = "gpt-4o-mini-tts"
    openai_tts_voice: str = "coral"
    openai_timeout_s: int = 30

    # --- Multi-agent / chatbot (CLAUDE.md mục 6, 8) ---
    incident_llm_enabled: bool = True             # luồng sự cố dùng LLM (tắt -> chỉ tầng luật)
    agent_max_steps: int = 6                      # số lượt Supervisor tối đa / yêu cầu
    worker_max_steps: int = 5                     # số vòng tool tối đa / worker
    worker_timeout_s: int = 45
    chat_timeout_s: int = 120
    chat_history_max_messages: int = 30           # vượt -> tóm tắt phần cũ
    chat_max_per_hour: int = 60                   # mỗi người dùng
    confirm_ttl_s: int = 300                      # đề xuất quá hạn -> coi như hủy

    # --- Langfuse ---
    langfuse_enabled: bool = False
    langfuse_host: str = Field("https://cloud.langfuse.com",
                               validation_alias=AliasChoices("LANGFUSE_HOST", "LANGFUSE_BASE_URL", "langfuse_host"))
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""

    @field_validator("work_hours_start", "work_hours_end", mode="before")
    @classmethod
    def _parse_time(cls, v):
        return time.fromisoformat(v) if isinstance(v, str) else v

    @property
    def work_day_set(self) -> set[int]:
        return {int(d) for d in self.work_days.split(",") if d.strip()}

    @field_validator("openai_model", "openai_stt_model", "openai_tts_model", "openai_tts_voice",
                     "openai_reasoning_effort", mode="before")
    @classmethod
    def _empty_to_default(cls, v, info):
        # .env để trống (OPENAI_MODEL=) -> dùng mặc định trong code
        return cls.model_fields[info.field_name].default if v in ("", None) else v

    @property
    def worker_model(self) -> str:
        return self.openai_model_worker or self.openai_model

    @property
    def llm_enabled(self) -> bool:
        return bool(self.openai_api_key)

    @property
    def backend_base_url(self) -> str:
        return self.backend_url or f"http://localhost:{self.backend_port}"

    @property
    def postgres_conninfo(self) -> str:
        return (f"host={self.postgres_host} port={self.postgres_port} dbname={self.postgres_db} "
                f"user={self.postgres_agent_user} password={self.postgres_agent_password}")


@lru_cache
def get_settings() -> Settings:
    return Settings()
