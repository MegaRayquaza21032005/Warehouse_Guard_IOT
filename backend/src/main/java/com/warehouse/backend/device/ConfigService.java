package com.warehouse.backend.device;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

import org.springframework.stereotype.Service;

import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.mqtt.MqttPublisher;
import com.warehouse.backend.mqtt.Topics;
import com.warehouse.backend.telemetry.LiveStateService;
import com.warehouse.backend.telemetry.TelemetryRepository;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/**
 * Ngưỡng cảnh báo của ESP32 (CLAUDE.md mục 4, 5.5). Kiểm tra giống hệt firmware (logic.h validateConfig)
 * rồi gửi TOÀN BỘ cấu hình (retained) tới warehouse/cmd/config. ESP32 xác nhận qua status/config.
 */
@Service
public class ConfigService {

    /** Khóa -> {min, max, kiểu nguyên?}. */
    private record Rule(double min, double max, boolean integer) {
    }

    private static final Map<String, Rule> RULES = new LinkedHashMap<>();
    private static final Map<String, Number> DEFAULTS = new LinkedHashMap<>();

    static {
        rule("mq2Warning", 150, 4095, true, 1500);
        rule("mq2Danger", 150, 4095, true, 2500);
        rule("tempHigh", 0, 80, false, 38);
        rule("humHigh", 10, 100, false, 80);
        rule("tempRiseC", 0.5, 20, false, 3);
        rule("tempRiseWindowMin", 1, 15, true, 5);
        rule("mistFireMaxMin", 1, 60, true, 10);
        rule("mistCoolMaxMin", 1, 60, true, 5);
        rule("mistCooldownMin", 0, 240, true, 15);
        rule("mistHumMax", 10, 100, false, 70);
        rule("humFanCheckMin", 5, 240, true, 30);
        rule("humFanMinDrop", 0.5, 50, false, 3);
    }

    private static void rule(String key, double min, double max, boolean integer, Number def) {
        RULES.put(key, new Rule(min, max, integer));
        DEFAULTS.put(key, def);
    }

    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };

    private final LiveStateService live;
    private final TelemetryRepository telemetry;
    private final MqttPublisher mqtt;
    private final ObjectMapper mapper;

    public ConfigService(LiveStateService live, TelemetryRepository telemetry, MqttPublisher mqtt,
            ObjectMapper mapper) {
        this.live = live;
        this.telemetry = telemetry;
        this.mqtt = mqtt;
        this.mapper = mapper;
    }

    /** Cấu hình ESP32 đang dùng (đã xác nhận); chưa có thì trả mặc định của firmware. */
    public Map<String, Object> current() {
        Map<String, Object> cfg = new LinkedHashMap<>(DEFAULTS);
        Optional.ofNullable(live.get(Topics.STATUS_CONFIG))
                .or(() -> telemetry.configJson().map(j -> mapper.readValue(j, MAP)))
                .ifPresent(m -> m.forEach((k, v) -> {
                    if (RULES.containsKey(k)) {
                        cfg.put(k, v);
                    }
                }));
        return cfg;
    }

    /** Ghép thay đổi vào cấu hình hiện tại, kiểm tra, gửi xuống ESP32. */
    public Map<String, Object> update(Map<String, Object> patch) {
        if (patch == null || patch.isEmpty()) {
            throw ApiException.badRequest("empty_config", "Không có trường nào để cập nhật");
        }
        Map<String, Object> merged = current();
        for (Map.Entry<String, Object> e : patch.entrySet()) {
            Rule r = RULES.get(e.getKey());
            if (r == null) {
                throw ApiException.badRequest("unknown_key", "Khóa không hợp lệ: " + e.getKey()
                        + ". Hợp lệ: " + RULES.keySet());
            }
            if (!(e.getValue() instanceof Number n)) {
                throw ApiException.badRequest("invalid_value", e.getKey() + " phải là số");
            }
            double v = n.doubleValue();
            if (r.integer() && v != Math.rint(v)) {
                throw ApiException.badRequest("invalid_value", e.getKey() + " phải là số nguyên");
            }
            if (v < r.min() || v > r.max()) {
                throw ApiException.badRequest("out_of_range",
                        e.getKey() + " phải trong khoảng " + fmt(r.min()) + " - " + fmt(r.max()));
            }
            merged.put(e.getKey(), r.integer() ? (Number) Math.round(v) : (Number) v);
        }
        double warn = num(merged, "mq2Warning");
        double danger = num(merged, "mq2Danger");
        if (danger <= warn + 150) {
            throw ApiException.badRequest("invalid_mq2_threshold", "mq2Danger phải lớn hơn mq2Warning + 150");
        }
        if (num(merged, "mistHumMax") >= num(merged, "humHigh")) {
            throw ApiException.badRequest("invalid_mist_hum_max", "mistHumMax phải nhỏ hơn humHigh");
        }
        mqtt.publish(Topics.CMD_CONFIG, merged, true);
        return merged;
    }

    private static double num(Map<String, Object> m, String k) {
        return ((Number) m.get(k)).doubleValue();
    }

    private static String fmt(double d) {
        return d == Math.rint(d) ? String.valueOf((long) d) : String.valueOf(d);
    }
}
