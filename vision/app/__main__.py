"""python -m app — chạy service vision bằng uvicorn, chỉ nghe 127.0.0.1 (không public — CLAUDE.md mục 3)."""

import socket
import sys

import uvicorn

from app.config import get_settings


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)   # như uvicorn: TIME_WAIT không tính là "đang dùng"
        try:
            s.bind(("127.0.0.1", port))
            return False
        except OSError:
            return True


if __name__ == "__main__":
    port = get_settings().vision_port
    # Kiểm tra TRƯỚC khi mở camera / kết nối MQTT: bản thứ hai không được tranh camera, và khi thoát cũng không
    # được gửi status/camera = offline đè lên bản đang chạy.
    if port_in_use(port):
        sys.exit(f"Cổng {port} đang được dùng — service vision đã chạy rồi? (dừng bản cũ trước, hoặc đổi VISION_PORT)")
    # Luồng MJPEG là kết nối không bao giờ tự kết thúc -> khi tắt chỉ chờ 3s rồi cắt (mặc định uvicorn chờ mãi)
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_config=None, timeout_graceful_shutdown=3)
