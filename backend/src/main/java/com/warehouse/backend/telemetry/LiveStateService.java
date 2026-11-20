package com.warehouse.backend.telemetry;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Service;

import com.warehouse.backend.mqtt.Topics;

/** Bản tin mới nhất của từng topic (trong RAM) — phục vụ GET /api/state và snapshot WebSocket. */
@Service
public class LiveStateService {

    public record Entry(Map<String, Object> data, Instant updatedAt) {
    }

    private final Map<String, Entry> latest = new ConcurrentHashMap<>();

    public void update(String topic, Map<String, Object> data, Instant ts) {
        latest.put(topic, new Entry(data, ts));
    }

    public Map<String, Object> get(String topic) {
        Entry e = latest.get(topic);
        return e == null ? null : e.data();
    }

    public Map<String, Object> snapshot() {
        Map<String, Object> sensors = new LinkedHashMap<>();
        sensors.put("mq2", entry(Topics.SENSOR_MQ2));
        sensors.put("dht11", entry(Topics.SENSOR_DHT));
        sensors.put("pir", entry(Topics.SENSOR_PIR));

        Map<String, Object> devices = new LinkedHashMap<>();
        for (String d : Topics.DEVICES) {
            devices.put(d, entry(Topics.status(d)));
        }

        Map<String, Object> s = new LinkedHashMap<>();
        s.put("online", entry(Topics.STATUS_ONLINE));
        s.put("device", entry(Topics.STATUS_DEVICE));
        s.put("safety", entry(Topics.STATUS_SAFETY));
        s.put("sensors", sensors);
        s.put("devices", devices);
        s.put("config", entry(Topics.STATUS_CONFIG));
        return s;
    }

    private Object entry(String topic) {
        Entry e = latest.get(topic);
        if (e == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("data", e.data());
        m.put("updatedAt", e.updatedAt());
        return m;
    }
}
