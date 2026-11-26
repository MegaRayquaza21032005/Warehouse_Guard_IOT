"""MQTT (tài khoản vision): gửi warehouse/sensor/camera; warehouse/status/camera retained + LWT offline."""

import json
import uuid
from typing import Any

import paho.mqtt.client as mqtt

from app.config import Settings
from app.logging_setup import get_logger

log = get_logger("MQTT")
TOPIC_STATUS = "warehouse/status/camera"


class MqttPublisher:
    def __init__(self, settings: Settings, status_info: dict[str, Any]):
        self.s = settings
        self.status_info = status_info
        self._stopping = False
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"vision-{uuid.uuid4().hex[:8]}")
        self.client.username_pw_set(settings.mqtt_vision_user, settings.mqtt_vision_password)
        self.client.will_set(TOPIC_STATUS, json.dumps({"status": "offline"}), qos=1, retain=True)
        self.client.reconnect_delay_set(min_delay=1, max_delay=10)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect

    @property
    def connected(self) -> bool:
        return self.client.is_connected()

    def start(self) -> None:
        log.info("Kết nối broker %s:%s (tài khoản %s)", self.s.mqtt_host, self.s.mqtt_port, self.s.mqtt_vision_user)
        self.client.connect_async(self.s.mqtt_host, self.s.mqtt_port, keepalive=30)
        self.client.loop_start()

    def stop(self) -> None:
        self._stopping = True
        if self.connected:   # dừng có chủ đích: tự báo offline (LWT chỉ gửi khi mất kết nối bất thường)
            self.client.publish(TOPIC_STATUS, json.dumps({"status": "offline"}), qos=1, retain=True).wait_for_publish(2)
        self.client.disconnect()
        self.client.loop_stop()

    def publish(self, topic: str, payload: dict[str, Any], retain: bool = False) -> bool:
        if not self.connected:
            return False
        info = self.client.publish(topic, json.dumps(payload, ensure_ascii=False), qos=0 if not retain else 1,
                                   retain=retain)
        return info.rc == mqtt.MQTT_ERR_SUCCESS

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code.is_failure:
            log.error("Broker từ chối kết nối: %s (kiểm tra MQTT_VISION_USER / mật khẩu)", reason_code)
            return
        log.info("Đã kết nối broker")
        client.publish(TOPIC_STATUS, json.dumps({"status": "online", **self.status_info}, ensure_ascii=False),
                       qos=1, retain=True)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        if self._stopping:
            log.info("Đã ngắt kết nối broker (báo camera offline)")
        else:
            log.warning("Mất kết nối broker (%s) — đang thử lại", reason_code)
