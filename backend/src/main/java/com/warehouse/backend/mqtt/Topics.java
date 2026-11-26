package com.warehouse.backend.mqtt;

import java.util.List;

/** Topic MQTT — CLAUDE.md mục 4. */
public final class Topics {

    private Topics() {
    }

    public static final String PREFIX = "warehouse/";
    public static final String SUBSCRIBE_ALL = "warehouse/#";

    public static final String SENSOR_MQ135 = "warehouse/sensor/mq135";
    public static final String SENSOR_DHT = "warehouse/sensor/dht11";
    public static final String SENSOR_PIR = "warehouse/sensor/pir";
    public static final String STATUS_SAFETY = "warehouse/status/safety";
    public static final String STATUS_ONLINE = "warehouse/status/online";
    public static final String STATUS_DEVICE = "warehouse/status/device";
    public static final String STATUS_CONFIG = "warehouse/status/config";
    public static final String CMD_CONFIG = "warehouse/cmd/config";
    public static final String ALERT = "warehouse/alert";

    public static final List<String> DEVICES = List.of("fan", "mist", "light");

    public static String cmd(String device) {
        return "warehouse/cmd/" + device;
    }

    public static String status(String device) {
        return "warehouse/status/" + device;
    }

    /** "warehouse/status/fan" -> "status.fan" (dùng làm "type" khi đẩy qua WebSocket). */
    public static String type(String topic) {
        String t = topic.startsWith(PREFIX) ? topic.substring(PREFIX.length()) : topic;
        return t.replace('/', '.');
    }
}
