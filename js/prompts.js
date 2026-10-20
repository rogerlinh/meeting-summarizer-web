// Prompts and JSON schemas sent to Gemini.

export const TRANSCRIBE_SYSTEM = `Bạn là chuyên gia gỡ băng cuộc họp. Nhiệm vụ: chuyển lời nói thành văn bản
chính xác (speech-to-text), tách theo người nói (diarization).
Quy tắc:
- Ghi đúng ngôn ngữ gốc người nói dùng; giữ thuật ngữ chuyên môn, tên riêng, con số.
- Làm sạch nhẹ: bỏ từ đệm (ờ, à, ừm, uh, you know...), câu lặp, tiếng ồn, lời nói vô nghĩa; KHÔNG tóm tắt, KHÔNG bịa.
- Nhãn người nói: dùng tên nếu được giới thiệu, ngược lại "Người nói 1", "Người nói 2"...
- Mỗi segment ngắn: tối đa khoảng 3 câu hoặc 30 giây. Nếu một người nói liên tục lâu, tách thành NHIỀU segment
  liên tiếp, mỗi segment có mốc "t" riêng.
- "t" là thời điểm TUYỆT ĐỐI tính từ đầu file, dạng HH:MM:SS.
- Gỡ băng TOÀN BỘ khoảng thời gian được yêu cầu, không dừng giữa chừng.
- Bỏ qua im lặng, nhạc chờ, tiếng gõ phím. Nếu không có lời nói trả về segments rỗng.`;

const STR = { type: "STRING" };
const STRS = { type: "ARRAY", items: STR };
const obj = (properties) => ({ type: "OBJECT", properties, required: Object.keys(properties) });

export const TRANSCRIBE_SCHEMA = obj({
  segments: { type: "ARRAY", items: obj({ t: STR, speaker: STR, text: STR }) },
});

export const summarySystem = ({ language, duration, nSections }) => `Bạn là thư ký biên tập chuyên nghiệp.
Đầu vào là bản gỡ băng (speech-to-text, có mốc thời gian) của một cuộc họp/video dài ${duration},
kèm các khung hình cắt từ video (mỗi hình có id và thời điểm).
Hãy viết một BÁO CÁO TỔNG HỢP CHI TIẾT, HOÀN CHỈNH bằng ${language}, đọc xong không cần xem lại video.

NỘI DUNG
- Loại bỏ nhiễu: chào hỏi, chuyện ngoài lề, câu lặp, từ đệm, trục trặc kỹ thuật ("nghe rõ không", "share màn hình"...),
  quảng cáo, kêu gọi like/share. Giữ lại MỌI ý có giá trị: lập luận, dẫn chứng, ví dụ, số liệu, tên người,
  tổ chức, địa điểm, mốc thời gian, kết luận.
- Chia thành khoảng ${nSections} phần theo chủ đề, theo trình tự thời gian (mỗi phần ~5–8 phút nội dung; được
  nhiều hơn nếu chủ đề thay đổi nhiều). Mỗi phần:
  • heading: tiêu đề cụ thể nói rõ nội dung (không chung chung như "Phần 1", "Thảo luận").
  • start / end: mốc HH:MM:SS bắt đầu và kết thúc của phần.
  • paragraphs: 2–5 đoạn văn, mỗi đoạn 3–6 câu, viết lại mạch lạc bằng văn viết: ai nói gì, vì sao,
    dẫn chứng nào, đi đến kết luận gì. Không viết chung chung.
  • key_points: 3–6 gạch đầu dòng ý chính, mỗi ý một câu đầy đủ.
  • quotes: 0–3 câu nói nguyên văn đáng chú ý (lấy đúng từ bản gỡ băng), kèm người nói và mốc thời gian.
  • figures: 1–3 hình minh hoạ cho phần đó, chọn từ danh sách khung hình. Ưu tiên hình có thời điểm nằm
    trong [start, end] của phần và thể hiện đúng nội dung đang nói (slide, biểu đồ, tài liệu, màn hình demo,
    vật/cảnh được nhắc tới). Nếu video chỉ có người nói, chọn hình rõ nét tại lúc nói ý quan trọng nhất.
    caption: 1 câu (không ghi mốc thời gian) mô tả hình VÀ liên hệ với nội dung.
    Không dùng một hình cho hai chỗ; chỉ dùng id có trong danh sách. Nếu không có khung hình nào thì để rỗng.
- overview: 1–2 đoạn tóm tắt toàn bộ (bối cảnh, mục đích, kết quả chính).
- key_takeaways: 4–8 kết luận quan trọng nhất.
- decisions / action_items (việc, người phụ trách, hạn; "" nếu không nêu) / open_questions: mảng rỗng nếu không có.
- Chuẩn hoá tên người nói (bản gỡ băng được làm theo từng đoạn nên cùng một người có thể mang nhãn khác nhau).
  speaker_aliases liệt kê MỌI nhãn xuất hiện ("from") và tên chuẩn ("to").
- Tuyệt đối không bịa thông tin không có trong bản gỡ băng hoặc hình.`;

export const SUMMARY_SCHEMA = obj({
  title: STR,
  meeting_type: STR,
  participants: STRS,
  speaker_aliases: { type: "ARRAY", items: obj({ from: STR, to: STR }) },
  overview: STR,
  key_takeaways: STRS,
  sections: {
    type: "ARRAY",
    items: obj({
      heading: STR, start: STR, end: STR, paragraphs: STRS, key_points: STRS,
      quotes: { type: "ARRAY", items: obj({ speaker: STR, text: STR, t: STR }) },
      figures: { type: "ARRAY", items: obj({ frame_id: { type: "INTEGER" }, caption: STR }) },
    }),
  },
  decisions: STRS,
  action_items: { type: "ARRAY", items: obj({ task: STR, owner: STR, deadline: STR }) },
  open_questions: STRS,
});
