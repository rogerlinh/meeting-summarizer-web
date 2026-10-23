// Meeting recordings saved in IndexedDB while recording, so a reload, a crash or a failed job loses nothing.
// A recording is deleted once its report has been produced, or when the user deletes it.

const DB = "meeting-summarizer";
let dbp = null;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("recordings", { keyPath: "id" });
      d.createObjectStore("parts", { autoIncrement: true }).createIndex("rec", "rec");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbp.catch(() => (dbp = null));
  return dbp;
}

async function tx(stores, mode, fn) {
  const t = (await db()).transaction(stores, mode);
  const out = fn(t);
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = t.onabort = () => reject(t.error || new Error("IndexedDB transaction failed"));
  });
  return out instanceof IDBRequest ? out.result : out;
}

/** meta: {name, t0, mime}. Returns the new recording id. */
export async function createRecording(meta) {
  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict our data
  const id = `${meta.t0}-${Math.random().toString(36).slice(2, 8)}`;
  await tx(["recordings"], "readwrite", (t) =>
    t.objectStore("recordings").put({ ...meta, id, seconds: 0, bytes: 0, finished: false, micActivity: null }));
  return id;
}

/** Append one MediaRecorder chunk and update the running totals in the same transaction. */
export async function appendPart(id, blob, update) {
  await tx(["recordings", "parts"], "readwrite", (t) => {
    t.objectStore("parts").add({ rec: id, blob });
    const recs = t.objectStore("recordings");
    const get = recs.get(id);
    get.onsuccess = () => get.result && recs.put({ ...get.result, ...update });
  });
}

export async function updateRecording(id, update) {
  await tx(["recordings"], "readwrite", (t) => {
    const recs = t.objectStore("recordings");
    const get = recs.get(id);
    get.onsuccess = () => get.result && recs.put({ ...get.result, ...update });
  });
}

/** Saved recordings, newest first. */
export async function listRecordings() {
  const all = await tx(["recordings"], "readonly", (t) => t.objectStore("recordings").getAll());
  return all.sort((a, b) => b.t0 - a.t0);
}

/** Rebuild the .webm from its chunks (chunks of one MediaRecorder concatenate into a valid file). */
export async function recordingFile(rec) {
  const parts = await tx(["parts"], "readonly", (t) => t.objectStore("parts").index("rec").getAll(rec.id));
  return new File(parts.map((p) => p.blob), `${rec.name.replace(/[\\/:*?"<>|]+/g, "_")}.webm`, { type: "video/webm" });
}

export async function deleteRecording(id) {
  await tx(["recordings", "parts"], "readwrite", (t) => {
    t.objectStore("recordings").delete(id);
    const cur = t.objectStore("parts").index("rec").openKeyCursor(IDBKeyRange.only(id));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { t.objectStore("parts").delete(c.primaryKey); c.continue(); }
    };
  });
}
