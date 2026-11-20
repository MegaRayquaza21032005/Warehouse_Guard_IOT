"""Giả lập ESP32 — test Java BE / AI Agent khi CHƯA cắm thiết bị thật.

Gửi dữ liệu cảm biến theo kịch bản, phản hồi lệnh cmd/* và cmd/config giống firmware v2
(hợp đồng MQTT: CLAUDE.md mục 4). Logic an toàn được ĐƠN GIẢN HÓA theo bảng mục 5.2 —
không thay thế được test trên board thật.

Chạy (conda env iot-agent):
    python tools/simulate_esp32.py                          # bình thường, chạy mãi
    python tools/simulate_esp32.py --plan normal:30,gas:30,fire:60,normal:30 --interval 2
    python tools/simulate_esp32.py --plan fire:20 --once     # chạy hết kế hoạch rồi thoát (gửi offline)

Kịch bản: normal | gas | gas_danger | fire | humid | hot
"""

import argparse
import json
import random
import signal
import sys
import threading
import time
from pathlib import Path

import paho.mqtt.client as mqtt

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
DEVICES = ("fan", "mist", "light")

DEFAULT_CONFIG = {
    "mq2Warning": 1500, "mq2Danger": 2500, "tempHigh": 38.0, "humHigh": 80.0,
    "tempRiseC": 3.0, "tempRiseWindowMin": 5, "mistFireMaxMin": 10, "mistCoolMaxMin": 5,
    "mistCooldownMin": 15, "mistHumMax": 70.0, "humFanCheckMin": 30, "humFanMinDrop": 3.0,
}

# kịch bản -> (mq2 raw, nhiệt độ, độ ẩm, trạng thái an toàn)
SCENARIOS = {
    "normal":     (800, 30.0, 65.0, "normal"),
    "gas":        (1800, 30.0, 65.0, "gas"),
    "gas_danger": (2900, 30.0, 65.0, "gas_danger"),
    "fire":       (2100, 41.0, 55.0, "fire"),
    "humid":      (800, 30.0, 86.0, "normal"),
    "hot":        (800, 39.5, 55.0, "normal"),
}


def load_env(path: Path) -> dict[str, str]:
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


class FakeEsp32:
    def __init__(self, client: mqtt.Client, verbose: bool):
        self.c = client
        self.verbose = verbose
        self.lock = threading.Lock()
        self.config = dict(DEFAULT_CONFIG)
        self.scenario = "normal"
        self.safety = "normal"
        self.start = time.time()
        self.motion = False
        self.manual = {d: None for d in DEVICES}   # {"on": bool, "source", "trace_id", "reason", "until"}
        self.state = {d: {"on": False, "reason": "idle", "source": "esp32_local", "trace_id": None} for d in DEVICES}
        self.published = {d: None for d in DEVICES}

    # ---------------- publish ----------------
    def pub(self, topic: str, payload: dict, retain: bool = False):
        self.c.publish(topic, json.dumps(payload), qos=1, retain=retain)
        if self.verbose:
            print(f"  -> {topic} {json.dumps(payload, ensure_ascii=False)}")

    def publish_all_status(self):
        self.pub("warehouse/status/online", {"status": "online"}, retain=True)
        self.pub("warehouse/status/config", self.config, retain=True)
        self.publish_safety(force=True)
        for d in DEVICES:
            self.publish_device(d, force=True)

    def publish_safety(self, force=False):
        self.pub("warehouse/status/safety", {"state": self.safety, "mq2Level": self.mq2_level(),
                                             "tempRise": 0.0, "faults": []}, retain=True)

    def publish_device(self, d: str, ack: dict | None = None, force=False):
        s = self.state[d]
        m = self.manual[d]
        snap = (s["on"], s["reason"], s["source"], m is not None)
        if not force and ack is None and self.published[d] == snap:
            return
        payload = {"state": "on" if s["on"] else "off", "mode": "manual" if m else "auto",
                   "reason": s["reason"], "source": s["source"], "trace_id": s["trace_id"]}
        if ack:
            payload["ack"] = ack
        self.pub(f"warehouse/status/{d}", payload, retain=True)
        self.published[d] = snap

    # ---------------- logic (đơn giản hóa bảng 5.2) ----------------
    def mq2_level(self) -> str:
        raw = SCENARIOS[self.scenario][0]
        if raw >= self.config["mq2Danger"]:
            return "danger"
        return "warning" if raw >= self.config["mq2Warning"] else "normal"

    def decide(self):
        now = time.time()
        _, temp, hum, safety = SCENARIOS[self.scenario]
        if safety != self.safety:
            print(f"[SAFETY] {self.safety} -> {safety}")
            if safety == "fire":
                self.manual["mist"] = None  # vào cháy: xóa thủ công cũ của phun sương
            self.safety = safety
            self.publish_safety()
        for d in DEVICES:
            m = self.manual[d]
            if m and m["until"] and now >= m["until"]:
                self.manual[d] = m = None
        hot = temp >= self.config["tempHigh"]
        humid = hum >= self.config["humHigh"]

        def manual_or(d, on, reason):
            m = self.manual[d]
            if m:
                return m["on"], m["reason"], m["source"], m["trace_id"]
            return on, reason, "esp32_local", None

        # Quạt
        if safety == "fire":
            fan = (False, "fire_off", "esp32_local", None)
        elif safety == "gas_danger":
            fan = (True, "gas_danger", "esp32_local", None)
        elif self.manual["fan"]:
            fan = manual_or("fan", False, "idle")
        elif safety == "gas":
            fan = (True, "gas", "esp32_local", None)
        elif humid:
            fan = (True, "hum_high", "esp32_local", None)
        elif hot:
            fan = (True, "temp_high", "esp32_local", None)
        else:
            fan = (False, "idle", "esp32_local", None)
        # Phun sương
        if safety == "fire":
            mist = manual_or("mist", True, "fire")
        elif safety in ("gas", "gas_danger"):
            mist = (False, "blocked_gas", "esp32_local", None)
        elif hum >= self.config["humHigh"]:
            mist = (False, "blocked_hum_high", "esp32_local", None)
        elif self.manual["mist"]:
            mist = manual_or("mist", False, "idle")
        elif hot and hum < self.config["mistHumMax"]:
            mist = (True, "cooling", "esp32_local", None)
        else:
            mist = (False, "idle", "esp32_local", None)
        # Đèn
        if safety == "fire":
            light = (True, "fire", "esp32_local", None)
        elif safety == "gas_danger":
            light = (True, "gas_danger", "esp32_local", None)
        else:
            light = manual_or("light", False, "idle")

        for d, (on, reason, source, trace) in zip(DEVICES, (fan, mist, light)):
            changed = self.state[d]["on"] != on
            self.state[d] = {"on": on, "reason": reason, "source": source, "trace_id": trace}
            if changed:
                time.sleep(0.2)  # relay lệch nhau 200ms như firmware
                print(f"[RELAY] {d} {'ON' if on else 'OFF'} ({reason})")
            self.publish_device(d)

    # ---------------- lệnh ----------------
    def on_message(self, client, userdata, msg):
        try:
            data = json.loads(msg.payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        with self.lock:
            if msg.topic == "warehouse/cmd/config":
                merged = dict(self.config)
                merged.update({k: v for k, v in data.items() if k in DEFAULT_CONFIG})
                if merged["mq2Danger"] <= merged["mq2Warning"] + 150 or merged["mistHumMax"] >= merged["humHigh"]:
                    self.pub("warehouse/status/config", {**self.config, "error": "invalid_config"}, retain=True)
                    return
                self.config = merged
                self.pub("warehouse/status/config", self.config, retain=True)
                print("[CFG] cập nhật cấu hình")
                return
            device = msg.topic.rsplit("/", 1)[-1]
            if device not in DEVICES:
                return
            source = data.get("source", "user")
            trace = data.get("trace_id", "")
            current = self.manual[device]
            if source != "user" and current and current["source"] == "user":
                result = "ignored_user_priority"
            elif data.get("mode") == "auto":
                self.manual[device] = None
                result = "applied"
            elif data.get("state") in ("on", "off"):
                dur = int(data.get("duration_s") or 0)
                self.manual[device] = {"on": data["state"] == "on", "source": source, "trace_id": trace,
                                       "reason": data.get("reason") or "manual",
                                       "until": time.time() + dur if dur > 0 else None}
                result = "applied"
            else:
                result = "invalid_command"
            print(f"[CMD] {device} {data.get('state') or data.get('mode')} (source={source}) -> {result}")
            self.decide()
            self.publish_device(device, ack={"trace_id": trace, "result": result})

    # ---------------- dữ liệu cảm biến ----------------
    def tick(self, uptime_s: int):
        raw, temp, hum, _ = SCENARIOS[self.scenario]
        with self.lock:
            self.decide()
            self.pub("warehouse/sensor/mq2", {"raw": int(raw + random.randint(-40, 40)), "mv": int(raw * 0.8),
                                              "level": self.mq2_level(), "warmingUp": False})
            self.pub("warehouse/sensor/dht11", {"temp": round(temp + random.uniform(-0.3, 0.3), 1),
                                                "hum": round(hum + random.uniform(-1, 1), 1), "tempRise": 0.0})
            if random.random() < 0.15:
                self.motion = not self.motion
                self.pub("warehouse/sensor/pir", {"motion": self.motion})
            if uptime_s % 30 < 5:
                self.pub("warehouse/status/device", {"id": "esp32-sim", "uptime": uptime_s, "rssi": -55,
                                                     "ip": "127.0.0.1"})


def parse_plan(plan: str) -> list[tuple[str, int]]:
    steps = []
    for part in plan.split(","):
        name, _, secs = part.partition(":")
        if name not in SCENARIOS:
            raise SystemExit(f"Kịch bản không hợp lệ: {name}. Hợp lệ: {', '.join(SCENARIOS)}")
        steps.append((name, int(secs) if secs else 0))
    return steps


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plan", default="normal", help="vd. normal:30,gas:30,fire:60 (giây; bỏ trống = mãi mãi)")
    ap.add_argument("--interval", type=float, default=5.0, help="chu kỳ gửi cảm biến (giây), firmware: 5")
    ap.add_argument("--once", action="store_true", help="chạy hết kế hoạch rồi thoát")
    ap.add_argument("-v", "--verbose", action="store_true", help="in mọi bản tin gửi đi")
    args = ap.parse_args()
    plan = parse_plan(args.plan)

    env = load_env(ENV_PATH)
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="esp32-simulator")
    client.username_pw_set(env.get("MQTT_ESP32_USER", "esp32"), env.get("MQTT_ESP32_PASSWORD", "esp32"))
    client.will_set("warehouse/status/online", json.dumps({"status": "offline"}), qos=1, retain=True)
    esp = FakeEsp32(client, args.verbose)

    def on_connect(c, userdata, flags, rc, props):
        if rc.is_failure:
            print(f"Broker từ chối: {rc}", file=sys.stderr)
            return
        print("[MQTT] đã kết nối (giả lập ESP32)")
        c.subscribe([("warehouse/cmd/fan", 1), ("warehouse/cmd/mist", 1), ("warehouse/cmd/light", 1),
                     ("warehouse/cmd/config", 1)])
        with esp.lock:
            esp.publish_all_status()

    client.on_connect = on_connect
    client.on_message = esp.on_message
    client.connect(env.get("MQTT_HOST", "localhost"), int(env.get("MQTT_PORT", "1883")), keepalive=30)
    client.loop_start()

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    t0 = time.time()
    try:
        for name, secs in plan:
            print(f"[PLAN] kịch bản {name} {secs or '∞'}s")
            esp.scenario = name
            end = time.time() + secs if secs else None
            while not stop.is_set() and (end is None or time.time() < end):
                esp.tick(int(time.time() - t0))
                stop.wait(args.interval)
            if stop.is_set():
                break
        if not args.once and not stop.is_set():
            print("[PLAN] hết kế hoạch, giữ kịch bản cuối (Ctrl+C để dừng)")
            while not stop.is_set():
                esp.tick(int(time.time() - t0))
                stop.wait(args.interval)
    finally:
        client.publish("warehouse/status/online", json.dumps({"status": "offline"}), qos=1, retain=True).wait_for_publish(3)
        client.disconnect()
        client.loop_stop()
        print("[MQTT] đã ngắt kết nối")
    return 0


if __name__ == "__main__":
    sys.exit(main())
