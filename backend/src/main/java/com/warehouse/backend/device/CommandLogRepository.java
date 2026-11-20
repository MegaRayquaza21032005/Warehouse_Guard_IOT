package com.warehouse.backend.device;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

/** Bảng app.device_command_logs — nhật ký lệnh thiết bị từ MỌI nguồn (CLAUDE.md mục 8). */
@Repository
public class CommandLogRepository {

    private final JdbcClient jdbc;

    public CommandLogRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public record NewLog(String device, String action, String source, Long userId, String traceId, String reason,
            Integer durationS, String payloadJson) {
    }

    public long insert(NewLog l) {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.sql("""
                INSERT INTO app.device_command_logs
                    (device, action, source, user_id, trace_id, reason, duration_s, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)""")
                .params(l.device(), l.action(), l.source(), l.userId(), l.traceId(), l.reason(), l.durationS(),
                        l.payloadJson())
                .update(keys, "id");
        return keys.getKeyAs(Long.class);
    }

    public boolean existsByTraceId(String traceId) {
        return jdbc.sql("SELECT EXISTS (SELECT 1 FROM app.device_command_logs WHERE trace_id = ?)")
                .params(traceId).query(Boolean.class).single();
    }

    /** ESP32 xác nhận lệnh (status/* có "ack"). */
    public int applyAck(String traceId, String result, String confirmedState) {
        return jdbc.sql("""
                UPDATE app.device_command_logs SET result = ?, result_at = now(), confirmed_state = ?
                WHERE trace_id = ? AND result IS NULL""")
                .params(result, confirmedState, traceId).update();
    }

    public void markResult(long id, String result) {
        jdbc.sql("UPDATE app.device_command_logs SET result = ?, result_at = now() WHERE id = ?")
                .params(result, id).update();
    }

    public List<Map<String, Object>> search(String device, String source, Instant from, Instant to, int limit,
            int offset) {
        StringBuilder sql = new StringBuilder("""
                SELECT l.id, l.ts, l.device, l.action, l.source, l.user_id, u.username, l.trace_id, l.reason,
                       l.duration_s, l.result, l.result_at, l.confirmed_state
                FROM app.device_command_logs l LEFT JOIN app.users u ON u.id = l.user_id
                WHERE l.ts >= ? AND l.ts < ?""");
        List<Object> params = new ArrayList<>(List.of(utc(from), utc(to)));
        if (device != null) {
            sql.append(" AND l.device = ?");
            params.add(device);
        }
        if (source != null) {
            sql.append(" AND l.source = ?");
            params.add(source);
        }
        sql.append(" ORDER BY l.ts DESC, l.id DESC LIMIT ? OFFSET ?");
        params.add(limit);
        params.add(offset);
        return jdbc.sql(sql.toString()).params(params).query((rs, i) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", rs.getLong("id"));
            m.put("ts", rs.getObject("ts", OffsetDateTime.class).toInstant());
            m.put("device", rs.getString("device"));
            m.put("action", rs.getString("action"));
            m.put("source", rs.getString("source"));
            m.put("userId", rs.getObject("user_id"));
            m.put("username", rs.getString("username"));
            m.put("traceId", rs.getString("trace_id"));
            m.put("reason", rs.getString("reason"));
            m.put("durationS", rs.getObject("duration_s"));
            m.put("result", rs.getString("result"));
            OffsetDateTime ra = rs.getObject("result_at", OffsetDateTime.class);
            m.put("resultAt", ra == null ? null : ra.toInstant());
            m.put("confirmedState", rs.getString("confirmed_state"));
            return m;
        }).list();
    }

    static OffsetDateTime utc(Instant t) {
        return t.atOffset(ZoneOffset.UTC);
    }
}
