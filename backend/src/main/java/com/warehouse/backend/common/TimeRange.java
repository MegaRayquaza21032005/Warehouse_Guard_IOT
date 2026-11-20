package com.warehouse.backend.common;

import java.time.Duration;
import java.time.Instant;

/** Khoảng thời gian [from, to) cho các API lịch sử. Mặc định: 24 giờ gần nhất. */
public record TimeRange(Instant from, Instant to) {

    public static final Duration MAX_SPAN = Duration.ofDays(366);

    public static TimeRange of(Instant from, Instant to, Duration defaultSpan) {
        Instant t = to == null ? Instant.now() : to;
        Instant f = from == null ? t.minus(defaultSpan) : from;
        if (!f.isBefore(t)) {
            throw ApiException.badRequest("invalid_range", "from phải nhỏ hơn to");
        }
        if (Duration.between(f, t).compareTo(MAX_SPAN) > 0) {
            throw ApiException.badRequest("range_too_large", "Khoảng thời gian tối đa 366 ngày");
        }
        return new TimeRange(f, t);
    }

    public Duration span() {
        return Duration.between(from, to);
    }
}
