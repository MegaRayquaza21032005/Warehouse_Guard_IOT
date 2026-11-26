package com.warehouse.backend.camera;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import com.warehouse.backend.common.Rows;

@Repository
public class CameraRepository {

    private static final String SNAPSHOT_COLUMNS = """
            id, ts, alert_id, alert_type, incident_id, person_count, content_type, size_bytes""";

    private final JdbcClient jdbc;

    public CameraRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** Phần so sánh để chống ghi trùng (độ tin cậy dao động nên không so). fire / smoke null = không có model lửa. */
    public record EventKey(boolean person, int personCount, String error, Boolean fire, Boolean smoke) {
    }

    public record Image(String contentType, byte[] data) {
    }

    public Optional<EventKey> lastEvent() {
        return jdbc.sql("""
                SELECT person, person_count, error, fire, smoke FROM app.camera_events
                ORDER BY ts DESC, id DESC LIMIT 1""")
                .query((rs, i) -> new EventKey(rs.getBoolean("person"), rs.getInt("person_count"),
                        rs.getString("error"), (Boolean) rs.getObject("fire"), (Boolean) rs.getObject("smoke")))
                .optional();
    }

    public void insertEvent(EventKey e, Double conf, Double fireConf, Double smokeConf) {
        jdbc.sql("""
                INSERT INTO app.camera_events (person, person_count, person_conf, error, fire, fire_conf, smoke, smoke_conf)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""")
                .params(e.person(), e.personCount(), conf, e.error(), e.fire(), fireConf, e.smoke(), smokeConf)
                .update();
    }

    public long insertSnapshot(Long alertId, String alertType, String incidentId, Integer personCount,
            String contentType, byte[] image) {
        return jdbc.sql("""
                INSERT INTO app.camera_snapshots (alert_id, alert_type, incident_id, person_count, content_type,
                                                  size_bytes, image)
                VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id""")
                .params(alertId, alertType, incidentId, personCount, contentType, image.length, image)
                .query(Long.class).single();
    }

    public List<Map<String, Object>> listSnapshots(Long alertId, String incidentId, int limit) {
        StringBuilder sql = new StringBuilder("SELECT " + SNAPSHOT_COLUMNS + " FROM app.camera_snapshots WHERE TRUE");
        List<Object> params = new ArrayList<>();
        if (alertId != null) {
            sql.append(" AND alert_id = ?");
            params.add(alertId);
        }
        if (incidentId != null) {
            sql.append(" AND incident_id = ?");
            params.add(incidentId);
        }
        sql.append(" ORDER BY ts DESC, id DESC LIMIT ?");
        params.add(limit);
        return jdbc.sql(sql.toString()).params(params).query(Rows::toMap).list();
    }

    public Optional<Image> image(long id) {
        return jdbc.sql("SELECT content_type, image FROM app.camera_snapshots WHERE id = ?").params(id)
                .query((rs, i) -> new Image(rs.getString("content_type"), rs.getBytes("image"))).optional();
    }

    public int deleteSnapshotsBefore(Instant before) {
        return jdbc.sql("DELETE FROM app.camera_snapshots WHERE ts < ?").params(Rows.utc(before)).update();
    }
}
