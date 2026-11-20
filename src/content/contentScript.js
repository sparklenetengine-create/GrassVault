(() => {
  if (globalThis.__grassVaultContentScriptLoaded) return;
  globalThis.__grassVaultContentScriptLoaded = true;
  const DEBOUNCE_MS = 140;
  const MAX_CAPTURE_LENGTH = 20_000;
  const CODE_SELECTOR = "pre, code";
  let host, shadow, actionButton, badge, styleSheet, hostRule;
  let debounceTimer, activeText = "", activeSource = "selection", activeRect = null;
  let lastCodeElement = null, isBusy = false;

  function createUI() {
    if (!document.documentElement || host) return;
    host = document.createElement("div"); host.setAttribute("data-grassvault-root", ""); shadow = host.attachShadow({ mode: "closed" });
    styleSheet = new CSSStyleSheet();
    styleSheet.replaceSync(`
      :host { all: initial; position: fixed; inset: 0 auto auto 0; z-index: 2147483647; pointer-events: none; transform: translate3d(-10000px,-10000px,0); font-family: Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color-scheme: dark; }
      .container { display: flex; align-items: center; gap: 7px; pointer-events: none; }
      .action,.badge { box-sizing: border-box; border: 1px solid rgba(148,163,184,.24); border-radius: 999px; box-shadow: 0 8px 26px rgba(0,0,0,.32); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
      .action { pointer-events: auto; display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 13px; background: rgba(15,23,42,.94); color: #e2e8f0; font: 600 12px/1.2 Inter,ui-sans-serif,system-ui,sans-serif; cursor: pointer; white-space: nowrap; transition: border-color 120ms ease,transform 120ms ease,background 120ms ease; }
      .action:hover { transform: translateY(-1px); border-color: rgba(6,182,212,.8); background: rgba(15,23,42,.98); }
      .action:focus-visible { outline: 2px solid #06b6d4; outline-offset: 3px; }
      .action[disabled] { cursor: wait; opacity: .72; transform: none; }
      .mark { display: inline-block; width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #06b6d4; box-shadow: 0 0 10px rgba(6,182,212,.75); }
      .badge { display: inline-flex; align-items: center; min-height: 27px; padding: 0 9px; background: rgba(15,23,42,.94); color: #cbd5e1; font: 700 10px/1 Inter,ui-sans-serif,system-ui,sans-serif; white-space: nowrap; }
      .badge[data-mode="local"] { border-color: rgba(6,182,212,.55); color: #67e8f9; }
      .badge[data-mode="cloud"] { border-color: rgba(249,115,22,.55); color: #fdba74; }
      .badge[data-mode="error"] { border-color: rgba(248,113,113,.55); color: #fca5a5; }
      @media (prefers-reduced-motion: reduce) { .action { transition: none; } }
    `);
    shadow.adoptedStyleSheets = [styleSheet]; hostRule = styleSheet.cssRules[0];
    const container = document.createElement("div"); container.className = "container";
    actionButton = document.createElement("button"); actionButton.className = "action"; actionButton.type = "button"; actionButton.setAttribute("aria-label", "Vault selected text with GrassVault");
    const mark = document.createElement("span"); mark.className = "mark"; mark.setAttribute("aria-hidden", "true");
    const label = document.createElement("span"); label.className = "label"; label.textContent = "Vault with GrassVault";
    actionButton.append(mark, label);
    badge = document.createElement("output"); badge.className = "badge"; badge.setAttribute("aria-live", "polite"); badge.setAttribute("aria-atomic", "true"); badge.textContent = "Ready"; badge.dataset.mode = "idle";
    container.append(actionButton, badge); shadow.append(container);
    actionButton.addEventListener("click", onVaultClick); document.documentElement.append(host);
  }

  function getSelectionContext() {
    const selection = globalThis.getSelection?.(); if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const text = selection.toString().trim(); if (!text) return null;
    const range = selection.getRangeAt(0); const rect = range.getBoundingClientRect();
    const anchor = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
    const codeElement = anchor?.closest?.(CODE_SELECTOR);
    return { text: text.slice(0, MAX_CAPTURE_LENGTH), source: codeElement ? "code" : "selection", rect, codeElement: codeElement ?? null };
  }

  function getCodeContext(target) {
    const element = target instanceof Element ? target.closest(CODE_SELECTOR) : null;
    if (!element) return null;
    const text = (element.innerText || element.textContent || "").trim(); if (!text) return null;
    const rect = element.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return null;
    return { text: text.slice(0, MAX_CAPTURE_LENGTH), source: "code", rect, codeElement: element };
  }

  function placeAt(rect) {
    if (!hostRule || !rect) return;
    const margin = 10;
    const x = Math.max(margin, Math.min(rect.left + rect.width / 2, window.innerWidth - margin));
    let y = rect.top - 46; if (y < margin) y = Math.min(rect.bottom + 10, window.innerHeight - margin);
    hostRule.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0) translateX(-50%)`;
  }

  function hideUI() {
    if (!hostRule) return; hostRule.style.transform = "translate3d(-10000px,-10000px,0)"; activeText = ""; activeRect = null;
  }

  function showContext(context) {
    if (!context?.text || !context.rect) { hideUI(); return; }
    createUI(); activeText = context.text; activeSource = context.source; activeRect = context.rect; lastCodeElement = context.codeElement;
    actionButton.querySelector(".label").textContent = context.source === "code" ? "Vault code with GrassVault" : "Vault with GrassVault";
    actionButton.setAttribute("aria-label", context.source === "code" ? "Vault code with GrassVault" : "Vault selected text with GrassVault");
    placeAt(context.rect);
  }

  function refreshContext(eventTarget = null) {
    const selectionContext = getSelectionContext(); if (selectionContext) { showContext(selectionContext); return; }
    const codeContext = getCodeContext(eventTarget) || (lastCodeElement?.isConnected ? getCodeContext(lastCodeElement) : null);
    if (codeContext) { showContext(codeContext); return; } hideUI();
  }

  function scheduleRefresh(eventTarget = null) {
    if (debounceTimer) clearTimeout(debounceTimer); debounceTimer = setTimeout(() => refreshContext(eventTarget), DEBOUNCE_MS);
  }

  function setBadge(text, mode = "idle") { if (!badge) return; badge.textContent = text; badge.dataset.mode = mode; }

  async function onVaultClick() {
    if (isBusy || !activeText) return;
    isBusy = true; actionButton.disabled = true; actionButton.querySelector(".label").textContent = "Saving…"; setBadge("Working…");
    try {
      const response = await chrome.runtime.sendMessage({ type: "ANALYZE_AND_VAULT", payload: { snippet: activeText, metadata: { source: activeSource, title: document.title.slice(0, 300), url: `${location.origin}${location.pathname}`.slice(0, 2_000) } } });
      if (!response?.ok) throw new Error(response?.error?.message || "Could not vault this snippet.");
      const inference = response.inference;
      if (inference?.ok) {
        const latency = Number.isFinite(inference.latencyMs) ? `${Math.round(inference.latencyMs)} ms` : "latency n/a";
        setBadge(inference.mode === "local" ? `⚡ LOCAL · ${latency}` : inference.mode === "cloud" ? `☁️ CLOUD · ${latency}` : `Saved · ${latency}`, inference.mode);
      } else setBadge(`Saved · ${inference?.error?.message || "Inference unavailable"}`.slice(0, 70), "error");
      actionButton.querySelector(".label").textContent = "Saved to GrassVault";
      window.setTimeout(() => { if (actionButton?.isConnected) actionButton.querySelector(".label").textContent = activeSource === "code" ? "Vault code with GrassVault" : "Vault with GrassVault"; }, 1800);
    } catch (error) {
      console.error("GrassVault could not process the selected text.", error); setBadge(error instanceof Error ? error.message.slice(0, 70) : "GrassVault unavailable", "error");
    } finally { isBusy = false; if (actionButton) actionButton.disabled = false; }
  }

  document.addEventListener("mouseup", (event) => scheduleRefresh(event.target), true);
  document.addEventListener("keyup", (event) => scheduleRefresh(event.target), true);
  document.addEventListener("scroll", () => { if (activeRect) scheduleRefresh(); }, true);
  const observer = new MutationObserver(() => scheduleRefresh());
  function startObserver() { if (!document.documentElement) return; observer.observe(document.documentElement, { childList: true, subtree: true }); }
  if (document.documentElement) startObserver(); else document.addEventListener("DOMContentLoaded", startObserver, { once: true });
})();
