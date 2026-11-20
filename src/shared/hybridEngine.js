import { getAI, getGenerativeModel, GoogleAIBackend } from "@firebase/ai-logic";
import { firebaseApp } from "./firebaseConfig.js";

const env = import.meta.env ?? {};
const MODEL_NAME = env.VITE_FIREBASE_GEMINI_MODEL || "gemini-2.0-flash";
const TELEMETRY_KEY = "grassvaultInferenceTelemetry";
let firebaseModel;
let telemetryQueue = Promise.resolve();

function getChromeStorage() {
  try { return globalThis.chrome?.storage?.local ?? null; } catch { return null; }
}

async function readStrictLocal(options) {
  if (options.strictLocal === true) return true;
  const storage = getChromeStorage();
  if (!storage) return false;
  try {
    const values = await storage.get("strictLocal");
    return values?.strictLocal === true;
  } catch (error) {
    console.error("Could not read strict-local mode.", error);
    return true;
  }
}

function getFirebaseModel() {
  if (!firebaseApp) throw new Error("Firebase AI Logic is unavailable. Check the Firebase configuration.");
  if (!firebaseModel) {
    const ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });
    firebaseModel = getGenerativeModel(ai, { model: MODEL_NAME, inferenceMode: "PREFER_ON_DEVICE" });
  }
  return firebaseModel;
}

function getLocalLanguageModel() {
  try { return globalThis.window?.ai?.languageModel ?? null; } catch { return null; }
}

export async function checkLocalModelStatus() {
  const languageModel = getLocalLanguageModel();
  if (languageModel && typeof languageModel.availability === "function") {
    try {
      const status = await languageModel.availability();
      if (["readily", "after-download", "no"].includes(status)) {
        return {
          available: status !== "no",
          status,
          source: "window.ai",
          reason: status === "after-download"
            ? "The local model is available after its required download."
            : status === "no"
              ? "The browser reports that the local model is unavailable."
              : null
        };
      }
      return { available: false, status: "unknown", source: "window.ai", reason: "The browser returned an unknown local model status." };
    } catch (error) {
      return { available: false, status: "unknown", source: "window.ai", reason: error instanceof Error ? error.message : "Could not check the local model." };
    }
  }

  if (firebaseApp) {
    try {
      const model = getFirebaseModel();
      if (typeof model.isOnDeviceAvailable === "function") {
        const available = await model.isOnDeviceAvailable();
        return { available: available === true, status: available === true ? "readily" : "no", source: "firebase-ai-logic", reason: available === true ? null : "Firebase AI Logic reports no on-device model." };
      }
    } catch (error) {
      return { available: false, status: "unknown", source: "firebase-ai-logic", reason: error instanceof Error ? error.message : "Could not check Firebase on-device availability." };
    }
  }

  return { available: false, status: "no", source: "none", reason: "No supported on-device language model API is available." };
}

async function runLocalInference(prompt, options = {}) {
  const languageModel = getLocalLanguageModel();
  if (!languageModel || typeof languageModel.create !== "function") throw new Error("The browser on-device language model API is unavailable.");
  const sessionOptions = {};
  if (typeof options.onDownloadProgress === "function") {
    sessionOptions.monitor = (monitor) => {
      monitor.addEventListener("downloadprogress", (event) => {
        options.onDownloadProgress({ loaded: event.loaded, total: event.total, progress: Number.isFinite(event.loaded) && Number.isFinite(event.total) && event.total > 0 ? event.loaded / event.total : null });
      });
    };
  }
  let session;
  try {
    session = await languageModel.create(sessionOptions);
    const result = await session.prompt(prompt);
    if (typeof result !== "string") throw new Error("The local model returned an invalid response.");
    return result;
  } finally {
    try { session?.destroy?.(); } catch (error) { console.warn("Could not release the local model session.", error); }
  }
}

async function runCloudInference(prompt) {
  const model = getFirebaseModel();
  const response = await model.generateContent(prompt);
  const result = response?.response ?? response;
  const text = typeof result?.text === "function" ? result.text() : typeof result?.text === "string" ? result.text : null;
  if (typeof text !== "string") throw new Error("Firebase AI Logic returned an invalid response.");
  return text;
}

async function recordTelemetry({ mode, latencyMs }) {
  const storage = getChromeStorage();
  if (!storage) return;
  telemetryQueue = telemetryQueue.catch(() => undefined).then(async () => {
    const stored = await storage.get(TELEMETRY_KEY);
    const previous = stored?.[TELEMETRY_KEY] ?? {};
    const totalRequests = Number.isFinite(previous.totalRequests) ? previous.totalRequests : 0;
    const localCount = Number.isFinite(previous.localCount) ? previous.localCount : 0;
    const cloudCount = Number.isFinite(previous.cloudCount) ? previous.cloudCount : 0;
    const previousAverage = Number.isFinite(previous.averageLatencyMs) ? previous.averageLatencyMs : 0;
    const nextTotal = totalRequests + 1;
    await storage.set({ [TELEMETRY_KEY]: {
      totalRequests: nextTotal,
      localCount: localCount + (mode === "local" ? 1 : 0),
      cloudCount: cloudCount + (mode === "cloud" ? 1 : 0),
      averageLatencyMs: (previousAverage * totalRequests + latencyMs) / nextTotal,
      lastLatencyMs: latencyMs,
      lastMode: mode,
      lastRequestAt: new Date().toISOString()
    } });
  }).catch((error) => console.warn("Could not save inference telemetry.", error));
  await telemetryQueue;
}

function makeLocalOnlyError(reason, details, latencyMs) {
  return { ok: false, error: { code: "LOCAL_ONLY_UNAVAILABLE", message: reason, details }, mode: "local", latencyMs, timestamp: new Date().toISOString() };
}

export async function runHybridInference(prompt, options = {}) {
  const startedAt = performance.now();
  const finish = async (result, mode = "error") => {
    const latencyMs = Math.max(0, performance.now() - startedAt);
    result.latencyMs = latencyMs;
    await recordTelemetry({ mode, latencyMs });
    return result;
  };

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return finish({ ok: false, error: { code: "INVALID_PROMPT", message: "Prompt must be a non-empty string." }, mode: "error", timestamp: new Date().toISOString() });
  }

  const strictLocal = await readStrictLocal(options);
  const mustUseCloud = options.forceCloud === true || prompt.length >= 4000;
  if (strictLocal && mustUseCloud) {
    const reason = options.forceCloud === true
      ? "Cloud inference was requested, but strict-local mode is enabled."
      : "The prompt is 4,000 characters or longer, and strict-local mode is enabled.";
    return finish(makeLocalOnlyError(reason, { strictLocal: true, forceCloud: options.forceCloud === true }, 0));
  }

  if (!mustUseCloud) {
    const localStatus = await checkLocalModelStatus();
    if (localStatus.available) {
      try {
        const text = await runLocalInference(prompt, options);
        return finish({ ok: true, text, mode: "local", timestamp: new Date().toISOString() }, "local");
      } catch (error) {
        if (strictLocal) {
          return finish(makeLocalOnlyError("Local inference failed while strict-local mode is enabled.", { localError: error instanceof Error ? error.message : "Unknown local error" }, 0));
        }
        console.warn("Local inference failed; trying cloud inference.", error);
      }
    } else if (strictLocal) {
      return finish(makeLocalOnlyError("The local model is unavailable while strict-local mode is enabled.", localStatus, 0));
    }
  }

  if (strictLocal) return finish(makeLocalOnlyError("Cloud inference is disabled while strict-local mode is enabled.", { strictLocal: true }, 0));

  try {
    const text = await runCloudInference(prompt);
    return finish({ ok: true, text, mode: "cloud", timestamp: new Date().toISOString() }, "cloud");
  } catch (error) {
    return finish({ ok: false, error: { code: "CLOUD_INFERENCE_FAILED", message: error instanceof Error ? error.message : "Cloud inference failed.", offline: typeof navigator !== "undefined" && navigator.onLine === false }, mode: "cloud", timestamp: new Date().toISOString() });
  }
}
