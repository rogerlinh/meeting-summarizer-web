// Processing: upload -> speech-to-text per time range -> frames -> detailed report -> DOCX.
import { KeyPool, fileFor, generate, blobToBase64 } from "./gemini.js";
import { openMedia, captureFrame, candidateTimes, geminiMime, fmtTs, parseTs } from "./media.js";
import * as prompts from "./prompts.js";
import { buildDocx } from "./report.js";
import { speakerStats, suggestNames, mergeSuggestions, applyNames } from "./speakers.js";

/** Split segments the model returned as minutes of speech, spreading timestamps by word count. */
function splitLong(segs, end, maxWords = 60) {
  const out = [];
  segs.forEach((s, i) => {
    const words = s.text.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords * 1.5) return out.push(s);
    const span = Math.max(0, (i + 1 < segs.length ? segs[i + 1].start : end) - s.start);
    const pieces = [];
    let cur = [];
    for (const sent of s.text.split(/(?<=[.!?…])\s+/)) {
      cur.push(sent);
      if (cur.join(" ").split(/\s+/).length >= maxWords) { pieces.push(cur.join(" ")); cur = []; }
    }
    if (cur.length) pieces.push(cur.join(" "));
    let done = 0;
    for (const p of pieces) {
      out.push({ start: s.start + (span * done) / words.length, speaker: s.speaker, text: p });
      done += p.split(/\s+/).length;
    }
  });
  return out;
}

const cleanSpeaker = (s) => String(s || "?").replace(/[`\s]*t?json[`\s]*$/i, "").trim() || "?";

/**
 * Run the whole pipeline. ui = {log(msg), step(msg, pct), keyStatus(pool), reviewSpeakers(list) -> Promise<Map>}.
 * opts.micActivity: [[start, end], ...] seconds when the user's own microphone had speech.
 * Returns {summary, transcript, docx: Blob, transcriptText}.
 */
export async function run(file, settings, ui, { knownDuration = 0, sourceName, participants = [], micActivity = null } = {}) {
  const pool = new KeyPool(settings.keys);
  const models = settings.models;
  const log = (m) => { ui.log(m); ui.keyStatus(pool); };
  const mime = geminiMime(file);
  const isVideo = mime.startsWith("video/");

  try {
    ui.step("Đang đọc file…", 2);
    const media = await openMedia(file, knownDuration);
    const dur = media.duration;
    if (!dur) throw new Error("Không xác định được thời lượng file");
    log(`Thời lượng ${fmtTs(dur)}, ${media.hasVideo ? "có hình" : "chỉ có âm thanh"}, ${(file.size / 1e6).toFixed(1)} MB (${mime})`);

    // 1. Upload with the first key (other keys upload lazily if rotation reaches them)
    ui.step("Đang tải file lên Google Gemini…", 4);
    const first = await pool.acquire(models[0]);
    await fileFor(first, file, mime, (p) => ui.step(`Đang tải file lên Google Gemini… ${Math.round(p * 100)}%`, 4 + p * 14), log);

    // 2. Candidate frames, captured while transcription runs
    const frames = new Map();
    const framesDone = media.hasVideo ? (async () => {
      for (const [i, t] of candidateTimes(dur).entries()) frames.set(i + 1, await captureFrame(media, t));
      log(`Đã cắt ${frames.size} khung hình ứng viên`);
    })() : Promise.resolve();

    // 3. Speech-to-text by time range, in parallel across keys
    const chunk = settings.chunkMinutes * 60;
    const ranges = [];
    for (let a = 0; a < dur; a += chunk) ranges.push([a, Math.min(dur, a + chunk)]);
    ui.step(`Đang chuyển giọng nói thành văn bản (${ranges.length} đoạn)…`, 20);
    let done = 0;
    const hasFile = (st) => (st.files.has(file) ? 1 : 0);

    const transcribe = async ([a, b], idx) => {
      const data = await generate(pool, models, async (st) => {
        const f = await fileFor(st, file, mime, null, log);
        const part = { fileData: { mimeType: f.mimeType || mime, fileUri: f.uri } };
        if (isVideo) part.videoMetadata = { startOffset: `${Math.floor(a)}s`, endOffset: `${Math.ceil(b)}s`, fps: 0.2 };
        return [part, { text: `Hãy gỡ băng phần từ ${fmtTs(a)} đến ${fmtTs(b)} của file. Mốc "t" tính từ đầu file.` }];
      }, { system: prompts.transcribeSystem(participants), schema: prompts.TRANSCRIBE_SCHEMA, lowMedia: isVideo, prefer: hasFile, log });

      let segs = (data.segments || []).filter((s) => s.text?.trim())
        .map((s) => ({ start: parseTs(s.t), speaker: cleanSpeaker(s.speaker), text: s.text.trim() }));
      // "Người nói 1" in one chunk is not necessarily "Người nói 1" in another: keep them apart until identified
      if (ranges.length > 1) segs.forEach((s) => { if (/^Người nói d+$/i.test(s.speaker)) s.speaker += ` · đoạn ${idx + 1}`; });
      // some answers use times relative to the clip instead of the file
      if (a > 0 && segs.length && Math.max(...segs.map((s) => s.start)) < b - a + 30 && Math.min(...segs.map((s) => s.start)) < a - 30) {
        segs.forEach((s) => (s.start += a));
      }
      segs = splitLong(segs.filter((s) => s.start >= a - 30 && s.start <= b + 30).sort((x, y) => x.start - y.start), b);
      done++;
      ui.step(`Đang chuyển giọng nói thành văn bản (${done}/${ranges.length} đoạn)…`, 20 + (45 * done) / ranges.length);
      log(`Xong đoạn ${fmtTs(a)}–${fmtTs(b)}: ${segs.length} lượt nói, ${segs.reduce((n, s) => n + s.text.split(/\s+/).length, 0)} từ`);
      return segs;
    };

    const results = new Array(ranges.length);
    let next = 0;
    const workers = Math.max(1, Math.min(ranges.length, settings.keys.length, 4));
    await Promise.all(Array.from({ length: workers }, async () => {
      while (next < ranges.length) { const i = next++; results[i] = await transcribe(ranges[i], i); }
    }));
    const transcript = results.flat();
    if (!transcript.length) throw new Error("Không nhận diện được lời nói nào");

    // 4. Who is who: Gemini suggestion + microphone overlap, then the user confirms
    ui.step("Đang xác định người nói…", 66);
    let stats = speakerStats(transcript, micActivity);
    let geminiNames = new Map();
    try {
      geminiNames = await suggestNames(pool, models, stats, transcript, participants, log);
    } catch (e) { log(`Không gợi ý được tên người nói: ${e.message}`); }
    stats = mergeSuggestions(stats, geminiNames, settings.myName);
    let names = new Map(stats.map((s) => [s.label, s.suggested]));
    if (settings.reviewSpeakers && ui.reviewSpeakers) {
      ui.step("Chờ bạn xác nhận người nói…", 68);
      names = await ui.reviewSpeakers(stats, participants);
    }
    applyNames(transcript, names);
    log(`Người nói: ${[...new Set(transcript.map((s) => s.speaker))].join(", ")}`);

    ui.step("Đang chờ cắt khung hình…", 69);
    await framesDone;

    // 4. Detailed report from transcript + thumbnails
    ui.step("Đang viết báo cáo chi tiết…", 70);
    const parts = [{ text: "BẢN GỠ BĂNG:\n" + transcript.map((s) => `[${fmtTs(s.start)}] ${s.speaker}: ${s.text}`).join("\n") }];
    if (frames.size) {
      parts.push({ text: "\nKHUNG HÌNH ỨNG VIÊN (id @ thời điểm):" });
      for (const [id, fr] of frames) {
        parts.push({ text: `Frame id=${id} @ ${fmtTs(fr.t)}` });
        parts.push({ inlineData: { mimeType: "image/jpeg", data: await blobToBase64(fr.thumb) } });
      }
    }
    parts.push({ text: "Hãy lập báo cáo theo đúng schema." });
    const summary = await generate(pool, models, parts, {
      system: prompts.summarySystem({ language: settings.language, duration: fmtTs(dur), nSections: Math.max(3, Math.round(dur / 360)), participants }),
      schema: prompts.SUMMARY_SCHEMA, log,
    });

    // 5. Every section gets pictures from its own time range
    ui.step("Đang ghép hình minh hoạ…", 88);
    const used = new Set();
    const sections = summary.sections || [];
    for (const sec of sections) {
      sec.figures = (sec.figures || []).filter((f) => frames.has(f.frame_id) && !used.has(f.frame_id) && used.add(f.frame_id));
    }
    sections.forEach((sec, i) => {
      if (sec.figures.length || !frames.size) return;
      const lo = parseTs(sec.start);
      const hi = parseTs(sec.end) || (i + 1 < sections.length ? parseTs(sections[i + 1].start) : dur);
      const free = [...frames.keys()].filter((id) => !used.has(id));
      const pool2 = free.length ? free : [...frames.keys()];
      const inside = pool2.filter((id) => frames.get(id).t >= lo && frames.get(id).t < Math.max(hi, lo + 1));
      const pick = (inside.length ? inside : pool2)
        .reduce((best, id) => (Math.abs(frames.get(id).t - (lo + hi) / 2) < Math.abs(frames.get(best).t - (lo + hi) / 2) ? id : best));
      sec.figures = [{ frame_id: pick, caption: sec.heading || "" }];
      used.add(pick);
    });

    // 6. DOCX
    ui.step("Đang xuất DOCX…", 94);
    const docx = await buildDocx(summary, frames, transcript, { sourceName: sourceName || file.name, duration: dur, participants }, settings.includeTranscript);
    media.close();
    ui.step("Hoàn tất", 100);
    const transcriptText = transcript.map((s) => `[${fmtTs(s.start)}] ${s.speaker}: ${s.text}`).join("\n");
    return { summary, transcript, transcriptText, docx, figures: used.size };
  } finally {
    ui.keyStatus(pool);
    pool.deleteFiles(); // uploaded copies are removed from Google once done (they would expire after 48 h anyway)
  }
}
