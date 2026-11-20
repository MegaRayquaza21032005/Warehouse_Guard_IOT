package com.warehouse.backend.telemetry;

import java.util.Optional;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Ghi dữ liệu cảm biến / trạng thái vào schema app (JdbcClient, tên bảng ghi rõ schema). */
@Repository
public class TelemetryRepository {

    private final JdbcClient jdbc;

    public TelemetryRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public record DeviceStateRow(String state, String mode, String reason, String source, String traceId) {
    }

    public record SafetyRow(String state, String faultsJson) {
    }

    public void insertMq2(int raw, Integer mv, String level, boolean warmingUp) {
        jdbc.sql("INSERT INTO app.mq2_readings (raw, mv, level, warming_up) VALUES (?, ?, ?, ?)")
                .params(raw, mv, level, warmingUp).update();
    }

    public void insertClimate(Double temp, Double hum, Double tempRise, String error) {
        jdbc.sql("INSERT INTO app.climate_readings (temp, hum, temp_rise, error) VALUES (?, ?, ?, ?)")
                .params(temp, hum, tempRise, error).update();
    }

    public void insertMotion(boolean motion) {
        jdbc.sql("INSERT INTO app.motion_events (motion) VALUES (?)").params(motion).update();
    }

    public Optional<SafetyRow> lastSafety() {
        return jdbc.sql("SELECT state, faults::text AS faults FROM app.safety_events ORDER BY ts DESC, id DESC LIMIT 1")
                .query((rs, i) -> new SafetyRow(rs.getString("state"), rs.getString("faults"))).optional();
    }

    public void insertSafety(String state, String mq2Level, Double tempRise, String faultsJson) {
        jdbc.sql("INSERT INTO app.safety_events (state, mq2_level, temp_rise, faults) VALUES (?, ?, ?, ?::jsonb)")
                .params(state, mq2Level, tempRise, faultsJson).update();
    }

    public void insertHealth(Boolean online, Long uptimeS, Integer rssi, String ip) {
        jdbc.sql("INSERT INTO app.device_health (online, uptime_s, rssi, ip) VALUES (?, ?, ?, ?)")
                .params(online, uptimeS, rssi, ip).update();
    }

    public Optional<DeviceStateRow> lastDeviceState(String device) {
        return jdbc.sql("""
                SELECT state, mode, reason, source, trace_id FROM app.device_states
                WHERE device = ? ORDER BY ts DESC, id DESC LIMIT 1""")
                .params(device)
                .query((rs, i) -> new DeviceStateRow(rs.getString("state"), rs.getString("mode"),
                        rs.getString("reason"), rs.getString("source"), rs.getString("trace_id")))
                .optional();
    }

    public void insertDeviceState(String device, DeviceStateRow row) {
        jdbc.sql("""
                INSERT INTO app.device_states (device, state, mode, reason, source, trace_id)
                VALUES (?, ?, ?, ?, ?, ?)""")
                .params(device, row.state(), row.mode(), row.reason(), row.source(), row.traceId()).update();
    }

    public void upsertConfig(String payloadJson, String error) {
        jdbc.sql("""
                INSERT INTO app.device_config (id, payload, error, updated_at) VALUES (1, ?::jsonb, ?, now())
                ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, error = EXCLUDED.error,
                                               updated_at = EXCLUDED.updated_at""")
                .params(payloadJson, error).update();
    }

    public Optional<String> configJson() {
        return jdbc.sql("SELECT payload::text FROM app.device_config WHERE id = 1").query(String.class).optional();
    }
}
