package com.warehouse.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

class AuthIntegrationTest extends IntegrationTestBase {

    @Test
    void registerLoginMeRefreshLogout() throws Exception {
        // Đăng ký: username / email chuẩn hóa chữ thường, mật khẩu được băm
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("username", "Thanh", "email", "Thanh@Example.com", "password", "secret123",
                        "fullName", "Thanh"))))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.user.username").value("thanh"))
                .andExpect(jsonPath("$.user.email").value("thanh@example.com"))
                .andExpect(jsonPath("$.tokenType").value("Bearer"));
        String hash = jdbc.sql("SELECT password_hash FROM app.users WHERE username = 'thanh'").query(String.class)
                .single();
        assertThat(hash).startsWith("$2").doesNotContain("secret123");

        // Đăng nhập bằng username hoặc email
        mvc.perform(post("/api/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("login", "THANH", "password", "secret123")))).andExpect(status().isOk());
        String body = mvc.perform(post("/api/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("login", "thanh@example.com", "password", "secret123"))))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        Map<String, Object> tokens = parse(body);
        String access = (String) tokens.get("accessToken");
        String refresh = (String) tokens.get("refreshToken");

        mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + access))
                .andExpect(status().isOk()).andExpect(jsonPath("$.username").value("thanh"));

        // Làm mới: token cũ bị thu hồi (xoay vòng)
        String refreshed = mvc.perform(post("/api/auth/refresh").contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("refreshToken", refresh)))).andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        String newRefresh = (String) parse(refreshed).get("refreshToken");
        assertThat(newRefresh).isNotEqualTo(refresh);
        mvc.perform(post("/api/auth/refresh").contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("refreshToken", refresh))))
                .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.error").value("invalid_refresh_token"));

        // Đăng xuất: refresh token mới cũng hết hiệu lực
        mvc.perform(post("/api/auth/logout").contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("refreshToken", newRefresh)))).andExpect(status().isNoContent());
        mvc.perform(post("/api/auth/refresh").contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("refreshToken", newRefresh)))).andExpect(status().isUnauthorized());
    }

    @Test
    void rejectsDuplicatesWrongPasswordAndInvalidInput() throws Exception {
        registerAndGetToken("alice");
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("username", "ALICE", "email", "other@example.com", "password", "secret123"))))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error").value("username_taken"));
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("username", "bob", "email", "alice@example.com", "password", "secret123"))))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error").value("email_taken"));
        mvc.perform(post("/api/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("login", "alice", "password", "wrong-pass"))))
                .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.error").value("invalid_credentials"));
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("username", "a b", "email", "not-an-email", "password", "123"))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.details.username").exists())
                .andExpect(jsonPath("$.details.email").exists())
                .andExpect(jsonPath("$.details.password").exists());
    }

    @Test
    void protectsApiAndAcceptsInternalKey() throws Exception {
        mvc.perform(get("/api/state")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/state").header("Authorization", "Bearer not-a-jwt")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/state").header("X-Internal-Key", "test-internal-key")).andExpect(status().isOk());
        mvc.perform(get("/api/state").header("X-Internal-Key", "wrong")).andExpect(status().isUnauthorized());
        // AI Agent không phải người dùng -> không gọi được API cần user
        mvc.perform(get("/api/auth/me").header("X-Internal-Key", "test-internal-key"))
                .andExpect(status().isForbidden());
        String token = registerAndGetToken("carol");
        mvc.perform(get("/api/state").header("Authorization", "Bearer " + token)).andExpect(status().isOk());
    }
}
