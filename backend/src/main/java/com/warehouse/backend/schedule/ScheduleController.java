package com.warehouse.backend.schedule;

import java.util.Map;
import java.util.regex.Pattern;

import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.warehouse.backend.chat.AgentClient;
import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.security.CurrentUser;

/**
 * Lệnh thiết bị hẹn giờ / nối chuỗi tạo từ chatbot (vd. "bật phun sương 30s rồi bật quạt 30s") — nằm trong RAM của
 * AI Agent, Java BE làm trung gian. Thiết bị dùng chung nên mọi người dùng đã đăng nhập đều xem và hủy được
 * (giống nút điều khiển); ai-agent ghi user_id người hủy vào nhật ký tool call.
 */
@RestController
@RequestMapping("/api/schedules")
public class ScheduleController {

    private static final Pattern ID = Pattern.compile("[0-9a-fA-F-]{36}");

    private final AgentClient agent;

    public ScheduleController(AgentClient agent) {
        this.agent = agent;
    }

    /** Lệnh đang chờ, sớm nhất trước: {id, device, description, run_at, remaining_s, user_id, ...}. */
    @GetMapping
    public Object list(Authentication auth) {
        CurrentUser.require(auth);
        return agent.getJson("/schedules", Map.of());
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void cancel(@PathVariable String id, Authentication auth) {
        Long me = CurrentUser.require(auth);
        if (!ID.matcher(id).matches()) {
            throw ApiException.badRequest("invalid_id", "id không hợp lệ");
        }
        agent.delete("/schedules/" + id, Map.of("user_id", me));
    }
}
