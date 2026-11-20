package com.warehouse.backend.security;

import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

import com.warehouse.backend.common.ApiException;

/** Lấy id người dùng từ access token. */
public final class CurrentUser {

    private CurrentUser() {
    }

    /** id người dùng, hoặc null nếu là AI Agent (X-Internal-Key). */
    public static Long idOrNull(Authentication auth) {
        if (auth instanceof JwtAuthenticationToken jwt) {
            return Long.parseLong(jwt.getToken().getSubject());
        }
        return null;
    }

    /** id người dùng; lỗi 403 nếu không phải người dùng thật. */
    public static Long require(Authentication auth) {
        Long id = idOrNull(auth);
        if (id == null) {
            throw new ApiException(HttpStatus.FORBIDDEN, "user_required", "Chức năng này cần đăng nhập bằng tài khoản người dùng");
        }
        return id;
    }
}
