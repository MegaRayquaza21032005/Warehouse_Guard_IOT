package com.warehouse.backend.alert;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.warehouse.backend.chat.AgentClient;
import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.security.CurrentUser;

/** Cảnh báo (AI Agent phát qua warehouse/alert, backend lưu lại). */
@RestController
@RequestMapping("/api/alerts")
public class AlertController {

    private static final List<String> LEVELS = List.of("info", "warning", "critical");
    private static final List<String> FEEDBACK = List.of("true_alarm", "false_alarm");

    private static final Logger log = LoggerFactory.getLogger(AlertController.class);

    private final AlertRepository alerts;
    private final AgentClient agent;

    public AlertController(AlertRepository alerts, AgentClient agent) {
        this.alerts = alerts;
        this.agent = agent;
    }

    public record FeedbackRequest(String feedback, String note) {
    }

    @GetMapping
    public List<Map<String, Object>> list(@RequestParam(required = false) String level,
            @RequestParam(defaultValue = "false") boolean unacked,
            @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "50") int size) {
        if (level != null && !LEVELS.contains(level)) {
            throw ApiException.badRequest("invalid_level", "Mức hợp lệ: " + LEVELS);
        }
        int s = Math.max(1, Math.min(size, 200));
        return alerts.list(level, unacked, s, Math.max(0, page) * s);
    }

    @GetMapping("/{id}")
    public Map<String, Object> get(@PathVariable long id) {
        return alerts.find(id).orElseThrow(() -> ApiException.notFound("alert_not_found", "Không tìm thấy cảnh báo"));
    }

    /** "Đã xem" — dừng leo thang cảnh báo. */
    @PostMapping("/{id}/ack")
    public Map<String, Object> ack(@PathVariable long id, Authentication auth) {
        long userId = CurrentUser.require(auth);
        get(id);
        alerts.acknowledge(id, userId);
        return get(id);
    }

    /** Phản hồi đúng / báo giả — dữ liệu cho memory "warehouse/feedback" của AI Agent. */
    @PostMapping("/{id}/feedback")
    public Map<String, Object> feedback(@PathVariable long id, @RequestBody FeedbackRequest req, Authentication auth) {
        long userId = CurrentUser.require(auth);
        if (req.feedback() == null || !FEEDBACK.contains(req.feedback())) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_feedback", "feedback hợp lệ: " + FEEDBACK);
        }
        String note = req.note() == null ? null : req.note().strip();
        if (note != null && note.length() > 1000) {
            throw ApiException.badRequest("note_too_long", "Ghi chú tối đa 1000 ký tự");
        }
        get(id);
        alerts.feedback(id, req.feedback(), note, userId);
        Map<String, Object> saved = get(id);
        forwardToAgentMemory(saved, req.feedback(), note, userId);
        return saved;
    }

    /**
     * Gửi phản hồi sang long-term memory của AI Agent (("warehouse","feedback")) — chạy nền, lỗi không ảnh hưởng
     * việc lưu phản hồi ở Java BE (CLAUDE.md mục 7).
     */
    private void forwardToAgentMemory(Map<String, Object> alert, String feedback, String note, long userId) {
        Map<String, Object> body = new HashMap<>();
        body.put("user_id", userId);
        body.put("alert", alert);
        body.put("feedback", feedback);
        body.put("note", note);
        Thread.ofVirtual().name("feedback-to-agent").start(() -> {
            try {
                agent.postJson("/memory/feedback", body);
            } catch (RuntimeException e) {
                log.warn("[AGENT] Không gửi được phản hồi cảnh báo #{} sang memory: {}", alert.get("id"), e.getMessage());
            }
        });
    }
}
