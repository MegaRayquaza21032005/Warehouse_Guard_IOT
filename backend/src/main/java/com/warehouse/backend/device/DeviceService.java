package com.warehouse.backend.device;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;

import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.mqtt.MqttPublisher;
import com.warehouse.backend.mqtt.Topics;

import tools.jackson.databind.ObjectMapper;

/** Lệnh điều khiển thiết bị từ nút bấm trên web/app (source = user). */
@Service
public class DeviceService {

    private final MqttPublisher mqtt;
    private final CommandLogRepository logs;
    private final ObjectMapper mapper;

    public DeviceService(MqttPublisher mqtt, CommandLogRepository logs, ObjectMapper mapper) {
        this.mqtt = mqtt;
        this.logs = logs;
        this.mapper = mapper;
    }

    public record CommandRequest(String state, String mode, Integer durationS) {
    }

    public Map<String, Object> sendUserCommand(String device, CommandRequest req, Long userId) {
        if (!Topics.DEVICES.contains(device)) {
            throw ApiException.notFound("unknown_device", "Thiết bị hợp lệ: " + Topics.DEVICES);
        }
        boolean hasState = req.state() != null;
        boolean hasMode = req.mode() != null;
        if (hasState == hasMode) {
            throw ApiException.badRequest("invalid_command", "Gửi đúng một trong hai: state (on/off) hoặc mode (auto)");
        }
        if (hasState && !req.state().equals("on") && !req.state().equals("off")) {
            throw ApiException.badRequest("invalid_state", "state phải là on hoặc off");
        }
        if (hasMode && !req.mode().equals("auto")) {
            throw ApiException.badRequest("invalid_mode", "mode chỉ nhận auto");
        }
        if (req.durationS() != null && (req.durationS() < 1 || req.durationS() > 86400)) {
            throw ApiException.badRequest("invalid_duration", "durationS từ 1 đến 86400 giây");
        }
        if (hasMode && req.durationS() != null) {
            throw ApiException.badRequest("invalid_duration", "durationS chỉ dùng với state");
        }

        String traceId = UUID.randomUUID().toString();
        Map<String, Object> payload = new LinkedHashMap<>();
        if (hasState) {
            payload.put("state", req.state());
        } else {
            payload.put("mode", "auto");
        }
        payload.put("source", "user");
        payload.put("user_id", userId == null ? null : String.valueOf(userId));
        payload.put("trace_id", traceId);
        if (req.durationS() != null) {
            payload.put("duration_s", req.durationS());
        }

        // Ghi nhật ký trước rồi mới gửi (bản tin vòng lại từ broker sẽ bị bỏ qua nhờ trùng trace_id)
        long logId = logs.insert(new CommandLogRepository.NewLog(device, hasState ? req.state() : "auto", "user",
                userId, traceId, null, req.durationS(), mapper.writeValueAsString(payload)));
        try {
            mqtt.publish(Topics.cmd(device), payload, false);
        } catch (ApiException e) {
            logs.markResult(logId, "publish_failed");
            throw e;
        }

        Map<String, Object> res = new LinkedHashMap<>();
        res.put("traceId", traceId);
        res.put("device", device);
        res.put("command", payload);
        res.put("status", "sent");
        return res;
    }
}
