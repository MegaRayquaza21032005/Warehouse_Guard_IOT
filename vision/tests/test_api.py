import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import Components, create_app

KEY = "test-key"
JPEG = b"\xff\xd8\xff\xe0fake-jpeg\xff\xd9"


class FakePipeline:
    def __init__(self, jpeg=JPEG):
        self.jpeg = jpeg
        self.seq = 1

    def latest_jpeg(self):
        self.seq += 1                     # mỗi lần đọc là một khung "mới"
        return self.seq, self.jpeg

    def status(self):
        return {"person": True, "personCount": 1, "personConf": 0.9, "fps": 9.8, "error": None}


class FakeCamera:
    def info(self):
        return {"source": "0", "opened": True, "error": None, "width": 640, "height": 480}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_KEY", KEY)
    get_settings.cache_clear()
    pipeline = FakePipeline()
    app = create_app(lambda s: Components(pipeline, FakeCamera(), None, {"name": "yolo26n.pt", "device": "cpu"}))
    with TestClient(app) as c:
        c.pipeline = pipeline
        yield c
    get_settings.cache_clear()


H = {"X-Internal-Key": KEY}


def test_health_needs_no_key(client):
    assert client.get("/health").json() == {"status": "ok"}


@pytest.mark.parametrize("path", ["/status", "/snapshot.jpg", "/stream.mjpg"])
def test_internal_key_required(client, path):
    assert client.get(path).status_code == 401
    assert client.get(path, headers={"X-Internal-Key": "wrong"}).status_code == 401


def test_status(client):
    body = client.get("/status", headers=H).json()
    assert body["camera"]["opened"] is True
    assert body["model"]["name"] == "yolo26n.pt"
    assert body["detection"]["personCount"] == 1
    assert body["mqttConnected"] is False and body["viewers"] == 0


def test_snapshot(client):
    r = client.get("/snapshot.jpg", headers=H)
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg" and r.content == JPEG


def test_snapshot_without_frame_is_503(client):
    client.pipeline.jpeg = None
    r = client.get("/snapshot.jpg", headers=H)
    assert r.status_code == 503 and r.json()["detail"]["error"] == "no_frame"


def test_mjpeg_stream_sends_multipart_frames(client):
    with client.stream("GET", "/stream.mjpg?fps=30", headers=H) as r:
        assert r.status_code == 200
        assert r.headers["content-type"] == "multipart/x-mixed-replace; boundary=frame"
        buf = b""
        for chunk in r.iter_bytes():
            buf += chunk
            if buf.count(b"--frame") >= 2:
                break
    part = buf.split(b"--frame\r\n")[1]
    head, body = part.split(b"\r\n\r\n", 1)
    assert b"Content-Type: image/jpeg" in head and f"Content-Length: {len(JPEG)}".encode() in head
    assert body.startswith(JPEG)


def test_stream_fps_validated(client):
    assert client.get("/stream.mjpg?fps=100", headers=H).status_code == 422
