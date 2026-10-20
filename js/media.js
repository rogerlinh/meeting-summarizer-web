// Media helpers that run in the browser: duration, frame capture, MIME types.

const EXT_MIME = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/webm",
  avi: "video/avi", wmv: "video/wmv", mpg: "video/mpeg", mpeg: "video/mpeg", "3gp": "video/3gpp", flv: "video/x-flv",
  mp3: "audio/mp3", m4a: "audio/aac", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
  opus: "audio/ogg", weba: "audio/webm",
};

/** MIME type Gemini accepts. MKV is Matroska like WebM, so it is sent as video/webm. */
export function geminiMime(file) {
  const ext = (file.name || "").split(".").pop().toLowerCase();
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  const t = (file.type || "").split(";")[0];
  if (t === "video/x-matroska") return "video/webm";
  return t || "video/mp4";
}

const once = (el, ev) => new Promise((resolve, reject) => {
  const ok = () => { cleanup(); resolve(); };
  const bad = () => { cleanup(); reject(new Error("Trình duyệt không đọc được file này")); };
  const cleanup = () => { el.removeEventListener(ev, ok); el.removeEventListener("error", bad); };
  el.addEventListener(ev, ok);
  el.addEventListener("error", bad);
});

/** Open a file in a hidden <video> element. Returns {el, duration, hasVideo, close()}. */
export async function openMedia(file, knownDuration = 0) {
  const url = URL.createObjectURL(file);
  const el = document.createElement("video");
  el.muted = true;
  el.preload = "auto";
  el.playsInline = true;
  el.src = url;
  await once(el, "loadedmetadata");
  let duration = el.duration;
  if (!Number.isFinite(duration)) {
    // MediaRecorder WebM has no duration header: seeking far ahead makes the browser compute it
    duration = knownDuration;
    try {
      el.currentTime = 1e9;
      await Promise.race([once(el, "seeked"), new Promise((r) => setTimeout(r, 8000))]);
      if (Number.isFinite(el.duration)) duration = el.duration;
      el.currentTime = 0;
    } catch { /* keep knownDuration */ }
  }
  return {
    el, duration: duration || knownDuration, hasVideo: el.videoWidth > 0,
    close: () => { el.removeAttribute("src"); el.load(); URL.revokeObjectURL(url); },
  };
}

const toBlob = (canvas, q) => new Promise((r) => canvas.toBlob(r, "image/jpeg", q));

/** Seek to t and capture a full-size JPEG (max 1280px wide) plus a 480px thumbnail for Gemini. */
export async function captureFrame(media, t) {
  const { el } = media;
  el.currentTime = Math.max(0, Math.min(t, media.duration - 0.5));
  await Promise.race([once(el, "seeked"), new Promise((r) => setTimeout(r, 10000))]);
  const scale = Math.min(1, 1280 / el.videoWidth);
  const full = document.createElement("canvas");
  full.width = Math.round(el.videoWidth * scale);
  full.height = Math.round(el.videoHeight * scale);
  full.getContext("2d").drawImage(el, 0, 0, full.width, full.height);
  const thumb = document.createElement("canvas");
  thumb.width = 480;
  thumb.height = Math.round((480 * full.height) / full.width);
  thumb.getContext("2d").drawImage(full, 0, 0, thumb.width, thumb.height);
  return {
    t, width: full.width, height: full.height,
    full: await toBlob(full, 0.85), thumb: await toBlob(thumb, 0.6),
  };
}

/** Evenly spaced candidate times: about one every 45 s, between 40 and 90 frames. */
export function candidateTimes(duration) {
  const n = Math.min(90, Math.max(Math.min(40, Math.floor(duration / 20)), Math.floor(duration / 45)));
  const step = duration / Math.max(1, n);
  return Array.from({ length: n }, (_, i) => +(step / 2 + i * step).toFixed(1));
}

export function fmtTs(sec) {
  sec = Math.max(0, Math.floor(sec));
  const p = (x) => String(x).padStart(2, "0");
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
}

export function parseTs(s) {
  const parts = String(s || "").match(/\d+(?:\.\d+)?/g)?.slice(-3).map(Number) || [];
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}
