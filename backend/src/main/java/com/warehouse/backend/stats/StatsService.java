package com.warehouse.backend.stats;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.common.Rows;
import com.warehouse.backend.common.TimeRange;
import com.warehouse.backend.config.AppProperties;
import com.warehouse.backend.device.ConfigService;
import com.warehouse.backend.mqtt.Topics;

/**
 * Thống kê tính bằng SQL (CLAUDE.md mục 6 — danh mục số liệu giai đoạn 1).
 * Tên bảng / cột / hàm tổng hợp chỉ lấy từ danh sách cố định, không ghép từ input người dùng.
 */
@Service
public class StatsService {

    public record Point(Instant t, Double v) {
    }

    public record Series(String name, List<Point> points) {
    }

    public record HeatCell(int dayOfWeek, int hour, Double v) {
    }

    public record StatsResponse(String metric, String interval, Instant from, Instant to, String groupBy,
            List<Series> series, List<HeatCell> cells) {
    }

    public record TimelineSegment(Instant start, Instant end, String state, String reason, String source) {
    }

    private static final Map<String, String> INTERVALS = Map.of(
            "5m", "5 minutes", "1h", "1 hour", "1d", "1 day", "1w", "7 days");
    private static final Map<String, Duration> INTERVAL_DURATION = Map.of(
            "5m", Duration.ofMinutes(5), "1h", Duration.ofHours(1), "1d", Duration.ofDays(1), "1w", Duration.ofDays(7));
    private static final int MAX_BUCKETS = 2000;
    private static final Set<String> AGGS = Set.of("avg", "min", "max");
    public static final String HEATMAP = "hour_of_day,day_of_week";

    /** metric -> {bảng, cột, điều kiện lọc} cho số liệu dạng giá trị đo. */
    private static final Map<String, String[]> MEASURES = Map.of(
            "temp", new String[] { "app.climate_readings", "temp", "temp IS NOT NULL" },
            "hum", new String[] { "app.climate_readings", "hum", "hum IS NOT NULL" },
            "mq135", new String[] { "app.mq135_readings", "raw", "NOT warming_up" });

    public static final List<String> METRICS = List.of("temp", "hum", "mq135", "motion_count", "motion_events",
            "threshold_exceeded_pct", "device_on_minutes", "command_count", "alert_count", "false_alarm_rate",
            "incident_resolve_minutes", "device_online", "rssi", "mq135_baseline");

    private static final String BUCKET = "date_bin(CAST(:step AS interval), ts, CAST(:origin AS timestamptz))";

    private final JdbcClient jdbc;
    private final AppProperties props;
    private final ConfigService config;

    public StatsService(JdbcClient jdbc, AppProperties props, ConfigService config) {
        this.jdbc = jdbc;
        this.props = props;
        this.config = config;
    }

    public StatsResponse query(String metric, Instant from, Instant to, String interval, List<String> aggs,
            String groupBy, String device) {
        if (!METRICS.contains(metric)) {
            throw ApiException.badRequest("unknown_metric", "metric hợp lệ: " + METRICS);
        }
        String iv = interval == null ? "1h" : interval;
        if (!INTERVALS.containsKey(iv)) {
            throw ApiException.badRequest("invalid_interval", "interval hợp lệ: " + INTERVALS.keySet());
        }
        TimeRange r = TimeRange.of(from, to, Duration.ofHours(24));
        boolean heatmap = HEATMAP.equals(groupBy);
        if (!heatmap && r.span().dividedBy(INTERVAL_DURATION.get(iv)) > MAX_BUCKETS) {
            throw ApiException.badRequest("too_many_points",
                    "Quá nhiều điểm (tối đa " + MAX_BUCKETS + "), hãy tăng interval hoặc thu hẹp khoảng thời gian");
        }
        Params p = new Params(r, INTERVALS.get(iv), origin());

        return switch (metric) {
            case "temp", "hum", "mq135" -> measure(metric, p, aggs, groupBy, iv);
            case "motion_count" -> motionCount(p, groupBy, iv);
            case "threshold_exceeded_pct" -> thresholdPct(p, groupBy, iv);
            case "device_on_minutes" -> deviceOnMinutes(p, groupBy, device, iv);
            case "command_count" -> commandCount(p, groupBy, device, iv);
            case "motion_events" -> motionEvents(p, iv);
            case "alert_count" -> alertCount(p, groupBy, iv);
            case "false_alarm_rate" -> falseAlarmRate(p, iv);
            case "incident_resolve_minutes" -> incidentResolve(p, iv);
            case "device_online" -> deviceOnline(p, iv);
            case "rssi" -> simple("rssi", "avg(rssi)", "app.device_health", "rssi IS NOT NULL", p, iv);
            case "mq135_baseline" -> simple("mq135_baseline", "percentile_cont(0.1) WITHIN GROUP (ORDER BY raw)",
                    "app.mq135_readings", "NOT warming_up", p, iv);
            default -> throw new IllegalStateException(metric);
        };
    }

    // ---------------- Giá trị đo: nhiệt độ, độ ẩm, MQ135 ----------------
    private StatsResponse measure(String metric, Params p, List<String> aggs, String groupBy, String iv) {
        String[] m = MEASURES.get(metric);
        if (HEATMAP.equals(groupBy)) {
            List<HeatCell> cells = heat("avg(" + m[1] + ")", m[0], m[2], p);
            return new StatsResponse(metric, iv, p.r.from(), p.r.to(), groupBy, List.of(), cells);
        }
        requireNoGroup(groupBy, metric);
        List<String> as = aggs == null || aggs.isEmpty() ? List.of("avg") : aggs;
        for (String a : as) {
            if (!AGGS.contains(a)) {
                throw ApiException.badRequest("invalid_agg", "agg hợp lệ: " + AGGS);
            }
        }
        String select = as.stream().map(a -> a + "(" + m[1] + ")::float8 AS " + a).collect(Collectors.joining(", "));
        String sql = "SELECT " + BUCKET + " AS bucket, " + select + " FROM " + m[0]
                + " WHERE ts >= :from AND ts < :to AND " + m[2] + " GROUP BY 1 ORDER BY 1";
        Map<String, List<Point>> byAgg = new LinkedHashMap<>();
        as.forEach(a -> byAgg.put(a, new ArrayList<>()));
        p.bind(jdbc.sql(sql)).query((ResultSet rs) -> {
            Instant t = bucket(rs);
            for (String a : as) {
                byAgg.get(a).add(new Point(t, dbl(rs, a)));
            }
        });
        return new StatsResponse(metric, iv, p.r.from(), p.r.to(), null, toSeries(byAgg), List.of());
    }

    // ---------------- Chuyển động ----------------
    private StatsResponse motionCount(Params p, String groupBy, String iv) {
        if (HEATMAP.equals(groupBy)) {
            List<HeatCell> cells = heat("count(*)", "app.motion_events", "motion", p);
            return new StatsResponse("motion_count", iv, p.r.from(), p.r.to(), groupBy, List.of(), cells);
        }
        String grp;
        if (groupBy == null) {
            grp = "'count'";
        } else if ("work_hours".equals(groupBy)) {
            grp = "CASE WHEN extract(isodow FROM ts AT TIME ZONE :tz)::int = ANY(CAST(:days AS int[]))"
                    + " AND (ts AT TIME ZONE :tz)::time >= CAST(:wstart AS time)"
                    + " AND (ts AT TIME ZONE :tz)::time < CAST(:wend AS time)"
                    + " THEN 'work_hours' ELSE 'after_hours' END";
        } else {
            throw ApiException.badRequest("invalid_group_by", "motion_count hỗ trợ group_by: work_hours, " + HEATMAP);
        }
        String sql = "SELECT " + BUCKET + " AS bucket, " + grp + " AS grp, count(*)::float8 AS v"
                + " FROM app.motion_events WHERE motion AND ts >= :from AND ts < :to GROUP BY 1, 2 ORDER BY 1";
        var spec = p.bind(jdbc.sql(sql));
        if ("work_hours".equals(groupBy)) {
            AppProperties.WorkHours wh = props.workHours();
            String days = wh.days().stream().map(String::valueOf).collect(Collectors.joining(",", "{", "}"));
            spec = spec.param("tz", props.timezone()).param("days", days)
                    .param("wstart", wh.startTime().toString()).param("wend", wh.endTime().toString());
        }
        return new StatsResponse("motion_count", iv, p.r.from(), p.r.to(), groupBy, grouped(spec), List.of());
    }

    // ---------------- % thời gian vượt ngưỡng ----------------
    private StatsResponse thresholdPct(Params p, String groupBy, String iv) {
        requireNoGroup(groupBy, "threshold_exceeded_pct");
        Map<String, Object> cfg = config.current();
        String sql = "SELECT " + BUCKET + " AS bucket,"
                + " 100.0 * avg(CASE WHEN temp >= :th THEN 1 ELSE 0 END)::float8 AS temp,"
                + " 100.0 * avg(CASE WHEN hum >= :hh THEN 1 ELSE 0 END)::float8 AS hum"
                + " FROM app.climate_readings WHERE ts >= :from AND ts < :to AND temp IS NOT NULL AND hum IS NOT NULL"
                + " GROUP BY 1 ORDER BY 1";
        Map<String, List<Point>> s = new LinkedHashMap<>();
        s.put("temp", new ArrayList<>());
        s.put("hum", new ArrayList<>());
        p.bind(jdbc.sql(sql))
                .param("th", ((Number) cfg.get("tempHigh")).doubleValue())
                .param("hh", ((Number) cfg.get("humHigh")).doubleValue())
                .query((ResultSet rs) -> {
                    Instant t = bucket(rs);
                    s.get("temp").add(new Point(t, dbl(rs, "temp")));
                    s.get("hum").add(new Point(t, dbl(rs, "hum")));
                });
        return new StatsResponse("threshold_exceeded_pct", iv, p.r.from(), p.r.to(), null, toSeries(s), List.of());
    }

    // ---------------- Thời gian thiết bị chạy ----------------
    private StatsResponse deviceOnMinutes(Params p, String groupBy, String device, String iv) {
        requireDevice(device);
        if (groupBy != null && !"reason".equals(groupBy)) {
            throw ApiException.badRequest("invalid_group_by", "device_on_minutes hỗ trợ group_by: reason");
        }
        String grp = "reason".equals(groupBy) ? "coalesce(iv.reason, 'unknown')" : "'minutes'";
        String sql = """
                WITH s AS (
                    SELECT ts AS start_ts, lead(ts) OVER (ORDER BY ts, id) AS next_ts, state, reason
                    FROM app.device_states WHERE device = :device AND ts < :to
                ), iv AS (
                    SELECT greatest(start_ts, CAST(:from AS timestamptz)) AS s,
                           least(coalesce(next_ts, now()), CAST(:to AS timestamptz)) AS e, reason
                    FROM s WHERE state = 'on'
                ), b AS (
                    SELECT g AS bstart, g + CAST(:step AS interval) AS bend
                    FROM generate_series(
                        date_bin(CAST(:step AS interval), CAST(:from AS timestamptz), CAST(:origin AS timestamptz)),
                        CAST(:to AS timestamptz) - interval '1 microsecond', CAST(:step AS interval)) AS g
                )
                SELECT b.bstart AS bucket, %s AS grp,
                       (sum(extract(epoch FROM (least(b.bend, iv.e) - greatest(b.bstart, iv.s)))) / 60.0)::float8 AS v
                FROM b JOIN iv ON iv.s < b.bend AND iv.e > b.bstart AND iv.e > iv.s
                GROUP BY 1, 2 ORDER BY 1""".formatted(grp);
        var spec = p.bind(jdbc.sql(sql)).param("device", device);
        return new StatsResponse("device_on_minutes", iv, p.r.from(), p.r.to(), groupBy, grouped(spec), List.of());
    }

    // ---------------- Số lệnh theo nguồn ----------------
    private StatsResponse commandCount(Params p, String groupBy, String device, String iv) {
        if (groupBy != null && !"source".equals(groupBy)) {
            throw ApiException.badRequest("invalid_group_by", "command_count hỗ trợ group_by: source");
        }
        if (device != null) {
            requireDevice(device);
        }
        String grp = "source".equals(groupBy) ? "source" : "'count'";
        String sql = "SELECT " + BUCKET + " AS bucket, " + grp + " AS grp, count(*)::float8 AS v"
                + " FROM app.device_command_logs WHERE ts >= :from AND ts < :to"
                + (device != null ? " AND device = :device" : "") + " GROUP BY 1, 2 ORDER BY 1";
        var spec = p.bind(jdbc.sql(sql));
        if (device != null) {
            spec = spec.param("device", device);
        }
        return new StatsResponse("command_count", iv, p.r.from(), p.r.to(), groupBy, grouped(spec), List.of());
    }

    // ---------------- Chuyển động ngoài giờ (từng lần, dạng chấm) ----------------
    private StatsResponse motionEvents(Params p, String iv) {
        AppProperties.WorkHours wh = props.workHours();
        String days = wh.days().stream().map(String::valueOf).collect(Collectors.joining(",", "{", "}"));
        String sql = "SELECT ts AS bucket, 1.0::float8 AS v FROM app.motion_events WHERE motion"
                + " AND ts >= :from AND ts < :to AND NOT (extract(isodow FROM ts AT TIME ZONE :tz)::int"
                + " = ANY(CAST(:days AS int[])) AND (ts AT TIME ZONE :tz)::time >= CAST(:wstart AS time)"
                + " AND (ts AT TIME ZONE :tz)::time < CAST(:wend AS time)) ORDER BY ts LIMIT " + MAX_BUCKETS;
        List<Point> pts = new ArrayList<>();
        jdbc.sql(sql).param("from", Rows.utc(p.r.from())).param("to", Rows.utc(p.r.to()))
                .param("tz", props.timezone()).param("days", days)
                .param("wstart", wh.startTime().toString()).param("wend", wh.endTime().toString())
                .query((ResultSet rs) -> {
                    pts.add(new Point(bucket(rs), 1.0));
                });
        return new StatsResponse("motion_events", iv, p.r.from(), p.r.to(), null,
                List.of(new Series("after_hours", pts)), List.of());
    }

    // ---------------- Cảnh báo ----------------
    private StatsResponse alertCount(Params p, String groupBy, String iv) {
        if (groupBy != null && !List.of("type", "level", "source").contains(groupBy)) {
            throw ApiException.badRequest("invalid_group_by", "alert_count hỗ trợ group_by: type, level, source");
        }
        String grp = groupBy == null ? "'count'" : groupBy; // chỉ là tên cột cố định đã kiểm tra ở trên
        String sql = "SELECT " + BUCKET + " AS bucket, " + grp + " AS grp, count(*)::float8 AS v"
                + " FROM app.alerts WHERE ts >= :from AND ts < :to GROUP BY 1, 2 ORDER BY 1";
        return new StatsResponse("alert_count", iv, p.r.from(), p.r.to(), groupBy, grouped(p.bind(jdbc.sql(sql))),
                List.of());
    }

    /** % cảnh báo bị đánh dấu báo giả trong số cảnh báo đã có phản hồi. */
    private StatsResponse falseAlarmRate(Params p, String iv) {
        String sql = "SELECT " + BUCKET + " AS bucket, 'rate' AS grp,"
                + " (100.0 * avg(CASE WHEN feedback = 'false_alarm' THEN 1 ELSE 0 END))::float8 AS v"
                + " FROM app.alerts WHERE ts >= :from AND ts < :to AND feedback IS NOT NULL GROUP BY 1 ORDER BY 1";
        return new StatsResponse("false_alarm_rate", iv, p.r.from(), p.r.to(), null, grouped(p.bind(jdbc.sql(sql))),
                List.of());
    }

    /** Thời gian xử lý sự cố trung bình (phút) — từ cảnh báo "recovered" (details.duration_min). */
    private StatsResponse incidentResolve(Params p, String iv) {
        String sql = "SELECT avg((payload->'details'->>'duration_min')::float8)::float8 AS v FROM app.alerts"
                + " WHERE type = 'recovered' AND ts >= :from AND ts < :to"
                + " AND jsonb_typeof(payload->'details'->'duration_min') = 'number'";
        Double v = p.bind(jdbc.sql(sql)).query((rs, i) -> dbl(rs, "v")).optional().orElse(null);
        return stat("incident_resolve_minutes", "avg", v, p, iv);
    }

    /** % thời gian ESP32 trực tuyến (theo status/online, kể cả trạng thái từ trước khoảng thời gian). */
    private StatsResponse deviceOnline(Params p, String iv) {
        String sql = """
                WITH s AS (
                    SELECT ts, lead(ts) OVER (ORDER BY ts, id) AS next_ts, online
                    FROM app.device_health WHERE online IS NOT NULL AND ts < :to
                ), iv AS (
                    SELECT greatest(ts, CAST(:from AS timestamptz)) AS s,
                           least(coalesce(next_ts, now()), CAST(:to AS timestamptz)) AS e, online
                    FROM s WHERE coalesce(next_ts, now()) > CAST(:from AS timestamptz)
                )
                SELECT (100.0 * sum(CASE WHEN online THEN extract(epoch FROM e - s) ELSE 0 END)
                        / nullif(sum(extract(epoch FROM e - s)), 0))::float8 AS v
                FROM iv WHERE e > s""";
        Double v = p.bind(jdbc.sql(sql)).query((rs, i) -> dbl(rs, "v")).optional().orElse(null);
        return stat("device_online", "uptime_pct", v, p, iv);
    }

    /** Một chuỗi số theo bucket: biểu thức tổng hợp cố định trên một bảng cố định. */
    private StatsResponse simple(String metric, String aggExpr, String table, String where, Params p, String iv) {
        String sql = "SELECT " + BUCKET + " AS bucket, 'avg' AS grp, (" + aggExpr + ")::float8 AS v FROM " + table
                + " WHERE ts >= :from AND ts < :to AND " + where + " GROUP BY 1 ORDER BY 1";
        return new StatsResponse(metric, iv, p.r.from(), p.r.to(), null, grouped(p.bind(jdbc.sql(sql))), List.of());
    }

    private static StatsResponse stat(String metric, String name, Double v, Params p, String iv) {
        List<Point> pts = v == null ? List.of() : List.of(new Point(p.r.to(), v));
        return new StatsResponse(metric, iv, p.r.from(), p.r.to(), null, List.of(new Series(name, pts)), List.of());
    }

    // ---------------- Dòng thời gian bật/tắt ----------------
    public List<TimelineSegment> timeline(String device, Instant from, Instant to) {
        requireDevice(device);
        TimeRange r = TimeRange.of(from, to, Duration.ofHours(24));
        String sql = """
                WITH s AS (
                    SELECT ts, id, lead(ts) OVER (ORDER BY ts, id) AS next_ts, state, reason, source
                    FROM app.device_states WHERE device = :device AND ts < :to
                )
                SELECT greatest(ts, CAST(:from AS timestamptz)) AS start_ts,
                       least(coalesce(next_ts, now()), CAST(:to AS timestamptz)) AS end_ts, state, reason, source
                FROM s WHERE coalesce(next_ts, now()) > CAST(:from AS timestamptz) ORDER BY ts, id""";
        return jdbc.sql(sql).param("device", device).param("from", Rows.utc(r.from())).param("to", Rows.utc(r.to()))
                .query((rs, i) -> new TimelineSegment(
                        rs.getObject("start_ts", OffsetDateTime.class).toInstant(),
                        rs.getObject("end_ts", OffsetDateTime.class).toInstant(),
                        rs.getString("state"), rs.getString("reason"), rs.getString("source")))
                .list();
    }

    // ---------------- Tiện ích ----------------
    private List<HeatCell> heat(String aggExpr, String table, String where, Params p) {
        String sql = "SELECT extract(isodow FROM ts AT TIME ZONE :tz)::int AS dow,"
                + " extract(hour FROM ts AT TIME ZONE :tz)::int AS hour, (" + aggExpr + ")::float8 AS v"
                + " FROM " + table + " WHERE ts >= :from AND ts < :to AND " + where + " GROUP BY 1, 2 ORDER BY 1, 2";
        return jdbc.sql(sql).param("tz", props.timezone()).param("from", Rows.utc(p.r.from()))
                .param("to", Rows.utc(p.r.to()))
                .query((rs, i) -> new HeatCell(rs.getInt("dow"), rs.getInt("hour"), dbl(rs, "v"))).list();
    }

    private List<Series> grouped(JdbcClient.StatementSpec spec) {
        Map<String, List<Point>> m = new LinkedHashMap<>();
        spec.query((ResultSet rs) -> {
            m.computeIfAbsent(rs.getString("grp"), k -> new ArrayList<>()).add(new Point(bucket(rs), dbl(rs, "v")));
        });
        return toSeries(m);
    }

    private static List<Series> toSeries(Map<String, List<Point>> m) {
        return m.entrySet().stream().map(e -> new Series(e.getKey(), e.getValue())).toList();
    }

    private static void requireNoGroup(String groupBy, String metric) {
        if (groupBy != null) {
            throw ApiException.badRequest("invalid_group_by",
                    metric + " chỉ hỗ trợ group_by=" + HEATMAP + " (hoặc không group)");
        }
    }

    private static void requireDevice(String device) {
        if (device == null || !Topics.DEVICES.contains(device)) {
            throw ApiException.badRequest("invalid_device", "Cần tham số device: " + Topics.DEVICES);
        }
    }

    private static Instant bucket(ResultSet rs) throws SQLException {
        return rs.getObject("bucket", OffsetDateTime.class).toInstant();
    }

    private static Double dbl(ResultSet rs, String col) throws SQLException {
        double v = rs.getDouble(col);
        return rs.wasNull() ? null : Math.round(v * 100.0) / 100.0;
    }

    /** Mốc chia bucket: 00:00 thứ Hai theo giờ địa phương -> bucket ngày/tuần bắt đầu đúng nửa đêm / thứ Hai. */
    private OffsetDateTime origin() {
        return LocalDate.of(2000, 1, 3).atStartOfDay(props.zone()).toOffsetDateTime();
    }

    private record Params(TimeRange r, String step, OffsetDateTime origin) {
        JdbcClient.StatementSpec bind(JdbcClient.StatementSpec spec) {
            return spec.param("step", step).param("origin", origin).param("from", Rows.utc(r.from()))
                    .param("to", Rows.utc(r.to()));
        }
    }
}
