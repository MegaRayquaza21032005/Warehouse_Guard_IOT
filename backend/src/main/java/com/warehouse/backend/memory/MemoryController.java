package com.warehouse.backend.memory;

import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.warehouse.backend.chat.AgentClient;
import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.security.CurrentUser;

/**
 * Long-term memory của AI Agent (CLAUDE.md mục 7) — Java BE làm trung gian, user_id lấy từ JWT.
 * Người dùng xem / xóa memory cá nhân của mình; kiến thức chung về kho: ai cũng xem, người tạo hoặc ADMIN xóa.
 */
@RestController
@RequestMapping("/api/memories")
public class MemoryController {

    private static final Pattern KEY = Pattern.compile("[A-Za-z0-9_.-]{1,100}");
    private static final List<String> KINDS = List.of("facts", "incidents", "feedback");

    private final AgentClient agent;

    public MemoryController(AgentClient agent) {
        this.agent = agent;
    }

    /** Ghi nhớ cá nhân của tôi (sở thích, cách xưng hô...). */
    @GetMapping
    public Object mine(Authentication auth, @RequestParam(defaultValue = "100") int limit) {
        return agent.getJson("/memory", Map.of("user_id", CurrentUser.require(auth), "limit", limit));
    }

    @DeleteMapping("/{key}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteMine(@PathVariable String key, Authentication auth) {
        agent.delete("/memory/" + key(key), Map.of("user_id", CurrentUser.require(auth)));
    }

    /** Bộ nhớ dùng chung: kind = facts (kiến thức về kho) | incidents (tóm tắt sự cố) | feedback (đúng / báo giả). */
    @GetMapping("/warehouse")
    public Object warehouse(Authentication auth, @RequestParam(defaultValue = "facts") String kind,
            @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "100") int size) {
        CurrentUser.require(auth);
        if (!KINDS.contains(kind)) {
            throw ApiException.badRequest("invalid_kind", "kind hợp lệ: " + KINDS);
        }
        int s = Math.max(1, Math.min(size, 500));
        return agent.getJson("/memory/warehouse", Map.of("kind", kind, "limit", s, "offset", Math.max(0, page) * s));
    }

    /** Xóa kiến thức chung về kho — chỉ người tạo hoặc ADMIN. */
    @DeleteMapping("/warehouse/{key}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteFact(@PathVariable String key, Authentication auth) {
        Long me = CurrentUser.require(auth);
        boolean admin = auth.getAuthorities().stream().anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
        agent.delete("/memory/warehouse/" + key(key), Map.of("user_id", me, "is_admin", admin));
    }

    private static String key(String k) {
        if (!KEY.matcher(k).matches()) {
            throw ApiException.badRequest("invalid_key", "key không hợp lệ");
        }
        return k;
    }
}
