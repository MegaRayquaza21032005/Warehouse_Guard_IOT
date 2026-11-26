import numpy as np

from app.detector import Detection
from app.pipeline import TOPIC_CAMERA, VisionPipeline
from app.presence import PresenceTracker

PERSON = Detection("person", 0.87, (10, 10, 100, 200))


class FakeCamera:
    def __init__(self):
        self.seq = 0
        self.frame: np.ndarray | None = np.zeros((48, 64, 3), dtype=np.uint8)
        self.error: str | None = None

    def next(self):
        self.seq += 1

    def latest(self):
        return self.seq, self.frame


class FakeDetector:
    def __init__(self):
        self.result: list[Detection] = []
        self.fail = False
        self.calls = 0

    def detect(self, frame):
        self.calls += 1
        if self.fail:
            raise RuntimeError("cuda error")
        return list(self.result)


def make(confirm=2, clear=3.0, publish_s=5.0):
    cam, det, sent = FakeCamera(), FakeDetector(), []
    p = VisionPipeline(cam, det, PresenceTracker(confirm, clear), lambda t, d: sent.append((t, d)),
                       infer_fps=10, publish_s=publish_s)
    return p, cam, det, sent


def step(p, cam, now):
    cam.next()
    p.step(now)


def test_first_frame_publishes_and_produces_jpeg():
    p, cam, det, sent = make()
    step(p, cam, 100.0)
    assert sent == [(TOPIC_CAMERA, {"person": False, "personCount": 0, "personConf": None, "fps": None})]
    seq, jpeg = p.latest_jpeg()
    assert seq == 1 and jpeg[:2] == b"\xff\xd8"          # JPEG


def test_same_camera_frame_is_not_reprocessed():
    p, cam, det, sent = make()
    step(p, cam, 100.0)
    p.step(100.1)                                         # camera chưa có khung mới
    assert det.calls == 1


def test_person_confirmed_publishes_immediately_and_clears():
    p, cam, det, sent = make(confirm=2, clear=3.0)
    step(p, cam, 100.0)
    det.result = [PERSON]
    step(p, cam, 100.1)
    assert len(sent) == 1                                 # mới 1 khung -> chưa xác nhận
    step(p, cam, 100.2)
    assert sent[-1][1]["person"] is True and sent[-1][1]["personCount"] == 1
    assert sent[-1][1]["personConf"] == 0.87
    det.result = []
    step(p, cam, 101.0)
    assert len(sent) == 2                                 # còn trong thời gian chờ hết người
    step(p, cam, 103.3)
    assert sent[-1][1] == {"person": False, "personCount": 0, "personConf": None, "fps": sent[-1][1]["fps"]}


def test_count_change_throttled_to_once_per_second():
    p, cam, det, sent = make(confirm=1)
    step(p, cam, 100.0)
    det.result = [PERSON]
    step(p, cam, 100.1)
    n = len(sent)
    det.result = [PERSON, PERSON]
    step(p, cam, 100.2)
    assert len(sent) == n                                 # < 1s kể từ lần gửi trước
    step(p, cam, 101.2)
    assert sent[-1][1]["personCount"] == 2


def test_periodic_heartbeat():
    p, cam, det, sent = make(publish_s=5.0)
    step(p, cam, 100.0)
    step(p, cam, 102.0)
    assert len(sent) == 1
    step(p, cam, 105.1)
    assert len(sent) == 2


def test_camera_error_publishes_error_and_resets_presence():
    p, cam, det, sent = make(confirm=1)
    det.result = [PERSON]
    step(p, cam, 100.0)
    assert p.tracker.state.present
    cam.frame, cam.error = None, "camera_unavailable"
    p.step(100.5)
    assert sent[-1][1] == {"error": "camera_unavailable"}
    assert not p.tracker.state.present
    assert p.latest_jpeg()[1][:2] == b"\xff\xd8"          # ảnh "NO SIGNAL" cho người đang xem
    p.step(101.0)
    assert len(sent) == 2                                 # lỗi kéo dài: chỉ nhắc lại theo chu kỳ
    p.step(105.6)
    assert sent[-1][1] == {"error": "camera_unavailable"} and len(sent) == 3
    cam.frame, cam.error = np.zeros((48, 64, 3), dtype=np.uint8), None
    step(p, cam, 106.0)
    assert p.error is None and sent[-1][1]["person"] is True


def test_camera_still_opening_is_not_an_error():
    p, cam, det, sent = make()
    cam.frame, cam.error = None, None          # luồng camera chưa mở xong
    p.step(100.0)
    assert sent == [] and p.error is None


def test_detector_failure_is_reported_not_raised():
    p, cam, det, sent = make()
    det.fail = True
    step(p, cam, 100.0)
    assert sent[-1][1] == {"error": "detector_failed"}
    assert p.status()["error"] == "detector_failed"


# ---------------------------------------------------------------- lửa / khói (detector thứ hai)
FIRE = Detection("fire", 0.72, (200, 100, 260, 180))
SMOKE = Detection("smoke", 0.61, (150, 40, 300, 160))


def make_fire(confirm=2, clear=10.0):
    cam, det, fire, sent = FakeCamera(), FakeDetector(), FakeDetector(), []
    p = VisionPipeline(cam, det, PresenceTracker(1, 3.0), lambda t, d: sent.append((t, d)), infer_fps=10,
                       publish_s=5.0, fire_detector=fire, fire_tracker=PresenceTracker(confirm, clear),
                       smoke_tracker=PresenceTracker(confirm, clear))
    return p, cam, fire, sent


def test_payload_without_fire_model_has_no_fire_fields():
    p, cam, det, sent = make()
    step(p, cam, 100.0)
    assert "fire" not in sent[-1][1] and "smoke" not in sent[-1][1]
    assert p.status()["fireEnabled"] is False


def test_fire_confirmed_after_n_frames_publishes_immediately():
    p, cam, fire, sent = make_fire(confirm=2)
    step(p, cam, 100.0)
    assert sent[-1][1] == {"person": False, "personCount": 0, "personConf": None, "fire": False, "fireConf": None,
                           "smoke": False, "smokeConf": None, "fps": None}
    fire.result = [FIRE]
    step(p, cam, 100.1)
    assert len(sent) == 1                                 # 1 khung -> chưa tính (chống báo giả)
    step(p, cam, 100.2)
    assert len(sent) == 2 and sent[-1][1]["fire"] is True and sent[-1][1]["fireConf"] == 0.72
    assert sent[-1][1]["smoke"] is False
    st = p.status()
    assert st["fire"] is True and st["fireEnabled"] is True


def test_fire_clears_only_after_clear_s():
    p, cam, fire, sent = make_fire(confirm=1, clear=10.0)
    fire.result = [FIRE, SMOKE]
    step(p, cam, 100.0)
    assert sent[-1][1]["fire"] is True and sent[-1][1]["smoke"] is True
    fire.result = []
    step(p, cam, 105.0)                                   # mất 5s (khuất / nhấp nháy) -> vẫn còn
    assert p.fire_tracker.state.present
    step(p, cam, 110.5)
    assert sent[-1][1]["fire"] is False and sent[-1][1]["smoke"] is False


def test_person_and_fire_counted_separately():
    p, cam, fire, sent = make_fire(confirm=1)
    p.detector.result = [PERSON]
    fire.result = [SMOKE]
    step(p, cam, 100.0)
    last = sent[-1][1]
    assert last["person"] is True and last["personCount"] == 1          # khói không tính là người
    assert last["smoke"] is True and last["fire"] is False


def test_fire_detector_failure_is_detector_failed_and_resets():
    p, cam, fire, sent = make_fire(confirm=1)
    fire.result = [FIRE]
    step(p, cam, 100.0)
    fire.fail = True
    step(p, cam, 100.1)
    assert sent[-1][1] == {"error": "detector_failed"}
    assert not p.fire_tracker.state.present               # lỗi -> không còn "đang thấy lửa"
