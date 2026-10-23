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
   - **Link YouTube** (video công khai): Gemini đọc thẳng từ link, không cần tải về. Trình duyệt không cắt được
     khung hình từ YouTube, nên báo cáo dùng ảnh đại diện của video. Google Drive, Facebook, Vimeo… không tải
     trực tiếp được từ trình duyệt: hãy tải video về rồi dùng ô Tải lên.
4. Đợi xử lý xong, file DOCX tự tải về. Bản gỡ băng (.txt) có nút tải riêng.

**Bản ghi không bị mất:** trong lúc ghi, cứ 10 giây trang lưu phần mới vào IndexedDB của trình duyệt. Tải lại trang,
tắt trình duyệt giữa chừng hay job bị lỗi thì bản ghi vẫn nằm ở mục **Bản ghi chưa xử lý** đầu trang, với các nút
Tạo báo cáo, Tải về (.webm) và Xoá. Bản ghi tự xoá khi đã tạo báo cáo thành công. Nếu trình duyệt không cho lưu
(cửa sổ ẩn danh, ổ đầy), trang báo ngay và hỏi lại trước khi bạn rời trang.

## Ai nói gì, giao việc cho ai

- **Người dự họp:** điền mỗi dòng một người theo dạng `Tên – vai trò`. Danh sách này được nhớ cho lần sau.
  Gemini dùng nó để gắn tên cho từng giọng nói.
- **Tên của bạn** (tab Cài đặt): khi ghi họp có trộn micro, trang đo lúc micro của bạn có tiếng. Giọng nào
  trùng micro nhiều nhất (≥ 40% và gấp đôi người đứng sau) sẽ được gắn tên bạn.
- **Xác nhận người nói:** sau bước gỡ băng, trang hiện từng giọng kèm câu mẫu, tên gợi ý và độ tin cậy.
  Bạn sửa hoặc chọn tên, rồi bấm xác nhận để viết báo cáo. Tab đổi tiêu đề và phát tiếng báo; không ai xác nhận
  sau 5 phút thì trang tự dùng tên gợi ý (bắt đầu gõ tên thì trang chờ bạn). Có thể tắt bước này trong Cài đặt.
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
   app chuyển ngay sang model kế tiếp: mặc định 7 model Flash (3.8 → 3.7 → 3.6 → 3.5 → 3-preview → 3.5-lite → 3.1-lite)
   cộng các model Gemini 3+ Flash khác mà key gọi được.
   - **Quota:** gói miễn phí cho khoảng 20 request/ngày cho *mỗi model, mỗi project*. Hết quota thì trang hiện cảnh báo
     (model nào, giới hạn, đang dùng model nào thay, khi nào thử lại) và tab Cài đặt có bảng **Quota theo model**.
     Trạng thái quota được nhớ trong trình duyệt nên lần sau trang bỏ qua ngay model đã hết quota.
3. Cắt khung hình ứng viên bằng `<video>` và canvas (khoảng 1 hình mỗi 45 giây).
4. Gemini viết báo cáo trong 2 lượt: lượt đầu đọc toàn bộ bản gỡ băng để lập khung (tổng quan, người nói,
   việc được giao, quyết định, danh sách phần); lượt sau viết **song song** từng phần (đoạn văn chi tiết, ý chính,
   trích dẫn, 1–3 hình có chú thích), mỗi phần chỉ nhận bản gỡ băng và khung hình của khoảng thời gian đó.
   Bước gỡ băng và viết từng phần dùng thinking "low" nên nhanh khoảng gấp đôi.
5. Tạo DOCX ngay trong trình duyệt bằng thư viện [`docx`](https://www.npmjs.com/package/docx).
   Bản gỡ băng không chèn vào DOCX mà tải riêng dạng .txt.

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
