package com.warehouse.backend.ws;

import java.io.IOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import com.warehouse.backend.mqtt.Topics;
import com.warehouse.backend.telemetry.LiveStateService;

import tools.jackson.databind.ObjectMapper;

/**
 * WebSocket /ws/live?token=<access token>.
 * Khi kết nối: gửi {"type":"snapshot","data":{...}}. Sau đó mỗi bản tin MQTT:
 * {"type":"sensor.mq135","topic":"warehouse/sensor/mq135","data":{...},"ts":"..."}.
 */
@Component
public class LiveWebSocketHandler extends TextWebSocketHandler implements LiveBroadcaster {

    private static final Logger log = LoggerFactory.getLogger(LiveWebSocketHandler.class);

    private final Set<WebSocketSession> sessions = ConcurrentHashMap.newKeySet();
    private final ObjectMapper mapper;
    private final LiveStateService live;

    public LiveWebSocketHandler(ObjectMapper mapper, LiveStateService live) {
        this.mapper = mapper;
        this.live = live;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws IOException {
        WebSocketSession safe = new ConcurrentWebSocketSessionDecorator(session, 5000, 512 * 1024);
        sessions.add(safe);
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("type", "snapshot");
        msg.put("data", live.snapshot());
        msg.put("ts", Instant.now());
        safe.sendMessage(new TextMessage(mapper.writeValueAsString(msg)));
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.removeIf(s -> s.getId().equals(session.getId()));
    }

    @Override
    public void broadcast(String topic, Object data, Instant ts) {
        if (sessions.isEmpty()) {
            return;
        }
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("type", Topics.type(topic));
        msg.put("topic", topic);
        msg.put("data", data);
        msg.put("ts", ts);
        TextMessage text = new TextMessage(mapper.writeValueAsString(msg));
        for (WebSocketSession s : sessions) {
            try {
                if (s.isOpen()) {
                    s.sendMessage(text);
                }
            } catch (IOException | IllegalStateException e) {
                log.debug("[WS] gửi tới {} lỗi: {}", s.getId(), e.getMessage());
            }
        }
    }

    public int sessionCount() {
        return sessions.size();
    }
}
