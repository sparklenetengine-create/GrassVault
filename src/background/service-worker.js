import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { firebaseAuth, firestore, signInFirebaseUser } from "../shared/firebaseConfig.js";
import { runHybridInference } from "../shared/hybridEngine.js";

const VAULT_KEY = "grassvaultEntries";
const STRICT_LOCAL_KEY = "strictLocal";
const MAX_LOCAL_ENTRIES = 500;
const MAX_SNIPPET_LENGTH = 20_000;
const MAX_SYNC_LENGTH = 10_000;
let storageQueue = Promise.resolve();

function getLocalStorage() {
  try { return globalThis.chrome?.storage?.local ?? null; } catch { return null; }
}

function createId() {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

function truncate(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function sanitizeUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 2_000);
  } catch { return ""; }
}

function sanitizeTitle(value) {
  return truncate(typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "", 300);
}

function redactSecrets(value) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED API KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|access[_-]?token|client[_-]?secret|password)\b(\s*[:=]\s*)["']?[^"' \r\n,;]+["']?/gi, "$1$2[REDACTED]");
}

function makeEntry(payload, sender) {
  const snippet = typeof payload?.snippet === "string" ? payload.snippet : typeof payload?.text === "string" ? payload.text : "";
  return {
    id: createId(),
    snippet: truncate(snippet, MAX_SNIPPET_LENGTH),
    metadata: {
      title: sanitizeTitle(payload?.metadata?.title || sender?.tab?.title),
      url: sanitizeUrl(payload?.metadata?.url) || sanitizeUrl(sender?.tab?.url),
      source: payload?.metadata?.source === "code" ? "code" : "selection",
      createdAt: new Date().toISOString()
    },
    executionMode: "unknown",
    syncStatus: "pending"
  };
}

async function persistEntry(entry) {
  const storage = getLocalStorage();
  if (!storage) throw new Error("Chrome local storage is unavailable.");
  storageQueue = storageQueue.catch(() => undefined).then(async () => {
    const current = await storage.get(VAULT_KEY);
    const entries = Array.isArray(current?.[VAULT_KEY]) ? current[VAULT_KEY] : [];
    await storage.set({ [VAULT_KEY]: [entry, ...entries].slice(0, MAX_LOCAL_ENTRIES) });
  });
  await storageQueue;
}

async function updateEntry(entryId, patch) {
  const storage = getLocalStorage();
  if (!storage) return;
  storageQueue = storageQueue.catch(() => undefined).then(async () => {
    const current = await storage.get(VAULT_KEY);
    const entries = Array.isArray(current?.[VAULT_KEY]) ? current[VAULT_KEY] : [];
    await storage.set({ [VAULT_KEY]: entries.map((entry) => entry?.id === entryId ? { ...entry, ...patch } : entry) });
  });
  await storageQueue;
}

async function isStrictLocalEnabled() {
  const storage = getLocalStorage();
  if (!storage) return false;
  try {
    const value = await storage.get(STRICT_LOCAL_KEY);
    return value?.[STRICT_LOCAL_KEY] === true;
  } catch (error) {
    console.error("Could not read the strict-local setting.", error);
    return true;
  }
}

async function syncSanitizedEntry(entry) {
  if (!firestore || !firebaseAuth) {
    await updateEntry(entry.id, { syncStatus: "local-only" });
    return { synced: false, reason: "Firebase is not configured." };
  }
  if (await isStrictLocalEnabled()) {
    await updateEntry(entry.id, { syncStatus: "local-only" });
    return { synced: false, reason: "Strict-local mode is enabled." };
  }
  try {
    const credential = firebaseAuth.currentUser ? { user: firebaseAuth.currentUser } : await signInFirebaseUser();
    const user = credential?.user;
    if (!user?.uid) throw new Error("Firebase authentication did not return a user.");
    const cloudEntry = {
      snippet: redactSecrets(truncate(entry.snippet, MAX_SYNC_LENGTH)),
      metadata: { ...entry.metadata, executionMode: entry.executionMode },
      executionMode: entry.executionMode,
      createdAt: serverTimestamp(),
      schemaVersion: 1
    };
    await addDoc(collection(firestore, "users", user.uid, "vault"), cloudEntry);
    await updateEntry(entry.id, { syncStatus: "synced" });
    return { synced: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Firestore sync failed.";
    console.warn("GrassVault could not sync this entry.", error);
    await updateEntry(entry.id, { syncStatus: "pending", syncError: truncate(message, 500) });
    return { synced: false, reason: message };
  }
}

async function handleAnalyzeAndVault(message, sender) {
  const entry = makeEntry(message?.payload ?? message, sender);
  if (!entry.snippet.trim()) {
    return { ok: false, error: { code: "EMPTY_SNIPPET", message: "There is no selected text or code to vault." } };
  }
  await persistEntry(entry);
  let inference;
  try {
    inference = await runHybridInference(entry.snippet, message?.options && typeof message.options === "object" ? message.options : {});
  } catch (error) {
    inference = { ok: false, error: { code: "INFERENCE_FAILED", message: error instanceof Error ? error.message : "Inference failed." }, mode: "error", timestamp: new Date().toISOString() };
  }
  entry.executionMode = inference?.mode === "local" || inference?.mode === "cloud" ? inference.mode : "unknown";
  await updateEntry(entry.id, { executionMode: entry.executionMode });
  const sync = await syncSanitizedEntry(entry);
  return {
    ok: true,
    entry: { id: entry.id, metadata: entry.metadata, executionMode: entry.executionMode, syncStatus: sync.synced ? "synced" : sync.reason === "Strict-local mode is enabled." ? "local-only" : "pending" },
    inference,
    sync
  };
}

async function handleGetTelemetry() {
  const storage = getLocalStorage();
  if (!storage) return { ok: false, error: { code: "STORAGE_UNAVAILABLE", message: "Chrome local storage is unavailable." } };
  try {
    const values = await storage.get(["grassvaultInferenceTelemetry", STRICT_LOCAL_KEY, VAULT_KEY]);
    const entries = Array.isArray(values?.[VAULT_KEY]) ? values[VAULT_KEY] : [];
    return {
      ok: true,
      telemetry: values?.grassvaultInferenceTelemetry ?? { totalRequests: 0, localCount: 0, cloudCount: 0, averageLatencyMs: 0 },
      strictLocal: values?.[STRICT_LOCAL_KEY] === true,
      vault: { count: entries.length, pendingSyncCount: entries.filter((entry) => entry?.syncStatus === "pending").length }
    };
  } catch (error) {
    return { ok: false, error: { code: "TELEMETRY_READ_FAILED", message: error instanceof Error ? error.message : "Could not read local telemetry." } };
  }
}

async function handleToggleStrictLocal(message) {
  const storage = getLocalStorage();
  if (!storage) return { ok: false, error: { code: "STORAGE_UNAVAILABLE", message: "Chrome local storage is unavailable." } };
  try {
    const current = await storage.get(STRICT_LOCAL_KEY);
    const enabled = typeof message?.enabled === "boolean" ? message.enabled : current?.[STRICT_LOCAL_KEY] !== true;
    await storage.set({ [STRICT_LOCAL_KEY]: enabled });
    return { ok: true, strictLocal: enabled };
  } catch (error) {
    return { ok: false, error: { code: "SETTING_UPDATE_FAILED", message: error instanceof Error ? error.message : "Could not update strict-local mode." } };
  }
}

async function dispatchMessage(message, sender) {
  switch (message?.type) {
    case "ANALYZE_AND_VAULT": return handleAnalyzeAndVault(message, sender);
    case "GET_TELEMETRY": return handleGetTelemetry();
    case "TOGGLE_STRICT_LOCAL": return handleToggleStrictLocal(message);
    default: return { ok: false, error: { code: "UNKNOWN_MESSAGE", message: "GrassVault does not recognize this message type." } };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  dispatchMessage(message, sender).then(sendResponse).catch((error) => {
    console.error("GrassVault message handling failed.", error);
    sendResponse({ ok: false, error: { code: "RUNTIME_ERROR", message: error instanceof Error ? error.message : "An unexpected extension error occurred." } });
  });
  return true;
});
