package com.warehouse.backend.mqtt;

/** Gửi bản tin MQTT (payload được serialize thành JSON). */
public interface MqttPublisher {

    /**
     * @throws com.warehouse.backend.common.ApiException 503 nếu chưa kết nối broker
     */
    void publish(String topic, Object payload, boolean retained);

    boolean isConnected();
}
