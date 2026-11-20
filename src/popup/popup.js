import "./popup.css";
import { checkLocalModelStatus } from "../shared/hybridEngine.js";

const elements = {
  connection: document.querySelector("#connection-status"), count: document.querySelector("#vault-count"), requestCount: document.querySelector("#request-count"),
  localBar: document.querySelector("#local-bar"), cloudBar: document.querySelector("#cloud-bar"), localPercent: document.querySelector("#local-percent"),
  cloudPercent: document.querySelector("#cloud-percent"), averageLatency: document.querySelector("#average-latency"), modelStatus: document.querySelector("#model-status"),
  strictToggle: document.querySelector("#strict-local-toggle"), strictDescription: document.querySelector("#strict-local-description"), dashboardButton: document.querySelector("#open-dashboard"), error: document.querySelector("#error-message")
};

function setError(message = "") { elements.error.textContent = message; elements.error.classList.toggle("hidden", !message); }
function setConnection(connected) {
  elements.connection.textContent = connected ? "Online" : "Offline";
  elements.connection.className = connected ? "rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-cyan-300" : "rounded-full border border-orange-400/20 bg-orange-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-orange-300";
}
function setShareClass(element, percent) {
  const share = Math.max(0, Math.min(100, Math.round(percent / 10) * 10));
  for (let value = 0; value <= 100; value += 10) element.classList.remove(`share-${value}`);
  element.classList.add(`share-${share}`);
}
function renderTelemetry(response) {
  if (!response?.ok) throw new Error(response?.error?.message || "Could not load telemetry.");
  const telemetry = response.telemetry ?? {};
  const localCount = Number.isFinite(telemetry.localCount) ? Math.max(0, telemetry.localCount) : 0;
  const cloudCount = Number.isFinite(telemetry.cloudCount) ? Math.max(0, telemetry.cloudCount) : 0;
  const total = localCount + cloudCount; const localPercent = total ? Math.round((localCount / total) * 100) : 0; const cloudPercent = total ? 100 - localPercent : 0;
  elements.count.textContent = String(response.vault?.count ?? 0); elements.requestCount.textContent = `${Number(telemetry.totalRequests) || 0} requests`;
  elements.localPercent.textContent = `${localPercent}%`; elements.cloudPercent.textContent = `${cloudPercent}%`;
  setShareClass(elements.localBar, localPercent); setShareClass(elements.cloudBar, cloudPercent);
  elements.averageLatency.textContent = Number.isFinite(telemetry.averageLatencyMs) ? `${Math.round(telemetry.averageLatencyMs)} ms` : "— ms";
  elements.strictToggle.checked = response.strictLocal === true; elements.strictDescription.textContent = response.strictLocal ? "Cloud inference and sync are disabled" : "Prevent cloud inference and sync";
}
async function refreshTelemetry() { renderTelemetry(await chrome.runtime.sendMessage({ type: "GET_TELEMETRY" })); }
async function loadModelStatus() {
  try {
    const status = await checkLocalModelStatus(); const ready = status.status === "readily";
    elements.modelStatus.textContent = ready ? "Gemini Nano Ready" : "Cloud Fallback";
    elements.modelStatus.className = ready ? "status-ready rounded-full px-3 py-1.5 text-xs font-semibold" : "status-cloud rounded-full px-3 py-1.5 text-xs font-semibold";
    elements.modelStatus.title = status.reason || status.status;
  } catch (error) {
    elements.modelStatus.textContent = "Cloud Fallback"; elements.modelStatus.className = "status-cloud rounded-full px-3 py-1.5 text-xs font-semibold";
    elements.modelStatus.title = error instanceof Error ? error.message : "Local model status unavailable.";
  }
}
async function refresh() {
  setError(""); setConnection(navigator.onLine);
  try { await refreshTelemetry(); } catch (error) { setError(error instanceof Error ? error.message : "Could not load GrassVault data."); }
  await loadModelStatus();
}
elements.strictToggle.addEventListener("change", async () => {
  elements.strictToggle.disabled = true; setError("");
  try {
    const result = await chrome.runtime.sendMessage({ type: "TOGGLE_STRICT_LOCAL", enabled: elements.strictToggle.checked });
    if (!result?.ok) throw new Error(result?.error?.message || "Could not update local-only mode.");
    elements.strictToggle.checked = result.strictLocal === true; elements.strictDescription.textContent = result.strictLocal ? "Cloud inference and sync are disabled" : "Prevent cloud inference and sync";
  } catch (error) { elements.strictToggle.checked = !elements.strictToggle.checked; setError(error instanceof Error ? error.message : "Could not update local-only mode."); }
  finally { elements.strictToggle.disabled = false; }
});
elements.dashboardButton.addEventListener("click", async () => {
  try { await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/index.html") }); window.close(); }
  catch (error) { setError(error instanceof Error ? error.message : "Could not open the dashboard."); }
});
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === "local" && (changes.grassvaultEntries || changes.grassvaultInferenceTelemetry || changes.strictLocal)) refreshTelemetry().catch((error) => setError(error instanceof Error ? error.message : "Could not refresh telemetry."));
});
window.addEventListener("online", () => setConnection(true)); window.addEventListener("offline", () => setConnection(false)); refresh();
