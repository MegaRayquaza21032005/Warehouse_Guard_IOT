package com.warehouse.backend.push;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import com.warehouse.backend.config.AppProperties;

import tools.jackson.databind.ObjectMapper;

/**
 * Push notification FCM cho cảnh báo (CLAUDE.md mục 5.4): critical / warning luôn push; info push trừ khi
 * details.push = false (LLM chọn "chỉ hiện trong app"). Gửi cho MỌI người dùng — cảnh báo kho không theo người.
 * Chạy nền (virtual thread): FCM chậm / lỗi không ảnh hưởng việc lưu cảnh báo.
 */
@Service
public class PushService {

    private static final Logger log = LoggerFactory.getLogger(PushService.class);

    private static final Map<String, String> TYPE_VI = Map.ofEntries(
            Map.entry("fire", "Nghi cháy"), Map.entry("fire_people", "Nghi cháy, có thể có người"),
            Map.entry("gas_danger", "Rò rỉ khí nhiều"), Map.entry("gas", "Có khí / khói"),
            Map.entry("intrusion", "Đột nhập"), Map.entry("mist_fire_max_time", "Phun sương hết giờ"),
            Map.entry("device_offline", "ESP32 mất kết nối"), Map.entry("no_data", "Không có dữ liệu"),
            Map.entry("device_no_response", "Thiết bị không phản hồi"), Map.entry("sensor_fault", "Lỗi cảm biến"),
            Map.entry("temp_high_prolonged", "Nóng kéo dài"), Map.entry("hum_high_prolonged", "Ẩm kéo dài"),
            Map.entry("ventilation_ineffective", "Thông gió không hiệu quả"), Map.entry("recovered", "Đã bình thường"),
            Map.entry("escalation", "Chưa ai xem cảnh báo nguy hiểm"), Map.entry("manual_notice", "Thông báo"));

    private final PushTokenRepository tokens;
    private final FcmClient fcm;

    public PushService(PushTokenRepository tokens, AppProperties props, ObjectMapper mapper) {
        this.tokens = tokens;
        FcmClient c = null;
        AppProperties.Push p = props.push();
        if (p != null && p.enabled()) {
            try {
                c = new FcmClient(Path.of(p.credentialsFile()), p.fcmUrl() == null ? "https://fcm.googleapis.com"
                        : p.fcmUrl(), mapper);
                log.info("[PUSH] Bật FCM (project {})", c.projectId());
            } catch (Exception e) {
                log.error("[PUSH] Không đọc được FCM_CREDENTIALS_FILE ({}): {} — tắt push", p.credentialsFile(),
                        e.getMessage());
            }
        } else {
            log.info("[PUSH] Chưa cấu hình FCM_CREDENTIALS_FILE — tắt push (cảnh báo vẫn có trên web/app qua WebSocket)");
        }
        this.fcm = c;
    }

    public boolean enabled() {
        return fcm != null;
    }

    /** Gọi sau khi đã lưu cảnh báo (alert = dòng app.alerts đã lưu, có id). */
    public void onAlert(Map<String, Object> alert) {
        if (fcm == null || !shouldPush(alert)) {
            return;
        }
        Thread.ofVirtual().name("push-alert").start(() -> sendAll(alert));
    }

    static boolean shouldPush(Map<String, Object> alert) {
        String level = String.valueOf(alert.get("level"));
        if ("critical".equals(level) || "warning".equals(level)) {
            return true;
        }
        return !(alert.get("details") instanceof Map<?, ?> d && Boolean.FALSE.equals(d.get("push")));
    }

    private void sendAll(Map<String, Object> alert) {
        List<String> all = tokens.allTokens();
        if (all.isEmpty()) {
            return;
        }
        int ok = 0;
        for (String t : all) {
            try {
                switch (fcm.send(message(alert, t))) {
                    case OK -> ok++;
                    case INVALID_TOKEN -> {
                        tokens.deleteToken(t);
                        log.info("[PUSH] Xóa token không còn hợp lệ");
                    }
                    case ERROR -> {
                    }
                }
            } catch (RuntimeException e) {
                log.warn("[PUSH] Gửi lỗi: {}", e.getMessage());
            }
        }
        log.info("[PUSH] Cảnh báo #{} {} {} -> {}/{} máy", alert.get("id"), alert.get("level"), alert.get("type"), ok,
                all.size());
    }

    static Map<String, Object> message(Map<String, Object> alert, String token) {
        String level = String.valueOf(alert.get("level"));
        String type = String.valueOf(alert.get("type"));
        String typeVi = type.endsWith("_analysis")
                ? "Phân tích: " + TYPE_VI.getOrDefault(type.replace("_analysis", ""), type)
                : TYPE_VI.getOrDefault(type, type);
        String prefix = switch (level) {
            case "critical" -> "🚨 NGUY HIỂM";
            case "warning" -> "⚠️ Cảnh báo";
            default -> "ℹ️ Thông tin";
        };
        String body = String.valueOf(alert.getOrDefault("message", ""));
        if (body.length() > 900) {
            body = body.substring(0, 900) + "…";
        }
        String channel = "critical".equals(level) ? "alerts-critical" : "alerts";
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("token", token);
        m.put("notification", Map.of("title", prefix + " · " + typeVi, "body", body));
        m.put("data", Map.of("alertId", String.valueOf(alert.get("id")), "type", type, "level", level));
        m.put("android", Map.of("priority", "info".equals(level) ? "NORMAL" : "HIGH",
                "notification", Map.of("channel_id", channel, "sound", "default", "tag", "alert-" + alert.get("id"))));
        m.put("apns", Map.of("headers", Map.of("apns-priority", "info".equals(level) ? "5" : "10"),
                "payload", Map.of("aps", Map.of("sound", "default"))));
        return m;
    }
}
