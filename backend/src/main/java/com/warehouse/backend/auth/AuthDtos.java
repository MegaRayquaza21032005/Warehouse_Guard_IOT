package com.warehouse.backend.auth;

import java.time.Instant;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/** Request / response của API đăng nhập, đăng ký. */
public final class AuthDtos {

    private AuthDtos() {
    }

    public record RegisterRequest(
            @NotBlank(message = "Bắt buộc") @Size(min = 3, max = 50, message = "Từ 3 đến 50 ký tự")
            @Pattern(regexp = "^[a-zA-Z0-9_.]+$", message = "Chỉ gồm chữ, số, dấu _ và .") String username,
            @NotBlank(message = "Bắt buộc") @Email(message = "Email không hợp lệ") @Size(max = 255) String email,
            @NotBlank(message = "Bắt buộc") @Size(min = 6, max = 100, message = "Từ 6 đến 100 ký tự") String password,
            @Size(max = 100, message = "Tối đa 100 ký tự") String fullName) {
    }

    /** login = username hoặc email. */
    public record LoginRequest(
            @NotBlank(message = "Bắt buộc") String login,
            @NotBlank(message = "Bắt buộc") String password) {
    }

    public record RefreshRequest(@NotBlank(message = "Bắt buộc") String refreshToken) {
    }

    public record UserDto(Long id, String username, String email, String fullName, String role, Instant createdAt) {
        public static UserDto of(User u) {
            return new UserDto(u.getId(), u.getUsername(), u.getEmail(), u.getFullName(), u.getRole(),
                    u.getCreatedAt());
        }
    }

    public record AuthResponse(String accessToken, String refreshToken, String tokenType, long expiresIn,
            UserDto user) {
    }
}
