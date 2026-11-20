package com.warehouse.backend.mqtt;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import org.eclipse.paho.client.mqttv3.IMqttActionListener;
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken;
import org.eclipse.paho.client.mqttv3.IMqttToken;
import org.eclipse.paho.client.mqttv3.MqttAsyncClient;
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttException;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import com.warehouse.backend.common.ApiException;
import com.warehouse.backend.config.AppProperties;

import jakarta.annotation.PreDestroy;
import tools.jackson.databind.ObjectMapper;

/**
 * Kết nối Mosquitto bằng tài khoản "backend", subscribe warehouse/# và chuyển mọi bản tin cho
 * {@link MqttIngestService}. Ứng dụng vẫn khởi động được khi broker chưa chạy — tự thử lại mỗi 5 giây.
 */
@Component
@ConditionalOnProperty(prefix = "app.mqtt", name = "enabled", havingValue = "true")
public class PahoMqttGateway implements MqttPublisher, MqttCallbackExtended {

    private static final Logger log = LoggerFactory.getLogger(PahoMqttGateway.class);

    private final AppProperties.Mqtt cfg;
    private final MqttIngestService ingest;
    private final ObjectMapper mapper;
    private final AtomicBoolean connecting = new AtomicBoolean(false);
    private MqttAsyncClient client;

    public PahoMqttGateway(AppProperties props, MqttIngestService ingest, ObjectMapper mapper) {
        this.cfg = props.mqtt();
        this.ingest = ingest;
        this.mapper = mapper;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void start() throws MqttException {
        String clientId = cfg.clientId() + "-" + UUID.randomUUID().toString().substring(0, 8);
        client = new MqttAsyncClient(cfg.uri(), clientId, new MemoryPersistence());
        client.setCallback(this);
        connect();
    }

    @Scheduled(fixedDelay = 5000, initialDelay = 5000)
    public void ensureConnected() {
        if (client != null && !client.isConnected()) {
            connect();
        }
    }

    private void connect() {
        if (!connecting.compareAndSet(false, true)) {
            return;
        }
        MqttConnectOptions opts = new MqttConnectOptions();
        opts.setCleanSession(true);
        opts.setAutomaticReconnect(true);
        opts.setKeepAliveInterval(30);
        opts.setConnectionTimeout(5);
        opts.setMaxInflight(100);
        if (cfg.username() != null && !cfg.username().isBlank()) {
            opts.setUserName(cfg.username());
            opts.setPassword(cfg.password() == null ? new char[0] : cfg.password().toCharArray());
        }
        try {
            client.connect(opts, null, new IMqttActionListener() {
                @Override
                public void onSuccess(IMqttToken token) {
                    connecting.set(false);
                }

                @Override
                public void onFailure(IMqttToken token, Throwable ex) {
                    connecting.set(false);
                    log.warn("[MQTT] Kết nối {} thất bại: {}", cfg.uri(), ex.getMessage());
                }
            });
        } catch (MqttException e) {
            connecting.set(false);
            log.warn("[MQTT] Kết nối {} lỗi: {}", cfg.uri(), e.getMessage());
        }
    }

    @Override
    public void connectComplete(boolean reconnect, String serverURI) {
        log.info("[MQTT] {} tới {}", reconnect ? "Kết nối lại" : "Đã kết nối", serverURI);
        try {
            client.subscribe(Topics.SUBSCRIBE_ALL, 1);
        } catch (MqttException e) {
            log.error("[MQTT] Subscribe thất bại", e);
        }
    }

    @Override
    public void connectionLost(Throwable cause) {
        log.warn("[MQTT] Mất kết nối: {}", cause == null ? "?" : cause.getMessage());
    }

    @Override
    public void messageArrived(String topic, MqttMessage message) {
        try {
            ingest.handle(topic, message.getPayload(), message.isRetained());
        } catch (Exception e) {
            // Không ném lỗi ra Paho (sẽ làm rớt kết nối)
            log.error("[MQTT] Xử lý {} lỗi", topic, e);
        }
    }

    @Override
    public void deliveryComplete(IMqttDeliveryToken token) {
        // không cần
    }

    @Override
    public void publish(String topic, Object payload, boolean retained) {
        if (!isConnected()) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "mqtt_unavailable",
                    "Chưa kết nối được MQTT broker");
        }
        try {
            byte[] bytes = mapper.writeValueAsBytes(payload);
            client.publish(topic, bytes, 1, retained);
        } catch (MqttException e) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "mqtt_publish_failed", e.getMessage());
        }
    }

    @Override
    public boolean isConnected() {
        return client != null && client.isConnected();
    }

    @PreDestroy
    public void stop() {
        if (client == null) {
            return;
        }
        try {
            if (client.isConnected()) {
                client.disconnect().waitForCompletion(2000);
            }
            client.close();
        } catch (MqttException e) {
            log.debug("[MQTT] Đóng kết nối: {}", e.getMessage());
        }
    }
}
