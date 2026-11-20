package com.warehouse.backend.chat;

import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.StringJoiner;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.config.AppProperties;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/**
 * Gọi REST của AI Agent (nội bộ, header X-Internal-Key). Java BE là cửa ngõ duy nhất cho client (CLAUDE.md mục 3):
 * client không bao giờ gọi thẳng ai-agent. user_id luôn lấy từ JWT, không lấy từ body của client.
 */
@Component
public class AgentClient {

    private static final Logger log = LoggerFactory.getLogger(AgentClient.class);
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };

    /** HTTP/1.1: mặc định HttpClient thử nâng cấp h2c kèm body -> uvicorn bỏ mất body (lỗi 422). */
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(3)).build();
    private final String base;
    private final String key;
    private final Duration timeout;
    private final ObjectMapper mapper;

    public AgentClient(AppProperties props, ObjectMapper mapper) {
        this.base = props.agent().url().replaceAll("/+$", "");
        this.key = props.internalApiKey() == null ? "" : props.internalApiKey();
        this.timeout = props.agent().timeout() == null ? Duration.ofSeconds(60) : props.agent().timeout();
        this.mapper = mapper;
    }

    /** POST JSON, trả luồng SSE của agent. Lỗi HTTP -> ApiException (trước khi bắt đầu stream). */
    public InputStream postSse(String path, Object body) {
        HttpRequest req = request(path, Map.of()).header("Accept", "text/event-stream")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body))).build();
        HttpResponse<InputStream> res = send(req, HttpResponse.BodyHandlers.ofInputStream());
        if (res.statusCode() != 200) {
            throw toError(res.statusCode(), readQuietly(res.body()));
        }
        return res.body();
    }

    public Object getJson(String path, Map<String, ?> query) {
        HttpResponse<String> res = send(request(path, query).GET().build(), HttpResponse.BodyHandlers.ofString());
        return parse(res);
    }

    public void delete(String path, Map<String, ?> query) {
        HttpResponse<String> res = send(request(path, query).DELETE().build(), HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() >= 300) {
            throw toError(res.statusCode(), res.body());
        }
    }

    public Object postJson(String path, Object body) {
        HttpRequest req = request(path, Map.of()).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body))).build();
        return parse(send(req, HttpResponse.BodyHandlers.ofString()));
    }

    public byte[] postForBytes(String path, Object body) {
        HttpRequest req = request(path, Map.of()).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body))).build();
        HttpResponse<byte[]> res = send(req, HttpResponse.BodyHandlers.ofByteArray());
        if (res.statusCode() != 200) {
            throw toError(res.statusCode(), new String(res.body(), StandardCharsets.UTF_8));
        }
        return res.body();
    }

    /** multipart/form-data: một file + các trường chữ. */
    public Object postMultipart(String path, String fileField, String filename, String contentType, byte[] data,
            Map<String, String> fields) {
        String boundary = "----wh" + UUID.randomUUID().toString().replace("-", "");
        StringBuilder head = new StringBuilder();
        fields.forEach((k, v) -> head.append("--").append(boundary).append("\r\n")
                .append("Content-Disposition: form-data; name=\"").append(k).append("\"\r\n\r\n")
                .append(v).append("\r\n"));
        head.append("--").append(boundary).append("\r\n")
                .append("Content-Disposition: form-data; name=\"").append(fileField).append("\"; filename=\"")
                .append(filename.replaceAll("[\"\\r\\n]", "_")).append("\"\r\n")
                .append("Content-Type: ").append(contentType).append("\r\n\r\n");
        byte[] h = head.toString().getBytes(StandardCharsets.UTF_8);
        byte[] tail = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);
        byte[] all = new byte[h.length + data.length + tail.length];
        System.arraycopy(h, 0, all, 0, h.length);
        System.arraycopy(data, 0, all, h.length, data.length);
        System.arraycopy(tail, 0, all, h.length + data.length, tail.length);
        HttpRequest req = request(path, Map.of()).header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(all)).build();
        return parse(send(req, HttpResponse.BodyHandlers.ofString()));
    }

    // ------------------------------------------------------------------------------------------------
    private HttpRequest.Builder request(String path, Map<String, ?> query) {
        StringJoiner q = new StringJoiner("&");
        query.forEach((k, v) -> {
            if (v != null) {
                q.add(enc(k) + "=" + enc(String.valueOf(v)));
            }
        });
        String uri = base + path + (q.length() > 0 ? "?" + q : "");
        return HttpRequest.newBuilder(URI.create(uri)).timeout(timeout).header("X-Internal-Key", key);
    }

    private <T> HttpResponse<T> send(HttpRequest req, HttpResponse.BodyHandler<T> handler) {
        try {
            return http.send(req, handler);
        } catch (ConnectException e) {
            throw unavailable(e);
        } catch (IOException e) {
            if (e.getCause() instanceof ConnectException) {
                throw unavailable(e);
            }
            log.warn("[AGENT] {} {} lỗi: {}", req.method(), req.uri().getPath(), e.toString());
            throw new ApiException(HttpStatus.BAD_GATEWAY, "agent_error", "AI Agent không phản hồi");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "agent_unavailable", "Bị ngắt khi gọi AI Agent");
        }
    }

    private ApiException unavailable(Exception e) {
        log.warn("[AGENT] Không kết nối được {}: {}", base, e.toString());
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "agent_unavailable",
                "Trợ lý AI chưa chạy. Cảnh báo an toàn và điều khiển bằng nút vẫn hoạt động.");
    }

    private Object parse(HttpResponse<String> res) {
        if (res.statusCode() >= 300) {
            throw toError(res.statusCode(), res.body());
        }
        return res.body() == null || res.body().isBlank() ? null : mapper.readValue(res.body(), Object.class);
    }

    /** Giữ nguyên mã lỗi của agent ({"error","message"}) nếu có. */
    private ApiException toError(int status, String body) {
        String code = "agent_error";
        String message = "AI Agent trả lỗi " + status;
        try {
            Map<String, Object> m = mapper.readValue(body, MAP);
            Object detail = m.get("detail");
            if (detail instanceof Map<?, ?> d) {
                m = mapper.convertValue(d, MAP);
            }
            if (m.get("error") != null) {
                code = String.valueOf(m.get("error"));
            }
            if (m.get("message") != null) {
                message = String.valueOf(m.get("message"));
            }
        } catch (RuntimeException ignored) {
            // không phải JSON -> dùng mặc định
        }
        HttpStatus st = HttpStatus.resolve(status);
        if (st == null || status == 401) {     // 401 = sai INTERNAL_API_KEY giữa 2 service, không phải lỗi của user
            st = HttpStatus.BAD_GATEWAY;
        }
        return new ApiException(st, code, message);
    }

    private static String readQuietly(InputStream in) {
        try (in) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }
}
