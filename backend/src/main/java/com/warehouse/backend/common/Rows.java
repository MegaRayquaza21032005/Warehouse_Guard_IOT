package com.warehouse.backend.common;

import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;

/** Chuyển một dòng SQL thành Map với tên cột camelCase, thời gian -> Instant (cột jsonb hãy ép ::text trong SQL). */
public final class Rows {

    private Rows() {
    }

    public static Map<String, Object> toMap(ResultSet rs, int rowNum) throws SQLException {
        ResultSetMetaData md = rs.getMetaData();
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 1; i <= md.getColumnCount(); i++) {
            Object v = rs.getObject(i);
            if (v instanceof Timestamp t) {
                v = t.toInstant();
            } else if (v instanceof OffsetDateTime o) {
                v = o.toInstant();
            }
            m.put(camel(md.getColumnLabel(i)), v);
        }
        return m;
    }

    public static OffsetDateTime utc(Instant t) {
        return t.atOffset(ZoneOffset.UTC);
    }

    static String camel(String snake) {
        StringBuilder sb = new StringBuilder();
        boolean up = false;
        for (char c : snake.toCharArray()) {
            if (c == '_') {
                up = true;
            } else {
                sb.append(up ? Character.toUpperCase(c) : c);
                up = false;
            }
        }
        return sb.toString();
    }
}
