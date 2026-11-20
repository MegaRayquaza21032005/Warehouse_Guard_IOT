package com.warehouse.backend.chat;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.security.CurrentUser;

/**
 * Chatbot, giọng nói, nhật ký agent — làm trung gian tới AI Agent (CLAUDE.md mục 6, 8).
 * user_id luôn lấy từ JWT. Chat trả về stream SSE (text/event-stream) chuyển tiếp nguyên văn từ agent.
 */
@RestController
public class ChatController {

    private static final Pattern THREAD_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private static final int MAX_MESSAGE = 2000;
    private static final int MAX_TTS = 4000;

    private final AgentClient agent;

    public ChatController(AgentClient agent) {
        this.agent = agent;
    }

    public record ChatRequest(String threadId, String message, String inputMode) {
    }

    public record ConfirmRequest(Boolean approved) {
    }

    public record TtsRequest(String text) {
    }

    // ------------------------------------------------------------------------------------------ chat
    /**
     * Gửi tin nhắn. Stream SSE, sự kiện: meta {thread_id, trace_id}, status, token, discard, confirmation, result,
     * done, error. Không gửi threadId = tạo hội thoại mới.
     */
    @PostMapping(value = "/api/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<StreamingResponseBody> chat(@RequestBody ChatRequest req, Authentication auth) {
        Long userId = CurrentUser.require(auth);
        String message = req.message() == null ? "" : req.message().strip();
        if (message.isEmpty() || message.length() > MAX_MESSAGE) {
            throw ApiException.badRequest("invalid_message", "Tin nhắn phải có 1-" + MAX_MESSAGE + " ký tự");
        }
        String mode = req.inputMode() == null ? "text" : req.inputMode();
        if (!List.of("text", "voice").contains(mode)) {
            throw ApiException.badRequest("invalid_input_mode", "inputMode: text | voice");
        }
        Map<String, Object> body = new HashMap<>();
        body.put("user_id", userId);
        body.put("username", username(auth));
        body.put("thread_id", req.threadId() == null ? null : threadId(req.threadId()));
        body.put("message", message);
        body.put("input_mode", mode);
        return sse(agent.postSse("/chat", body));
    }

    /** Bấm [Đồng ý] / [Hủy] cho đề xuất đang chờ. Stream SSE như /api/chat. */
    @PostMapping(value = "/api/chat/{threadId}/confirm", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<StreamingResponseBody> confirm(@PathVariable String threadId,
            @RequestBody ConfirmRequest req, Authentication auth) {
        Long userId = CurrentUser.require(auth);
        if (req.approved() == null) {
            throw ApiException.badRequest("invalid_decision", "Cần trường approved: true | false");
        }
        return sse(agent.postSse("/chat/" + threadId(threadId) + "/confirm",
                Map.of("user_id", userId, "approved", req.approved())));
    }

    @GetMapping("/api/chat/threads")
    public Object threads(Authentication auth, @RequestParam(defaultValue = "50") int limit) {
        return agent.getJson("/chat/threads", Map.of("user_id", CurrentUser.require(auth), "limit", limit));
    }

    /** Tin nhắn của hội thoại + đề xuất đang chờ xác nhận (nếu có) để hiện lại nút. */
    @GetMapping("/api/chat/threads/{threadId}")
    public Object thread(@PathVariable String threadId, Authentication auth) {
        return agent.getJson("/chat/threads/" + threadId(threadId), Map.of("user_id", CurrentUser.require(auth)));
    }

    @DeleteMapping("/api/chat/threads/{threadId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteThread(@PathVariable String threadId, Authentication auth) {
        agent.delete("/chat/threads/" + threadId(threadId), Map.of("user_id", CurrentUser.require(auth)));
    }

    // ------------------------------------------------------------------------------------------ giọng nói
    /** Dự phòng khi thiết bị không nhận dạng được giọng nói. Âm thanh không được lưu. */
    @PostMapping(value = "/api/voice/stt", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Object stt(@RequestPart("file") MultipartFile file, Authentication auth) throws IOException {
        Long userId = CurrentUser.require(auth);
        if (file.isEmpty()) {
            throw ApiException.badRequest("empty_audio", "File âm thanh trống");
        }
        String name = file.getOriginalFilename() == null ? "audio.webm" : file.getOriginalFilename();
        String type = file.getContentType() == null ? "application/octet-stream" : file.getContentType();
        return agent.postMultipart("/voice/stt", "file", name, type, file.getBytes(),
                Map.of("user_id", String.valueOf(userId), "language", "vi"));
    }

    /** Dự phòng khi thiết bị không có giọng đọc tiếng Việt. Trả audio/mpeg. */
    @PostMapping(value = "/api/voice/tts", produces = "audio/mpeg")
    public ResponseEntity<byte[]> tts(@RequestBody TtsRequest req, Authentication auth) {
        Long userId = CurrentUser.require(auth);
        if (req.text() == null || req.text().isBlank() || req.text().length() > MAX_TTS) {
            throw ApiException.badRequest("invalid_text", "text phải có 1-" + MAX_TTS + " ký tự");
        }
        byte[] audio = agent.postForBytes("/voice/tts", Map.of("user_id", userId, "text", req.text()));
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("audio/mpeg")).body(audio);
    }

    // ------------------------------------------------------------------------------------------ nhật ký agent
    /**
     * Nhật ký tool call của agent. ADMIN xem tất cả; người dùng thường chỉ thấy tool call từ yêu cầu của mình và
     * của luồng sự cố.
     */
    @GetMapping("/api/agent/tool-calls")
    public Object toolCalls(Authentication auth, @RequestParam(required = false) String traceId,
            @RequestParam(required = false) String threadId, @RequestParam(required = false) Long userId,
            @RequestParam(required = false) String agent, @RequestParam(required = false) String tool,
            @RequestParam(required = false) String status, @RequestParam(required = false) String flow,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "100") int size) {
        Long me = CurrentUser.require(auth);
        boolean admin = auth.getAuthorities().stream().anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
        int s = Math.max(1, Math.min(size, 500));
        Map<String, Object> q = new LinkedHashMap<>();
        q.put("trace_id", traceId);
        q.put("thread_id", threadId);
        q.put("agent", agent);
        q.put("tool", tool);
        q.put("status", status);
        q.put("flow", flow);
        q.put("from", from);
        q.put("to", to);
        q.put("limit", s);
        q.put("offset", Math.max(0, page) * s);
        if (admin) {
            q.put("user_id", userId);
        } else {
            q.put("viewer_id", me);
        }
        return this.agent.getJson("/logs/tool-calls", q);
    }

    // ------------------------------------------------------------------------------------------
    private static ResponseEntity<StreamingResponseBody> sse(InputStream in) {
        StreamingResponseBody body = out -> pipe(in, out);
        return ResponseEntity.ok().contentType(MediaType.TEXT_EVENT_STREAM).header("Cache-Control", "no-cache")
                .header("X-Accel-Buffering", "no").body(body);
    }

    /** Chép từng đoạn và flush ngay để client nhận chữ dần. Client ngắt -> đóng kết nối tới agent. */
    private static void pipe(InputStream in, OutputStream out) throws IOException {
        try (in) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
                out.flush();
            }
        }
    }

    private static String threadId(String id) {
        if (!THREAD_ID.matcher(id).matches()) {
            throw ApiException.badRequest("invalid_thread_id", "threadId không hợp lệ");
        }
        return id;
    }

    private static String username(Authentication auth) {
        if (auth instanceof JwtAuthenticationToken jwt) {
            return jwt.getToken().getClaimAsString("username");
        }
        return null;
    }
}
