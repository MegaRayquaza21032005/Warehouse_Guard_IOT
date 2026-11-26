"""Service vision: camera -> YOLO phát hiện người + lửa / khói -> MQTT + HTTP nội bộ (chỉ Java BE gọi, header X-Internal-Key).

HTTP (127.0.0.1:VISION_PORT, không public — client xem qua Java BE /api/camera/*):
  GET /health        — sống / chết (không cần khóa)
  GET /status        — camera, model, kết quả phát hiện, MQTT
  GET /snapshot.jpg  — ảnh mới nhất (có khung YOLO)
  GET /stream.mjpg   — MJPEG (multipart/x-mixed-replace) ảnh có khung YOLO
"""

import asyncio
import hmac
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Callable

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse

from app.config import Settings, get_settings
from app.logging_setup import get_logger, setup_logging

log = get_logger("VISION")
BOUNDARY = "frame"


@dataclass
class Components:
    """Các phần chạy nền — tách ra để test thay bằng đồ giả (không cần camera / GPU)."""
    pipeline: Any                       # VisionPipeline
    camera: Any = None                  # Camera
    mqtt: Any = None                    # MqttPublisher
    model: dict[str, Any] = field(default_factory=dict)
    stop: Callable[[], None] = lambda: None


def build_components(s: Settings) -> Components:
    from app.camera import Camera
    from app.detector import FireSmokeDetector, PersonDetector
    from app.mqtt import MqttPublisher
    from app.pipeline import VisionPipeline
    from app.presence import PresenceTracker

    detector = PersonDetector(s.model_path, s.vision_device, s.vision_imgsz, s.vision_conf)
    fire = None
    fire_info: dict[str, Any] | None = None
    if s.fire_model_path is not None:
        try:
            fire = FireSmokeDetector(s.fire_model_path, s.vision_device, s.vision_imgsz, s.vision_fire_conf,
                                     s.vision_smoke_conf)
            fire_info = {"name": fire.name, "fireConf": s.vision_fire_conf, "smokeConf": s.vision_smoke_conf,
                         "confirmFrames": s.vision_fire_confirm_frames, "clearS": s.vision_fire_clear_s}
        except Exception as e:  # noqa: BLE001 — thiếu / sai model lửa: vẫn chạy phát hiện người
            log.error("KHÔNG bật được phát hiện lửa / khói (%s) — chỉ phát hiện người", e)
            fire_info = {"name": s.fire_model_path.name, "error": str(e)}
    else:
        log.warning("VISION_FIRE_MODEL trống — tắt phát hiện lửa / khói")
    model = {"name": detector.name, "device": detector.device, "half": detector.half, "imgsz": s.vision_imgsz,
             "conf": s.vision_conf, "inferFps": s.vision_infer_fps, "fire": fire_info}
    mqtt = MqttPublisher(s, {"model": detector.name, "fireModel": fire.name if fire else None,
                             "device": detector.device})
    camera = Camera(s.camera_source, s.vision_camera_width, s.vision_camera_height)
    pipeline = VisionPipeline(camera, detector, PresenceTracker(s.vision_confirm_frames, s.vision_clear_s),
                              lambda topic, payload: mqtt.publish(topic, payload),
                              s.vision_infer_fps, s.vision_publish_s, s.vision_jpeg_quality,
                              fire_detector=fire,
                              fire_tracker=PresenceTracker(s.vision_fire_confirm_frames, s.vision_fire_clear_s),
                              smoke_tracker=PresenceTracker(s.vision_fire_confirm_frames, s.vision_fire_clear_s))
    mqtt.start()
    camera.start()
    pipeline.start()

    def stop() -> None:
        pipeline.stop()
        camera.stop()
        mqtt.stop()

    return Components(pipeline, camera, mqtt, model, stop)


def require_internal_key(x_internal_key: str | None = Header(default=None)) -> None:
    expected = get_settings().internal_api_key
    if not expected or not x_internal_key or not hmac.compare_digest(expected, x_internal_key):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            detail={"error": "invalid_internal_key", "message": "Sai hoặc thiếu X-Internal-Key"})


def create_app(factory: Callable[[Settings], Components] = build_components) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        s = get_settings()
        setup_logging(s.log_level)
        if not s.internal_api_key:
            log.warning("INTERNAL_API_KEY trống — Java BE sẽ không gọi được /status, /stream.mjpg, /snapshot.jpg")
        app.state.c = await asyncio.to_thread(factory, s)       # nạp model mất vài giây
        app.state.viewers = 0
        app.state.started = time.time()
        log.info("Sẵn sàng tại http://127.0.0.1:%s", s.vision_port)
        try:
            yield
        finally:
            await asyncio.to_thread(app.state.c.stop)

    app = FastAPI(title="Warehouse vision", lifespan=lifespan)
    guard = [Depends(require_internal_key)]

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"status": "ok"}

    @app.get("/status", dependencies=guard)
    def get_status(request: Request) -> dict[str, Any]:
        c: Components = request.app.state.c
        return {"uptimeS": round(time.time() - request.app.state.started), "camera": c.camera.info() if c.camera else None,
                "model": c.model, "detection": c.pipeline.status(),
                "mqttConnected": bool(c.mqtt and c.mqtt.connected), "viewers": request.app.state.viewers}

    @app.get("/snapshot.jpg", dependencies=guard)
    def snapshot(request: Request) -> Response:
        _, jpeg = request.app.state.c.pipeline.latest_jpeg()
        if jpeg is None:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                                detail={"error": "no_frame", "message": "Chưa có khung hình từ camera"})
        return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @app.get("/stream.mjpg", dependencies=guard)
    async def stream(request: Request, fps: float = Query(15, ge=1, le=30)) -> StreamingResponse:
        pipeline = request.app.state.c.pipeline
        gap = 1.0 / fps

        async def frames():
            request.app.state.viewers += 1
            last = -1
            try:
                while not await request.is_disconnected():
                    seq, jpeg = pipeline.latest_jpeg()
                    if jpeg is None or seq == last:
                        await asyncio.sleep(0.02)
                        continue
                    last = seq
                    yield (f"--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(jpeg)}\r\n\r\n"
                           .encode() + jpeg + b"\r\n")
                    await asyncio.sleep(gap)
            finally:
                request.app.state.viewers -= 1

        return StreamingResponse(frames(), media_type=f"multipart/x-mixed-replace; boundary={BOUNDARY}",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    return app


app = create_app()
