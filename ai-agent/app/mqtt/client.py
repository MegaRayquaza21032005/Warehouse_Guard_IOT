"""Kết nối MQTT (tài khoản agent). Paho chạy luồng riêng -> đẩy bản tin vào asyncio.Queue để xử lý tuần tự."""

import asyncio
import json
import uuid
from typing import Any

import paho.mqtt.client as mqtt

from app.config import Settings
from app.logging_setup import get_logger

log = get_logger("MQTT")
SUBSCRIBE_ALL = "warehouse/#"


class MqttBridge:
    def __init__(self, settings: Settings, loop: asyncio.AbstractEventLoop):
        self.s = settings
        self.loop = loop
        self.queue: asyncio.Queue[tuple[str, dict[str, Any], bool]] = asyncio.Queue(maxsize=10_000)
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"ai-agent-{uuid.uuid4().hex[:8]}")
        self.client.username_pw_set(settings.mqtt_agent_user, settings.mqtt_agent_password)
        self.client.reconnect_delay_set(min_delay=1, max_delay=10)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message

    @property
    def connected(self) -> bool:
        return self.client.is_connected()

    def start(self) -> None:
        log.info("Kết nối broker %s:%s (tài khoản %s)", self.s.mqtt_host, self.s.mqtt_port, self.s.mqtt_agent_user)
        self.client.connect_async(self.s.mqtt_host, self.s.mqtt_port, keepalive=30)
        self.client.loop_start()     # tự kết nối lại khi mất

    def stop(self) -> None:
        self.client.disconnect()
        self.client.loop_stop()

    def publish(self, topic: str, payload: dict[str, Any], retain: bool = False) -> bool:
        if not self.connected:
            log.error("Chưa kết nối broker — không gửi được %s", topic)
            return False
        info = self.client.publish(topic, json.dumps(payload, ensure_ascii=False), qos=1, retain=retain)
        return info.rc == mqtt.MQTT_ERR_SUCCESS

    # ---- callback (luồng của Paho) ----
    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code.is_failure:
            log.error("Broker từ chối kết nối: %s", reason_code)
            return
        log.info("Đã kết nối, subscribe %s", SUBSCRIBE_ALL)
        client.subscribe(SUBSCRIBE_ALL, qos=1)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        log.warning("Mất kết nối broker (%s) — đang thử lại", reason_code)

    def _on_message(self, client, userdata, msg):
        try:
            data = json.loads(msg.payload.decode("utf-8")) if msg.payload else None
        except (ValueError, UnicodeDecodeError):
            log.debug("Bỏ qua %s: không phải JSON", msg.topic)
            return
        if not isinstance(data, dict):
            return
        self.loop.call_soon_threadsafe(self._enqueue, msg.topic, data, msg.retain)

    def _enqueue(self, topic: str, data: dict[str, Any], retained: bool) -> None:
        try:
            self.queue.put_nowait((topic, data, retained))
        except asyncio.QueueFull:
            log.error("Hàng đợi MQTT đầy — bỏ bản tin %s", topic)
