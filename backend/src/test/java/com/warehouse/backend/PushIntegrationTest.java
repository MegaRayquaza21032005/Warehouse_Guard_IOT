package com.warehouse.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPairGenerator;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/** Push FCM với máy chủ Google OAuth + FCM giả (không cần Firebase thật). */
class PushIntegrationTest extends IntegrationTestBase {

    private static final int FCM_PORT = 18766;
    private static final List<String> sent = new CopyOnWriteArrayList<>();
    private static final List<String> tokenRequests = new CopyOnWriteArrayList<>();
    private static HttpServer server;
    private static Path credentials;

    @DynamicPropertySource
    static void push(DynamicPropertyRegistry r) throws Exception {
        if (server == null) {
            start();
        }
        r.add("app.push.credentials-file", () -> credentials.toString());
        r.add("app.push.fcm-url", () -> "http://127.0.0.1:" + FCM_PORT);
    }

    static void start() throws Exception {
        var kp = KeyPairGenerator.getInstance("RSA");
        kp.initialize(2048);
        String pem = "-----BEGIN PRIVATE KEY-----\n"
                + Base64.getMimeEncoder().encodeToString(kp.generateKeyPair().getPrivate().getEncoded())
                + "\n-----END PRIVATE KEY-----\n";
        credentials = Files.createTempFile("fcm-sa", ".json");
        Files.writeString(credentials, """
                {"type":"service_account","project_id":"test-proj","client_email":"push@test-proj.iam.gserviceaccount.com",
                 "private_key":%s,"token_uri":"http://127.0.0.1:%d/token"}"""
                .formatted(new tools.jackson.databind.ObjectMapper().writeValueAsString(pem), FCM_PORT));
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", FCM_PORT), 0);
        server.createContext("/token", ex -> {
            tokenRequests.add(body(ex));
            reply(ex, 200, "{\"access_token\":\"ya29.test\",\"expires_in\":3600}");
        });
        server.createContext("/v1/projects/test-proj/messages:send", ex -> {
            String b = body(ex);
            if (!"Bearer ya29.test".equals(ex.getRequestHeaders().getFirst("Authorization"))) {
                reply(ex, 401, "{}");
                return;
            }
            sent.add(b);
            if (b.contains("\"dead-token\"")) {
                reply(ex, 404, "{\"error\":{\"status\":\"NOT_FOUND\",\"details\":[{\"errorCode\":\"UNREGISTERED\"}]}}");
            } else {
                reply(ex, 200, "{\"name\":\"projects/test-proj/messages/1\"}");
            }
        });
        server.start();
    }

    private static String body(HttpExchange ex) throws IOException {
        return new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
    }

    private static void reply(HttpExchange ex, int code, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(code, b.length);
        ex.getResponseBody().write(b);
        ex.close();
    }

    @AfterAll
    static void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    @BeforeEach
    void clean() {
        sent.clear();
        jdbc.sql("TRUNCATE app.push_tokens").update();
    }

    private void waitSent(int n) throws InterruptedException {
        for (int i = 0; i < 100 && sent.size() < n; i++) {
            Thread.sleep(50);
        }
    }

    @Test
    void registersTokensAndPushesAlertsToAllUsers() throws Exception {
        String a = "Bearer " + registerAndGetToken("pusha");
        String b = "Bearer " + registerAndGetToken("pushb");
        mvc.perform(get("/api/push/status").header("Authorization", a))
                .andExpect(jsonPath("$.enabled").value(true)).andExpect(jsonPath("$.myDevices").value(0));
        mvc.perform(post("/api/push/tokens").header("Authorization", a).contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("token", "tok-a", "platform", "android")))).andExpect(status().isNoContent());
        mvc.perform(post("/api/push/tokens").header("Authorization", b).contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("token", "dead-token", "platform", "android")))).andExpect(status().isNoContent());
        mvc.perform(post("/api/push/tokens").header("Authorization", b).contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("token", "x", "platform", "symbian")))).andExpect(status().isBadRequest());

        mqttIn("warehouse/alert", Map.of("type", "fire", "level", "critical", "message", "NGHI CHÁY", "source", "rule",
                "details", Map.of("temp", 41)));
        waitSent(2);
        assertThat(sent).hasSize(2);
        String msg = sent.stream().filter(s -> s.contains("tok-a")).findFirst().orElseThrow();
        Map<String, Object> m = parse(msg);
        @SuppressWarnings("unchecked")
        Map<String, Object> message = (Map<String, Object>) m.get("message");
        assertThat(message.get("notification").toString()).contains("NGUY HIỂM", "Nghi cháy", "NGHI CHÁY");
        assertThat(message.get("data").toString()).contains("alertId=1", "level=critical");
        assertThat(message.get("android").toString()).contains("alerts-critical", "HIGH");
        assertThat(tokenRequests.getFirst()).contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");

        // token hỏng (UNREGISTERED) bị xóa
        Thread.sleep(200);
        assertThat(jdbc.sql("SELECT token FROM app.push_tokens ORDER BY token").query(String.class).list())
                .containsExactly("tok-a");

        // info + details.push=false -> không push; info thường -> push
        sent.clear();
        mqttIn("warehouse/alert", Map.of("type", "hum_high_prolonged", "level", "info", "message", "ẩm",
                "source", "agent", "details", Map.of("push", false)));
        mqttIn("warehouse/alert", Map.of("type", "recovered", "level", "info", "message", "Đã bình thường",
                "source", "rule"));
        waitSent(1);
        Thread.sleep(300);
        assertThat(sent).hasSize(1);
        assertThat(sent.getFirst()).contains("Đã bình thường");

        // đăng xuất trên máy -> hủy token
        mvc.perform(delete("/api/push/tokens").header("Authorization", a).contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("token", "tok-a")))).andExpect(status().isNoContent());
        assertThat(jdbc.sql("SELECT count(*) FROM app.push_tokens").query(Integer.class).single()).isZero();
    }
}
