"""Giờ làm việc — xác định chuyển động có phải "ngoài giờ" (đột nhập) hay không."""

from dataclasses import dataclass
from datetime import datetime, time
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class WorkSchedule:
    start: time
    end: time
    days: frozenset[int]          # 1 = thứ Hai ... 7 = Chủ nhật
    tz: ZoneInfo

    def is_work_time(self, ts: float) -> bool:
        local = datetime.fromtimestamp(ts, self.tz)
        if local.isoweekday() not in self.days:
            return False
        t = local.time()
        if self.start <= self.end:
            return self.start <= t < self.end
        return t >= self.start or t < self.end   # ca qua nửa đêm
