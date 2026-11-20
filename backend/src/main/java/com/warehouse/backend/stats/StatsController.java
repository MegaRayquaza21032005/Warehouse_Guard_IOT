package com.warehouse.backend.stats;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;

import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.warehouse.backend.stats.StatsService.StatsResponse;
import com.warehouse.backend.stats.StatsService.TimelineSegment;

/**
 * GET /api/stats?metric=temp&from=...&to=...&interval=1h&agg=avg,min,max[&group_by=...][&device=...]
 * GET /api/stats/timeline?device=fan&from=...&to=...
 */
@RestController
@RequestMapping("/api/stats")
public class StatsController {

    private final StatsService stats;

    public StatsController(StatsService stats) {
        this.stats = stats;
    }

    @GetMapping
    public StatsResponse stats(@RequestParam String metric,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(required = false) String interval,
            @RequestParam(required = false) String agg,
            @RequestParam(name = "group_by", required = false) String groupBy,
            @RequestParam(required = false) String device) {
        List<String> aggs = agg == null || agg.isBlank() ? List.of()
                : Arrays.stream(agg.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
        String gb = groupBy == null || groupBy.isBlank() ? null : groupBy.replace(" ", "");
        return stats.query(metric, from, to, interval, aggs, gb, device);
    }

    @GetMapping("/timeline")
    public List<TimelineSegment> timeline(@RequestParam String device,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to) {
        return stats.timeline(device, from, to);
    }
}
