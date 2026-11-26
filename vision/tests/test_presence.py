from app.presence import PresenceTracker


def test_needs_consecutive_frames_to_confirm():
    t = PresenceTracker(confirm_frames=3, clear_s=3)
    assert t.update(1, 0.8, 0.0) is False
    assert t.update(1, 0.8, 0.1) is False
    assert not t.state.present
    assert t.update(2, 0.9, 0.2) is True
    assert t.state.present and t.state.count == 2 and t.state.conf == 0.9


def test_single_false_positive_frame_is_ignored():
    t = PresenceTracker(confirm_frames=3, clear_s=3)
    t.update(1, 0.6, 0.0)
    t.update(0, None, 0.1)          # chuỗi bị ngắt -> đếm lại từ đầu
    t.update(1, 0.6, 0.2)
    t.update(1, 0.6, 0.3)
    assert not t.state.present
    assert t.update(1, 0.6, 0.4) is True


def test_brief_miss_keeps_presence_then_clears_after_clear_s():
    t = PresenceTracker(confirm_frames=1, clear_s=3)
    t.update(1, 0.8, 0.0)
    assert t.update(0, None, 1.0) is False and t.state.present      # khuất thoáng qua
    assert t.update(1, 0.7, 2.0) is False and t.state.present
    assert t.update(0, None, 4.9) is False and t.state.present      # mới 2.9s kể từ lần cuối thấy
    assert t.update(0, None, 5.0) is True and not t.state.present
    assert t.state.count == 0 and t.state.conf is None


def test_count_change_is_not_a_presence_change():
    t = PresenceTracker(confirm_frames=1, clear_s=3)
    t.update(1, 0.8, 0.0)
    assert t.update(3, 0.9, 0.1) is False
    assert t.state.count == 3


def test_reset_on_camera_error():
    t = PresenceTracker(confirm_frames=1, clear_s=3)
    t.update(1, 0.8, 0.0)
    assert t.reset() is True
    assert not t.state.present
    assert t.reset() is False
