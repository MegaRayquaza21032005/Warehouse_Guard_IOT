package com.warehouse.backend.push;

import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.security.CurrentUser;

/** App mobile đăng ký / hủy token FCM để nhận push cảnh báo. */
@RestController
@RequestMapping("/api/push")
public class PushController {

    private static final List<String> PLATFORMS = List.of("android", "ios");

    private final PushTokenRepository tokens;
    private final PushService push;

    public PushController(PushTokenRepository tokens, PushService push) {
        this.tokens = tokens;
        this.push = push;
    }

    public record TokenRequest(String token, String platform) {
    }

    /** Trạng thái push phía server (đã cấu hình FCM chưa) + số máy của tôi đã đăng ký. */
    @GetMapping("/status")
    public Map<String, Object> status(Authentication auth) {
        long me = CurrentUser.require(auth);
        return Map.of("enabled", push.enabled(), "myDevices", tokens.countForUser(me));
    }

    @PostMapping("/tokens")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void register(@RequestBody TokenRequest req, Authentication auth) {
        long me = CurrentUser.require(auth);
        if (req.token() == null || req.token().isBlank() || req.token().length() > 4096) {
            throw ApiException.badRequest("invalid_token", "Thiếu token FCM");
        }
        String platform = req.platform() == null ? "android" : req.platform().toLowerCase();
        if (!PLATFORMS.contains(platform)) {
            throw ApiException.badRequest("invalid_platform", "platform hợp lệ: " + PLATFORMS);
        }
        tokens.upsert(me, req.token().strip(), platform);
    }

    /** Gọi khi đăng xuất trên điện thoại — máy đó thôi nhận push. */
    @DeleteMapping("/tokens")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void unregister(@RequestBody TokenRequest req, Authentication auth) {
        long me = CurrentUser.require(auth);
        if (req.token() != null) {
            tokens.delete(me, req.token().strip());
        }
    }
}
