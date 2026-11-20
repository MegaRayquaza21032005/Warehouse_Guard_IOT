package com.warehouse.backend.device;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.common.TimeRange;
import com.warehouse.backend.mqtt.Topics;
import com.warehouse.backend.security.CurrentUser;
import com.warehouse.backend.telemetry.LiveStateService;

@RestController
@RequestMapping("/api")
public class DeviceController {

    private static final List<String> SOURCES = List.of("esp32_local", "rule", "agent", "user");

    private final DeviceService devices;
    private final CommandLogRepository logs;
    private final LiveStateService live;

    public DeviceController(DeviceService devices, CommandLogRepository logs, LiveStateService live) {
        this.devices = devices;
        this.logs = logs;
        this.live = live;
    }

    /** Trạng thái hiện tại của quạt, phun sương, đèn. */
    @GetMapping("/devices")
    public Map<String, Object> list() {
        Map<String, Object> m = new LinkedHashMap<>();
        for (String d : Topics.DEVICES) {
            m.put(d, live.get(Topics.status(d)));
        }
        return m;
    }

    /**
     * Bật / tắt / về tự động. Body: {"state":"on"} | {"state":"off","durationS":600} | {"mode":"auto"}.
     * Trả 202: lệnh đã gửi; ESP32 xác nhận qua WebSocket (status.* có ack.trace_id) và nhật ký lệnh.
     */
    @PostMapping("/devices/{device}/command")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public Map<String, Object> command(@PathVariable String device, @RequestBody DeviceService.CommandRequest req,
            Authentication auth) {
        return devices.sendUserCommand(device, req, CurrentUser.require(auth));
    }

    /** Nhật ký lệnh thiết bị từ mọi nguồn — trả lời "ai / cái gì đã bật quạt lúc 3h sáng". */
    @GetMapping("/device-logs")
    public List<Map<String, Object>> logs(@RequestParam(required = false) String device,
            @RequestParam(required = false) String source,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "50") int size) {
        if (device != null && !Topics.DEVICES.contains(device)) {
            throw ApiException.badRequest("unknown_device", "Thiết bị hợp lệ: " + Topics.DEVICES);
        }
        if (source != null && !SOURCES.contains(source)) {
            throw ApiException.badRequest("unknown_source", "Nguồn hợp lệ: " + SOURCES);
        }
        TimeRange r = TimeRange.of(from, to, Duration.ofDays(7));
        int s = Math.max(1, Math.min(size, 500));
        return logs.search(device, source, r.from(), r.to(), s, Math.max(0, page) * s);
    }
}
