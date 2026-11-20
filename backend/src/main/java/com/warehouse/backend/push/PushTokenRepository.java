package com.warehouse.backend.push;

import java.util.List;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Bảng app.push_tokens — token FCM của từng điện thoại. */
@Repository
public class PushTokenRepository {

    private final JdbcClient jdbc;

    public PushTokenRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** Một token chỉ thuộc một người dùng (người đăng nhập gần nhất trên máy đó). */
    public void upsert(long userId, String token, String platform) {
        jdbc.sql("""
                INSERT INTO app.push_tokens (user_id, token, platform) VALUES (?, ?, ?)
                ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
                                                  last_seen_at = now()""")
                .params(userId, token, platform).update();
    }

    public int delete(long userId, String token) {
        return jdbc.sql("DELETE FROM app.push_tokens WHERE user_id = ? AND token = ?").params(userId, token).update();
    }

    public void deleteToken(String token) {
        jdbc.sql("DELETE FROM app.push_tokens WHERE token = ?").params(token).update();
    }

    /** Cảnh báo kho gửi cho MỌI người dùng (CLAUDE.md mục 5.4). */
    public List<String> allTokens() {
        return jdbc.sql("SELECT token FROM app.push_tokens ORDER BY id").query(String.class).list();
    }

    public int countForUser(long userId) {
        return jdbc.sql("SELECT count(*) FROM app.push_tokens WHERE user_id = ?").params(userId).query(Integer.class)
                .single();
    }
}
