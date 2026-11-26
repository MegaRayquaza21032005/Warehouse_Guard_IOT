package com.warehouse.backend.config;

import java.time.Duration;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Cấu hình riêng của ứng dụng (prefix "app" trong application.yml, giá trị lấy từ .env). */
@ConfigurationProperties(prefix = "app")
public record AppProperties(
        String timezone,
        Jwt jwt,
        String internalApiKey,
        List<String> corsAllowedOrigins,
        WorkHours workHours,
        Mqtt mqtt,
        Agent agent,
        Push push,
        Vision vision) {

    public ZoneId zone() {
        return ZoneId.of(timezone);
    }

    public record Jwt(String secret, Duration accessTtl, Duration refreshTtl) {
    }

    /** Giờ làm việc. days: 1 = Thứ 2 ... 7 = Chủ nhật (ISO). */
    public record WorkHours(String start, String end, List<Integer> days) {
        public LocalTime startTime() {
            return LocalTime.parse(start);
        }

        public LocalTime endTime() {
            return LocalTime.parse(end);
        }
    }

    /** AI Agent nội bộ (FastAPI, không public). url vd. http://localhost:8000. */
    public record Agent(String url, Duration timeout) {
    }

    /**
     * Service vision nội bộ (camera + YOLO, chỉ nghe 127.0.0.1). url vd. http://localhost:8100.
     * snapshotAlertTypes: loại cảnh báo được chụp ảnh làm bằng chứng; snapshotRetentionDays: giữ ảnh bao lâu.
     */
    public record Vision(String url, Duration timeout, List<String> snapshotAlertTypes, int snapshotRetentionDays) {
    }

    /**
     * Push FCM (HTTP v1). credentialsFile = file JSON service account của Firebase; trống -> tắt push.
     * fcmUrl chỉ đổi khi test.
     */
    public record Push(String credentialsFile, String fcmUrl) {
        public boolean enabled() {
            return credentialsFile != null && !credentialsFile.isBlank();
        }
    }

    public record Mqtt(boolean enabled, String host, int port, String username, String password, String clientId) {
        public String uri() {
            return "tcp://" + host + ":" + port;
        }
    }
}
