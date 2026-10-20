// Processing: upload -> speech-to-text per time range -> frames -> detailed report -> DOCX.
import { KeyPool, fileFor, generate, blobToBase64, modelChain } from "./gemini.js";
import { openMedia, captureFrame, candidateTimes, geminiMime, fmtTs, parseTs, youtubeInfo, youtubeThumbnail } from "./media.js";
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
 * `file` is a File/Blob, or {youtube: id, url, name} for a public YouTube video that Gemini reads by link.
 * opts.micActivity: [[start, end], ...] seconds when the user's own microphone had speech.
 * Returns {summary, transcript, docx: Blob, transcriptText}.
 */
export async function run(file, settings, ui, { knownDuration = 0, sourceName, participants = [], micActivity = null } = {}) {
  const pool = new KeyPool(settings.keys);
  const models = settings.autoModels === false ? settings.models
    : await modelChain(settings.models, settings.keys[0], (m) => ui.log(m));
  const log = (m) => { ui.log(m); ui.keyStatus(pool); };
  const yt = file.youtube ? file : null;
  const mime = yt ? "video/*" : geminiMime(file);
  const isVideo = !!yt || mime.startsWith("video/");
  let media = null;

  try {
    let dur;
    const frames = new Map();
    let framesDone = Promise.resolve();
    let cover = null;
    if (yt) {
      // Gemini fetches the video from YouTube itself: nothing to upload. Frames cannot be cut from a
      // cross-origin player, so the report uses the video's thumbnail only.
      ui.step("Đang đọc thông tin video YouTube…", 4);
      const info = await youtubeInfo(yt.youtube);
      dur = info.duration;
      if (info.title && !sourceName) sourceName = info.title;
      log(dur ? `Video YouTube ${fmtTs(dur)}${info.title ? `: ${info.title}` : ""}`
        : "Không đọc được thời lượng video YouTube: gỡ băng cả video trong một lượt");
      framesDone = youtubeThumbnail(yt.youtube).then((t) => { cover = t; });
    } else {
      ui.step("Đang đọc file…", 2);
      media = await openMedia(file, knownDuration);
      dur = media.duration;
      if (!dur) throw new Error("Không xác định được thời lượng file");
      log(`Thời lượng ${fmtTs(dur)}, ${media.hasVideo ? "có hình" : "chỉ có âm thanh"}, ${(file.size / 1e6).toFixed(1)} MB (${mime})`);

      // 1. Upload with the first key (other keys upload lazily if rotation reaches them)
      ui.step("Đang tải file lên Google Gemini…", 4);
      const first = pool.anyKey();
      await fileFor(first, file, mime, (p) => ui.step(`Đang tải file lên Google Gemini… ${Math.round(p * 100)}%`, 4 + p * 14), log);

      // 2. Candidate frames, captured while transcription runs
      if (media.hasVideo) framesDone = (async () => {
        for (const [i, t] of candidateTimes(dur).entries()) frames.set(i + 1, await captureFrame(media, t));
        log(`Đã cắt ${frames.size} khung hình ứng viên`);
      })();
    }

    // 3. Speech-to-text by time range, in parallel across keys
    const chunk = settings.chunkMinutes * 60;
    const ranges = [];
    for (let a = 0; a < dur; a += chunk) ranges.push([a, Math.min(dur, a + chunk)]);
    // a tail of a few seconds is rejected by Gemini (400): fold it into the previous range
    if (ranges.length > 1 && ranges[ranges.length - 1][1] - ranges[ranges.length - 1][0] < 60) ranges[ranges.length - 2][1] = ranges.pop()[1];
    if (!ranges.length) ranges.push([0, Infinity]); // unknown length: whole video at once
    ui.step(`Đang chuyển giọng nói thành văn bản (${ranges.length} đoạn)…`, 20);
    let done = 0;
    const hasFile = (st) => (st.files.has(file) ? 1 : 0);

    const transcribe = async ([a, b], idx) => {
      const whole = !Number.isFinite(b);
      const data = await generate(pool, models, async (st) => {
        let part;
        if (yt) part = { fileData: { fileUri: yt.url } };
        else {
          const f = await fileFor(st, file, mime, null, log);
          part = { fileData: { mimeType: f.mimeType || mime, fileUri: f.uri } };
        }
        if (isVideo && !whole) part.videoMetadata = { startOffset: `${Math.floor(a)}s`, endOffset: `${Math.ceil(b)}s`, fps: 0.2 };
        const ask = whole ? "Hãy gỡ băng toàn bộ video." : `Hãy gỡ băng phần từ ${fmtTs(a)} đến ${fmtTs(b)} của file.`;
        return [part, { text: `${ask} Mốc "t" tính từ đầu file.` }];
      }, { system: prompts.transcribeSystem(participants), schema: prompts.TRANSCRIBE_SCHEMA, lowMedia: isVideo, thinking: "low", prefer: hasFile, log });

      let segs = (data.segments || []).filter((s) => s.text?.trim())
        .map((s) => ({ start: parseTs(s.t), speaker: cleanSpeaker(s.speaker), text: s.text.trim() }));
      // "Người nói 1" in one chunk is not necessarily "Người nói 1" in another: keep them apart until identified
      if (ranges.length > 1) segs.forEach((s) => { if (/^Người nói \d+$/i.test(s.speaker)) s.speaker += ` · đoạn ${idx + 1}`; });
      // some answers use times relative to the clip instead of the file
      if (a > 0 && segs.length && Math.max(...segs.map((s) => s.start)) < b - a + 30 && Math.min(...segs.map((s) => s.start)) < a - 30) {
        segs.forEach((s) => (s.start += a));
      }
      segs.sort((x, y) => x.start - y.start);
      const end = whole ? (segs.length ? segs[segs.length - 1].start + 15 : 0) : b;
      segs = splitLong(segs.filter((s) => s.start >= a - 30 && s.start <= end + 30), end);
      done++;
      ui.step(`Đang chuyển giọng nói thành văn bản (${done}/${ranges.length} đoạn)…`, 20 + (45 * done) / ranges.length);
      log(`Xong đoạn ${fmtTs(a)}–${fmtTs(end)}: ${segs.length} lượt nói, ${segs.reduce((n, s) => n + s.text.split(/\s+/).length, 0)} từ`);
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
    if (!dur) dur = transcript[transcript.length - 1].start + 15;

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

    // 4. Report outline (whole meeting: overview, people, tasks, list of sections); frames keep being cut meanwhile
    ui.step("Đang lập khung báo cáo…", 70);
    const line = (s) => `[${fmtTs(s.start)}] ${s.speaker}: ${s.text}`;
    const summary = await generate(pool, models, [
      { text: "BẢN GỠ BĂNG:\n" + transcript.map(line).join("\n") },
      { text: "Hãy lập khung báo cáo theo đúng schema." },
    ], {
      system: prompts.outlineSystem({ language: settings.language, duration: fmtTs(dur), nSections: Math.max(3, Math.round(dur / 360)), participants }),
      schema: prompts.OUTLINE_SCHEMA, log,
    });
    const sections = (summary.sections || []).filter((s) => s.heading);
    if (!sections.length) sections.push({ heading: summary.title || "Nội dung", start: fmtTs(0), end: fmtTs(dur) });
    summary.sections = sections;
    log(`Khung báo cáo: ${sections.length} phần, ${(summary.action_items || []).length} việc được giao`);

    ui.step("Đang chờ cắt khung hình…", 74);
    await framesDone;

    // 5. Every section written at the same time, each with its own slice of transcript and frames
    const thumbs = new Map();
    for (const [id, fr] of frames) thumbs.set(id, await blobToBase64(fr.thumb));
    const toc = `KHUNG BÁO CÁO: ${summary.title}\nTóm tắt: ${summary.overview}\nCác phần:\n` +
      sections.map((s, i) => `${i + 1}. [${s.start}–${s.end}] ${s.heading}`).join("\n");
    const bounds = sections.map((s, i) => {
      const lo = parseTs(s.start);
      const hi = parseTs(s.end) || (i + 1 < sections.length ? parseTs(sections[i + 1].start) : dur);
      return [lo, Math.max(hi, lo + 1)];
    });
    let written = 0;
    const writeSection = async (i) => {
      const [lo, hi] = bounds[i];
      const slice = transcript.filter((s) => s.start >= lo - 30 && s.start < hi + 30);
      const parts = [
        { text: toc },
        { text: `\nPHẦN CẦN VIẾT: ${i + 1}. ${sections[i].heading} (${fmtTs(lo)}–${fmtTs(hi)})` },
        { text: "\nBẢN GỠ BĂNG CỦA PHẦN NÀY:\n" + (slice.length ? slice.map(line).join("\n") : "(không có lời nói)") },
      ];
      const inRange = [...frames].filter(([, fr]) => fr.t >= lo - 5 && fr.t < hi + 5);
      if (inRange.length) {
        parts.push({ text: "\nKHUNG HÌNH TRONG PHẦN NÀY (id @ thời điểm):" });
        for (const [id, fr] of inRange) {
          parts.push({ text: `Frame id=${id} @ ${fmtTs(fr.t)}` });
          parts.push({ inlineData: { mimeType: "image/jpeg", data: thumbs.get(id) } });
        }
      }
      parts.push({ text: "Hãy viết phần này theo đúng schema." });
      const body = await generate(pool, models, parts, {
        system: prompts.sectionSystem({ language: settings.language, participants }),
        schema: prompts.SECTION_SCHEMA, thinking: "low", log,
      });
      Object.assign(sections[i], {
        paragraphs: body.paragraphs || [], key_points: body.key_points || [], quotes: body.quotes || [],
        figures: (body.figures || []).filter((f) => inRange.some(([id]) => id === f.frame_id)),
      });
      written++;
      ui.step(`Đang viết chi tiết từng phần (${written}/${sections.length})…`, 76 + (12 * written) / sections.length);
    };
    ui.step(`Đang viết chi tiết từng phần (0/${sections.length})…`, 76);
    let nextSec = 0;
    const secWorkers = Math.max(1, Math.min(sections.length, settings.keys.length * 2, 8));
    await Promise.all(Array.from({ length: secWorkers }, async () => {
      while (nextSec < sections.length) await writeSection(nextSec++);
    }));

    // 6. Every section gets pictures from its own time range
    ui.step("Đang ghép hình minh hoạ…", 89);
    const used = new Set();
    for (const sec of sections) {
      sec.figures = (sec.figures || []).filter((f) => frames.has(f.frame_id) && !used.has(f.frame_id) && used.add(f.frame_id));
    }
    sections.forEach((sec, i) => {
      if (sec.figures.length || !frames.size) return;
      const [lo, hi] = bounds[i];
      const free = [...frames.keys()].filter((id) => !used.has(id));
      const pool2 = free.length ? free : [...frames.keys()];
      const inside = pool2.filter((id) => frames.get(id).t >= lo && frames.get(id).t < hi);
      const pick = (inside.length ? inside : pool2)
        .reduce((best, id) => (Math.abs(frames.get(id).t - (lo + hi) / 2) < Math.abs(frames.get(best).t - (lo + hi) / 2) ? id : best));
      sec.figures = [{ frame_id: pick, caption: sec.heading || "" }];
      used.add(pick);
    });

    if (cover && sections.length) {
      frames.set(1, cover);
      sections[0].figures = [{ frame_id: 1, caption: "Ảnh đại diện của video trên YouTube" }];
      used.add(1);
    }

    // 7. DOCX
    ui.step("Đang xuất DOCX…", 94);
    const docx = await buildDocx(summary, frames, { sourceName: sourceName || file.name, duration: dur, participants });
    media?.close();
    ui.step("Hoàn tất", 100);
    const transcriptText = transcript.map((s) => `[${fmtTs(s.start)}] ${s.speaker}: ${s.text}`).join("\n");
    return { summary, transcript, transcriptText, docx, figures: used.size };
  } finally {
    ui.keyStatus(pool);
    pool.deleteFiles(); // uploaded copies are removed from Google once done (they would expire after 48 h anyway)
  }
}
