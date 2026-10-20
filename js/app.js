import { run } from "./pipeline.js";
import { testKey } from "./gemini.js";
import { youtubeId } from "./media.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mask = (k) => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : "****");

// ---------- settings (this browser only) ----------
const STORE = "meeting-summarizer-settings";
const DEFAULTS = { keys: [], models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"], language: "Tiếng Việt", chunkMinutes: 15,
  includeTranscript: true, myName: "", reviewSpeakers: true, participants: "" };
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || "{}") }; } catch { return { ...DEFAULTS }; }
}
function saveSettings(s) {
  try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { toast("Trình duyệt chặn lưu cài đặt (chế độ ẩn danh?)"); }
}
let settings = loadSettings();

function toast(msg, ms = 3500) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

function showTab(name) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === "tab-" + name));
}
document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

function renderSettings() {
  $("#keyList").innerHTML = settings.keys.length
    ? settings.keys.map((k, i) => `<li>${esc(mask(k))} <button data-i="${i}">Xoá</button></li>`).join("")
    : '<li class="muted">Chưa có key</li>';
  $("#keyList").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    settings.keys.splice(+b.dataset.i, 1); saveSettings(settings); renderSettings();
  }));
  $("#models").value = settings.models.join(", ");
  $("#language").value = settings.language;
  $("#chunkMinutes").value = settings.chunkMinutes;
  $("#includeTranscript").checked = settings.includeTranscript;
  $("#myName").value = settings.myName;
  $("#reviewSpeakers").checked = settings.reviewSpeakers;
  if (document.activeElement !== $("#participants")) $("#participants").value = settings.participants;
  const warn = settings.keys.length ? "" : 'Chưa có Gemini API key. Vào tab <b>API key & Cài đặt</b> để nhập key của bạn.';
  $("#warn").innerHTML = warn; $("#warn").classList.toggle("hidden", !warn);
}
$("#addKeys").onclick = () => {
  const added = $("#newKeys").value.split(/[\s,]+/).map((k) => k.trim()).filter((k) => k && !settings.keys.includes(k));
  if (!added.length) return;
  settings.keys.push(...added); saveSettings(settings); $("#newKeys").value = ""; renderSettings();
  toast(`Đã thêm ${added.length} key`);
};
$("#testKeys").onclick = async () => {
  const btn = $("#testKeys"); btn.disabled = true; btn.textContent = "Đang kiểm tra…";
  const res = await Promise.all(settings.keys.map(async (k) => ({ key: mask(k), ...(await testKey(k)) })));
  btn.disabled = false; btn.textContent = "Kiểm tra key";
  alert(res.map((r) => `${r.ok ? "✅" : "❌"} ${r.key}  ${r.ok ? "" : r.message}`).join("\n") || "Chưa có key");
};
$("#saveSettings").onclick = () => {
  settings.models = $("#models").value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!settings.models.length) settings.models = [...DEFAULTS.models];
  settings.language = $("#language").value.trim() || DEFAULTS.language;
  settings.chunkMinutes = Math.min(40, Math.max(5, +$("#chunkMinutes").value || 15));
  settings.includeTranscript = $("#includeTranscript").checked;
  settings.myName = $("#myName").value.trim();
  settings.reviewSpeakers = $("#reviewSpeakers").checked;
  saveSettings(settings); renderSettings();
  $("#saved").textContent = "✓ Đã lưu"; setTimeout(() => ($("#saved").textContent = ""), 2000);
};
$("#clearAll").onclick = () => {
  if (!confirm("Xoá toàn bộ API key và cài đặt khỏi trình duyệt này?")) return;
  try { localStorage.removeItem(STORE); } catch { /* ignore */ }
  settings = loadSettings(); renderSettings(); toast("Đã xoá");
};

// ---------- participants (remembered for the next meeting) ----------
$("#participants").oninput = () => { settings.participants = $("#participants").value; saveSettings(settings); };
const participantList = () => $("#participants").value.split("\n").map((l) => l.trim()).filter(Boolean);
const personName = (line) => line.split(/\s+[–—-]\s+|\s*[:(|]\s*/)[0].trim();

/** Show the speaker table and resolve with Map(label -> confirmed name) when the user clicks the button. */
function reviewSpeakers(stats, participants) {
  const names = [...new Set([settings.myName, ...participants.map(personName), "Cả nhóm"].filter(Boolean))];
  $("#peopleList").innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
  const confClass = (c) => ({ "cao": "cao", "trung bình": "trung", "thấp": "thap" }[c] || "thap");
  $("#reviewRows").innerHTML = stats.map((s, i) => `
    <div class="spk">
      <div>
        <div class="spk-label">${esc(s.label)}</div>
        <div class="spk-meta">${s.count} lượt nói · ${s.words} từ${s.micRatio != null ? ` · trùng micro của bạn ${Math.round(s.micRatio * 100)}%` : ""}</div>
        ${s.samples.map((x) => `<p class="spk-sample"><b>${fmt(x.t)}</b> ${esc(x.text)}</p>`).join("")}
      </div>
      <div class="spk-name">
        <input list="peopleList" data-i="${i}" value="${esc(s.suggested === s.label ? "" : s.suggested)}" placeholder="${esc(s.label)}">
        <span class="conf ${confClass(s.confidence)}">Gợi ý: ${esc(s.suggested)} (độ tin cậy ${esc(s.confidence)})</span>
        ${s.reason ? `<span class="spk-meta">${esc(s.reason)}</span>` : ""}
      </div>
    </div>`).join("");
  $("#review").classList.remove("hidden");
  $("#review").scrollIntoView({ behavior: "smooth", block: "start" });
  return new Promise((resolve) => {
    $("#reviewOk").onclick = () => {
      const map = new Map();
      $("#reviewRows").querySelectorAll("input").forEach((inp) => {
        const s = stats[+inp.dataset.i];
        map.set(s.label, inp.value.trim() || s.label);
      });
      $("#review").classList.add("hidden");
      resolve(map);
    };
  });
}
const fmt = (sec) => { sec = Math.floor(sec); const p = (x) => String(x).padStart(2, "0"); return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec % 3600 / 60))}:${p(sec % 60)}`; };

// ---------- job runner ----------
let busy = false;
function setBusy(b) {
  busy = b;
  $("#upBtn").disabled = b || !chosen;
  $("#ytBtn").disabled = b;
  $("#recStart").disabled = b || !!rec.recorder;
  window.onbeforeunload = b ? () => "Đang xử lý" : null;
}

function renderKeyStatus(pool) {
  $("#keyStatus tbody").innerHTML = pool.status().map((k) => `<tr title="${esc(k.lastError)}"><td><code>${esc(k.key)}</code></td>
    <td><span class="pill ${k.state}">${k.state}${k.cooldown ? " " + k.cooldown + "s" : ""}</span></td>
    <td>${k.ok}</td><td>${k.rateLimited}</td><td>${k.errors}</td></tr>`).join("");
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

async function startJob(file, opts = {}) {
  if (busy) return;
  if (!settings.keys.length) { toast("Hãy nhập Gemini API key trước"); showTab("settings"); return; }
  setBusy(true);
  const card = $("#jobCard"); card.classList.remove("hidden");
  $("#jobTitle").textContent = opts.sourceName || file.name;
  $("#jobPill").className = "pill running"; $("#jobPill").textContent = "Đang xử lý";
  $("#jobError").classList.add("hidden"); $("#review").classList.add("hidden"); $("#jobOutputs").innerHTML = ""; $("#jobPreview").classList.add("hidden");
  $("#jobLog").textContent = "";
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  const ui = {
    log: (m) => { $("#jobLog").textContent += `${new Date().toLocaleTimeString("vi-VN")} ${m}\n`; },
    step: (m, pct) => { $("#jobStep").textContent = m; $("#jobBar").style.width = `${pct}%`; },
    keyStatus: renderKeyStatus,
    reviewSpeakers,
  };
  try {
    const res = await run(file, settings, ui, { participants: participantList(), ...opts });
    let base = (res.summary.title || "bao_cao").replace(/[\\/:*?"<>|]+/g, "_").trim();
    if (base.length > 80) base = base.slice(0, 80).replace(/\s+\S*$/, ""); // cut on a word boundary
    base = base || "bao_cao";
    $("#jobPill").className = "pill done"; $("#jobPill").textContent = "Hoàn tất";
    $("#jobOutputs").innerHTML = '<button class="primary" id="dlDocx">⬇ Tải báo cáo DOCX</button><button id="dlTxt">⬇ Bản gỡ băng (.txt)</button>';
    $("#dlDocx").onclick = () => download(res.docx, `${base}.docx`);
    $("#dlTxt").onclick = () => download(new Blob([res.transcriptText], { type: "text/plain;charset=utf-8" }), `${base} - go bang.txt`);
    const s = res.summary;
    $("#jobPreview").innerHTML = `<h3>${esc(s.title)}</h3><p class="muted">${(s.sections || []).length} phần · ${res.figures} hình · ${res.transcript.length} lượt nói</p>
      <p>${esc(s.overview)}</p><ol>${(s.sections || []).map((x) => `<li><b>${esc(x.start)}</b> ${esc(x.heading)}</li>`).join("")}</ol>`;
    $("#jobPreview").classList.remove("hidden");
    download(res.docx, `${base}.docx`);
  } catch (e) {
    console.error(e);
    $("#jobPill").className = "pill error"; $("#jobPill").textContent = "Lỗi";
    $("#jobError").textContent = e.message; $("#jobError").classList.remove("hidden");
    ui.log("LỖI: " + e.message);
  } finally {
    setBusy(false);
  }
}

// ---------- upload ----------
let chosen = null;
const drop = $("#drop");
function choose(f) {
  chosen = f || null;
  $("#dropText").textContent = f ? `${f.name} (${(f.size / 1e6).toFixed(1)} MB)` : "Kéo thả file vào đây hoặc bấm để chọn";
  $("#upBtn").disabled = !f || busy;
}
$("#file").onchange = (e) => choose(e.target.files[0]);
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); choose(e.dataTransfer.files[0]); };
$("#upBtn").onclick = () => chosen && startJob(chosen);

// ---------- YouTube link ----------
$("#ytBtn").onclick = () => {
  const id = youtubeId($("#ytUrl").value);
  if (!id) { toast("Link không phải video YouTube. Video Drive/Facebook/Vimeo hãy tải về rồi dùng ô Tải lên."); return; }
  const url = `https://www.youtube.com/watch?v=${id}`;
  startJob({ youtube: id, url, name: url });
};
$("#ytUrl").onkeydown = (e) => e.key === "Enter" && $("#ytBtn").click();

// ---------- meeting recording (kept in memory, processed on stop) ----------
const rec = { recorder: null, streams: [], ctx: null, parts: [], bytes: 0, t0: 0, timer: null, name: "", mic: [], micTimer: null };

/** Turn 100 ms microphone loudness samples into [start, end] intervals where the user was speaking. */
function micIntervals(samples) {
  if (samples.length < 20) return [];
  const sorted = samples.map((x) => x[1]).sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * 0.2)];
  const thr = Math.max(noise * 3, 0.01);
  const out = [];
  for (const [t, rms] of samples) {
    if (rms < thr) continue;
    const last = out[out.length - 1];
    if (last && t - last[1] <= 0.6) last[1] = t + 0.1;
    else out.push([t, t + 0.1]);
  }
  return out.filter(([a, b]) => b - a >= 0.4);
}

async function startRecording() {
  if (!settings.keys.length) { toast("Hãy nhập Gemini API key trước"); showTab("settings"); return; }
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5, width: { max: 1920 } }, audio: true, systemAudio: "include", selfBrowserSurface: "exclude",
    });
  } catch { toast("Đã huỷ chọn nguồn ghi"); return; }
  if (!display.getAudioTracks().length && !confirm("Nguồn đã chọn KHÔNG có âm thanh (chưa tích 'Chia sẻ âm thanh'). Vẫn tiếp tục?")) {
    display.getTracks().forEach((t) => t.stop()); return;
  }
  rec.streams = [display];
  const ctx = new AudioContext(); rec.ctx = ctx;
  const dest = ctx.createMediaStreamDestination();
  if (display.getAudioTracks().length) ctx.createMediaStreamSource(display).connect(dest);
  if ($("#recMic").checked) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      rec.streams.push(mic);
      const micSrc = ctx.createMediaStreamSource(mic);
      micSrc.connect(dest);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      micSrc.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      rec.mic = [];
      rec.micTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        rec.mic.push([Date.now(), Math.sqrt(sum / buf.length)]);
      }, 100);
    } catch { toast("Không truy cập được micro, chỉ ghi âm thanh nguồn"); }
  }
  const mixed = new MediaStream([...display.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  rec.recorder = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: 600_000, audioBitsPerSecond: 64_000 });
  rec.parts = []; rec.bytes = 0; rec.name = $("#recName").value.trim() || `Cuộc họp ${new Date().toLocaleString("vi-VN")}`;
  rec.recorder.ondataavailable = (e) => { if (e.data.size) { rec.parts.push(e.data); rec.bytes += e.data.size; } };
  rec.recorder.onstop = finishRecording;
  display.getVideoTracks()[0].onended = () => rec.recorder?.state === "recording" && rec.recorder.stop();
  rec.t0 = Date.now();
  rec.recorder.start(10_000);

  const v = $("#recPreview"); v.srcObject = display; v.play(); v.classList.remove("hidden");
  $("#recStatus").classList.remove("hidden"); $("#recStart").disabled = true; $("#recStop").disabled = false;
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.t0) / 1000);
    $("#recTime").textContent = [s / 3600, (s % 3600) / 60, s % 60].map((x) => String(Math.floor(x)).padStart(2, "0")).join(":");
    $("#recSize").textContent = (rec.bytes / 1e6).toFixed(1) + " MB";
  }, 1000);
  window.onbeforeunload = () => "Đang ghi cuộc họp";
}

function finishRecording() {
  clearInterval(rec.timer); clearInterval(rec.micTimer); window.onbeforeunload = null;
  const seconds = (Date.now() - rec.t0) / 1000;
  const micActivity = micIntervals(rec.mic.map(([ms, rms]) => [(ms - rec.t0) / 1000, rms]).filter(([t]) => t >= 0));
  rec.mic = [];
  rec.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  rec.ctx?.close();
  $("#recPreview").classList.add("hidden"); $("#recStatus").classList.add("hidden");
  $("#recStop").disabled = true; rec.recorder = null; $("#recStart").disabled = busy;
  if (!rec.bytes) { toast("Không có dữ liệu ghi"); return; }
  const file = new File(rec.parts, `${rec.name}.webm`, { type: "video/webm" });
  rec.parts = [];
  // offer the raw recording too, so nothing is lost if processing fails
  const keep = $("#jobOutputs");
  startJob(file, { knownDuration: seconds, sourceName: rec.name, micActivity: micActivity.length ? micActivity : null }).then(() => {
    const b = document.createElement("button"); b.textContent = "⬇ File ghi hình (.webm)";
    b.onclick = () => download(file, file.name); keep.appendChild(b);
  });
}
$("#recStart").onclick = startRecording;
$("#recStop").onclick = () => rec.recorder?.state === "recording" && rec.recorder.stop();

renderSettings();
if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
  $("#recStart").disabled = true;
  $("#recStart").title = "Trình duyệt này không hỗ trợ ghi màn hình";
}
