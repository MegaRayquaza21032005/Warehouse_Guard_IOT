package com.warehouse.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;

import com.warehouse.backend.common.ApiException;

class DeviceIntegrationTest extends IntegrationTestBase {

    @Test
    @SuppressWarnings("unchecked")
    void userCommandIsPublishedLoggedAndAcknowledged() throws Exception {
        String token = registerAndGetToken("thanh");
        String res = mvc.perform(post("/api/devices/light/command").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("state", "on", "durationS", 300))))
                .andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        String traceId = (String) parse(res).get("traceId");

        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(mqtt).publish(eq("warehouse/cmd/light"), payload.capture(), eq(false));
        Map<String, Object> p = (Map<String, Object>) payload.getValue();
        assertThat(p).containsEntry("state", "on").containsEntry("source", "user").containsEntry("user_id", "1")
                .containsEntry("trace_id", traceId).containsEntry("duration_s", 300);

        // Bản tin vòng lại từ broker không tạo dòng trùng
        mqttIn("warehouse/cmd/light", p);
        assertThat(count("SELECT count(*) FROM app.device_command_logs")).isEqualTo(1);

        // ESP32 xác nhận
        mqttIn("warehouse/status/light", Map.of("state", "on", "mode", "manual", "reason", "manual",
                "source", "user", "trace_id", traceId, "ack", Map.of("trace_id", traceId, "result", "applied")));
        Map<String, Object> log = jdbc.sql("SELECT result, confirmed_state, source, user_id FROM app.device_command_logs")
                .query().singleRow();
        assertThat(log).containsEntry("result", "applied").containsEntry("confirmed_state", "on")
                .containsEntry("source", "user").containsEntry("user_id", 1L);
    }

    @Test
    void rejectsInvalidCommands() throws Exception {
        String token = registerAndGetToken("thanh");
        String auth = "Bearer " + token;
        mvc.perform(post("/api/devices/pump/command").header("Authorization", auth)
                .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("state", "on"))))
                .andExpect(status().isNotFound());
        mvc.perform(post("/api/devices/fan/command").header("Authorization", auth)
                .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("state", "on", "mode", "auto"))))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error").value("invalid_command"));
        mvc.perform(post("/api/devices/fan/command").header("Authorization", auth)
                .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("state", "maybe"))))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/api/devices/fan/command").header("Authorization", auth)
                .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("state", "on", "durationS", 0))))
                .andExpect(status().isBadRequest());
        // AI Agent không dùng API này (agent ra lệnh qua MQTT với source=agent)
        mvc.perform(post("/api/devices/fan/command").header("X-Internal-Key", "test-internal-key")
                .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("state", "on"))))
                .andExpect(status().isForbidden());
        verify(mqtt, never()).publish(anyString(), any(), anyBoolean());
    }

    @Test
    void brokerDownGives503AndMarksLog() throws Exception {
        String token = registerAndGetToken("thanh");
        doThrow(new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "mqtt_unavailable", "down"))
                .when(mqtt).publish(anyString(), any(), anyBoolean());
        mvc.perform(post("/api/devices/fan/command").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("state", "on"))))
                .andExpect(status().isServiceUnavailable());
        assertThat(jdbc.sql("SELECT result FROM app.device_command_logs").query(String.class).single())
                .isEqualTo("publish_failed");
    }

    @Test
    void esp32LocalChangesAndAgentCommandsAreLogged() throws Exception {
        // Luật cục bộ ESP32 bật quạt vì khí
        Map<String, Object> fanOn = Map.of("state", "on", "mode", "auto", "reason", "gas", "source", "esp32_local");
        mqttIn("warehouse/status/fan", fanOn);
        mqttIn("warehouse/status/fan", fanOn);   // retained gửi lại -> không trùng
        assertThat(count("SELECT count(*) FROM app.device_states WHERE device = 'fan'")).isEqualTo(1);
        // Agent ra lệnh với user_id không tồn tại -> vẫn ghi, user_id = null
        mqttIn("warehouse/cmd/light", Map.of("state", "on", "source", "agent", "user_id", "999",
                "trace_id", "agent-1", "reason", "motion_after_hours", "duration_s", 300));

        String token = registerAndGetToken("thanh");
        String body = mvc.perform(get("/api/device-logs").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        List<?> logs = mapper.readValue(body, List.class);
        assertThat(logs).hasSize(2);
        mvc.perform(get("/api/device-logs?source=esp32_local").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$[0].device").value("fan"))
                .andExpect(jsonPath("$[0].action").value("on"))
                .andExpect(jsonPath("$[0].reason").value("gas"));
        mvc.perform(get("/api/device-logs?source=agent").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$[0].userId").doesNotExist())
                .andExpect(jsonPath("$[0].reason").value("motion_after_hours"))
                .andExpect(jsonPath("$[0].durationS").value(300));
    }

    @Test
    @SuppressWarnings("unchecked")
    void configIsValidatedMergedAndPublishedRetained() throws Exception {
        String auth = "Bearer " + registerAndGetToken("thanh");
        mvc.perform(get("/api/config").header("Authorization", auth))
                .andExpect(jsonPath("$.mq135Warning").value(1500)).andExpect(jsonPath("$.humHigh").value(80));
        mvc.perform(put("/api/config").header("Authorization", auth).contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("mq135Warning", 2400)))).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("invalid_mq135_threshold"));
        mvc.perform(put("/api/config").header("Authorization", auth).contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("mistHumMax", 85)))).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("invalid_mist_hum_max"));
        mvc.perform(put("/api/config").header("Authorization", auth).contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("tempRiseWindowMin", 2.5)))).andExpect(status().isBadRequest());
        mvc.perform(put("/api/config").header("Authorization", auth).contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("foo", 1)))).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("unknown_key"));
        verify(mqtt, never()).publish(anyString(), any(), anyBoolean());

        mvc.perform(put("/api/config").header("Authorization", auth).contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("mq135Warning", 1700)))).andExpect(status().isAccepted());
        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(mqtt).publish(eq("warehouse/cmd/config"), payload.capture(), eq(true));
        Map<String, Object> sent = (Map<String, Object>) payload.getValue();
        assertThat(sent).containsEntry("mq135Warning", 1700L).containsKey("humFanMinDrop").hasSize(12);

        // ESP32 xác nhận -> lưu DB, GET trả giá trị mới
        mqttIn("warehouse/status/config", sent);
        mvc.perform(get("/api/config").header("Authorization", auth)).andExpect(jsonPath("$.mq135Warning").value(1700));
        assertThat(jdbc.sql("SELECT payload->>'mq135Warning' FROM app.device_config").query(String.class).single())
                .isEqualTo("1700");
    }

    @Test
    void alertsAreStoredAcknowledgedAndGetFeedback() throws Exception {
        String auth = "Bearer " + registerAndGetToken("thanh");
        mqttIn("warehouse/alert", Map.of("type", "fire", "level", "critical", "message", "Nghi cháy",
                "source", "rule", "incident_id", "inc-1"));
        mvc.perform(get("/api/alerts?unacked=true").header("Authorization", auth))
                .andExpect(jsonPath("$[0].type").value("fire")).andExpect(jsonPath("$[0].level").value("critical"));
        mvc.perform(post("/api/alerts/1/ack").header("Authorization", auth)).andExpect(status().isOk())
                .andExpect(jsonPath("$.acknowledgedByName").value("thanh"));
        mvc.perform(get("/api/alerts?unacked=true").header("Authorization", auth)).andExpect(jsonPath("$").isEmpty());
        mvc.perform(post("/api/alerts/1/feedback").header("Authorization", auth).contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("feedback", "maybe")))).andExpect(status().isBadRequest());
        mvc.perform(post("/api/alerts/1/feedback").header("Authorization", auth).contentType(MediaType.APPLICATION_JSON)
                .content(json(Map.of("feedback", "false_alarm", "note", "Đang hàn"))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.feedback").value("false_alarm"));
        mvc.perform(get("/api/alerts/99").header("Authorization", auth)).andExpect(status().isNotFound());
    }

    private long count(String sql) {
        return jdbc.sql(sql).query(Long.class).single();
    }
}
