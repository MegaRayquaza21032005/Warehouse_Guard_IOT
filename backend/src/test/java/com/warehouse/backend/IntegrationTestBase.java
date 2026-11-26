package com.warehouse.backend;

import static org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers.springSecurity;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

import com.warehouse.backend.mqtt.MqttIngestService;
import com.warehouse.backend.mqtt.MqttPublisher;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/** Nền chung: Postgres Testcontainers, MQTT giả (không cần broker), DB sạch trước mỗi test. */
@SpringBootTest(properties = {
        "app.mqtt.enabled=false",
        "app.internal-api-key=test-internal-key",
        "app.jwt.secret=test-secret-test-secret-test-secret-test-secret",
        "app.timezone=Asia/Ho_Chi_Minh",
        "app.work-hours.start=08:00",
        "app.work-hours.end=17:30",
        "app.work-hours.days=1,2,3,4,5,6",
        "app.agent.url=http://127.0.0.1:" + IntegrationTestBase.AGENT_PORT })
@Import(TestcontainersConfiguration.class)
public abstract class IntegrationTestBase {

    /** Cổng của AI Agent giả (ChatIntegrationTest). */
    protected static final int AGENT_PORT = 18765;

    protected static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };

    @Autowired
    protected WebApplicationContext context;
    @Autowired
    protected JdbcClient jdbc;
    @Autowired
    protected ObjectMapper mapper;
    @Autowired
    protected MqttIngestService ingest;

    @MockitoBean
    protected MqttPublisher mqtt;

    protected MockMvc mvc;

    @BeforeEach
    void baseSetUp() {
        mvc = MockMvcBuilders.webAppContextSetup(context).apply(springSecurity()).build();
        jdbc.sql("""
                TRUNCATE app.users, app.refresh_tokens, app.mq135_readings, app.climate_readings, app.motion_events,
                         app.safety_events, app.device_states, app.device_health, app.device_config,
                         app.device_command_logs, app.alerts, app.push_tokens RESTART IDENTITY CASCADE""").update();
    }

    protected String json(Object o) {
        return mapper.writeValueAsString(o);
    }

    protected Map<String, Object> parse(String s) {
        return mapper.readValue(s, MAP);
    }

    /** Đăng ký user mới, trả access token. */
    protected String registerAndGetToken(String username) throws Exception {
        String body = mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("username", username, "email", username + "@example.com",
                        "password", "secret123"))))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        return (String) parse(body).get("accessToken");
    }

    protected void mqttIn(String topic, Object payload) {
        ingest.handle(topic, json(payload).getBytes(), false);
    }
}
