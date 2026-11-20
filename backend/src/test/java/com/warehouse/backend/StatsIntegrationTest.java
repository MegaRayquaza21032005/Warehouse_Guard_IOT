package com.warehouse.backend;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.OffsetDateTime;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Dữ liệu dựng tay với thời điểm cố định — thứ Hai 05/01/2026, giờ Việt Nam (+07:00).
 */
class StatsIntegrationTest extends IntegrationTestBase {

    private static final String DAY = "2026-01-05T";
    private String auth;

    @BeforeEach
    void setUp() throws Exception {
        auth = "Bearer " + registerAndGetToken("thanh");
    }

    private void climate(String time, double temp, double hum) {
        jdbc.sql("INSERT INTO app.climate_readings (ts, temp, hum) VALUES (?, ?, ?)")
                .params(OffsetDateTime.parse(DAY + time + "+07:00"), temp, hum).update();
    }

    private void fan(String time, String state, String reason) {
        jdbc.sql("INSERT INTO app.device_states (ts, device, state, mode, reason, source) VALUES (?, 'fan', ?, 'auto', ?, 'esp32_local')")
                .params(OffsetDateTime.parse(DAY + time + "+07:00"), state, reason).update();
    }

    /** Giờ địa phương -> tham số from/to dạng UTC "...Z" (tránh dấu + phải mã hóa trong URL). */
    private String range(String fromTime, String toTime) {
        return "&from=" + utc(fromTime) + "&to=" + utc(toTime);
    }

    private static String utc(String localTime) {
        return OffsetDateTime.parse(DAY + localTime + "+07:00").toInstant().toString();
    }

    @Test
    void temperatureAggregatesPerHour() throws Exception {
        climate("00:10:00", 30, 60);
        climate("00:40:00", 32, 62);
        climate("01:15:00", 40, 85);
        mvc.perform(get("/api/stats?metric=temp&interval=1h&agg=avg,max" + range("00:00:00", "02:00:00"))
                .header("Authorization", auth))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.series[0].name").value("avg"))
                .andExpect(jsonPath("$.series[0].points[0].t").value("2026-01-04T17:00:00Z"))
                .andExpect(jsonPath("$.series[0].points[0].v").value(31.0))
                .andExpect(jsonPath("$.series[0].points[1].v").value(40.0))
                .andExpect(jsonPath("$.series[1].name").value("max"))
                .andExpect(jsonPath("$.series[1].points[0].v").value(32.0));

        // % thời gian vượt ngưỡng (mặc định tempHigh 38, humHigh 80): giờ 01 -> 100%
        mvc.perform(get("/api/stats?metric=threshold_exceeded_pct&interval=1h" + range("00:00:00", "02:00:00"))
                .header("Authorization", auth))
                .andExpect(jsonPath("$.series[0].name").value("temp"))
                .andExpect(jsonPath("$.series[0].points[0].v").value(0.0))
                .andExpect(jsonPath("$.series[0].points[1].v").value(100.0))
                .andExpect(jsonPath("$.series[1].points[1].v").value(100.0));

        // Heatmap theo giờ x thứ: thứ Hai (1), giờ địa phương 0 và 1
        mvc.perform(get("/api/stats?metric=temp&group_by=hour_of_day,day_of_week" + range("00:00:00", "02:00:00"))
                .header("Authorization", auth))
                .andExpect(jsonPath("$.cells[0].dayOfWeek").value(1))
                .andExpect(jsonPath("$.cells[0].hour").value(0))
                .andExpect(jsonPath("$.cells[0].v").value(31.0))
                .andExpect(jsonPath("$.cells[1].hour").value(1));
    }

    @Test
    void deviceOnMinutesSplitsAcrossBucketsAndReasons() throws Exception {
        fan("00:00:00", "on", "gas");
        fan("00:30:00", "off", "idle");
        fan("00:50:00", "on", "hum_high");
        fan("01:20:00", "off", "idle");
        mvc.perform(get("/api/stats?metric=device_on_minutes&device=fan&interval=1h" + range("00:00:00", "02:00:00"))
                .header("Authorization", auth))
                .andExpect(jsonPath("$.series[0].points[0].v").value(40.0))   // 30 + 10 phút
                .andExpect(jsonPath("$.series[0].points[1].v").value(20.0));
        mvc.perform(get("/api/stats?metric=device_on_minutes&device=fan&interval=1h&group_by=reason"
                + range("00:00:00", "02:00:00")).header("Authorization", auth))
                .andExpect(jsonPath("$.series[?(@.name=='gas')].points[0].v").value(30.0))
                .andExpect(jsonPath("$.series[?(@.name=='hum_high')].points[0].v").value(10.0));

        mvc.perform(get("/api/stats/timeline?device=fan" + range("00:10:00", "01:00:00")).header("Authorization", auth))
                .andExpect(jsonPath("$[0].start").value("2026-01-04T17:10:00Z"))   // cắt theo from
                .andExpect(jsonPath("$[0].state").value("on"))
                .andExpect(jsonPath("$[1].state").value("off"))
                .andExpect(jsonPath("$[2].end").value("2026-01-04T18:00:00Z"));    // cắt theo to
    }

    @Test
    void motionSplitsWorkHoursAndAfterHours() throws Exception {
        for (String t : new String[] { "09:00:00", "10:30:00", "20:00:00" }) {
            jdbc.sql("INSERT INTO app.motion_events (ts, motion) VALUES (?, true)")
                    .params(OffsetDateTime.parse(DAY + t + "+07:00")).update();
        }
        jdbc.sql("INSERT INTO app.motion_events (ts, motion) VALUES (?, false)")
                .params(OffsetDateTime.parse(DAY + "09:00:30+07:00")).update();
        mvc.perform(get("/api/stats?metric=motion_count&interval=1d&group_by=work_hours" + range("00:00:00", "23:59:59"))
                .header("Authorization", auth))
                .andExpect(jsonPath("$.series[?(@.name=='work_hours')].points[0].v").value(2.0))
                .andExpect(jsonPath("$.series[?(@.name=='after_hours')].points[0].v").value(1.0))
                .andExpect(jsonPath("$.series[0].points[0].t").value("2026-01-04T17:00:00Z")); // nửa đêm giờ VN
    }

    private void alert(String time, String type, String level, String feedback, String payload) {
        jdbc.sql("INSERT INTO app.alerts (ts, type, level, message, source, payload, feedback)"
                + " VALUES (?, ?, ?, 'm', 'rule', ?::jsonb, ?)")
                .params(OffsetDateTime.parse(DAY + time + "+07:00"), type, level, payload, feedback).update();
    }

    private void health(String time, Boolean online, Integer rssi) {
        jdbc.sql("INSERT INTO app.device_health (ts, online, rssi) VALUES (?, ?, ?)")
                .params(OffsetDateTime.parse(DAY + time + "+07:00"), online, rssi).update();
    }

    @Test
    void alertAndSystemMetrics() throws Exception {
        alert("00:10:00", "gas", "warning", "false_alarm", "{}");
        alert("00:20:00", "gas", "warning", "true_alarm", "{}");
        alert("00:30:00", "fire", "critical", null, "{}");
        alert("00:40:00", "recovered", "info", null, "{\"details\":{\"duration_min\":12}}");
        alert("01:40:00", "recovered", "info", null, "{\"details\":{\"duration_min\":18}}");
        mvc.perform(get("/api/stats?metric=alert_count&interval=1h&group_by=type" + range("00:00:00", "02:00:00"))
                .header("Authorization", auth))
                .andExpect(jsonPath("$.series[?(@.name=='gas')].points[0].v").value(2.0))
                .andExpect(jsonPath("$.series[?(@.name=='recovered')].points.length()").value(2));
        mvc.perform(get("/api/stats?metric=false_alarm_rate&interval=1d" + range("00:00:00", "23:00:00"))
                .header("Authorization", auth)).andExpect(jsonPath("$.series[0].points[0].v").value(50.0));
        mvc.perform(get("/api/stats?metric=incident_resolve_minutes" + range("00:00:00", "02:00:00"))
                .header("Authorization", auth)).andExpect(jsonPath("$.series[0].points[0].v").value(15.0));

        health("00:00:00", true, null);
        health("00:05:00", null, -60);
        health("00:35:00", null, -50);
        health("01:00:00", false, null);
        health("01:30:00", true, null);
        mvc.perform(get("/api/stats?metric=device_online" + range("00:00:00", "02:00:00"))
                .header("Authorization", auth))
                .andExpect(jsonPath("$.series[0].name").value("uptime_pct"))
                .andExpect(jsonPath("$.series[0].points[0].v").value(75.0));
        mvc.perform(get("/api/stats?metric=rssi&interval=1h" + range("00:00:00", "02:00:00"))
                .header("Authorization", auth)).andExpect(jsonPath("$.series[0].points[0].v").value(-55.0));
    }

    @Test
    void motionEventsOnlyAfterHours() throws Exception {
        for (String t : new String[] { "09:00:00", "20:00:00", "22:15:00" }) {
            jdbc.sql("INSERT INTO app.motion_events (ts, motion) VALUES (?, true)")
                    .params(OffsetDateTime.parse(DAY + t + "+07:00")).update();
        }
        mvc.perform(get("/api/stats?metric=motion_events" + range("00:00:00", "23:59:59"))
                .header("Authorization", auth))
                .andExpect(jsonPath("$.series[0].name").value("after_hours"))
                .andExpect(jsonPath("$.series[0].points.length()").value(2))
                .andExpect(jsonPath("$.series[0].points[0].t").value("2026-01-05T13:00:00Z"));
        for (int i = 0; i < 10; i++) {
            jdbc.sql("INSERT INTO app.mq2_readings (ts, raw, mv, level, warming_up) VALUES (?, ?, 0, 'normal', false)")
                    .params(OffsetDateTime.parse(DAY + "00:0" + i + ":00+07:00"), 100 + i * 10).update();
        }
        mvc.perform(get("/api/stats?metric=mq2_baseline&interval=1h" + range("00:00:00", "01:00:00"))
                .header("Authorization", auth)).andExpect(jsonPath("$.series[0].points[0].v").value(109.0));
    }

    @Test
    void rejectsBadParameters() throws Exception {
        mvc.perform(get("/api/stats?metric=foo").header("Authorization", auth)).andExpect(status().isBadRequest());
        mvc.perform(get("/api/stats?metric=temp&interval=2h").header("Authorization", auth))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/stats?metric=temp&agg=sum").header("Authorization", auth))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/stats?metric=temp&interval=5m&from=2025-01-01T00:00:00Z&to=2026-01-01T00:00:00Z")
                .header("Authorization", auth)).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("too_many_points"));
        mvc.perform(get("/api/stats?metric=device_on_minutes").header("Authorization", auth))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/stats?metric=temp&group_by=reason").header("Authorization", auth))
                .andExpect(status().isBadRequest());
    }
}
