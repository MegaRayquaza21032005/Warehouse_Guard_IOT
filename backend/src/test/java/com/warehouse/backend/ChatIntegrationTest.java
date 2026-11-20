package com.warehouse.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MvcResult;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.warehouse.backend.chat.AgentClient;
import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.config.AppProperties;

import tools.jackson.databind.ObjectMapper;

/** Java BE làm trung gian chat / giọng nói / nhật ký tới AI Agent (agent giả = HttpServer của JDK). */
class ChatIntegrationTest extends IntegrationTestBase {

    static HttpServer agent;
    /** path -> {method, query, body, key} của request cuối cùng agent giả nhận được. */
    static final Map<String, Map<String, String>> received = new ConcurrentHashMap<>();
    static volatile int chatStatus = 200;

    @BeforeAll
    static void startFakeAgent() throws IOException {
        agent = HttpServer.create(new InetSocketAddress("127.0.0.1", AGENT_PORT), 0);
        agent.createContext("/", ChatIntegrationTest::handle);
        agent.start();
    }

    @AfterAll
    static void stopFakeAgent() {
        agent.stop(0);
    }

    @BeforeEach
    void reset() {
        received.clear();
        chatStatus = 200;
    }

    static void handle(HttpExchange ex) throws IOException {
        String path = ex.getRequestURI().getPath();
        String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.ISO_8859_1);
        received.put(path, Map.of("method", ex.getRequestMethod(),
                "query", String.valueOf(ex.getRequestURI().getRawQuery()), "body", body,
                "key", String.valueOf(ex.getRequestHeaders().getFirst("X-Internal-Key")),
                "type", String.valueOf(ex.getRequestHeaders().getFirst("Content-Type"))));
        if (path.equals("/chat") && chatStatus != 200) {
            send(ex, chatStatus, "application/json",
                    "{\"error\":\"confirmation_pending\",\"message\":\"Đang chờ xác nhận\"}");
        } else if (path.equals("/chat") || path.endsWith("/confirm")) {
            send(ex, 200, "text/event-stream", "event: meta\r\ndata: {\"thread_id\":\"t-1\",\"trace_id\":\"c-1\"}\r\n\r\n"
                    + "event: token\r\ndata: {\"text\":\"Xin chào\"}\r\n\r\n"
                    + "event: done\r\ndata: {\"message\":\"Xin chào\"}\r\n\r\n");
        } else if (path.equals("/voice/stt")) {
            send(ex, 200, "application/json", "{\"text\":\"bật đèn kho\"}");
        } else if (path.equals("/voice/tts")) {
            send(ex, 200, "audio/mpeg", "ID3fake");
        } else if (path.startsWith("/chat/threads/")) {
            if (ex.getRequestMethod().equals("DELETE")) {
                ex.sendResponseHeaders(204, -1);
                ex.close();
            } else {
                send(ex, 404, "application/json", "{\"error\":\"thread_not_found\",\"message\":\"Không tìm thấy\"}");
            }
        } else {
            send(ex, 200, "application/json", "[]");
        }
    }

    static void send(HttpExchange ex, int status, String type, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", type);
        ex.sendResponseHeaders(status, b.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(b);
        }
    }

    @Test
    void chatStreamsSseAndUsesUserIdFromJwt() throws Exception {
        String token = registerAndGetToken("thanh");
        MvcResult r = mvc.perform(post("/api/chat").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("message", "Kho thế nào?", "inputMode", "voice", "user_id", 999))))
                .andExpect(request().asyncStarted()).andReturn();
        String sse = mvc.perform(asyncDispatch(r)).andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_EVENT_STREAM))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(sse).contains("event: meta").contains("event: done").contains("Xin chào");

        Map<String, String> req = received.get("/chat");
        Map<String, Object> body = parse(new String(req.get("body").getBytes(StandardCharsets.ISO_8859_1),
                StandardCharsets.UTF_8));
        assertThat(body).containsEntry("user_id", 1).containsEntry("username", "thanh")
                .containsEntry("input_mode", "voice").containsEntry("message", "Kho thế nào?");
        assertThat(req.get("key")).isEqualTo("test-internal-key");
    }

    @Test
    void agentErrorsArePassedThroughBeforeStreaming() throws Exception {
        String token = registerAndGetToken("thanh");
        chatStatus = 409;
        mvc.perform(post("/api/chat").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("message", "hi", "threadId", "t-1"))))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error").value("confirmation_pending"));
        mvc.perform(get("/api/chat/threads/t-unknown").header("Authorization", "Bearer " + token))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.error").value("thread_not_found"));
    }

    @Test
    void validatesInputAndRequiresRealUser() throws Exception {
        String auth = "Bearer " + registerAndGetToken("thanh");
        mvc.perform(post("/api/chat").header("Authorization", auth).contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("message", "  ")))).andExpect(status().isBadRequest());
        mvc.perform(post("/api/chat/..%2Fx/confirm").header("Authorization", auth)
                .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("approved", true))))
                .andExpect(status().is4xxClientError());
        mvc.perform(post("/api/chat/t-1/confirm").header("Authorization", auth)
                .contentType(MediaType.APPLICATION_JSON).content("{}")).andExpect(status().isBadRequest());
        // AI Agent (khóa nội bộ) không được dùng chat thay người dùng
        mvc.perform(post("/api/chat").header("X-Internal-Key", "test-internal-key")
                .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("message", "hi"))))
                .andExpect(status().isForbidden());
        mvc.perform(post("/api/chat").contentType(MediaType.APPLICATION_JSON).content(json(Map.of("message", "hi"))))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void confirmForwardsDecision() throws Exception {
        String auth = "Bearer " + registerAndGetToken("thanh");
        MvcResult r = mvc.perform(post("/api/chat/t-abc_1/confirm").header("Authorization", auth)
                .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("approved", false))))
                .andExpect(request().asyncStarted()).andReturn();
        mvc.perform(asyncDispatch(r)).andExpect(status().isOk());
        assertThat(parse(received.get("/chat/t-abc_1/confirm").get("body")))
                .containsEntry("user_id", 1).containsEntry("approved", false);
    }

    @Test
    void voiceSttAndTts() throws Exception {
        String auth = "Bearer " + registerAndGetToken("thanh");
        MockMultipartFile file = new MockMultipartFile("file", "a.webm", "audio/webm", new byte[] { 1, 2, 3 });
        mvc.perform(multipart("/api/voice/stt").file(file).header("Authorization", auth))
                .andExpect(status().isOk()).andExpect(jsonPath("$.text").value("bật đèn kho"));
        Map<String, String> stt = received.get("/voice/stt");
        assertThat(stt.get("type")).startsWith("multipart/form-data");
        assertThat(stt.get("body")).contains("name=\"user_id\"").contains("filename=\"a.webm\"")
                .contains("\u0001\u0002\u0003");

        byte[] audio = mvc.perform(post("/api/voice/tts").header("Authorization", auth)
                .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("text", "Xin chào"))))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray();
        assertThat(new String(audio, StandardCharsets.UTF_8)).isEqualTo("ID3fake");
    }

    @Test
    void toolCallLogsAreScopedToUser() throws Exception {
        String auth = "Bearer " + registerAndGetToken("thanh");
        mvc.perform(get("/api/agent/tool-calls").param("userId", "5").param("traceId", "c-1")
                .header("Authorization", auth)).andExpect(status().isOk());
        String q = received.get("/logs/tool-calls").get("query");
        assertThat(q).contains("viewer_id=1").contains("trace_id=c-1").doesNotContain("user_id=5");
    }

    @Test
    void agentDownGives503() {
        AppProperties props = new AppProperties("Asia/Ho_Chi_Minh", null, "k", List.of(), null, null,
                new AppProperties.Agent("http://127.0.0.1:1", Duration.ofSeconds(2)));
        AgentClient client = new AgentClient(props, new ObjectMapper());
        assertThatThrownBy(() -> client.getJson("/chat/threads", Map.of()))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.status()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                    assertThat(e.code()).isEqualTo("agent_unavailable");
                });
    }
}
