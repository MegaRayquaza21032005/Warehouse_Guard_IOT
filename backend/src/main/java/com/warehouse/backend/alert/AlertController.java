package com.warehouse.backend.alert;

import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.security.CurrentUser;

/** Cảnh báo (AI Agent phát qua warehouse/alert, backend lưu lại). */
@RestController
@RequestMapping("/api/alerts")
public class AlertController {

    private static final List<String> LEVELS = List.of("info", "warning", "critical");
    private static final List<String> FEEDBACK = List.of("true_alarm", "false_alarm");

    private final AlertRepository alerts;

    public AlertController(AlertRepository alerts) {
        this.alerts = alerts;
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
        return get(id);
    }
}
