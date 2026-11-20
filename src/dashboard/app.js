import "../popup/popup.css";
import { collection, deleteDoc, doc, onSnapshot } from "firebase/firestore";
import { firebaseAuth, firestore, signInFirebaseUser } from "../shared/firebaseConfig.js";

const VAULT_KEY = "grassvaultEntries";
const elements = { syncStatus: document.querySelector("#sync-status"), refreshButton: document.querySelector("#refresh-button"), totalCount: document.querySelector("#total-count"), localCount: document.querySelector("#local-count"), cloudCount: document.querySelector("#cloud-count"), search: document.querySelector("#search-input"), filter: document.querySelector("#filter-select"), error: document.querySelector("#page-error"), empty: document.querySelector("#empty-state"), list: document.querySelector("#vault-list") };
let localEntries = [], cloudEntries = [], unsubscribeCloud = null, currentUser = null;

function setError(message = "") { elements.error.textContent = message; elements.error.classList.toggle("hidden", !message); }
function setSyncStatus(text, tone = "neutral") {
  elements.syncStatus.textContent = text;
  const classes = tone === "success" ? "border-cyan-400/20 bg-cyan-400/10 text-cyan-300" : tone === "error" ? "border-orange-400/20 bg-orange-400/10 text-orange-300" : "border-zinc-700 text-zinc-400";
  elements.syncStatus.className = `rounded-full border px-3 py-1.5 text-xs ${classes}`;
}
function getLocalStorage() { try { return globalThis.chrome?.storage?.local ?? null; } catch { return null; } }
function text(value) { return typeof value === "string" ? value : ""; }
function normalizeLocalEntry(entry, index) {
  const metadata = entry?.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
  return { id: text(entry?.id) || `local-${index}`, snippet: text(entry?.snippet), title: text(metadata.title), url: text(metadata.url), source: text(metadata.source) || "selection", createdAt: text(metadata.createdAt), origin: "local", executionMode: entry?.executionMode === "local" || entry?.executionMode === "cloud" ? entry.executionMode : "unknown", syncStatus: text(entry?.syncStatus) || "local-only", firestoreId: null };
}
function normalizeCloudEntry(snapshot) {
  const data = snapshot.data() ?? {}; const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  let createdAt = text(metadata.createdAt); if (!createdAt && data.createdAt?.toDate) { try { createdAt = data.createdAt.toDate().toISOString(); } catch { createdAt = ""; } }
  const mode = data.executionMode || metadata.executionMode;
  return { id: snapshot.id, snippet: text(data.snippet), title: text(metadata.title), url: text(metadata.url), source: text(metadata.source) || "selection", createdAt, origin: "cloud", executionMode: mode === "local" || mode === "cloud" ? mode : "unknown", syncStatus: "synced", firestoreId: snapshot.id };
}
function allEntries() { return [...localEntries, ...cloudEntries]; }
function matchesFilter(entry, filter) { return filter === "all" || entry.executionMode === filter; }
function matchesSearch(entry, query) { return !query || [entry.snippet, entry.title, entry.url, entry.source, entry.syncStatus, entry.executionMode].join(" ").toLowerCase().includes(query); }
function makeTag(label, classes) { const tag = document.createElement("span"); tag.className = `rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${classes}`; tag.textContent = label; return tag; }
function formatDate(value) { if (!value) return "Date unavailable"; const date = new Date(value); if (Number.isNaN(date.getTime())) return "Date unavailable"; return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }
function makeCard(entry) {
  const article = document.createElement("article"); article.className = "glass-card overflow-hidden rounded-2xl"; article.dataset.entryId = entry.id; article.dataset.origin = entry.origin; if (entry.firestoreId) article.dataset.firestoreId = entry.firestoreId;
  const header = document.createElement("div"); header.className = "flex items-start justify-between gap-4 border-b border-white/5 px-5 py-4";
  const group = document.createElement("div"); group.className = "min-w-0";
  const title = document.createElement("h2"); title.className = "truncate text-sm font-semibold text-zinc-100"; title.textContent = entry.title || "Saved snippet";
  const details = document.createElement("p"); details.className = "mt-1 truncate text-xs text-zinc-500"; details.textContent = [entry.source, entry.url, formatDate(entry.createdAt)].filter(Boolean).join(" · ");
  group.append(title, details); const tags = document.createElement("div"); tags.className = "flex shrink-0 flex-wrap justify-end gap-2";
  if (entry.executionMode === "local") tags.append(makeTag("⚡ LOCAL", "border-cyan-400/25 bg-cyan-400/10 text-cyan-300")); else if (entry.executionMode === "cloud") tags.append(makeTag("☁ CLOUD", "border-orange-400/25 bg-orange-400/10 text-orange-300")); else tags.append(makeTag("NOT ANALYZED", "border-zinc-700 bg-zinc-800/70 text-zinc-400"));
  tags.append(makeTag(entry.origin === "local" ? "ON DEVICE" : "SYNCED", "border-zinc-700 bg-zinc-800/70 text-zinc-400")); if (entry.syncStatus === "pending") tags.append(makeTag("PENDING SYNC", "border-zinc-700 bg-zinc-800/70 text-zinc-400")); header.append(group, tags);
  const snippet = document.createElement("pre"); snippet.className = "max-h-72 overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-xs leading-6 text-zinc-300"; snippet.textContent = entry.snippet;
  const actions = document.createElement("div"); actions.className = "flex justify-end gap-2 border-t border-white/5 px-5 py-3";
  const copy = document.createElement("button"); copy.type = "button"; copy.dataset.action = "copy"; copy.className = "rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:border-cyan-400/30 hover:text-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"; copy.textContent = "Copy";
  const remove = document.createElement("button"); remove.type = "button"; remove.dataset.action = "delete"; remove.className = "rounded-lg border border-red-400/15 bg-red-400/5 px-3 py-2 text-xs font-medium text-red-300 transition hover:border-red-400/40 hover:bg-red-400/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"; remove.textContent = "Delete";
  actions.append(copy, remove); article.append(header, snippet, actions); return article;
}
function render() {
  const entries = allEntries(); const query = elements.search.value.trim().toLowerCase(); const filtered = entries.filter((entry) => matchesFilter(entry, elements.filter.value) && matchesSearch(entry, query));
  elements.totalCount.textContent = String(entries.length); elements.localCount.textContent = String(entries.filter((entry) => entry.executionMode === "local").length); elements.cloudCount.textContent = String(entries.filter((entry) => entry.executionMode === "cloud").length);
  elements.list.replaceChildren(...filtered.map(makeCard)); elements.empty.classList.toggle("hidden", filtered.length !== 0);
}
async function loadLocalEntries() { const storage = getLocalStorage(); if (!storage) throw new Error("Chrome local storage is unavailable in this page."); const stored = await storage.get(VAULT_KEY); const values = Array.isArray(stored?.[VAULT_KEY]) ? stored[VAULT_KEY] : []; localEntries = values.map(normalizeLocalEntry); render(); }
async function startCloudListener() {
  if (!firestore || !firebaseAuth) { setSyncStatus("Cloud sync unavailable", "error"); return; }
  try {
    const credential = firebaseAuth.currentUser ? { user: firebaseAuth.currentUser } : await signInFirebaseUser(); currentUser = credential?.user ?? firebaseAuth.currentUser; if (!currentUser?.uid) throw new Error("Firebase authentication did not return a user.");
    unsubscribeCloud?.(); unsubscribeCloud = onSnapshot(collection(firestore, "users", currentUser.uid, "vault"), (snapshot) => { cloudEntries = snapshot.docs.map(normalizeCloudEntry); setSyncStatus("Cloud synced", "success"); render(); }, (error) => { console.error("GrassVault cloud snapshot failed.", error); setSyncStatus("Cloud sync error", "error"); setError(error instanceof Error ? error.message : "Could not load synced vault entries."); });
  } catch (error) { console.error("GrassVault cloud connection failed.", error); setSyncStatus("Local only", "error"); setError(error instanceof Error ? error.message : "Could not connect to the cloud vault."); }
}
async function deleteLocalEntry(id) { const storage = getLocalStorage(); if (!storage) throw new Error("Chrome local storage is unavailable."); const stored = await storage.get(VAULT_KEY); const entries = Array.isArray(stored?.[VAULT_KEY]) ? stored[VAULT_KEY] : []; const updated = entries.filter((entry) => entry?.id !== id); await storage.set({ [VAULT_KEY]: updated }); localEntries = updated.map(normalizeLocalEntry); }
async function deleteCloudEntry(entry) { if (!firestore || !currentUser?.uid || !entry.firestoreId) throw new Error("Cloud vault is not connected."); await deleteDoc(doc(firestore, "users", currentUser.uid, "vault", entry.firestoreId)); }

elements.search.addEventListener("input", render); elements.filter.addEventListener("change", render);
elements.refreshButton.addEventListener("click", async () => { elements.refreshButton.disabled = true; setError(""); try { await loadLocalEntries(); setSyncStatus("Refreshing…"); await startCloudListener(); } catch (error) { setError(error instanceof Error ? error.message : "Could not refresh the vault."); } finally { elements.refreshButton.disabled = false; } });
elements.list.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const card = button.closest("[data-entry-id]"); const entry = allEntries().find((item) => item.id === card?.dataset.entryId && item.origin === card?.dataset.origin); if (!entry) { setError("This vault item is no longer available."); return; }
  setError(""); button.disabled = true;
  try {
    if (button.dataset.action === "copy") { await navigator.clipboard.writeText(entry.snippet); setSyncStatus("Copied to clipboard", "success"); window.setTimeout(() => setSyncStatus("Ready"), 1800); }
    else if (button.dataset.action === "delete") { if (entry.origin === "cloud") await deleteCloudEntry(entry); else await deleteLocalEntry(entry.id); render(); setSyncStatus("Item deleted", "success"); }
  } catch (error) { console.error("Vault item action failed.", error); setError(error instanceof Error ? error.message : "Could not complete the action."); } finally { button.disabled = false; }
});
getLocalStorage()?.onChanged?.addListener((changes, area) => { if (area === "local" && changes[VAULT_KEY]) { localEntries = Array.isArray(changes[VAULT_KEY].newValue) ? changes[VAULT_KEY].newValue.map(normalizeLocalEntry) : []; render(); } });
window.addEventListener("beforeunload", () => unsubscribeCloud?.());
async function initialize() { setError(""); try { await loadLocalEntries(); } catch (error) { setError(error instanceof Error ? error.message : "Could not load local vault items."); } await startCloudListener(); }
initialize();
