package com.warehouse.backend.camera;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.config.AppProperties;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/**
 * Gọi service vision nội bộ (camera + YOLO, header X-Internal-Key). Client không bao giờ gọi thẳng vision —
 * Java BE chuyển tiếp hình (CLAUDE.md mục 3).
 */
@Component
public class VisionClient {

    private static final Logger log = LoggerFactory.getLogger(VisionClient.class);
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };

    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(2)).build();
    private final String base;
    private final String key;
    private final Duration timeout;
    private final ObjectMapper mapper;

    public VisionClient(AppProperties props, ObjectMapper mapper) {
        AppProperties.Vision v = props.vision();
        String url = v == null || v.url() == null || v.url().isBlank() ? "http://localhost:8100" : v.url();
        this.base = url.replaceAll("/+$", "");
        this.key = props.internalApiKey() == null ? "" : props.internalApiKey();
        this.timeout = v == null || v.timeout() == null ? Duration.ofSeconds(5) : v.timeout();
        this.mapper = mapper;
    }

    public Map<String, Object> status() {
        HttpResponse<String> res = send(get("/status"), HttpResponse.BodyHandlers.ofString());
        check(res.statusCode(), res.body());
        return mapper.readValue(res.body(), MAP);
    }

    /** Ảnh JPEG mới nhất (có khung YOLO). */
    public byte[] snapshot() {
        HttpResponse<byte[]> res = send(get("/snapshot.jpg"), HttpResponse.BodyHandlers.ofByteArray());
        check(res.statusCode(), new String(res.body(), StandardCharsets.UTF_8));
        return res.body();
    }

    /** Mở luồng MJPEG; người gọi phải đóng body. Lỗi -> ApiException (trước khi trả hình cho client). */
    public HttpResponse<InputStream> openStream(int fps) {
        HttpResponse<InputStream> res = send(get("/stream.mjpg?fps=" + fps), HttpResponse.BodyHandlers.ofInputStream());
        if (res.statusCode() != 200) {
            String body;
            try (InputStream in = res.body()) {
                body = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            } catch (IOException e) {
                body = "";
            }
            check(res.statusCode(), body);
        }
        return res;
    }

    // ------------------------------------------------------------------------------------------------
    private HttpRequest get(String path) {
        // timeout chỉ áp cho lúc chờ header phản hồi — luồng MJPEG sau đó chạy không giới hạn
        return HttpRequest.newBuilder(URI.create(base + path)).timeout(timeout).header("X-Internal-Key", key)
                .GET().build();
    }

    private <T> HttpResponse<T> send(HttpRequest req, HttpResponse.BodyHandler<T> handler) {
        try {
            return http.send(req, handler);
        } catch (IOException e) {
            log.debug("[VISION] {} lỗi: {}", req.uri().getPath(), e.toString());
            throw unavailable();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw unavailable();
        }
    }

    private void check(int status, String body) {
        if (status == 200) {
            return;
        }
        if (status == 503 && body != null && body.contains("no_frame")) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "camera_no_frame", "Camera chưa có hình");
        }
        log.warn("[VISION] trả {}: {}", status, body == null ? "" : body.substring(0, Math.min(200, body.length())));
        // 401 = sai INTERNAL_API_KEY giữa 2 service, không phải lỗi của người dùng
        throw new ApiException(HttpStatus.BAD_GATEWAY, "vision_error", "Service camera trả lỗi " + status);
    }

    private ApiException unavailable() {
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "vision_unavailable",
                "Service camera chưa chạy. Cảm biến chuyển động PIR vẫn hoạt động.");
    }
}
