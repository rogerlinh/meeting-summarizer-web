import { run } from "./pipeline.js";
import { testKey } from "./gemini.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mask = (k) => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : "****");

// ---------- settings (this browser only) ----------
const STORE = "meeting-summarizer-settings";
const DEFAULTS = { keys: [], models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"], language: "Tiếng Việt", chunkMinutes: 15, includeTranscript: true };
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
  saveSettings(settings); renderSettings();
  $("#saved").textContent = "✓ Đã lưu"; setTimeout(() => ($("#saved").textContent = ""), 2000);
};
$("#clearAll").onclick = () => {
  if (!confirm("Xoá toàn bộ API key và cài đặt khỏi trình duyệt này?")) return;
  try { localStorage.removeItem(STORE); } catch { /* ignore */ }
  settings = loadSettings(); renderSettings(); toast("Đã xoá");
};

// ---------- job runner ----------
let busy = false;
function setBusy(b) {
  busy = b;
  $("#upBtn").disabled = b || !chosen;
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
  $("#jobError").classList.add("hidden"); $("#jobOutputs").innerHTML = ""; $("#jobPreview").classList.add("hidden");
  $("#jobLog").textContent = "";
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  const ui = {
    log: (m) => { $("#jobLog").textContent += `${new Date().toLocaleTimeString("vi-VN")} ${m}\n`; },
    step: (m, pct) => { $("#jobStep").textContent = m; $("#jobBar").style.width = `${pct}%`; },
    keyStatus: renderKeyStatus,
  };
  try {
    const res = await run(file, settings, ui, opts);
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

// ---------- meeting recording (kept in memory, processed on stop) ----------
const rec = { recorder: null, streams: [], ctx: null, parts: [], bytes: 0, t0: 0, timer: null, name: "" };

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
      rec.streams.push(mic); ctx.createMediaStreamSource(mic).connect(dest);
    } catch { toast("Không truy cập được micro, chỉ ghi âm thanh nguồn"); }
  }
  const mixed = new MediaStream([...display.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  rec.recorder = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: 600_000, audioBitsPerSecond: 64_000 });
  rec.parts = []; rec.bytes = 0; rec.name = $("#recName").value.trim() || `Cuộc họp ${new Date().toLocaleString("vi-VN")}`;
  rec.recorder.ondataavailable = (e) => { if (e.data.size) { rec.parts.push(e.data); rec.bytes += e.data.size; } };
  rec.recorder.onstop = finishRecording;
  display.getVideoTracks()[0].onended = () => rec.recorder?.state === "recording" && rec.recorder.stop();
  rec.recorder.start(10_000);

  const v = $("#recPreview"); v.srcObject = display; v.play(); v.classList.remove("hidden");
  $("#recStatus").classList.remove("hidden"); $("#recStart").disabled = true; $("#recStop").disabled = false;
  rec.t0 = Date.now();
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.t0) / 1000);
    $("#recTime").textContent = [s / 3600, (s % 3600) / 60, s % 60].map((x) => String(Math.floor(x)).padStart(2, "0")).join(":");
    $("#recSize").textContent = (rec.bytes / 1e6).toFixed(1) + " MB";
  }, 1000);
  window.onbeforeunload = () => "Đang ghi cuộc họp";
}

function finishRecording() {
  clearInterval(rec.timer); window.onbeforeunload = null;
  const seconds = (Date.now() - rec.t0) / 1000;
  rec.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  rec.ctx?.close();
  $("#recPreview").classList.add("hidden"); $("#recStatus").classList.add("hidden");
  $("#recStop").disabled = true; rec.recorder = null; $("#recStart").disabled = busy;
  if (!rec.bytes) { toast("Không có dữ liệu ghi"); return; }
  const file = new File(rec.parts, `${rec.name}.webm`, { type: "video/webm" });
  rec.parts = [];
  // offer the raw recording too, so nothing is lost if processing fails
  const keep = $("#jobOutputs");
  startJob(file, { knownDuration: seconds, sourceName: rec.name }).then(() => {
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
