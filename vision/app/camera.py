"""Đọc camera trong luồng riêng, luôn giữ khung MỚI NHẤT (bỏ khung cũ — không để trễ dồn lại).

Camera lỗi / bị rút / bị ứng dụng khác chiếm -> tự mở lại (chờ tăng dần tới 10s), `error` = "camera_unavailable".

Nguồn là FILE VIDEO (VISION_CAMERA=/đường/dẫn/video.mp4 — demo / thử phát hiện lửa mà không cần đốt lửa thật):
phát đúng tốc độ của video và tự lặp lại từ đầu khi hết.
"""

import os
import threading
import time
from typing import Any

import cv2
import numpy as np

from app.logging_setup import get_logger

log = get_logger("CAMERA")


class Camera:
    def __init__(self, source: int | str, width: int, height: int):
        self.source = source
        self.width = width
        self.height = height
        self._frame: np.ndarray | None = None
        self._seq = 0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.error: str | None = None
        self.opened = False
        self.actual_size: tuple[int, int] | None = None
        self.is_file = isinstance(source, str) and os.path.isfile(source)

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="camera", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)

    def latest(self) -> tuple[int, np.ndarray | None]:
        with self._lock:
            return self._seq, self._frame

    def info(self) -> dict[str, Any]:
        return {"source": str(self.source), "opened": self.opened, "error": self.error,
                "width": self.actual_size[0] if self.actual_size else None,
                "height": self.actual_size[1] if self.actual_size else None}

    # ------------------------------------------------------------------ luồng đọc
    def _open(self) -> cv2.VideoCapture | None:
        backend = cv2.CAP_V4L2 if isinstance(self.source, int) else cv2.CAP_ANY
        cap = cv2.VideoCapture(self.source, backend)
        if not cap.isOpened():
            cap.release()
            return None
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    def _loop(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            cap = self._open()
            if cap is None:
                self._fail(f"Không mở được camera {self.source} — thử lại sau {backoff:.0f}s")
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 10.0)
                continue
            fails = 0
            gap = 1.0 / (cap.get(cv2.CAP_PROP_FPS) or 25.0) if self.is_file else 0.0
            next_at = time.monotonic()
            while not self._stop.is_set():
                if self.is_file:            # file: phát theo tốc độ video (đọc liền thì hết file trong 1 giây)
                    next_at += gap
                    self._stop.wait(max(0.0, next_at - time.monotonic()))
                ok, frame = cap.read()
                if (not ok or frame is None) and self.is_file and self.opened:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)          # hết video -> lặp lại
                    ok, frame = cap.read()
                if not ok or frame is None:
                    fails += 1
                    if fails >= 20:          # ~ vài giây không đọc được -> mở lại
                        break
                    time.sleep(0.05)
                    continue
                if not self.opened:
                    self.opened, self.error, backoff = True, None, 1.0
                    self.actual_size = (frame.shape[1], frame.shape[0])
                    log.info("Đã mở camera %s (%dx%d)", self.source, frame.shape[1], frame.shape[0])
                fails = 0
                with self._lock:
                    self._frame = frame
                    self._seq += 1
            cap.release()
            if not self._stop.is_set():
                self._fail(f"Mất tín hiệu camera {self.source} — đang mở lại")

    def _fail(self, msg: str) -> None:
        if self.opened or self.error is None:
            log.warning(msg)
        self.opened, self.error = False, "camera_unavailable"
        with self._lock:
            self._frame = None
