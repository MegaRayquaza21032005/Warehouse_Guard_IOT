package com.warehouse.backend.camera;

import static com.warehouse.backend.common.Json.bool;
import static com.warehouse.backend.common.Json.dbl;
import static com.warehouse.backend.common.Json.intVal;
import static com.warehouse.backend.common.Json.str;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import com.warehouse.backend.config.AppProperties;
import com.warehouse.backend.ws.LiveBroadcaster;

/**
 * Camera (service vision):
 * - lưu sự kiện có / hết người, có / hết lửa, khói (chỉ khi đổi),
 * - chụp ảnh làm bằng chứng khi có cảnh báo đột nhập / cháy / camera thấy lửa, khói (chạy nền — không làm chậm việc lưu cảnh báo),
 * - xóa ảnh cũ hơn CAMERA_SNAPSHOT_RETENTION_DAYS.
 */
@Service
public class CameraService {

    private static final Logger log = LoggerFactory.getLogger(CameraService.class);
    /** Sự kiện WebSocket khi có ảnh mới: {"type":"camera.snapshot","data":{id, alertId, ...}}. */
    public static final String SNAPSHOT_TOPIC = "warehouse/camera/snapshot";

    private final CameraRepository repo;
    private final VisionClient vision;
    private final LiveBroadcaster broadcaster;
    private final List<String> snapshotTypes;
    private final int retentionDays;

    public CameraService(CameraRepository repo, VisionClient vision, LiveBroadcaster broadcaster, AppProperties props) {
        this.repo = repo;
        this.vision = vision;
        this.broadcaster = broadcaster;
        AppProperties.Vision v = props.vision();
        this.snapshotTypes = v == null || v.snapshotAlertTypes() == null ? List.of() : v.snapshotAlertTypes();
        this.retentionDays = v == null || v.snapshotRetentionDays() <= 0 ? 30 : v.snapshotRetentionDays();
    }

    /** warehouse/sensor/camera. Bản tin định kỳ giống bản trước -> bỏ qua. */
    public void onReading(Map<String, Object> d) {
        String error = str(d, "error");
        Boolean person = bool(d, "person");
        if (error == null && person == null) {
            return;
        }
        boolean p = error == null && Boolean.TRUE.equals(person);
        Integer count = intVal(d, "personCount");
        Boolean fire = error == null ? bool(d, "fire") : null;
        Boolean smoke = error == null ? bool(d, "smoke") : null;
        CameraRepository.EventKey key = new CameraRepository.EventKey(p, p ? Math.max(1, count == null ? 1 : count) : 0,
                error, fire, smoke);
        if (repo.lastEvent().map(key::equals).orElse(false)) {
            return;
        }
        repo.insertEvent(key, p ? dbl(d, "personConf") : null, Boolean.TRUE.equals(fire) ? dbl(d, "fireConf") : null,
                Boolean.TRUE.equals(smoke) ? dbl(d, "smokeConf") : null);
    }

    /** Gọi sau khi đã lưu cảnh báo. Loại cần ảnh -> chụp nền. */
    public void onAlert(long alertId, String type, String incidentId, Map<String, Object> details) {
        if (!snapshotTypes.contains(type)) {
            return;
        }
        Integer personCount = details == null ? null : intVal(details, "person_count");
        Thread.ofVirtual().name("camera-snapshot-" + alertId)
                .start(() -> capture(alertId, type, incidentId, personCount));
    }

    /** Chụp ảnh hiện tại của camera gắn với cảnh báo. Trả id ảnh hoặc null nếu camera không có hình. */
    public Long capture(Long alertId, String type, String incidentId, Integer personCount) {
        try {
            byte[] jpeg = vision.snapshot();
            long id = repo.insertSnapshot(alertId, type, incidentId, personCount, "image/jpeg", jpeg);
            log.info("[CAMERA] Đã lưu ảnh #{} ({} KB) cho cảnh báo #{} ({})", id, jpeg.length / 1024, alertId, type);
            Map<String, Object> ev = new LinkedHashMap<>();
            ev.put("id", id);
            ev.put("alertId", alertId);
            ev.put("alertType", type);
            ev.put("incidentId", incidentId);
            broadcaster.broadcast(SNAPSHOT_TOPIC, ev, Instant.now());
            return id;
        } catch (RuntimeException e) {
            log.warn("[CAMERA] Không chụp được ảnh cho cảnh báo #{} ({}): {}", alertId, type, e.getMessage());
            return null;
        }
    }

    @Scheduled(cron = "0 17 3 * * *")
    public void cleanup() {
        int n = repo.deleteSnapshotsBefore(Instant.now().minus(Duration.ofDays(retentionDays)));
        if (n > 0) {
            log.info("[CAMERA] Đã xóa {} ảnh cũ hơn {} ngày", n, retentionDays);
        }
    }
}
