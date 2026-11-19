"""Đọc ngưỡng từ .env và gửi xuống ESP32 qua MQTT.

Chạy (trong conda env iot-agent):
    conda activate iot-agent
    python tools/push_config.py

Bản tin được gửi dạng retained, nên ESP32 nhận lại mỗi khi kết nối lại broker.
Dùng tài khoản MQTT_USER / MQTT_PASSWORD trong .env.
"""

import json
import sys
import threading
from pathlib import Path

import paho.mqtt.client as mqtt

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
TOPIC = "warehouse/cmd/config"
TIMEOUT_S = 5


def load_env(path: Path) -> dict[str, str]:
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def main() -> int:
    env = load_env(ENV_PATH)

    payload = json.dumps({
        "mq2Warning": int(env["MQ2_WARNING"]),
        "mq2Danger": int(env["MQ2_DANGER"]),
        "tempHigh": float(env["TEMP_HIGH"]),
        "humHigh": float(env["HUM_HIGH"]),
    })
    host = env.get("MQTT_HOST", "localhost")
    port = int(env.get("MQTT_PORT", "1883"))

    connected = threading.Event()
    result: dict[str, object] = {}

    def on_connect(client, userdata, flags, reason_code, properties):
        result["rc"] = reason_code
        connected.set()

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="tools-push-config")
    if env.get("MQTT_USER"):
        client.username_pw_set(env["MQTT_USER"], env.get("MQTT_PASSWORD", ""))
    client.on_connect = on_connect

    try:
        client.connect(host, port, keepalive=10)
    except OSError as exc:
        print(f"Không kết nối được broker {host}:{port}: {exc}", file=sys.stderr)
        return 1

    client.loop_start()
    try:
        if not connected.wait(TIMEOUT_S):
            print(f"Hết thời gian chờ broker {host}:{port}", file=sys.stderr)
            return 1
        rc = result["rc"]
        if rc.is_failure:
            print(f"Broker từ chối kết nối: {rc} (kiểm tra MQTT_USER / MQTT_PASSWORD)", file=sys.stderr)
            return 1

        info = client.publish(TOPIC, payload, qos=1, retain=True)
        info.wait_for_publish(TIMEOUT_S)
        if not info.is_published():
            print("Gửi thất bại (không nhận được xác nhận từ broker)", file=sys.stderr)
            return 1
    finally:
        client.disconnect()
        client.loop_stop()

    print(f"Đã gửi {TOPIC}: {payload}")
    print("ESP32 xác nhận trên topic warehouse/status/config")
    return 0


if __name__ == "__main__":
    sys.exit(main())
