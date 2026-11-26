package com.warehouse.backend.mqtt;

import static com.warehouse.backend.common.Json.bool;
import static com.warehouse.backend.common.Json.dbl;
import static com.warehouse.backend.common.Json.intVal;
import static com.warehouse.backend.common.Json.longVal;
import static com.warehouse.backend.common.Json.obj;
import static com.warehouse.backend.common.Json.str;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import com.warehouse.backend.alert.AlertRepository;
import com.warehouse.backend.push.PushService;
import com.warehouse.backend.auth.UserRepository;
import com.warehouse.backend.device.CommandLogRepository;
import com.warehouse.backend.device.CommandLogRepository.NewLog;
import com.warehouse.backend.telemetry.LiveStateService;
import com.warehouse.backend.telemetry.TelemetryRepository;
import com.warehouse.backend.telemetry.TelemetryRepository.DeviceStateRow;
import com.warehouse.backend.ws.LiveBroadcaster;

import tools.jackson.core.JacksonException;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/**
 * Xử lý MỌI bản tin MQTT (warehouse/#): lưu DB, cập nhật trạng thái hiện tại, đẩy realtime qua WebSocket.
 *
 * Bản tin retained được broker gửi lại mỗi lần backend kết nối lại -> chỉ ghi lịch sử khi khác bản ghi
 * cuối cùng trong DB, tránh ghi trùng.
 */
@Service
public class MqttIngestService {

    private static final Logger log = LoggerFactory.getLogger(MqttIngestService.class);
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };

    private final ObjectMapper mapper;
    private final TelemetryRepository telemetry;
    private final CommandLogRepository commandLogs;
    private final AlertRepository alerts;
    private final UserRepository users;
    private final LiveStateService live;
    private final LiveBroadcaster broadcaster;
    private final PushService push;

    public MqttIngestService(ObjectMapper mapper, TelemetryRepository telemetry, CommandLogRepository commandLogs,
            AlertRepository alerts, UserRepository users, LiveStateService live, LiveBroadcaster broadcaster,
            PushService push) {
        this.mapper = mapper;
        this.telemetry = telemetry;
        this.commandLogs = commandLogs;
        this.alerts = alerts;
        this.users = users;
        this.live = live;
        this.broadcaster = broadcaster;
        this.push = push;
    }

    public void handle(String topic, byte[] payload, boolean retained) {
        Map<String, Object> data;
        try {
            data = mapper.readValue(payload, MAP);
        } catch (JacksonException e) {
            log.warn("[INGEST] {}: payload không phải JSON object, bỏ qua", topic);
            return;
        }
        if (data == null) {
            return;
        }
        Instant now = Instant.now();
        Object broadcastData = data;

        switch (topic) {
            case Topics.SENSOR_MQ135 -> onMq135(data);
            case Topics.SENSOR_DHT -> onDht(data);
            case Topics.SENSOR_PIR -> onPir(data);
            case Topics.STATUS_SAFETY -> onSafety(data);
            case Topics.STATUS_ONLINE -> telemetry.insertHealth("online".equals(str(data, "status")), null, null, null);
            case Topics.STATUS_DEVICE -> telemetry.insertHealth(true, longVal(data, "uptime"),
                    intVal(data, "rssi"), str(data, "ip"));
            case Topics.STATUS_CONFIG -> onConfig(data);
            case Topics.ALERT -> broadcastData = onAlert(data);
            default -> {
                if (topic.startsWith("warehouse/status/")) {
                    String device = topic.substring("warehouse/status/".length());
                    if (Topics.DEVICES.contains(device)) {
                        onDeviceStatus(device, data);
                    }
                } else if (topic.startsWith("warehouse/cmd/")) {
                    String device = topic.substring("warehouse/cmd/".length());
                    if (Topics.DEVICES.contains(device)) {
                        onDeviceCommand(device, data);
                    }
                    return; // lệnh không phải trạng thái -> không cập nhật live / không đẩy realtime
                }
            }
        }
        live.update(topic, data, now);
        broadcaster.broadcast(topic, broadcastData, now);
    }

    // ---------------- Cảm biến ----------------
    private void onMq135(Map<String, Object> d) {
        Integer raw = intVal(d, "raw");
        if (raw == null) {
            return;
        }
        String level = Optional.ofNullable(str(d, "level")).orElse("normal");
        telemetry.insertMq135(raw, intVal(d, "mv"), level, Boolean.TRUE.equals(bool(d, "warmingUp")));
    }

    private void onDht(Map<String, Object> d) {
        telemetry.insertClimate(dbl(d, "temp"), dbl(d, "hum"), dbl(d, "tempRise"), str(d, "error"));
    }

    private void onPir(Map<String, Object> d) {
        Boolean motion = bool(d, "motion");
        if (motion != null) {
            telemetry.insertMotion(motion);
        }
    }

    // ---------------- Trạng thái ----------------
    private void onSafety(Map<String, Object> d) {
        String state = str(d, "state");
        if (state == null) {
            return;
        }
        String faults = toJson(d.getOrDefault("faults", List.of()));
        boolean changed = telemetry.lastSafety()
                .map(last -> !last.state().equals(state) || !sameJson(last.faultsJson(), faults))
                .orElse(true);
        if (changed) {
            telemetry.insertSafety(state, str(d, "mq135Level"), dbl(d, "tempRise"), faults);
        }
    }

    private void onConfig(Map<String, Object> d) {
        Map<String, Object> cfg = new LinkedHashMap<>(d);
        Object error = cfg.remove("error");
        telemetry.upsertConfig(toJson(cfg), error == null ? null : String.valueOf(error));
    }

    private void onDeviceStatus(String device, Map<String, Object> d) {
        String state = str(d, "state");
        if (state == null) {
            return;
        }
        DeviceStateRow row = new DeviceStateRow(state, str(d, "mode"), str(d, "reason"), str(d, "source"),
                str(d, "trace_id"));

        // ESP32 xác nhận lệnh
        Map<String, Object> ack = obj(d, "ack");
        if (ack != null && str(ack, "trace_id") != null && !str(ack, "trace_id").isEmpty()) {
            commandLogs.applyAck(str(ack, "trace_id"), str(ack, "result"), state);
        }

        Optional<DeviceStateRow> last = telemetry.lastDeviceState(device);
        if (last.isPresent() && last.get().equals(row)) {
            return; // trùng (vd. retained gửi lại khi kết nối lại)
        }
        telemetry.insertDeviceState(device, row);

        // Luật cục bộ ESP32 tự đổi trạng thái -> ghi nhật ký lệnh với source esp32_local.
        // Lần đầu thấy thiết bị (chưa có lịch sử) chỉ ghi khi đang BẬT — trạng thái tắt lúc khởi động không phải lệnh.
        boolean stateChanged = last.map(l -> !l.state().equals(state)).orElse("on".equals(state));
        if (stateChanged && "esp32_local".equals(row.source())) {
            commandLogs.insert(new NewLog(device, state, "esp32_local", null, null, row.reason(), null, toJson(d)));
        }
    }

    /** Mọi lệnh cmd/* (từ user / rule / agent) đều được ghi nhật ký; trùng trace_id thì bỏ qua. */
    private void onDeviceCommand(String device, Map<String, Object> d) {
        String traceId = str(d, "trace_id");
        if (traceId != null && !traceId.isEmpty() && commandLogs.existsByTraceId(traceId)) {
            return;
        }
        String action = "auto".equals(str(d, "mode")) ? "auto"
                : ("on".equals(str(d, "state")) || "off".equals(str(d, "state"))) ? str(d, "state") : "invalid";
        String source = Optional.ofNullable(str(d, "source")).orElse("user");
        Long userId = longVal(d, "user_id");
        if (userId != null && !users.existsById(userId)) {
            userId = null;
        }
        commandLogs.insert(new NewLog(device, action, source, userId, traceId, str(d, "reason"),
                intVal(d, "duration_s"), toJson(d)));
    }

    // ---------------- Cảnh báo ----------------
    private Object onAlert(Map<String, Object> d) {
        String type = Optional.ofNullable(str(d, "type")).orElse("unknown");
        String level = Optional.ofNullable(str(d, "level")).orElse("info");
        long id = alerts.insert(type, level, str(d, "message"), str(d, "source"), str(d, "incident_id"),
                toJson(d));
        Map<String, Object> saved = alerts.find(id).orElse(d);
        push.onAlert(saved);
        return saved;
    }

    // ---------------- Tiện ích ----------------
    private String toJson(Object o) {
        return mapper.writeValueAsString(o);
    }

    private boolean sameJson(String a, String b) {
        try {
            return Objects.equals(mapper.readTree(a), mapper.readTree(b));
        } catch (JacksonException e) {
            return false;
        }
    }
}
