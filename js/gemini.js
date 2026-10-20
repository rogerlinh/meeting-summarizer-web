// Gemini REST client for the browser: key rotation, model fallback, Files API uploads.
// Keys never leave the browser except in requests to generativelanguage.googleapis.com.

const BASE = "https://generativelanguage.googleapis.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (k) => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : "****");

export class GeminiError extends Error {}

class HttpError extends Error {
  constructor(status, err) {
    super(`${status} ${err.status || ""}: ${err.message || ""}`);
    this.status = status;
    this.err = err;
  }
}

async function httpError(r) {
  let err = {};
  try { err = (await r.json()).error || {}; } catch { err = { message: r.statusText }; }
  return new HttpError(r.status, err);
}

function retryDelay(err) {
  for (const d of err.details || []) {
    if ((d["@type"] || "").endsWith("RetryInfo")) {
      const m = /([\d.]+)s/.exec(d.retryDelay || "");
      if (m) return parseFloat(m[1]);
    }
  }
  return 30;
}

/** Pool of API keys. Picks the least recently used key that is not cooling down for the model. */
export class KeyPool {
  constructor(keys) {
    this.states = keys.map((key) => ({
      key, label: mask(key), disabled: false, lastUsed: 0, cooldown: {},
      ok: 0, rateLimited: 0, errors: 0, lastError: "", files: new Map(),
    }));
  }

  async acquire(model, prefer = () => 0, maxWait = 120_000) {
    const deadline = Date.now() + maxWait;
    for (;;) {
      const now = Date.now();
      const live = this.states.filter((s) => !s.disabled);
      if (!live.length) throw new GeminiError("Không còn API key hợp lệ nào. Kiểm tra lại key trong Cài đặt.");
      const ready = live.filter((s) => (s.cooldown[model] || 0) <= now);
      if (ready.length) {
        ready.sort((a, b) => prefer(b) - prefer(a) || a.lastUsed - b.lastUsed);
        ready[0].lastUsed = now;
        return ready[0];
      }
      const next = Math.min(...live.map((s) => s.cooldown[model] || 0));
      if (next > deadline) {
        throw new GeminiError(`Tất cả key đều đang bị giới hạn cho ${model} (mở lại sau ${Math.round((next - now) / 1000)}s).`);
      }
      await sleep(Math.max(500, next - now));
    }
  }

  /** Decide what to do after an HTTP error on a key. Returns true when the call should be retried. */
  handle(st, model, e, log) {
    if (!(e instanceof HttpError)) {
      st.errors++; st.lastError = String(e);
      st.cooldown[model] = Date.now() + 5000;
      return true;
    }
    const blob = JSON.stringify(e.err);
    st.lastError = e.message.slice(0, 200);
    if (e.status === 429) {
      st.rateLimited++;
      const perDay = blob.includes("PerDay");
      st.cooldown[model] = Date.now() + (perDay ? 3600 : Math.max(retryDelay(e.err), 5)) * 1000;
      log?.(`Key ${st.label} bị giới hạn (${model}), chuyển key khác`);
      return true;
    }
    if (blob.includes("API_KEY_INVALID") || e.status === 401 || e.status === 403) {
      st.disabled = true;
      log?.(`Key ${st.label} bị từ chối, đã vô hiệu hoá (${(e.err.message || "").slice(0, 120)})`);
      return true;
    }
    if (e.status >= 500) {
      st.errors++;
      st.cooldown[model] = Date.now() + 10_000;
      return true;
    }
    return false;
  }

  status() {
    const now = Date.now();
    return this.states.map((s) => {
      const cd = Math.max(0, ...Object.values(s.cooldown));
      return {
        key: s.label, state: s.disabled ? "disabled" : cd > now ? "cooldown" : "ready",
        cooldown: Math.max(0, Math.round((cd - now) / 1000)),
        ok: s.ok, rateLimited: s.rateLimited, errors: s.errors, lastError: s.lastError,
      };
    });
  }

  async deleteFiles() {
    for (const s of this.states) {
      for (const p of s.files.values()) {
        try {
          const f = await p;
          await fetch(`${BASE}/v1beta/${f.name}`, { method: "DELETE", headers: { "x-goog-api-key": s.key } });
        } catch { /* upload failed or already gone */ }
      }
      s.files.clear();
    }
  }
}

/** Upload a file with one key (Files API, resumable) and wait until Gemini has processed it. */
function uploadWithKey(key, file, mime, onProgress) {
  return (async () => {
    const start = await fetch(`${BASE}/upload/v1beta/files`, {
      method: "POST",
      headers: {
        "x-goog-api-key": key,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(file.size),
        "X-Goog-Upload-Header-Content-Type": mime,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: (file.name || "recording").slice(0, 100) } }),
    });
    if (!start.ok) throw await httpError(start);
    const url = start.headers.get("X-Goog-Upload-URL");
    if (!url) throw new GeminiError("Không nhận được địa chỉ tải lên từ Google");

    let info = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.setRequestHeader("X-Goog-Upload-Command", "upload, finalize");
      xhr.setRequestHeader("X-Goog-Upload-Offset", "0");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status === 200) resolve(JSON.parse(xhr.responseText).file);
        else reject(new HttpError(xhr.status, { message: xhr.responseText.slice(0, 300) }));
      };
      xhr.onerror = () => reject(new GeminiError("Lỗi mạng khi tải file lên Google"));
      xhr.send(file);
    });

    while (info.state === "PROCESSING") {
      await sleep(4000);
      const r = await fetch(`${BASE}/v1beta/${info.name}`, { headers: { "x-goog-api-key": key } });
      if (!r.ok) throw await httpError(r);
      info = await r.json();
    }
    if (info.state === "FAILED") throw new GeminiError("Google không xử lý được file này (định dạng không hỗ trợ?)");
    return info;
  })();
}

/** The uploaded file for this key (files belong to the key's project, so each key needs its own copy). */
export function fileFor(st, file, mime, onProgress, log) {
  if (!st.files.has(file)) {
    log?.(`Đang tải file lên Google bằng key ${st.label}…`);
    const p = uploadWithKey(st.key, file, mime, onProgress);
    p.catch(() => st.files.delete(file));
    st.files.set(file, p);
  }
  return st.files.get(file);
}

/** POST generateContent. buildBody(st) can be async (e.g. waits for the key's upload). */
async function call(pool, model, buildBody, log, prefer) {
  let last = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const st = await pool.acquire(model, prefer);
    try {
      const body = await buildBody(st);
      const r = await fetch(`${BASE}/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": st.key },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw await httpError(r);
      st.ok++;
      return await r.json();
    } catch (e) {
      last = e.message;
      if (e instanceof HttpError && e.status === 404) throw e; // model does not exist
      if (e instanceof GeminiError) throw e;
      if (!pool.handle(st, model, e, log)) throw e;
      if (!(e instanceof HttpError) || e.status >= 500) await sleep(Math.min(2 ** attempt * 1000, 20_000));
    }
  }
  throw new GeminiError(`Thất bại sau nhiều lần thử: ${last}`);
}

/**
 * Generate text, trying each model in order. `parts` is an array or `async (keyState) => array`.
 * Returns parsed JSON when a schema is given.
 */
export async function generate(pool, models, parts, { system, schema, temperature = 0.3, lowMedia, prefer, log } = {}) {
  const errors = [];
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await call(pool, model, async (st) => {
          const body = {
            contents: [{ role: "user", parts: typeof parts === "function" ? await parts(st) : parts }],
            generationConfig: { temperature },
          };
          if (system) body.systemInstruction = { parts: [{ text: system }] };
          if (schema) Object.assign(body.generationConfig, { responseMimeType: "application/json", responseSchema: schema });
          if (lowMedia) body.generationConfig.mediaResolution = "MEDIA_RESOLUTION_LOW";
          return body;
        }, log, prefer);
        const cand = (data.candidates || [{}])[0];
        const text = (cand.content?.parts || []).map((p) => p.text || "").join("");
        if (text) {
          if (!schema) return text;
          return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
        }
        const block = data.promptFeedback?.blockReason;
        const reason = block ? `blockReason=${block}` : `finishReason=${cand.finishReason}`;
        errors.push(`${model}: phản hồi rỗng (${reason})`);
        log?.(`Model ${model} trả về rỗng (${reason}), thử lại ${attempt + 1}/3`);
        if (block) break;
      } catch (e) {
        errors.push(`${model}: ${e.message}`);
        log?.(`Model ${model} lỗi: ${e.message}`);
        if (e instanceof SyntaxError) continue; // malformed JSON: try again
        break;
      }
    }
  }
  throw new GeminiError(errors.join(" | "));
}

/** Validate keys with a free models.list call. */
export async function testKey(key) {
  try {
    const r = await fetch(`${BASE}/v1beta/models?pageSize=1`, { headers: { "x-goog-api-key": key } });
    if (r.ok) return { ok: true, message: "OK" };
    return { ok: false, message: (await httpError(r)).message };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

export const blobToBase64 = (blob) => new Promise((resolve) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result.split(",")[1]);
  fr.readAsDataURL(blob);
});
