"""Cấu hình ai-agent — đọc từ file .env ở thư mục gốc dự án (CLAUDE.md mục 9)."""

from datetime import time
from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
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

    # --- Langfuse ---
    langfuse_enabled: bool = False
    langfuse_host: str = "https://cloud.langfuse.com"
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""

    @field_validator("work_hours_start", "work_hours_end", mode="before")
    @classmethod
    def _parse_time(cls, v):
        return time.fromisoformat(v) if isinstance(v, str) else v

    @property
    def work_day_set(self) -> set[int]:
        return {int(d) for d in self.work_days.split(",") if d.strip()}

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
