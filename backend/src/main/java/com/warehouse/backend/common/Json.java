package com.warehouse.backend.common;

import java.util.Map;

/** Đọc giá trị từ payload JSON đã parse thành Map (an toàn với kiểu sai / thiếu). */
public final class Json {

    private Json() {
    }

    public static String str(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v == null ? null : String.valueOf(v);
    }

    public static Integer intVal(Map<String, Object> m, String key) {
        return m.get(key) instanceof Number n ? n.intValue() : null;
    }

    public static Long longVal(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (v instanceof Number n) {
            return n.longValue();
        }
        if (v instanceof String s && s.matches("\\d{1,18}")) {
            return Long.parseLong(s);
        }
        return null;
    }

    public static Double dbl(Map<String, Object> m, String key) {
        return m.get(key) instanceof Number n ? n.doubleValue() : null;
    }

    public static Boolean bool(Map<String, Object> m, String key) {
        return m.get(key) instanceof Boolean b ? b : null;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> obj(Map<String, Object> m, String key) {
        return m.get(key) instanceof Map<?, ?> o ? (Map<String, Object>) o : null;
    }
}
