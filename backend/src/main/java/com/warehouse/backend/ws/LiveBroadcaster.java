package com.warehouse.backend.ws;

import java.time.Instant;

/** Đẩy sự kiện realtime tới client (WebSocket). */
public interface LiveBroadcaster {

    void broadcast(String topic, Object data, Instant ts);
}
