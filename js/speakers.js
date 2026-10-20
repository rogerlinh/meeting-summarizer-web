// Speaker identification: per-label stats, microphone overlap, Gemini name suggestions.
import { generate } from "./gemini.js";
import { fmtTs } from "./media.js";
import * as prompts from "./prompts.js";

const words = (t) => t.split(/\s+/).filter(Boolean).length;

/** Seconds of [a, b] covered by the sorted interval list. */
function overlap(a, b, intervals) {
  let s = 0;
  for (const [x, y] of intervals) {
    if (y <= a) continue;
    if (x >= b) break;
    s += Math.min(b, y) - Math.max(a, x);
  }
  return s;
}

/** One entry per speaker label: counts, sample lines, and how much of their speech overlaps the user's mic. */
export function speakerStats(transcript, micActivity) {
  const by = new Map();
  transcript.forEach((s, i) => {
    const end = Math.min(i + 1 < transcript.length ? transcript[i + 1].start : s.start + 15, s.start + 30);
    const e = by.get(s.speaker) || { label: s.speaker, count: 0, words: 0, seconds: 0, micSeconds: 0, lines: [] };
    e.count++;
    e.words += words(s.text);
    e.seconds += Math.max(1, end - s.start);
    if (micActivity?.length) e.micSeconds += overlap(s.start, Math.max(end, s.start + 1), micActivity);
    e.lines.push(s);
    by.set(s.speaker, e);
  });
  return [...by.values()].map((e) => {
    // samples: the longest lines, spread over time, shown in time order
    const samples = [...e.lines].sort((x, y) => words(y.text) - words(x.text)).slice(0, 4).sort((x, y) => x.start - y.start);
    return { label: e.label, count: e.count, words: e.words, micRatio: micActivity?.length ? e.micSeconds / e.seconds : null,
      samples: samples.map((s) => ({ t: s.start, text: s.text.length > 220 ? s.text.slice(0, 220) + "…" : s.text })) };
  }).sort((a, b) => b.words - a.words);
}

/** Ask Gemini to match labels to participant names (and link labels across chunks). */
export async function suggestNames(pool, models, stats, transcript, participants, log) {
  // context around each sample helps (who called whom by name just before)
  const context = (t) => transcript.filter((s) => s.start >= t - 40 && s.start <= t + 10)
    .map((s) => `  [${fmtTs(s.start)}] ${s.speaker}: ${s.text.slice(0, 200)}`).join("\n");
  const text = stats.map((s) => `### Nhãn: ${s.label} (${s.count} lượt, ${s.words} từ)\n` +
    s.samples.map((x) => `Mẫu tại ${fmtTs(x.t)}:\n${context(x.t)}`).join("\n")).join("\n\n");
  const data = await generate(pool, models, [{ text }, { text: "Đề xuất tên cho từng nhãn theo đúng schema." }],
    { system: prompts.linkSystem(participants), schema: prompts.LINK_SCHEMA, log });
  return new Map((data.mapping || []).filter((m) => m.label).map((m) => [m.label.trim(), m]));
}

/**
 * Suggested name per label. The label whose speech overlaps the user's microphone clearly the most
 * (>= 40 % and twice the runner-up; model timestamps are a few seconds off) is the user, which beats Gemini's guess.
 */
export function mergeSuggestions(stats, geminiMap, myName) {
  const ranked = stats.filter((s) => s.micRatio != null).sort((a, b) => b.micRatio - a.micRatio);
  const me = ranked[0] && ranked[0].micRatio >= 0.4 && ranked[0].micRatio >= 2 * (ranked[1]?.micRatio || 0) ? ranked[0] : null;
  return stats.map((s) => {
    const g = geminiMap.get(s.label);
    if (me && s.label === me.label) {
      return { ...s, suggested: myName || "Tôi", confidence: "cao", reason: `${Math.round(s.micRatio * 100)}% lời nói trùng lúc micro của bạn có tiếng` };
    }
    return { ...s, suggested: g?.name?.trim() || s.label, confidence: g?.confidence || "thấp", reason: g?.reason || "" };
  });
}

export function applyNames(transcript, names) {
  transcript.forEach((s) => { const n = names.get(s.speaker); if (n && n.trim()) s.speaker = n.trim(); });
}
