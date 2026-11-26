"""Xác nhận "có người" từ kết quả từng khung — chống báo giả / nhấp nháy (thuần Python, test được).

- Thấy người ở `confirm_frames` khung phân tích LIÊN TIẾP -> có người.
- Đang có người mà không thấy ai liên tục `clear_s` giây -> hết người (người đi khuất / bị che thoáng qua
  không làm trạng thái nhảy qua lại).
"""

from dataclasses import dataclass


@dataclass
class PresenceState:
    present: bool = False
    count: int = 0              # số người ở khung gần nhất có người (khi đang "có người")
    conf: float | None = None   # độ tin cậy cao nhất ở khung đó


class PresenceTracker:
    def __init__(self, confirm_frames: int = 3, clear_s: float = 3.0):
        self.confirm_frames = max(1, confirm_frames)
        self.clear_s = clear_s
        self.state = PresenceState()
        self._streak = 0
        self._last_seen: float | None = None

    def update(self, count: int, conf: float | None, now: float) -> bool:
        """Nhận kết quả 1 khung. Trả True nếu "có người / không" đổi (số người đổi thì không tính — số người
        dao động từng khung, bên gửi MQTT tự giới hạn tần suất)."""
        before = self.state.present
        if count > 0:
            self._streak += 1
            self._last_seen = now
            if self.state.present or self._streak >= self.confirm_frames:
                self.state = PresenceState(True, count, conf)
        else:
            self._streak = 0
            if self.state.present and (self._last_seen is None or now - self._last_seen >= self.clear_s):
                self.state = PresenceState()
        return self.state.present != before

    def reset(self) -> bool:
        """Camera lỗi -> không còn biết có người hay không."""
        changed = self.state.present
        self.state, self._streak, self._last_seen = PresenceState(), 0, None
        return changed
