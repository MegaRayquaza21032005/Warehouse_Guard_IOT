"""Vòng xử lý: khung mới nhất của camera -> YOLO người (+ YOLO lửa / khói nếu có model) -> xác nhận
(nhiều khung liên tiếp) -> ảnh có khung (MJPEG) + MQTT.

Chạy luôn (kể cả khi không ai xem) vì kết quả là đầu vào của tầng luật và của ESP32 (lửa -> trạng thái `fire`).
Tải GPU được giới hạn bằng VISION_INFER_FPS (mặc định 10 khung/giây).
"""

import threading
import time
from typing import Any, Callable, Protocol

import cv2
import numpy as np

from app.detector import Detection, annotate, encode_jpeg
from app.logging_setup import get_logger
from app.presence import PresenceTracker

log = get_logger("PERSON")
log_fire = get_logger("FIRE")
TOPIC_CAMERA = "warehouse/sensor/camera"
COUNT_PUBLISH_MIN_S = 1.0          # số người đổi (khi đang có người) -> gửi tối đa 1 lần / giây


class FrameSource(Protocol):
    error: str | None

    def latest(self) -> tuple[int, np.ndarray | None]: ...


class Detector(Protocol):
    def detect(self, frame: np.ndarray) -> list[Detection]: ...


Publisher = Callable[[str, dict[str, Any]], Any]


class VisionPipeline:
    def __init__(self, camera: FrameSource, detector: Detector, tracker: PresenceTracker, publish: Publisher,
                 infer_fps: float = 10.0, publish_s: float = 5.0, jpeg_quality: int = 75,
                 fire_detector: Detector | None = None, fire_tracker: PresenceTracker | None = None,
                 smoke_tracker: PresenceTracker | None = None):
        self.camera = camera
        self.detector = detector
        self.tracker = tracker
        # Lửa / khói: không có model -> không gửi các trường fire / smoke (bên nhận coi là "không biết")
        self.fire_detector = fire_detector
        self.fire_tracker = fire_tracker or PresenceTracker(5, 10.0)
        self.smoke_tracker = smoke_tracker or PresenceTracker(5, 10.0)
        self.publish = publish
        self.interval = 1.0 / max(0.5, infer_fps)
        self.publish_s = publish_s
        self.jpeg_quality = jpeg_quality

        self._lock = threading.Lock()
        self._jpeg: bytes | None = None
        self._seq = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

        self.error: str | None = None
        self.fps: float | None = None
        self.infer_ms: float | None = None
        self.frames = 0
        self.last_dets: list[Detection] = []
        self._last_cam_seq = -1
        self._last_infer_at: float | None = None
        self._last_pub_at: float | None = None
        self._last_pub: dict[str, Any] | None = None

    # ------------------------------------------------------------------ vòng đời
    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="vision", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)

    def latest_jpeg(self) -> tuple[int, bytes | None]:
        with self._lock:
            return self._seq, self._jpeg

    def status(self) -> dict[str, Any]:
        st = self.tracker.state
        out = {"person": st.present, "personCount": st.count, "personConf": _r(st.conf),
               "detections": len(self.last_dets), "fps": _r(self.fps, 1), "inferMs": _r(self.infer_ms, 1),
               "frames": self.frames, "error": self.error, "fireEnabled": self.fire_detector is not None}
        if self.fire_detector is not None:
            f, k = self.fire_tracker.state, self.smoke_tracker.state
            out.update(fire=f.present, fireConf=_r(f.conf), smoke=k.present, smokeConf=_r(k.conf))
        return out

    # ------------------------------------------------------------------ xử lý
    def _loop(self) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self.step(time.time())
            except Exception:  # noqa: BLE001 — một khung lỗi không được làm dừng service
                log.exception("Lỗi xử lý khung hình")
            self._stop.wait(max(0.005, self.interval - (time.monotonic() - started)))

    def step(self, now: float) -> None:
        """Xử lý 1 nhịp (tách riêng để test không cần luồng / camera thật)."""
        seq, frame = self.camera.latest()
        if frame is None:
            if self.camera.error:                 # None = camera đang mở lần đầu, chưa phải lỗi
                self._on_error(self.camera.error, now)
            return
        if seq == self._last_cam_seq:
            return
        self._last_cam_seq = seq

        t0 = time.perf_counter()
        try:
            dets = self.detector.detect(frame)
            if self.fire_detector is not None:
                dets = dets + self.fire_detector.detect(frame)
        except Exception:  # noqa: BLE001
            log.exception("YOLO lỗi")
            self._on_error("detector_failed", now)
            return
        self.infer_ms = (time.perf_counter() - t0) * 1000
        if self.error is not None:
            log.info("Camera / YOLO hoạt động lại")
            self.error = None
        self.frames += 1
        if self._last_infer_at is not None:
            inst = 1.0 / max(1e-3, now - self._last_infer_at)
            self.fps = inst if self.fps is None else 0.8 * self.fps + 0.2 * inst
        self._last_infer_at = now
        self.last_dets = dets

        people = [d for d in dets if d.label == "person"]
        changed = self.tracker.update(len(people), max((d.conf for d in people), default=None), now)
        st = self.tracker.state
        if changed:
            if st.present:
                log.info("CÓ NGƯỜI: %d (độ tin cậy %.2f)", st.count, st.conf or 0)
            else:
                log.info("Không còn người trong khung hình")
        if self.fire_detector is not None:
            changed |= self._update_fire(dets, "fire", self.fire_tracker, now)
            changed |= self._update_fire(dets, "smoke", self.smoke_tracker, now)

        img = annotate(frame, dets, st.present, self.fps, self.infer_ms,
                       fire=self.fire_tracker.state.present and self.fire_detector is not None,
                       smoke=self.smoke_tracker.state.present and self.fire_detector is not None)
        self._set_jpeg(encode_jpeg(img, self.jpeg_quality))
        self._maybe_publish(now, force=changed)

    @staticmethod
    def _update_fire(dets: list[Detection], label: str, tracker: PresenceTracker, now: float) -> bool:
        found = [d for d in dets if d.label == label]
        changed = tracker.update(len(found), max((d.conf for d in found), default=None), now)
        if changed:
            name = "LỬA" if label == "fire" else "KHÓI"
            if tracker.state.present:
                log_fire.warning("CAMERA THẤY %s (độ tin cậy %.2f)", name, tracker.state.conf or 0)
            else:
                log_fire.info("Hết %s trong khung hình", name.lower())
        return changed

    def _on_error(self, error: str, now: float) -> None:
        if self.error != error:
            log.warning("Không có hình (%s) — chưa phát hiện được người%s", error,
                        " / lửa / khói" if self.fire_detector is not None else "")
            self.error = error
            self.tracker.reset()
            self.fire_tracker.reset()
            self.smoke_tracker.reset()
            self._set_jpeg(encode_jpeg(_placeholder(error), self.jpeg_quality))
            self._maybe_publish(now, force=True)
        else:
            self._maybe_publish(now, force=False)

    def _set_jpeg(self, data: bytes) -> None:
        with self._lock:
            self._jpeg = data
            self._seq += 1

    def payload(self) -> dict[str, Any]:
        if self.error:
            return {"error": self.error}
        st = self.tracker.state
        p: dict[str, Any] = {"person": st.present, "personCount": st.count if st.present else 0,
                             "personConf": _r(st.conf) if st.present else None}
        if self.fire_detector is not None:
            f, k = self.fire_tracker.state, self.smoke_tracker.state
            p.update(fire=f.present, fireConf=_r(f.conf) if f.present else None,
                     smoke=k.present, smokeConf=_r(k.conf) if k.present else None)
        p["fps"] = _r(self.fps, 1)
        return p

    def _maybe_publish(self, now: float, force: bool) -> None:
        p = self.payload()
        since = None if self._last_pub_at is None else now - self._last_pub_at
        count_changed = (self._last_pub is not None and p.get("person")
                         and p.get("personCount") != self._last_pub.get("personCount"))
        if not (force or since is None or since >= self.publish_s
                or (count_changed and since >= COUNT_PUBLISH_MIN_S)):
            return
        self._last_pub_at, self._last_pub = now, p
        try:
            self.publish(TOPIC_CAMERA, p)
        except Exception:  # noqa: BLE001
            log.exception("Không gửi được %s", TOPIC_CAMERA)


def _placeholder(error: str) -> np.ndarray:
    img = np.zeros((360, 640, 3), dtype=np.uint8)
    cv2.putText(img, "NO SIGNAL", (200, 170), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (200, 200, 200), 2, cv2.LINE_AA)
    cv2.putText(img, error, (200, 210), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (120, 120, 255), 1, cv2.LINE_AA)
    cv2.putText(img, time.strftime("%H:%M:%S"), (8, 350), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (150, 150, 150), 1)
    return img


def _r(v: float | None, n: int = 2) -> float | None:
    return None if v is None else round(v, n)
