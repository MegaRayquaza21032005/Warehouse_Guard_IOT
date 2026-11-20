package com.warehouse.backend.alert;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class AlertRepository {

    private static final String COLUMNS = """
            a.id, a.ts, a.type, a.level, a.message, a.source, a.incident_id,
            a.acknowledged_by, ua.username AS acknowledged_by_name, a.acknowledged_at,
            a.feedback, a.feedback_note, a.feedback_by""";
    private static final String FROM = " FROM app.alerts a LEFT JOIN app.users ua ON ua.id = a.acknowledged_by";

    private final JdbcClient jdbc;

    public AlertRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public long insert(String type, String level, String message, String source, String incidentId,
            String payloadJson) {
        return jdbc.sql("""
                INSERT INTO app.alerts (type, level, message, source, incident_id, payload)
                VALUES (?, ?, ?, ?, ?, ?::jsonb) RETURNING id""")
                .params(type, level, message, source, incidentId, payloadJson).query(Long.class).single();
    }

    public Optional<Map<String, Object>> find(long id) {
        return jdbc.sql("SELECT " + COLUMNS + FROM + " WHERE a.id = ?").params(id).query(AlertRepository::row)
                .optional();
    }

    public List<Map<String, Object>> list(String level, boolean unackedOnly, int limit, int offset) {
        StringBuilder sql = new StringBuilder("SELECT " + COLUMNS + FROM + " WHERE TRUE");
        List<Object> params = new ArrayList<>();
        if (level != null) {
            sql.append(" AND a.level = ?");
            params.add(level);
        }
        if (unackedOnly) {
            sql.append(" AND a.acknowledged_at IS NULL");
        }
        sql.append(" ORDER BY a.ts DESC, a.id DESC LIMIT ? OFFSET ?");
        params.add(limit);
        params.add(offset);
        return jdbc.sql(sql.toString()).params(params).query(AlertRepository::row).list();
    }

    public int acknowledge(long id, long userId) {
        return jdbc.sql("""
                UPDATE app.alerts SET acknowledged_by = ?, acknowledged_at = now()
                WHERE id = ? AND acknowledged_at IS NULL""").params(userId, id).update();
    }

    public int feedback(long id, String feedback, String note, long userId) {
        return jdbc.sql("UPDATE app.alerts SET feedback = ?, feedback_note = ?, feedback_by = ? WHERE id = ?")
                .params(feedback, note, userId, id).update();
    }

    private static Map<String, Object> row(ResultSet rs, int i) throws SQLException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", rs.getLong("id"));
        m.put("ts", rs.getObject("ts", OffsetDateTime.class).toInstant());
        m.put("type", rs.getString("type"));
        m.put("level", rs.getString("level"));
        m.put("message", rs.getString("message"));
        m.put("source", rs.getString("source"));
        m.put("incidentId", rs.getString("incident_id"));
        m.put("acknowledgedBy", rs.getObject("acknowledged_by"));
        m.put("acknowledgedByName", rs.getString("acknowledged_by_name"));
        OffsetDateTime ack = rs.getObject("acknowledged_at", OffsetDateTime.class);
        m.put("acknowledgedAt", ack == null ? null : ack.toInstant());
        m.put("feedback", rs.getString("feedback"));
        m.put("feedbackNote", rs.getString("feedback_note"));
        m.put("feedbackBy", rs.getObject("feedback_by"));
        return m;
    }
}
