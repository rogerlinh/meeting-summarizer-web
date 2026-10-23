import { run } from "./pipeline.js";
import { testKey, KeyPool } from "./gemini.js";
import { youtubeId } from "./media.js";
import * as store from "./store.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mask = (k) => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : "****");

// ---------- settings (this browser only) ----------
const STORE = "meeting-summarizer-settings";
// Every model has its own free quota per project, so a longer chain means more reports per day.
const DEFAULTS = { keys: [], models: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
  "gemini-3-flash-preview", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"], autoModels: true,
  language: "Tiếng Việt", chunkMinutes: 15, myName: "", reviewSpeakers: true, participants: "" };
const OLD_DEFAULT_MODELS = "gemini-3.8-flash,gemini-3.5-flash-lite";
function loadSettings() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || "{}") }; } catch { s = { ...DEFAULTS }; }
  if (s.models.join(",") === OLD_DEFAULT_MODELS) s.models = [...DEFAULTS.models]; // untouched old default
  return s;
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
  if (name === "settings" && !busy) renderQuota(new KeyPool(settings.keys)); // limits remembered from earlier runs
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
  $("#autoModels").checked = settings.autoModels;
  $("#language").value = settings.language;
  $("#chunkMinutes").value = settings.chunkMinutes;
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
  settings.autoModels = $("#autoModels").checked;
  if (!settings.models.length) settings.models = [...DEFAULTS.models];
  settings.language = $("#language").value.trim() || DEFAULTS.language;
  settings.chunkMinutes = Math.min(40, Math.max(5, +$("#chunkMinutes").value || 15));
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
  const title = document.title;
  document.title = "⏳ Chờ xác nhận người nói – " + title;
  chime();
  return new Promise((resolve) => {
    // nobody at the screen: go on with the suggested names (and anything already typed) after a while
    let left = REVIEW_TIMEOUT_S;
    const tick = () => { $("#reviewAuto").textContent = `Tự động dùng tên gợi ý sau ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`; };
    tick();
    const timer = setInterval(() => { left--; tick(); if (left <= 0) finish(); }, 1000);
    const finish = () => {
      clearInterval(timer);
      document.title = title;
      const map = new Map();
      $("#reviewRows").querySelectorAll("input").forEach((inp) => {
        const s = stats[+inp.dataset.i];
        map.set(s.label, inp.value.trim() || s.label);
      });
      $("#review").classList.add("hidden");
      resolve(map);
    };
    $("#reviewOk").onclick = finish;
    // typing means someone is there: stop the countdown
    $("#reviewRows").oninput = () => { clearInterval(timer); $("#reviewAuto").textContent = ""; };
  });
}
const REVIEW_TIMEOUT_S = 300;

/** Short two-tone sound so the user notices the review panel while in another tab. */
function chime() {
  try {
    const ctx = new AudioContext();
    [880, 660].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.25);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.25 + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.25);
      o.stop(ctx.currentTime + i * 0.25 + 0.25);
    });
    setTimeout(() => ctx.close(), 1000);
  } catch { /* no audio */ }
}
const fmt = (sec) => { sec = Math.floor(sec); const p = (x) => String(x).padStart(2, "0"); return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec % 3600 / 60))}:${p(sec % 60)}`; };

// ---------- job runner ----------
let busy = false;
function setBusy(b) {
  busy = b;
  $("#upBtn").disabled = b || !chosen;
  $("#ytBtn").disabled = b;
  $("#recStart").disabled = b || !!rec.recorder;
  updateLeaveGuard();
}

/** Ask before leaving while recording, while a job runs, or while a recording exists only in memory. */
function updateLeaveGuard() {
  const why = rec.recorder ? "Đang ghi cuộc họp" : busy ? "Đang xử lý" : rec.unsaved ? "Bản ghi chưa được lưu" : "";
  window.onbeforeunload = why ? (e) => { e.preventDefault(); return (e.returnValue = why); } : null;
}

function renderKeyStatus(pool) {
  $("#keyStatus tbody").innerHTML = pool.status().map((k) => `<tr title="${esc(k.lastError)}"><td><code>${esc(k.key)}</code></td>
    <td><span class="pill ${k.state}">${k.state}${k.cooldown ? " " + k.cooldown + "s" : ""}</span></td>
    <td>${k.ok}</td><td>${k.rateLimited}</td><td>${k.errors}</td></tr>`).join("");
  renderQuota(pool);
}

const mins = (s) => (s >= 90 ? `~${Math.round(s / 60)} phút` : `${s} giây`);
const quotaWhy = (q) => (q.perDay ? `hết quota trong ngày${q.limit ? ` (${q.limit} request/ngày/project)` : ""}` : "giới hạn tạm thời (theo phút)");

/** Quota notice above the job log + the per-model table in Settings. */
function renderQuota(pool) {
  const q = pool.quota();
  const full = q.filter((m) => m.blocked >= m.keys);
  const msgs = full.map((m) => `⚠ <b>${esc(m.model)}</b> ${quotaWhy(m)} trên cả ${m.keys} key – thử lại được sau ${mins(m.retry)}.`);
  if (full.length && pool.lastModel && !full.some((m) => m.model === pool.lastModel)) {
    msgs.push(`App đã tự chuyển sang <b>${esc(pool.lastModel)}</b>.`);
  }
  $("#quotaNote").innerHTML = msgs.join("<br>");
  $("#quotaNote").classList.toggle("hidden", !msgs.length);
  $("#quotaTable tbody").innerHTML = q.length
    ? q.map((m) => `<tr><td><code>${esc(m.model)}</code></td><td>${m.blocked}/${m.keys}</td><td>${quotaWhy(m)}</td><td>${mins(m.retry)}</td></tr>`).join("")
    : '<tr><td colspan="4" class="muted">Chưa model nào bị giới hạn</td></tr>';
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
  const { recordingId, saved, ...runOpts } = opts;
  jobRecId = recordingId; renderSaved();
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
    const res = await run(file, settings, ui, { participants: participantList(), ...runOpts });
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
    if (recordingId) {
      // the report exists now: the saved recording is no longer needed (the .webm button stays for this session)
      await saved?.catch(() => {});
      await store.deleteRecording(recordingId).catch(() => {});
    }
    return true;
  } catch (e) {
    console.error(e);
    $("#jobPill").className = "pill error"; $("#jobPill").textContent = "Lỗi";
    $("#jobError").textContent = e.message; $("#jobError").classList.remove("hidden");
    ui.log("LỖI: " + e.message);
    if (recordingId) ui.log("Bản ghi vẫn được lưu trong trình duyệt: mục “Bản ghi chưa xử lý” ở đầu trang, tải lại trang không mất.");
    return false;
  } finally {
    jobRecId = null; renderSaved();
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

// ---------- meeting recording (saved to IndexedDB every 10 s, processed on stop) ----------
const rec = { recorder: null, streams: [], ctx: null, parts: [], bytes: 0, t0: 0, timer: null, name: "", mic: [], micTimer: null,
  id: null, saving: Promise.resolve(), unsaved: false };

/** IndexedDB refused a chunk (private window, disk full…): stop saving and keep the user from losing the in-memory copy. */
function saveFailed(e) {
  console.error(e);
  if (rec.id) store.updateRecording(rec.id, { broken: true }).catch(() => {});
  rec.id = null; rec.unsaved = true;
  updateLeaveGuard();
  toast("Không lưu được bản ghi vào trình duyệt. Đừng tải lại trang; khi xong hãy bấm ⬇ File ghi hình để tải về.", 8000);
}

const micActivityNow = () => micIntervals(rec.mic.map(([ms, rms]) => [(ms - rec.t0) / 1000, rms]).filter(([t]) => t >= 0));

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
  rec.recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    rec.parts.push(e.data); rec.bytes += e.data.size;
    if (!rec.id) return;
    const id = rec.id, update = { bytes: rec.bytes, seconds: (Date.now() - rec.t0) / 1000, micActivity: micActivityNow() };
    rec.saving = rec.saving.then(() => rec.id === id && store.appendPart(id, e.data, update)).catch(saveFailed);
  };
  rec.recorder.onstop = finishRecording;
  display.getVideoTracks()[0].onended = () => rec.recorder?.state === "recording" && rec.recorder.stop();
  rec.t0 = Date.now();
  rec.id = null; rec.unsaved = false; rec.saving = Promise.resolve();
  try { rec.id = await store.createRecording({ name: rec.name, t0: rec.t0 }); } catch (e) { saveFailed(e); }
  rec.recorder.start(10_000);

  const v = $("#recPreview"); v.srcObject = display; v.play(); v.classList.remove("hidden");
  $("#recStatus").classList.remove("hidden"); $("#recStart").disabled = true; $("#recStop").disabled = false;
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.t0) / 1000);
    $("#recTime").textContent = [s / 3600, (s % 3600) / 60, s % 60].map((x) => String(Math.floor(x)).padStart(2, "0")).join(":");
    $("#recSize").textContent = (rec.bytes / 1e6).toFixed(1) + " MB";
  }, 1000);
  updateLeaveGuard();
}

function finishRecording() {
  clearInterval(rec.timer); clearInterval(rec.micTimer);
  const seconds = (Date.now() - rec.t0) / 1000;
  const micActivity = micActivityNow();
  rec.mic = [];
  rec.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  rec.ctx?.close();
  $("#recPreview").classList.add("hidden"); $("#recStatus").classList.add("hidden");
  $("#recStop").disabled = true; rec.recorder = null; $("#recStart").disabled = busy;
  updateLeaveGuard();
  const recordingId = rec.id;
  if (!rec.bytes) {
    toast("Không có dữ liệu ghi");
    if (recordingId) store.deleteRecording(recordingId).catch(() => {});
    rec.unsaved = false; updateLeaveGuard();
    return;
  }
  const file = new File(rec.parts, `${rec.name.replace(/[\\/:*?"<>|]+/g, "_")}.webm`, { type: "video/webm" });
  rec.parts = [];
  const mic = micActivity.length ? micActivity : null;
  const saved = recordingId
    ? rec.saving.then(() => rec.id === recordingId && store.updateRecording(recordingId, { finished: true, seconds, bytes: file.size, micActivity: mic })).catch(saveFailed)
    : Promise.resolve();
  // offer the raw recording too, so nothing is lost if processing fails
  const keep = $("#jobOutputs");
  startJob(file, { knownDuration: seconds, sourceName: rec.name, micActivity: mic, recordingId, saved }).then((ok) => {
    if (ok) { rec.unsaved = false; updateLeaveGuard(); }
    const b = document.createElement("button"); b.textContent = "⬇ File ghi hình (.webm)";
    b.onclick = () => { download(file, file.name); rec.unsaved = false; updateLeaveGuard(); };
    keep.appendChild(b);
  });
}

// ---------- recordings saved in this browser ----------
let savedRecs = [];
let jobRecId = null; // saved recording the running job is processing
async function renderSaved() {
  try { savedRecs = await store.listRecordings(); } catch { savedRecs = []; } // IndexedDB unavailable
  // hide the one still being recorded and the one being processed
  savedRecs = savedRecs.filter((r) => !(rec.recorder && r.id === rec.id) && r.id !== jobRecId);
  $("#savedRecs").classList.toggle("hidden", !savedRecs.length);
  $("#savedList").innerHTML = savedRecs.map((r) => `<li data-id="${esc(r.id)}">
    <div><b>${esc(r.name)}</b><span class="muted">${new Date(r.t0).toLocaleString("vi-VN")} · ${fmt(r.seconds)} · ${(r.bytes / 1e6).toFixed(1)} MB${
      r.broken ? " · lưu thiếu phần cuối" : r.finished ? "" : " · bị gián đoạn (giữ phần đã ghi)"}</span></div>
    <div class="row"><button class="primary" data-act="run">Tạo báo cáo</button><button data-act="dl">⬇ Tải về</button><button data-act="del">Xoá</button></div>
  </li>`).join("");
}
$("#savedList").onclick = async (e) => {
  const act = e.target.dataset?.act;
  const r = savedRecs.find((x) => x.id === e.target.closest("li")?.dataset.id);
  if (!act || !r) return;
  if (act === "del") {
    if (!confirm(`Xoá bản ghi "${r.name}" khỏi trình duyệt? Không khôi phục được.`)) return;
    await store.deleteRecording(r.id); renderSaved(); return;
  }
  if (act === "run" && busy) { toast("Đang xử lý một báo cáo khác"); return; }
  const file = await store.recordingFile(r);
  if (!file.size) { toast("Bản ghi trống"); return; }
  if (act === "dl") download(file, file.name);
  else startJob(file, { knownDuration: r.seconds, sourceName: r.name, micActivity: r.micActivity, recordingId: r.id });
};
$("#recStart").onclick = startRecording;
$("#recStop").onclick = () => rec.recorder?.state === "recording" && rec.recorder.stop();

renderSettings();
renderSaved();
if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
  $("#recStart").disabled = true;
  $("#recStart").title = "Trình duyệt này không hỗ trợ ghi màn hình";
}
