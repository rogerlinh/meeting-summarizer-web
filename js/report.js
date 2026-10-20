// Build the DOCX report in the browser with the `docx` library.
import { fmtTs } from "./media.js";

let docxLib;
const loadDocx = async () => (docxLib ??= await import("https://cdn.jsdelivr.net/npm/docx@9.5.1/+esm"));

const ACCENT = "1F4E79";
const MUTED = "595959";

export async function buildDocx(summary, frames, transcript, meta, includeTranscript) {
  const D = await loadDocx();
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, Table, TableRow, TableCell,
    WidthType, AlignmentType, ShadingType, PageBreak } = D;

  const P = (text, opts = {}) => new Paragraph({ children: [new TextRun(text)], spacing: { after: 120 }, ...opts });
  const H = (text, level) => new Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
  const bullets = (items) => (items || []).filter((s) => s && s.trim())
    .map((s) => new Paragraph({ text: s.trim(), bullet: { level: 0 } }));
  const muted = (text, size = 18, italic = false) => new TextRun({ text, color: MUTED, size, italics: italic });
  const cell = (text, { bold = false, fill, color, width } = {}) => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold, color })] })],
    shading: fill ? { type: ShadingType.CLEAR, color: "auto", fill } : undefined,
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
  });

  async function figure(fr, caption, no) {
    const maxW = 600;
    const w = Math.min(maxW, fr.width);
    const h = Math.round((w * fr.height) / fr.width);
    caption = (caption || "").replace(/\s*\(?\s*(?:tại|lúc|vào)?\s*(?:thời điểm|phút)?\s*\d{1,2}:\d{2}(?::\d{2})?\s*\)?/g, "")
      .trim().replace(/[.,;\s]+$/, "");
    return [
      new Paragraph({
        alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 120 },
        children: [new ImageRun({ type: "jpg", data: await fr.full.arrayBuffer(), transformation: { width: w, height: h } })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 200 },
        children: [muted(`Hình ${no}. ${caption} (tại ${fmtTs(fr.t)})`, 18, true)],
      }),
    ];
  }

  const body = [];
  body.push(new Paragraph({ text: summary.title || "Báo cáo tổng hợp", heading: HeadingLevel.TITLE }));
  body.push(new Paragraph({ children: [muted(summary.meeting_type || "Báo cáo tổng hợp", 22)], spacing: { after: 200 } }));

  const metaRows = [
    ["Nguồn", meta.sourceName || ""],
    ["Thời lượng", fmtTs(meta.duration || 0)],
    ["Thành phần", (summary.participants || []).join(", ") || "—"],
    ["Ngày tạo báo cáo", new Date().toLocaleString("vi-VN")],
  ];
  body.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: metaRows.map(([k, v]) => new TableRow({
      children: [cell(k, { bold: true, fill: "DEEAF6", width: 25 }), cell(v, { width: 75 })],
    })),
  }));

  body.push(H("1. Tóm tắt tổng quan", HeadingLevel.HEADING_1));
  for (const para of String(summary.overview || "").split(/\n+/)) if (para.trim()) body.push(P(para.trim()));
  if (summary.key_takeaways?.length) {
    body.push(H("Điểm chính", HeadingLevel.HEADING_2));
    body.push(...bullets(summary.key_takeaways));
  }

  body.push(H("2. Nội dung chi tiết", HeadingLevel.HEADING_1));
  let figNo = 0;
  for (const [i, sec] of (summary.sections || []).entries()) {
    body.push(H(`2.${i + 1}. ${sec.heading || ""}`, HeadingLevel.HEADING_2));
    if (sec.start) body.push(new Paragraph({ children: [muted(`⏱ ${sec.start}${sec.end ? " – " + sec.end : ""}`)] }));
    const figs = (sec.figures || []).filter((f) => frames.get(f.frame_id))
      .sort((a, b) => frames.get(a.frame_id).t - frames.get(b.frame_id).t);
    const paras = sec.paragraphs || [];
    for (const [k, para] of paras.entries()) {  // picture k right after paragraph k
      body.push(P(para));
      if (k < figs.length) body.push(...await figure(frames.get(figs[k].frame_id), figs[k].caption, ++figNo));
    }
    for (const f of figs.slice(paras.length)) body.push(...await figure(frames.get(f.frame_id), f.caption, ++figNo));
    if (sec.key_points?.length) {
      body.push(new Paragraph({ children: [new TextRun({ text: "Ý chính:", bold: true })] }));
      body.push(...bullets(sec.key_points));
    }
    for (const q of sec.quotes || []) {
      body.push(new Paragraph({
        indent: { left: 567 }, spacing: { after: 120 },
        children: [new TextRun({ text: `“${(q.text || "").trim()}”`, italics: true }),
          muted(`  — ${q.speaker || ""}${q.t ? ", " + q.t : ""}`)],
      }));
    }
  }

  let n = 3;
  if (summary.decisions?.length) {
    body.push(H(`${n++}. Quyết định`, HeadingLevel.HEADING_1));
    body.push(...bullets(summary.decisions));
  }
  if (summary.action_items?.length) {
    body.push(H(`${n++}. Công việc cần thực hiện`, HeadingLevel.HEADING_1));
    const head = ["#", "Công việc", "Phụ trách", "Thời hạn"];
    const widths = [6, 56, 22, 16];
    body.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ tableHeader: true, children: head.map((h, j) => cell(h, { bold: true, fill: ACCENT, color: "FFFFFF", width: widths[j] })) }),
        ...summary.action_items.map((it, k) => new TableRow({
          children: [String(k + 1), it.task || "", it.owner || "—", it.deadline || "—"].map((v, j) => cell(v, { width: widths[j] })),
        })),
      ],
    }));
  }
  if (summary.open_questions?.length) {
    body.push(H(`${n++}. Vấn đề còn bỏ ngỏ`, HeadingLevel.HEADING_1));
    body.push(...bullets(summary.open_questions));
  }

  if (includeTranscript && transcript.length) {
    body.push(new Paragraph({ children: [new PageBreak()] }));
    body.push(H("Phụ lục: Bản gỡ băng (speech-to-text)", HeadingLevel.HEADING_1));
    for (const s of transcript) {
      body.push(new Paragraph({
        spacing: { after: 60 },
        children: [muted(`[${fmtTs(s.start)}] `), new TextRun({ text: `${s.speaker}: `, bold: true }), new TextRun(s.text)],
      }));
    }
  }

  const doc = new Document({
    creator: "Meeting Summarizer",
    title: summary.title || "Báo cáo",
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 }, paragraph: { spacing: { line: 276 } } } },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", run: { size: 44, bold: true, color: ACCENT } },
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { size: 30, bold: true, color: ACCENT } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", run: { size: 25, bold: true, color: ACCENT } },
      ],
    },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1247, right: 1247 } } }, children: body }],
  });
  return Packer.toBlob(doc);
}
