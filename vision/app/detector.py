"""YOLO (Ultralytics): phát hiện người (model COCO, class 0) và lửa / khói (model fine-tune, class fire + smoke)
+ vẽ khung lên ảnh.

Hai detector cùng giao diện `detect(frame) -> list[Detection]`; pipeline chạy cả hai trên cùng một khung.
"""

import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from app.logging_setup import get_logger

log = get_logger("YOLO")
PERSON_CLASS = 0
FIRE_LABELS = ("fire", "smoke")
# Màu BGR theo nhãn
COLORS = {"person": (60, 200, 60), "fire": (0, 80, 255), "smoke": (170, 170, 170)}
RED = (40, 40, 220)
ORANGE = (0, 140, 255)


@dataclass(frozen=True)
class Detection:
    label: str
    conf: float
    box: tuple[int, int, int, int]      # x1, y1, x2, y2 (pixel)


def resolve_device(device: str) -> str:
    if device != "auto":
        return device
    import torch
    return "cuda:0" if torch.cuda.is_available() else "cpu"


class YoloDetector:
    """Bọc một model YOLO. `conf_by_label`: ngưỡng tin cậy riêng từng nhãn (nhãn không có trong dict bị bỏ)."""

    def __init__(self, model_path: Path, device: str, imgsz: int, conf_by_label: dict[str, float],
                 classes: list[int] | None = None):
        from ultralytics import YOLO      # import chậm (~2s) -> chỉ khi thật sự chạy model

        self.device = resolve_device(device)
        self.half = self.device.startswith("cuda")      # GPU -> FP16 (nhanh hơn, ít VRAM hơn)
        self._quant = 16 if self.half else None
        self.imgsz = imgsz
        self.conf_by_label = conf_by_label
        self.conf = min(conf_by_label.values())         # lọc thô trong model, lọc kỹ theo nhãn ở detect()
        self.classes = classes
        model_path.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.perf_counter()
        self.model = YOLO(str(model_path))   # tên model chuẩn mà chưa có file -> Ultralytics tự tải về đúng chỗ
        self.name = model_path.name
        self.names: dict[int, str] = dict(self.model.names)
        self.model.predict(np.zeros((imgsz, imgsz, 3), dtype=np.uint8), imgsz=imgsz, device=self.device,
                           quantize=self._quant, classes=classes, verbose=False)     # khởi động GPU
        log.info("Đã nạp %s %s trên %s%s (%.1fs)", self.name, sorted(conf_by_label), self.device,
                 " FP16" if self.half else "", time.perf_counter() - t0)

    def detect(self, frame: np.ndarray) -> list[Detection]:
        res = self.model.predict(frame, imgsz=self.imgsz, conf=self.conf, device=self.device, quantize=self._quant,
                                 classes=self.classes, verbose=False)[0]
        boxes = res.boxes
        if boxes is None or len(boxes) == 0:
            return []
        xyxy = boxes.xyxy.cpu().numpy().astype(int)
        confs = boxes.conf.cpu().numpy()
        clss = boxes.cls.cpu().numpy().astype(int)
        out = []
        for b, c, k in zip(xyxy, confs, clss):
            label = self.names.get(int(k), str(k)).lower()
            th = self.conf_by_label.get(label)
            if th is not None and c >= th:
                out.append(Detection(label, float(c), (int(b[0]), int(b[1]), int(b[2]), int(b[3]))))
        return out


class PersonDetector(YoloDetector):
    def __init__(self, model_path: Path, device: str = "auto", imgsz: int = 640, conf: float = 0.5):
        super().__init__(model_path, device, imgsz, {"person": conf}, classes=[PERSON_CLASS])


class FireSmokeDetector(YoloDetector):
    """Model fine-tune (vd. YOLO26s trên FASDD_CV) có 2 class `fire`, `smoke`."""

    def __init__(self, model_path: Path, device: str = "auto", imgsz: int = 640, fire_conf: float = 0.45,
                 smoke_conf: float = 0.45):
        if not model_path.is_file():     # model tự train, Ultralytics không tải được -> báo rõ
            raise FileNotFoundError(f"Không thấy model lửa / khói: {model_path}")
        super().__init__(model_path, device, imgsz, {"fire": fire_conf, "smoke": smoke_conf})
        missing = [l for l in FIRE_LABELS if l not in {n.lower() for n in self.names.values()}]
        if missing:
            raise ValueError(f"{self.name} không có class {missing} (đang có {self.names})")


def annotate(frame: np.ndarray, dets: list[Detection], present: bool, fps: float | None,
             infer_ms: float | None, fire: bool = False, smoke: bool = False) -> np.ndarray:
    """Vẽ khung + nhãn từng đối tượng và dòng trạng thái phía trên (chữ ASCII — OpenCV không vẽ được tiếng Việt)."""
    img = frame.copy()
    for d in dets:
        color = COLORS.get(d.label, (255, 200, 0))
        x1, y1, x2, y2 = d.box
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
        text = f"{d.label} {d.conf:.2f}"
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        ty = max(y1, th + 30)            # không đè lên dòng trạng thái
        cv2.rectangle(img, (x1, ty - th - 6), (x1 + tw + 6, ty), color, -1)
        cv2.putText(img, text, (x1 + 3, ty - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)

    n = sum(1 for d in dets if d.label == "person")
    parts = [f"PERSON: {n}" if present else ("person?" if n else "no person")]
    if fire:
        parts.append("FIRE")
    if smoke:
        parts.append("SMOKE")
    if fps is not None:
        parts.append(f"{fps:.1f} fps")
    if infer_ms is not None:
        parts.append(f"{infer_ms:.0f} ms")
    parts.append(time.strftime("%H:%M:%S"))
    bar = "  |  ".join(parts)
    color = ORANGE if (fire or smoke) else (RED if present else (230, 230, 230))
    cv2.rectangle(img, (0, 0), (img.shape[1], 24), (0, 0, 0), -1)
    cv2.putText(img, bar, (8, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)
    return img


def encode_jpeg(img: np.ndarray, quality: int) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("Không mã hóa được JPEG")
    return buf.tobytes()
