package com.warehouse.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/** Camera: lưu sự kiện, chụp ảnh khi có sự cố, chuyển tiếp MJPEG / ảnh từ service vision (giả = HttpServer). */
class CameraIntegrationTest extends IntegrationTestBase {

    static final byte[] JPEG = { (byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 1, 2, 3, (byte) 0xFF, (byte) 0xD9 };
    static HttpServer vision;
    static final Map<String, Map<String, String>> received = new ConcurrentHashMap<>();
    static volatile int snapshotStatus = 200;

    @BeforeAll
    static void startFakeVision() throws IOException {
        vision = HttpServer.create(new InetSocketAddress("127.0.0.1", VISION_PORT), 0);
        vision.createContext("/", CameraIntegrationTest::handle);
        vision.start();
    }

    @AfterAll
    static void stopFakeVision() {
        vision.stop(0);
    }

    @BeforeEach
    void reset() {
        received.clear();
        snapshotStatus = 200;
    }

    static void handle(HttpExchange ex) throws IOException {
        String path = ex.getRequestURI().getPath();
        received.put(path, Map.of("query", String.valueOf(ex.getRequestURI().getRawQuery()),
                "key", String.valueOf(ex.getRequestHeaders().getFirst("X-Internal-Key"))));
        switch (path) {
            case "/status" -> send(ex, 200, "application/json",
                    "{\"camera\":{\"opened\":true},\"model\":{\"name\":\"yolo26n.pt\"},\"detection\":{\"person\":true}}"
                            .getBytes(StandardCharsets.UTF_8));
            case "/snapshot.jpg" -> {
                if (snapshotStatus == 200) {
                    send(ex, 200, "image/jpeg", JPEG);
                } else {
                    send(ex, snapshotStatus, "application/json",
                            "{\"detail\":{\"error\":\"no_frame\",\"message\":\"x\"}}".getBytes(StandardCharsets.UTF_8));
                }
            }
            case "/stream.mjpg" -> {
                // 2 khung rồi đóng (vision thật thì chạy mãi)
                ex.getResponseHeaders().set("Content-Type", "multipart/x-mixed-replace; boundary=frame");
                ex.sendResponseHeaders(200, 0);
                try (OutputStream out = ex.getResponseBody()) {
                    for (int i = 0; i < 2; i++) {
                        out.write(("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + JPEG.length + "\r\n\r\n")
                                .getBytes(StandardCharsets.US_ASCII));
                        out.write(JPEG);
                        out.write("\r\n".getBytes(StandardCharsets.US_ASCII));
                    }
                }
            }
            default -> send(ex, 404, "text/plain", new byte[0]);
        }
    }

    static void send(HttpExchange ex, int code, String type, byte[] body) throws IOException {
        ex.getResponseHeaders().set("Content-Type", type);
        ex.sendResponseHeaders(code, body.length == 0 ? -1 : body.length);
        if (body.length > 0) {
            try (OutputStream out = ex.getResponseBody()) {
                out.write(body);
            }
        }
        ex.close();
    }

    // ---------------------------------------------------------------- MQTT -> DB / trạng thái hiện tại
    @Test
    void cameraReadingsAreStoredOnlyWhenChangedAndShownInState() throws Exception {
        String token = registerAndGetToken("cam1");
        mqttIn("warehouse/status/camera", Map.of("status", "online", "model", "yolo26n.pt", "device", "cuda:0"));
        mqttIn("warehouse/sensor/camera", Map.of("person", false, "personCount", 0, "fps", 9.8));
        mqttIn("warehouse/sensor/camera", Map.of("person", false, "personCount", 0, "fps", 9.7));   // trùng
        mqttIn("warehouse/sensor/camera", Map.of("person", true, "personCount", 2, "personConf", 0.91, "fps", 9.8));
        mqttIn("warehouse/sensor/camera", Map.of("person", true, "personCount", 2, "personConf", 0.88, "fps", 9.8));
        mqttIn("warehouse/sensor/camera", Map.of("error", "camera_unavailable"));

        List<Map<String, Object>> rows = jdbc.sql(
                "SELECT person, person_count, person_conf, error FROM app.camera_events ORDER BY id")
                .query((rs, i) -> Map.<String, Object>of("person", rs.getBoolean(1), "count", rs.getInt(2),
                        "error", String.valueOf(rs.getString(4))))
                .list();
        assertThat(rows).containsExactly(
                Map.of("person", false, "count", 0, "error", "null"),
                Map.of("person", true, "count", 2, "error", "null"),
                Map.of("person", false, "count", 0, "error", "camera_unavailable"));

        mvc.perform(get("/api/state").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sensors.camera.data.error").value("camera_unavailable"))
                .andExpect(jsonPath("$.camera.data.status").value("online"))
                .andExpect(jsonPath("$.camera.data.model").value("yolo26n.pt"));
        mvc.perform(get("/api/readings/camera").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(3))
                .andExpect(jsonPath("$[1].personCount").value(2));
    }

    @Test
    void fireAndSmokeReadingsAreStoredOnlyWhenChanged() throws Exception {
        String token = registerAndGetToken("cam4");
        Map<String, Object> clear = new java.util.HashMap<>(Map.of("person", false, "personCount", 0, "fire", false,
                "smoke", false, "fps", 9.8));
        mqttIn("warehouse/sensor/camera", Map.of("person", false, "personCount", 0, "fps", 9.8));  // chưa có model lửa
        mqttIn("warehouse/sensor/camera", clear);
        mqttIn("warehouse/sensor/camera", clear);                                                   // trùng
        mqttIn("warehouse/sensor/camera", Map.of("person", false, "personCount", 0, "fire", true, "fireConf", 0.83,
                "smoke", true, "smokeConf", 0.61, "fps", 9.8));
        mqttIn("warehouse/sensor/camera", Map.of("person", false, "personCount", 0, "fire", true, "fireConf", 0.79,
                "smoke", true, "smokeConf", 0.66, "fps", 9.8));                                    // trùng (conf khác)
        mqttIn("warehouse/sensor/camera", Map.of("person", false, "personCount", 0, "fire", false, "smoke", true,
                "smokeConf", 0.6, "fps", 9.8));

        List<String> rows = jdbc.sql("SELECT fire, fire_conf, smoke, smoke_conf FROM app.camera_events ORDER BY id")
                .query((rs, i) -> rs.getObject(1) + "/" + rs.getObject(2) + "/" + rs.getObject(3) + "/"
                        + rs.getObject(4))
                .list();
        assertThat(rows).containsExactly("null/null/null/null", "false/null/false/null", "true/0.83/true/0.61",
                "false/null/true/0.6");
        mvc.perform(get("/api/readings/camera").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(4))
                .andExpect(jsonPath("$[0].fire").value(false))          // mới nhất trước
                .andExpect(jsonPath("$[1].fire").value(true))
                .andExpect(jsonPath("$[1].smoke").value(true));
    }

    @Test
    void cameraFireAndSmokeAlertsCaptureSnapshots() throws Exception {
        mqttIn("warehouse/alert", Map.of("uid", "f1", "type", "camera_fire", "level", "critical",
                "message", "Camera phát hiện LỬA", "source", "rule", "incident_id", "inc-vision-1",
                "details", Map.of("evidence", List.of("camera"), "camera_fire", true, "fire_conf", 0.8)));
        mqttIn("warehouse/alert", Map.of("uid", "f2", "type", "camera_smoke", "level", "warning",
                "message", "Camera phát hiện KHÓI", "source", "rule", "incident_id", "inc-vision-1",
                "details", Map.of("camera_smoke", true)));
        assertThat(waitForSnapshots(2)).isEqualTo(2);
        assertThat(jdbc.sql("SELECT alert_type FROM app.camera_snapshots ORDER BY alert_type").query(String.class)
                .list()).containsExactly("camera_fire", "camera_smoke");
    }

    // ---------------------------------------------------------------- ảnh khi có sự cố
    @Test
    void intrusionAlertCapturesSnapshotLinkedToAlert() throws Exception {
        String token = registerAndGetToken("cam2");
        mqttIn("warehouse/alert", Map.of("uid", "u1", "type", "intrusion_confirmed", "level", "critical",
                "message", "Camera XÁC NHẬN có 2 người", "source", "rule", "incident_id", "inc-intrusion-1",
                "details", Map.of("evidence", List.of("pir", "camera"), "person_count", 2)));
        mqttIn("warehouse/alert", Map.of("uid", "u2", "type", "gas", "level", "warning", "message", "khí",
                "source", "rule", "details", Map.of()));
        long snaps = waitForSnapshots(1);
        assertThat(snaps).isEqualTo(1);
        Thread.sleep(300);      // cảnh báo "gas" không được chụp
        assertThat(jdbc.sql("SELECT count(*) FROM app.camera_snapshots").query(Long.class).single()).isEqualTo(1);
        assertThat(received.get("/snapshot.jpg").get("key")).isEqualTo("test-internal-key");

        String auth = "Bearer " + token;
        String list = mvc.perform(get("/api/alerts").header("Authorization", auth))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        assertThat(list).contains("\"snapshotId\":1").contains("\"snapshotId\":null");

        mvc.perform(get("/api/camera/snapshots").param("alertId", "1").header("Authorization", auth))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(1))
                .andExpect(jsonPath("$[0].alertType").value("intrusion_confirmed"))
                .andExpect(jsonPath("$[0].incidentId").value("inc-intrusion-1"))
                .andExpect(jsonPath("$[0].personCount").value(2))
                .andExpect(jsonPath("$[0].sizeBytes").value(JPEG.length))
                .andExpect(jsonPath("$[0].image").doesNotExist());
        mvc.perform(get("/api/camera/snapshots/1/image").header("Authorization", auth))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Type", "image/jpeg"))
                .andExpect(content().bytes(JPEG));
        mvc.perform(get("/api/camera/snapshots/99/image").header("Authorization", auth))
                .andExpect(status().isNotFound());
    }

    @Test
    void snapshotFailureDoesNotBreakAlert() throws Exception {
        snapshotStatus = 503;
        mqttIn("warehouse/alert", Map.of("uid", "u3", "type", "intrusion", "level", "critical", "message", "x",
                "source", "rule", "details", Map.of()));
        Thread.sleep(500);
        assertThat(jdbc.sql("SELECT count(*) FROM app.alerts").query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("SELECT count(*) FROM app.camera_snapshots").query(Long.class).single()).isZero();
    }

    // ---------------------------------------------------------------- token qua URL chỉ cho /api/camera/
    @Test
    void accessTokenInQueryOnlyAcceptedForCameraGets() throws Exception {
        String token = registerAndGetToken("cam3");
        mvc.perform(get("/api/camera/snapshots").param("access_token", token)).andExpect(status().isOk());
        mvc.perform(get("/api/camera/snapshots")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/camera/snapshots").param("access_token", "garbage")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/state").param("access_token", token)).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/alerts").param("access_token", token)).andExpect(status().isUnauthorized());
    }

    // ---------------------------------------------------------------- chuyển tiếp từ vision
    @Test
    void mjpegStreamIsProxied() throws Exception {
        String token = registerAndGetToken("cam4");
        byte[] body = mvc.perform(get("/api/camera/stream").param("access_token", token).param("fps", "50"))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Type", "multipart/x-mixed-replace; boundary=frame"))
                .andExpect(header().string("Cache-Control", "no-store"))
                .andReturn().getResponse().getContentAsByteArray();
        String text = new String(body, StandardCharsets.ISO_8859_1);
        assertThat(text.split("--frame", -1)).hasSize(3);
        assertThat(received.get("/stream.mjpg").get("query")).isEqualTo("fps=30");      // giới hạn 30
        assertThat(received.get("/stream.mjpg").get("key")).isEqualTo("test-internal-key");
    }

    @Test
    void liveSnapshotAndStatus() throws Exception {
        String auth = "Bearer " + registerAndGetToken("cam5");
        mvc.perform(get("/api/camera/snapshot").header("Authorization", auth))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(content().bytes(JPEG));
        mqttIn("warehouse/status/camera", Map.of("status", "online"));
        mvc.perform(get("/api/camera/status").header("Authorization", auth))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.reachable").value(true))
                .andExpect(jsonPath("$.service.model.name").value("yolo26n.pt"))
                .andExpect(jsonPath("$.online.data.status").value("online"));

        snapshotStatus = 503;
        mvc.perform(get("/api/camera/snapshot").header("Authorization", auth))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.error").value("camera_no_frame"));
    }

    @Test
    void visionDownGives503() throws Exception {
        String auth = "Bearer " + registerAndGetToken("cam6");
        vision.stop(0);
        try {
            mvc.perform(get("/api/camera/status").header("Authorization", auth))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.reachable").value(false))
                    .andExpect(jsonPath("$.error").value("vision_unavailable"));
            mvc.perform(get("/api/camera/stream").header("Authorization", auth))
                    .andExpect(status().isServiceUnavailable())
                    .andExpect(jsonPath("$.error").value("vision_unavailable"));
        } finally {
            startFakeVision();
        }
    }

    private long waitForSnapshots(long n) throws InterruptedException {
        long count = 0;
        for (int i = 0; i < 50 && count < n; i++) {
            count = jdbc.sql("SELECT count(*) FROM app.camera_snapshots").query(Long.class).single();
            if (count < n) {
                Thread.sleep(100);
            }
        }
        return count;
    }
}
