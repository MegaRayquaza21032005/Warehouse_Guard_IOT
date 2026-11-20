package com.warehouse.backend.device;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/config")
public class ConfigController {

    private final ConfigService config;

    public ConfigController(ConfigService config) {
        this.config = config;
    }

    @GetMapping
    public Map<String, Object> get() {
        return config.current();
    }

    /** Body: chỉ các trường muốn đổi, vd. {"mq2Warning": 1700}. Trả 202; ESP32 xác nhận qua status/config. */
    @PutMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    public Map<String, Object> update(@RequestBody Map<String, Object> patch) {
        Map<String, Object> res = new LinkedHashMap<>();
        res.put("status", "sent");
        res.put("config", config.update(patch));
        return res;
    }
}
