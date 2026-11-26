package com.warehouse.backend.camera;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.mqtt.Topics;
import com.warehouse.backend.telemetry.LiveStateService;

import jakarta.servlet.http.HttpServletResponse;

/**
 * Camera: xem trực tiếp (MJPEG có khung YOLO), ảnh hiện tại, ảnh chụp khi có sự cố.
 *
 * Thẻ <img> / Image của React Native không gửi được header Authorization -> các GET dưới /api/camera/ nhận thêm
 * access token qua query ?access_token=... (SecurityConfig). API khác vẫn chỉ nhận header.
 */
@RestController
@RequestMapping("/api/camera")
public class CameraController {

    private static final Logger log = LoggerFactory.getLogger(CameraController.class);

    private final VisionClient vision;
    private final CameraRepository repo;
    private final LiveStateService live;

    public CameraController(VisionClient vision, CameraRepository repo, LiveStateService live) {
        this.vision = vision;
        this.repo = repo;
        this.live = live;
    }

    /** Trạng thái: bản tin MQTT mới nhất (luôn có nếu từng nhận) + chi tiết từ service vision (nếu đang chạy). */
    @GetMapping("/status")
    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("online", live.entry(Topics.STATUS_CAMERA));
        out.put("detection", live.entry(Topics.SENSOR_CAMERA));
        try {
            out.put("service", vision.status());
            out.put("reachable", true);
        } catch (ApiException e) {
            out.put("service", null);
            out.put("reachable", false);
            out.put("error", e.code());
        }
        return out;
    }

    /**
     * MJPEG (multipart/x-mixed-replace) chuyển tiếp từ vision. Ghi thẳng ra response trong luồng request — không
     * dùng async để không bị spring.mvc.async.request-timeout cắt luồng xem lâu. Client đóng -> đóng luồng vision.
     */
    @GetMapping("/stream")
    public void stream(@RequestParam(defaultValue = "10") int fps, HttpServletResponse response) {
        HttpResponse<InputStream> up = vision.openStream(Math.max(1, Math.min(fps, 30)));
        response.setStatus(200);
        response.setContentType(up.headers().firstValue("Content-Type")
                .orElse("multipart/x-mixed-replace; boundary=frame"));
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Accel-Buffering", "no");
        long bytes = 0;
        try (InputStream in = up.body()) {
            OutputStream out = response.getOutputStream();
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
                out.flush();
                bytes += n;
            }
        } catch (IOException e) {
            // người xem đóng tab / mất mạng, hoặc vision dừng — bình thường
        }
        log.debug("[CAMERA] Kết thúc luồng xem ({} KB)", bytes / 1024);
    }

    /** Ảnh hiện tại (app di động lấy liên tục thay cho MJPEG). */
    @GetMapping("/snapshot")
    public ResponseEntity<byte[]> snapshot() {
        return ResponseEntity.ok().contentType(MediaType.IMAGE_JPEG).cacheControl(CacheControl.noStore())
                .body(vision.snapshot());
    }

    /** Ảnh chụp khi có sự cố (mới nhất trước). */
    @GetMapping("/snapshots")
    public List<Map<String, Object>> snapshots(@RequestParam(required = false) Long alertId,
            @RequestParam(required = false) String incidentId, @RequestParam(defaultValue = "30") int limit) {
        return repo.listSnapshots(alertId, incidentId, Math.max(1, Math.min(limit, 200)));
    }

    @GetMapping("/snapshots/{id}/image")
    public ResponseEntity<byte[]> image(@PathVariable long id) {
        CameraRepository.Image img = repo.image(id)
                .orElseThrow(() -> ApiException.notFound("snapshot_not_found", "Không tìm thấy ảnh"));
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(img.contentType()))
                .cacheControl(CacheControl.maxAge(Duration.ofDays(1)).cachePrivate()).body(img.data());
    }
}
