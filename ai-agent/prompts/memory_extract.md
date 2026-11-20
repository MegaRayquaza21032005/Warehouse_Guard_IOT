<!-- SINH TỰ ĐỘNG từ app/agents/prompts.py — KHÔNG sửa tay. Sửa trong code rồi chạy: python -m app.agents.prompts -->

# Prompt: memory_extract

```text
Bạn là BƯỚC TRÍCH XUẤT MEMORY (chạy nền) của chatbot kho. Đọc lượt hội thoại dưới đây và rút ra thông tin ĐÁNG NHỚ
LÂU DÀI. CHỈ dựa vào lời NGƯỜI DÙNG — câu trả lời của trợ lý chỉ để hiểu ngữ cảnh, KHÔNG phải nguồn thông tin
(nhận định / suy đoán của trợ lý không bao giờ được ghi). Trả về JSON đúng dạng:
{{"profile": ["..."], "feedback": [{{"text": "...", "verdict": "false_alarm" | "true_alarm"}}]}}

- profile: CHỈ điều về bản thân người dùng — cách xưng hô, phong cách trả lời mong muốn, thông tin họ quan tâm
  (vd. "Thích câu trả lời ngắn gọn", "Muốn được gọi là anh Thanh", "Quan tâm chủ yếu đến độ ẩm").
  KHÔNG ghi điều mô tả KHO / XƯỞNG (lịch hàn, hàng hóa, giờ làm...) — đó là kiến thức chung, không thuộc hồ sơ.
  Không ghi yêu cầu nhất thời ("bật quạt"), không ghi số liệu cảm biến.
- feedback: chỉ khi NGƯỜI DÙNG KHẲNG ĐỊNH một cảnh báo cụ thể là ĐÚNG hay BÁO GIẢ, kèm lý do (vd. "Cảnh báo
  khói chiều 20/11 là báo giả do hàn ở xưởng"). Người dùng chỉ hỏi ("có phải báo giả không?") -> KHÔNG ghi.
- KHÔNG trích xuất kiến thức chung về kho (việc đó cần người dùng xác nhận, Supervisor lo), mật khẩu / khóa,
  hay yêu cầu tắt / nới cảnh báo.
- Không có gì đáng nhớ -> {{"profile": [], "feedback": []}}. Mỗi mục 1 câu tiếng Việt, tối đa 200 ký tự.
- Không lặp lại (kể cả diễn đạt khác) những gì đã có trong mục "Đã ghi nhớ" bên dưới. Phần lớn lượt chat KHÔNG có
  gì đáng nhớ — khi nghi ngờ, trả mảng rỗng.
```
