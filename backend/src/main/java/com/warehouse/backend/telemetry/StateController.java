package com.warehouse.backend.telemetry;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.common.Rows;
import com.warehouse.backend.common.TimeRange;
import com.warehouse.backend.config.AppProperties;
import com.warehouse.backend.mqtt.MqttPublisher;
import com.warehouse.backend.mqtt.Topics;

@RestController
@RequestMapping("/api")
public class StateController {

    /** kind -> (bảng, cột). Danh sách cố định để không ghép tên bảng từ input người dùng. */
    private static final Map<String, String[]> READINGS = Map.of(
            "mq2", new String[] { "app.mq2_readings", "ts, raw, mv, level, warming_up" },
            "climate", new String[] { "app.climate_readings", "ts, temp, hum, temp_rise, error" },
            "motion", new String[] { "app.motion_events", "ts, motion" },
            "safety", new String[] { "app.safety_events", "ts, state, mq2_level, temp_rise, faults::text AS faults" },
            "health", new String[] { "app.device_health", "ts, online, uptime_s, rssi, ip" },
            "device-states", new String[] { "app.device_states", "ts, device, state, mode, reason, source, trace_id" });

    private final LiveStateService live;
    private final MqttPublisher mqtt;
    private final JdbcClient jdbc;
    private final AppProperties props;

    public StateController(LiveStateService live, MqttPublisher mqtt, JdbcClient jdbc, AppProperties props) {
        this.live = live;
        this.mqtt = mqtt;
        this.jdbc = jdbc;
        this.props = props;
    }

    /** Trạng thái hiện tại: cảm biến, an toàn, thiết bị, online, cấu hình. */
    @GetMapping("/state")
    public Map<String, Object> state() {
        Map<String, Object> s = live.snapshot();
        s.put("brokerConnected", mqtt.isConnected());
        AppProperties.WorkHours wh = props.workHours();
        s.put("workHours", Map.of("start", wh.start(), "end", wh.end(), "days", wh.days(),
                "timezone", props.timezone()));
        return s;
    }

    /** Dữ liệu thô theo thời gian (mới nhất trước). */
    @GetMapping("/readings/{kind}")
    public List<Map<String, Object>> readings(@PathVariable String kind,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(required = false) String device,
            @RequestParam(defaultValue = "500") int limit) {
        String[] t = READINGS.get(kind);
        if (t == null) {
            throw ApiException.notFound("unknown_kind", "Loại dữ liệu hợp lệ: " + READINGS.keySet());
        }
        TimeRange r = TimeRange.of(from, to, Duration.ofHours(1));
        int lim = Math.max(1, Math.min(limit, 5000));
        String deviceFilter = "";
        if ("device-states".equals(kind) && device != null) {
            if (!Topics.DEVICES.contains(device)) {
                throw ApiException.badRequest("unknown_device", "Thiết bị hợp lệ: " + Topics.DEVICES);
            }
            deviceFilter = " AND device = :device";
        }
        var spec = jdbc.sql("SELECT " + t[1] + " FROM " + t[0] + " WHERE ts >= :from AND ts < :to" + deviceFilter
                + " ORDER BY ts DESC, id DESC LIMIT :limit")
                .param("from", Rows.utc(r.from())).param("to", Rows.utc(r.to())).param("limit", lim);
        if (!deviceFilter.isEmpty()) {
            spec = spec.param("device", device);
        }
        return spec.query(Rows::toMap).list();
    }
}
