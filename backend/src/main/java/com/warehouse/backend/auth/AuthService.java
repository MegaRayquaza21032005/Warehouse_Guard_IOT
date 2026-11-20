package com.warehouse.backend.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Locale;

import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.warehouse.backend.auth.AuthDtos.AuthResponse;
import com.warehouse.backend.auth.AuthDtos.LoginRequest;
import com.warehouse.backend.auth.AuthDtos.RegisterRequest;
import com.warehouse.backend.auth.AuthDtos.UserDto;
import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.config.AppProperties;
import com.warehouse.backend.security.JwtService;

/**
 * Đăng ký / đăng nhập / làm mới phiên / đăng xuất.
 * Access token: JWT ngắn hạn. Refresh token: chuỗi ngẫu nhiên, lưu SHA-256 trong DB, xoay vòng mỗi lần dùng.
 */
@Service
public class AuthService {

    private static final SecureRandom RANDOM = new SecureRandom();

    private final UserRepository users;
    private final RefreshTokenRepository refreshTokens;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final JwtEncoder jwtEncoder;
    private final AppProperties props;

    public AuthService(UserRepository users, RefreshTokenRepository refreshTokens, PasswordEncoder passwordEncoder,
            JwtService jwtService, JwtEncoder jwtEncoder, AppProperties props) {
        this.users = users;
        this.refreshTokens = refreshTokens;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.jwtEncoder = jwtEncoder;
        this.props = props;
    }

    @Transactional
    public AuthResponse register(RegisterRequest req) {
        String username = req.username().trim().toLowerCase(Locale.ROOT);
        String email = req.email().trim().toLowerCase(Locale.ROOT);
        if (users.existsByUsername(username)) {
            throw new ApiException(HttpStatus.CONFLICT, "username_taken", "Tên đăng nhập đã được dùng");
        }
        if (users.existsByEmail(email)) {
            throw new ApiException(HttpStatus.CONFLICT, "email_taken", "Email đã được dùng");
        }
        String fullName = req.fullName() == null || req.fullName().isBlank() ? null : req.fullName().trim();
        User user = users.save(new User(username, email, passwordEncoder.encode(req.password()), fullName));
        return issueTokens(user);
    }

    @Transactional
    public AuthResponse login(LoginRequest req) {
        String login = req.login().trim().toLowerCase(Locale.ROOT);
        User user = (login.contains("@") ? users.findByEmail(login) : users.findByUsername(login))
                .filter(u -> passwordEncoder.matches(req.password(), u.getPasswordHash()))
                .orElseThrow(() -> new ApiException(HttpStatus.UNAUTHORIZED, "invalid_credentials",
                        "Sai tên đăng nhập hoặc mật khẩu"));
        if (!user.isEnabled()) {
            throw new ApiException(HttpStatus.FORBIDDEN, "account_disabled", "Tài khoản đã bị khóa");
        }
        return issueTokens(user);
    }

    /** Đổi refresh token cũ lấy cặp token mới; token cũ bị thu hồi (xoay vòng). */
    @Transactional
    public AuthResponse refresh(String rawRefreshToken) {
        Instant now = Instant.now();
        RefreshToken token = refreshTokens.findByTokenHash(sha256(rawRefreshToken))
                .filter(t -> t.isActive(now))
                .orElseThrow(() -> new ApiException(HttpStatus.UNAUTHORIZED, "invalid_refresh_token",
                        "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại"));
        token.revoke(now);
        User user = token.getUser();
        if (!user.isEnabled()) {
            throw new ApiException(HttpStatus.FORBIDDEN, "account_disabled", "Tài khoản đã bị khóa");
        }
        return issueTokens(user);
    }

    @Transactional
    public void logout(String rawRefreshToken) {
        refreshTokens.findByTokenHash(sha256(rawRefreshToken)).ifPresent(t -> t.revoke(Instant.now()));
    }

    @Transactional(readOnly = true)
    public UserDto me(Long userId) {
        return users.findById(userId).map(UserDto::of)
                .orElseThrow(() -> ApiException.notFound("user_not_found", "Không tìm thấy người dùng"));
    }

    private AuthResponse issueTokens(User user) {
        String access = jwtService.issueAccessToken(jwtEncoder, user);
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        String refresh = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        refreshTokens.save(new RefreshToken(user, sha256(refresh), Instant.now().plus(props.jwt().refreshTtl())));
        return new AuthResponse(access, refresh, "Bearer", jwtService.accessTtlSeconds(), UserDto.of(user));
    }

    static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
