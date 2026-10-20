# Meeting Summarizer (bản web)

Trang web tóm tắt cuộc họp và video thành **báo cáo DOCX chi tiết kèm hình minh hoạ**, dùng Gemini API key
của chính người dùng.

**Dùng ngay:** https://rogerlinh.github.io/meeting-summarizer-web/

## Cách dùng

1. Lấy Gemini API key miễn phí tại https://aistudio.google.com/apikey.
2. Mở trang, vào tab **API key & Cài đặt**, dán key (có thể nhiều key), bấm **Thêm key**.
3. Ở tab **Tạo báo cáo**, chọn một trong hai cách:
   - **Ghi cuộc họp trực tuyến:** ghi tab Google Meet / Zoom web / Teams. Khi chọn nguồn, tích "Chia sẻ âm thanh".
     Dùng Chrome hoặc Edge trên máy tính.
   - **Tải lên video/audio:** MP4, WEBM, MKV, MOV, MP3, M4A, WAV… tối đa 2 GB.
4. Đợi xử lý xong, file DOCX tự tải về. Bản gỡ băng (.txt) có nút tải riêng.

## Ai nói gì, giao việc cho ai

- **Người dự họp:** điền mỗi dòng một người theo dạng `Tên – vai trò`. Danh sách này được nhớ cho lần sau.
  Gemini dùng nó để gắn tên cho từng giọng nói.
- **Tên của bạn** (tab Cài đặt): khi ghi họp có trộn micro, trang đo lúc micro của bạn có tiếng. Giọng nào
  trùng micro nhiều nhất (≥ 40% và gấp đôi người đứng sau) sẽ được gắn tên bạn.
- **Xác nhận người nói:** sau bước gỡ băng, trang hiện từng giọng kèm câu mẫu, tên gợi ý và độ tin cậy.
  Bạn sửa hoặc chọn tên, rồi bấm xác nhận để viết báo cáo. Có thể tắt bước này trong Cài đặt.
- Báo cáo có thêm hai mục:
  - **Phát biểu theo từng người:** mỗi người trình bày, đề xuất, cam kết điều gì.
  - **Việc của từng người:** bảng việc theo từng người được giao, gồm người giao, thời hạn, câu nói gốc và mốc giờ.

## Quyền riêng tư

- Trang chạy hoàn toàn trong trình duyệt, không có máy chủ trung gian.
- API key chỉ lưu trong `localStorage` của trình duyệt bạn dùng, và chỉ được gửi tới `generativelanguage.googleapis.com`.
- Video được tải thẳng lên Google Gemini (Files API) bằng key của bạn để xử lý, rồi bị xoá ngay khi xong.
  Nếu bị gián đoạn, Google tự xoá sau 48 giờ.
- Nút **Xoá toàn bộ key và cài đặt** trong tab Cài đặt xoá mọi thứ trang đã lưu.

## Cách hoạt động

1. Tải file lên Gemini Files API.
2. Chuyển giọng nói thành văn bản theo từng đoạn 15 phút (`videoMetadata` start/end), chạy song song trên nhiều key.
   Gặp lỗi 429 thì đổi sang key khác, key bị từ chối thì loại ra. Khi tất cả key của một model đều hết hạn mức,
   app chuyển sang model dự phòng.
3. Cắt khung hình ứng viên bằng `<video>` và canvas (khoảng 1 hình mỗi 45 giây).
4. Gemini đọc bản gỡ băng và ảnh thu nhỏ, viết báo cáo: tổng quan, các phần theo thời gian (đoạn văn chi tiết,
   ý chính, trích dẫn, 1–3 hình có chú thích), quyết định, việc cần làm, vấn đề bỏ ngỏ.
5. Tạo DOCX ngay trong trình duyệt bằng thư viện [`docx`](https://www.npmjs.com/package/docx).

Google tính hạn mức theo **project**, nên các key cần thuộc các project khác nhau mới tăng được thông lượng.

## Cấu trúc

```
index.html, style.css
js/app.js       giao diện, cài đặt, ghi màn hình
js/pipeline.js  quy trình xử lý
js/gemini.js    xoay vòng key, Files API, generateContent
js/media.js     thời lượng, cắt khung hình
js/report.js    dựng DOCX
js/prompts.js   prompt + JSON schema
js/speakers.js  thống kê người nói, đối chiếu micro, gợi ý tên
```

Chạy thử ở máy: `python -m http.server 8000` trong thư mục này rồi mở http://localhost:8000.
