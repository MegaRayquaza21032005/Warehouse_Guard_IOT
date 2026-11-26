"""Cấu hình service vision — đọc từ file .env ở thư mục gốc dự án (CLAUDE.md mục 9)."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parents[2]
VISION_DIR = ROOT_DIR / "vision"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    # --- Dịch vụ (chỉ nghe 127.0.0.1 — client xem hình qua Java BE) ---
    vision_port: int = 8100
    log_level: str = "INFO"
    internal_api_key: str = ""

    # --- Camera ---
    vision_camera: str = "0"                 # số = /dev/videoN; hoặc URL (rtsp://..., http://...)
    vision_camera_width: int = 640
    vision_camera_height: int = 480

    # --- Phát hiện người (YOLO, COCO class 0 = person) ---
    vision_person_model: str = "yolo26n.pt"  # tên model Ultralytics (tự tải vào vision/models) hoặc đường dẫn .pt
    vision_device: str = "auto"              # auto | cuda:0 | cpu
    vision_imgsz: int = 640
    vision_conf: float = 0.5                 # ngưỡng tin cậy của từng khung bao
    vision_infer_fps: float = 10.0           # số khung phân tích / giây (giới hạn tải GPU)
    vision_confirm_frames: int = 3           # thấy người N khung liên tiếp mới tính là "có người"
    vision_clear_s: float = 3.0              # không thấy người liên tục N giây -> "không còn người"
    vision_publish_s: float = 5.0            # gửi warehouse/sensor/camera định kỳ (ngoài lúc đổi trạng thái)
    vision_jpeg_quality: int = 75

    # --- Phát hiện lửa / khói (model fine-tune riêng, class fire + smoke) ---
    vision_fire_model: str = "yolo26s_fasddcv.pt"   # file trong vision/models hoặc đường dẫn .pt; trống = tắt
    vision_fire_conf: float = 0.45           # ngưỡng tin cậy khung bao "fire"
    vision_smoke_conf: float = 0.45          # ngưỡng tin cậy khung bao "smoke"
    vision_fire_confirm_frames: int = 5      # thấy lửa / khói N khung liên tiếp mới tính (chống báo giả)
    vision_fire_clear_s: float = 10.0        # không thấy liên tục N giây -> hết lửa / khói

    # --- MQTT (tài khoản vision) ---
    mqtt_host: str = "localhost"
    mqtt_port: int = 1883
    mqtt_vision_user: str = "vision"
    mqtt_vision_password: str = "vision"

    @property
    def camera_source(self) -> int | str:
        return int(self.vision_camera) if self.vision_camera.strip().isdigit() else self.vision_camera.strip()

    @property
    def model_path(self) -> Path:
        return _in_models(self.vision_person_model)

    @property
    def fire_model_path(self) -> Path | None:
        return _in_models(self.vision_fire_model) if self.vision_fire_model.strip() else None


def _in_models(name: str) -> Path:
    p = Path(name.strip())
    return p if p.is_absolute() or p.parent != Path(".") else VISION_DIR / "models" / p.name


@lru_cache
def get_settings() -> Settings:
    return Settings()
