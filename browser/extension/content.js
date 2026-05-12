const SERVER_URL = "http://127.0.0.1:8000";
const LMSTUDIO_URL = "http://127.0.0.1:1234";
const LMSTUDIO_MODEL = "qwen3.5-9b-vlm";
const LMSTUDIO_TIMEOUT_MS = 60000;
let scanMode = false;
let selectionMode = false;
let selectedRect = null;
let scanTimer = null;
let lastPrefetchData = null;
let inFlightScan = false;
let queuedScan = null;
const translationCache = new Map();
const translationMemory = new Map();
let glossary = {};
let characterNames = [];
let backendButton = null;
let backendConfig = {
  type: "LMStudio",
  lmstudioUrl: LMSTUDIO_URL,
  lmstudioModel: LMSTUDIO_MODEL,
  deeplAuthKey: "",
  googleApiKey: "",
};
let overlayFontSize = parseInt(localStorage.getItem("overlayFontSize") || "14", 10);
const TESSERACT_LANG = "chi_sim+jpn+eng";
const scanBuffer = [];
const MAX_SCAN_BUFFER = 3;
let currentTabId = null;
const TRANSLATION_CACHE_LIMIT = 80;
const TRANSLATION_MEMORY_LIMIT = 400;
let shadowRootHost = null;
let statusSpan = null;
let fabButton = null;
let menuPanel = null;
let selectButton = null;
let startButton = null;
let clearButton = null;
let fullFrameButton = null;
let glossaryButton = null;
let characterButton = null;
let regionBox = null;
let selectionOverlay = null;
let annotationLayer = null;
let shadowRoot = null;
let lastCaptureTimestamp = 0;
let fabDragState = {
  active: false,
  moved: false,
  startX: 0,
  startY: 0,
  originLeft: 0,
  originTop: 0,
};

function setPageFavicon(url) {
  try {
    const head = document.head || document.documentElement;
    if (!head) return;

    const selectors = [
      'link[rel="icon"]',
      'link[rel="shortcut icon"]',
      'link[rel="apple-touch-icon"]',
    ];

    const icons = selectors
      .map((sel) => Array.from(head.querySelectorAll(sel)))
      .flat();

    if (icons.length === 0) {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = url;
      head.appendChild(link);
      return;
    }

    icons.forEach((icon) => {
      icon.href = url;
    });
  } catch (err) {
    console.warn('Failed to set page favicon', err);
  }
}

function createUI() {
  if (shadowRootHost) {
    return;
  }

  shadowRootHost = document.createElement("div");
  shadowRootHost.id = "manga-auto-scan-host";
  shadowRootHost.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  document.documentElement.appendChild(shadowRootHost);

  shadowRoot = shadowRootHost.attachShadow({ mode: "open" });
  const shadow = shadowRoot;
  setPageFavicon(chrome.runtime.getURL("icon.svg"));
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
    .fab { position: fixed; right: 18px; bottom: 18px; width: 52px; height: 52px; border-radius: 50%; border: none; background: rgba(20, 20, 20, 0.85); color: white; font-size: 24px; display: inline-flex; align-items: center; justify-content: center; cursor: grab; pointer-events: auto; transition: transform .2s ease, background .2s ease, box-shadow .2s ease, opacity .2s ease; box-shadow: 0 14px 40px rgba(0,0,0,0.25); opacity: 0.88; }
    .fab:hover { transform: scale(1.08); background: rgba(34, 130, 195, 0.92); opacity: 1; }
    .fab.dragging { cursor: grabbing; transform: scale(1.08); box-shadow: 0 18px 44px rgba(0,0,0,0.35); }
    .fab.scanning { background: rgba(220, 38, 38, 0.92); animation: pulse 1.2s infinite; }
    .fab.error { background: rgba(245, 158, 11, 0.96); }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(220,38,38,0.5); } 70% { box-shadow: 0 0 0 18px rgba(220,38,38,0); } 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); } }
    .menu { position: fixed; right: 18px; bottom: 82px; width: 220px; background: rgba(14, 18, 24, 0.95); border-radius: 18px; padding: 12px; box-shadow: 0 24px 60px rgba(0,0,0,0.28); color: #f8fafc; font-family: ui-sans-serif, system-ui, sans-serif; pointer-events: auto; display: none; }
    .menu.open { display: block; }
    .menu h4 { margin: 0 0 8px; font-size: 14px; color: #cbd5e1; }
    .menu button { border: none; border-radius: 12px; padding: 10px 12px; margin: 6px 0; font-size: 13px; background: rgba(255,255,255,0.08); color: #f8fafc; cursor: pointer; transition: background .2s ease; }
    .menu button:hover { background: rgba(255,255,255,0.16); }
    .status { margin-top: 8px; font-size: 12px; color: #94a3b8; }
    .status strong { color: #e2e8f0; }
    .status.error strong { color: #fca5a5; }
    .selection-overlay { position: fixed; inset: 0; background: rgba(20, 24, 32, 0.22); cursor: crosshair; pointer-events: auto; display: none; }
    .region-box { position: fixed; border: 2px dashed #38bdf8; background: rgba(56, 189, 248, 0.16); pointer-events: none; display: none; }
    .annotation-layer { position: fixed; inset: 0; pointer-events: none; }
    .cleaned-overlay { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; background-repeat: no-repeat; background-position: top left; background-size: contain; opacity: 0.96; z-index: 0; }
    .translation-overlay { position: absolute; background: rgba(0, 0, 0, 0.84); color: #f8fafc; padding: 14px; border-radius: 12px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; overflow-y: auto; box-shadow: 0 24px 64px rgba(0,0,0,0.4); z-index: 3; max-height: 100%; }
    .annotation-box { position: absolute; background: rgba(0,0,0,0.92); color: #f8fafc; padding: 4px 8px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; font-weight: 500; box-sizing: border-box; }
  `;

  const root = document.createElement("div");
  root.className = "root";
  root.innerHTML = `
    <button class="fab" id="fab" title="Auto Translator">🔎</button>
    <div class="menu" id="menu">
      <h4>Auto Translator</h4>
      <button id="btn-start">Start Scan</button>
      <button id="btn-full-frame">Scan Full Frame</button>
      <button id="btn-select">Select Region</button>
      <button id="btn-clear">Clear Region</button>
      <button id="btn-glossary">Glossary</button>
      <button id="btn-characters">Character Names</button>
      <button id="btn-backend">Backend: LMStudio</button>
      <button id="btn-fontsize">Text Size: 14px</button>
      <div class="status">Status: <strong id="status">Idle</strong></div>
    </div>
    <div class="selection-overlay" id="selectionOverlay"></div>
    <div class="region-box" id="regionBox"></div>
    <div class="annotation-layer" id="annotationLayer"></div>
  `;

  shadow.appendChild(style);
  shadow.appendChild(root);

  fabButton = shadow.getElementById("fab");
  menuPanel = shadow.getElementById("menu");
  startButton = shadow.getElementById("btn-start");
  selectButton = shadow.getElementById("btn-select");
  clearButton = shadow.getElementById("btn-clear");
  statusSpan = shadow.getElementById("status");
  selectionOverlay = shadow.getElementById("selectionOverlay");
  regionBox = shadow.getElementById("regionBox");
  annotationLayer = shadow.getElementById("annotationLayer");

  fabButton.addEventListener("mousedown", onFabMouseDown);
  fabButton.addEventListener("click", onFabClicked);
  startButton.addEventListener("click", onStartStopClicked);
  fullFrameButton = shadow.getElementById("btn-full-frame");
  fullFrameButton.addEventListener("click", onFullFrameClicked);
  selectButton.addEventListener("click", onSelectClicked);
  clearButton.addEventListener("click", onClearClicked);
  glossaryButton = shadow.getElementById("btn-glossary");
  glossaryButton.addEventListener("click", onGlossaryClicked);
  characterButton = shadow.getElementById("btn-characters");
  characterButton.addEventListener("click", onCharacterClicked);
  backendButton = shadow.getElementById("btn-backend");
  backendButton.addEventListener("click", onBackendClicked);
  const fontSizeButton = shadow.getElementById("btn-fontsize");
  fontSizeButton.textContent = `Text Size: ${overlayFontSize}px`;
  fontSizeButton.addEventListener("click", () => {
    const sizes = [12, 14, 16, 18, 20, 24];
    const idx = (sizes.indexOf(overlayFontSize) + 1) % sizes.length;
    overlayFontSize = sizes[idx];
    localStorage.setItem("overlayFontSize", String(overlayFontSize));
    fontSizeButton.textContent = `Text Size: ${overlayFontSize}px`;
  });
  selectionOverlay.addEventListener("mousedown", onSelectionMouseDown);
  loadGlossary();
  loadCharacterNames();
  loadBackendConfig();
  loadTranslationMemory();
  selectionOverlay.addEventListener("mousemove", onSelectionMouseMove);
  selectionOverlay.addEventListener("mouseup", onSelectionMouseUp);
  selectionOverlay.addEventListener("mouseleave", onSelectionMouseLeave);

  updateButtons();
}

function toggleMenu() {
  if (!menuPanel) return;
  menuPanel.classList.toggle("open");
}

function setStatus(text, isError = false) {
  if (!statusSpan || !fabButton) return;
  statusSpan.textContent = text;
  statusSpan.classList.toggle("error", isError);
  fabButton.classList.toggle("error", isError);
}

function onFabMouseDown(event) {
  if (!fabButton) return;
  event.preventDefault();
  fabDragState.active = true;
  fabDragState.moved = false;
  fabDragState.startX = event.clientX;
  fabDragState.startY = event.clientY;
  const rect = fabButton.getBoundingClientRect();
  fabDragState.originLeft = rect.left;
  fabDragState.originTop = rect.top;
  fabButton.classList.add("dragging");
  window.addEventListener("mousemove", onFabMouseMove);
  window.addEventListener("mouseup", onFabMouseUp);
}

function onFabMouseMove(event) {
  if (!fabDragState.active || !fabButton) return;
  const dx = event.clientX - fabDragState.startX;
  const dy = event.clientY - fabDragState.startY;
  const distance = Math.abs(dx) + Math.abs(dy);
  if (distance > 6) {
    fabDragState.moved = true;
  }
  const newLeft = Math.min(Math.max(8, fabDragState.originLeft + dx), window.innerWidth - fabButton.offsetWidth - 8);
  const newTop = Math.min(Math.max(8, fabDragState.originTop + dy), window.innerHeight - fabButton.offsetHeight - 8);
  fabButton.style.left = `${newLeft}px`;
  fabButton.style.top = `${newTop}px`;
  fabButton.style.right = "auto";
  fabButton.style.bottom = "auto";
}

function onFabMouseUp() {
  if (!fabDragState.active || !fabButton) return;
  fabDragState.active = false;
  fabButton.classList.remove("dragging");
  window.removeEventListener("mousemove", onFabMouseMove);
  window.removeEventListener("mouseup", onFabMouseUp);
}

function onFabClicked(event) {
  if (fabDragState.moved) {
    fabDragState.moved = false;
    return;
  }
  toggleMenu();
}

function updateButtons() {
  if (!startButton || !selectButton || !clearButton || !fabButton) return;
  startButton.textContent = scanMode ? "Stop Scan" : "Start Scan";
  selectButton.textContent = selectionMode ? "Cancel Select" : selectedRect ? "Change Region" : "Select Region";
  clearButton.style.display = selectedRect ? "block" : "none";
  fabButton.classList.toggle("scanning", scanMode);
}

function onStartStopClicked() {
  if (scanMode) {
    stopScan();
  } else {
    startScan();
  }
  updateButtons();
}

function onFullFrameClicked() {
  selectedRect = null;
  hideRegionBox();
  updateButtons();
  scanOnce();
}

function onSelectClicked() {
  if (selectionMode) {
    stopRegionSelection();
    return;
  }
  startRegionSelection();
}

function onClearClicked() {
  selectedRect = null;
  hideRegionBox();
  setStatus("Region cleared.");
  updateButtons();
}

function onGlossaryClicked() {
  const entry = window.prompt("Enter glossary entry in format source=target, or leave blank to cancel:", "");
  if (!entry) {
    return;
  }
  const [source, target] = entry.split("=").map((s) => s.trim());
  if (!source || !target) {
    setStatus("Invalid glossary format. Use source=target.");
    return;
  }
  glossary[source] = target;
  saveGlossary();
  setStatus(`Glossary updated: ${source} -> ${target}`);
}

function loadGlossary() {
  try {
    const raw = window.localStorage.getItem("autoScanGlossary");
    if (raw) {
      glossary = JSON.parse(raw);
    }
  } catch (err) {
    console.warn("Failed to load glossary", err);
    glossary = {};
  }
}

function saveGlossary() {
  try {
    window.localStorage.setItem("autoScanGlossary", JSON.stringify(glossary));
  } catch (err) {
    console.warn("Failed to save glossary", err);
  }
}

function loadCharacterNames() {
  try {
    const raw = window.localStorage.getItem("autoScanCharacterNames");
    if (raw) {
      characterNames = JSON.parse(raw);
    }
  } catch (err) {
    console.warn("Failed to load character names", err);
    characterNames = [];
  }
}

function saveCharacterNames() {
  try {
    window.localStorage.setItem("autoScanCharacterNames", JSON.stringify(characterNames));
  } catch (err) {
    console.warn("Failed to save character names", err);
  }
}

function loadBackendConfig() {
  try {
    const raw = window.localStorage.getItem("autoScanBackendConfig");
    if (raw) {
      const parsed = JSON.parse(raw);
      backendConfig = { ...backendConfig, ...parsed };
    }
  } catch (err) {
    console.warn("Failed to load backend config", err);
  }
}

function saveBackendConfig() {
  try {
    window.localStorage.setItem("autoScanBackendConfig", JSON.stringify(backendConfig));
  } catch (err) {
    console.warn("Failed to save backend config", err);
  }
}

function onBackendClicked() {
  const type = window.prompt("Choose translation backend: LMStudio, LMStudio Vision, DeepL, Google", backendConfig.type);
  if (!type) {
    return;
  }
  const normalized = type.trim();
  if (!["LMStudio", "LMStudio Vision", "DeepL", "Google"].includes(normalized)) {
    setStatus("Unknown backend type. Use LMStudio, LMStudio Vision, DeepL, or Google.", true);
    return;
  }

  backendConfig.type = normalized;
  if (normalized === "LMStudio" || normalized === "LMStudio Vision") {
    backendConfig.lmstudioUrl = window.prompt("LMStudio URL:", backendConfig.lmstudioUrl) || backendConfig.lmstudioUrl;
    backendConfig.lmstudioModel = window.prompt("LMStudio model (vision-capable for LMStudio Vision):", backendConfig.lmstudioModel) || backendConfig.lmstudioModel;
  } else if (normalized === "DeepL") {
    backendConfig.deeplAuthKey = window.prompt("DeepL auth key:", backendConfig.deeplAuthKey) || backendConfig.deeplAuthKey;
  } else if (normalized === "Google") {
    backendConfig.googleApiKey = window.prompt("Google Translate API key:", backendConfig.googleApiKey) || backendConfig.googleApiKey;
  }

  saveBackendConfig();
  updateButtons();
  setStatus(`Translation backend set to ${backendConfig.type}.`);
}

function updateButtons() {
  if (!startButton || !selectButton || !clearButton || !fabButton || !backendButton) return;
  startButton.textContent = scanMode ? "Stop Scan" : "Start Scan";
  selectButton.textContent = selectionMode ? "Cancel Select" : selectedRect ? "Change Region" : "Select Region";
  clearButton.style.display = selectedRect ? "block" : "none";
  fabButton.classList.toggle("scanning", scanMode);
  backendButton.textContent = `Backend: ${backendConfig.type}`;
}

function loadTranslationMemory() {
  try {
    const raw = window.localStorage.getItem("autoScanTranslationMemory");
    if (raw) {
      const parsed = JSON.parse(raw);
      translationMemory.clear();
      Object.entries(parsed).forEach(([key, value]) => translationMemory.set(key, value));
    }
  } catch (err) {
    console.warn("Failed to load translation memory", err);
  }
}

function saveTranslationMemory() {
  try {
    const serialized = Object.fromEntries(translationMemory);
    window.localStorage.setItem("autoScanTranslationMemory", JSON.stringify(serialized));
  } catch (err) {
    console.warn("Failed to save translation memory", err);
  }
}

function buildMemoryKey(text) {
  const sortedGlossary = Object.keys(glossary)
    .sort()
    .reduce((acc, key) => {
      acc[key] = glossary[key];
      return acc;
    }, {});
  const glossaryBlob = JSON.stringify(sortedGlossary);
  const namesBlob = JSON.stringify(characterNames);
  return `${text}||${glossaryBlob}||${namesBlob}`;
}

function getDomainId() {
  const host = window.location.host;
  const segments = window.location.pathname.split('/').filter(Boolean);
  if (segments.length >= 2) {
    return `${host}/${segments[0]}/${segments[1]}`;
  }
  return `${host}/${segments.join('/')}`;
}

function cacheGet(key) {
  if (!translationCache.has(key)) return undefined;
  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (translationCache.has(key)) {
    translationCache.delete(key);
  }
  translationCache.set(key, value);
  while (translationCache.size > TRANSLATION_CACHE_LIMIT) {
    const oldest = translationCache.keys().next().value;
    translationCache.delete(oldest);
  }
}

function memoryGet(key) {
  if (!translationMemory.has(key)) return undefined;
  const value = translationMemory.get(key);
  translationMemory.delete(key);
  translationMemory.set(key, value);
  return value;
}

function memorySet(key, value) {
  if (translationMemory.has(key)) {
    translationMemory.delete(key);
  }
  translationMemory.set(key, value);
  while (translationMemory.size > TRANSLATION_MEMORY_LIMIT) {
    const oldest = translationMemory.keys().next().value;
    translationMemory.delete(oldest);
  }
}

function onCharacterClicked() {
  const existing = characterNames.join(", ");
  const entry = window.prompt(
    "Enter character names separated by commas, or leave blank to keep current:",
    existing
  );
  if (entry === null) {
    return;
  }

  const names = entry
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  characterNames = names;
  saveCharacterNames();
  setStatus(
    `Character names updated: ${characterNames.length ? characterNames.join(", ") : "none"}`
  );
}

function expandRect(rect, factor) {
  const bufferX = Math.round(rect.width * factor);
  const bufferY = Math.round(rect.height * factor);
  const left = Math.max(0, rect.left - bufferX);
  const top = Math.max(0, rect.top - bufferY);
  const width = Math.min(window.innerWidth, rect.width + bufferX * 2 + (rect.left - left));
  const height = Math.min(window.innerHeight, rect.height + bufferY * 2 + (rect.top - top));
  return { left, top, width, height };
}

function pushScanBuffer(hash) {
  scanBuffer.unshift(hash);
  if (scanBuffer.length > MAX_SCAN_BUFFER) {
    scanBuffer.pop();
  }
}

function pixelmatch(img1, img2, output, width, height, options = {}) {
  const { threshold = 0.1, includeAA = false } = options;
  let diff = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r1 = img1[idx];
      const g1 = img1[idx + 1];
      const b1 = img1[idx + 2];
      const a1 = img1[idx + 3];
      const r2 = img2[idx];
      const g2 = img2[idx + 1];
      const b2 = img2[idx + 2];
      const a2 = img2[idx + 3];
      const delta = Math.max(
        Math.abs(r1 - r2),
        Math.abs(g1 - g2),
        Math.abs(b1 - b2),
        Math.abs(a1 - a2)
      );
      const normalized = delta / 255;
      const isDiff = normalized > threshold;
      if (isDiff) {
        diff += 1;
        if (output) {
          output[idx] = 255;
          output[idx + 1] = 0;
          output[idx + 2] = 255;
          output[idx + 3] = 255;
        }
      } else if (output) {
        output[idx] = 0;
        output[idx + 1] = 0;
        output[idx + 2] = 0;
        output[idx + 3] = 255;
      }
    }
  }
  return diff;
}

function hasFrameChanged(prev, next) {
  if (!prev || !next || prev.width !== next.width || prev.height !== next.height) return true;
  const diff = pixelmatch(prev.data, next.data, null, prev.width, prev.height, {
    threshold: 0.14,
  });
  return diff > (prev.width * prev.height) * 0.002;
}

function startRegionSelection() {
  selectionMode = true;
  if (!selectionOverlay) return;
  selectionOverlay.style.display = "block";
  selectionOverlay.style.cursor = "crosshair";
  selectedRect = null;
  hideRegionBox();
  setStatus("Drag to select region.");
  updateButtons();
}

function stopRegionSelection() {
  selectionMode = false;
  if (!selectionOverlay) return;
  selectionOverlay.style.display = "none";
  setStatus(selectedRect ? "Region locked." : "Selection canceled.");
  updateButtons();
}

let selectionStart = null;
function onSelectionMouseDown(event) {
  if (!selectionMode) return;
  event.preventDefault();
  selectionStart = { x: event.clientX, y: event.clientY };
  updateRegionBox({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
}

function onSelectionMouseMove(event) {
  if (!selectionMode || !selectionStart) return;
  event.preventDefault();
  const left = Math.min(selectionStart.x, event.clientX);
  const top = Math.min(selectionStart.y, event.clientY);
  const width = Math.abs(selectionStart.x - event.clientX);
  const height = Math.abs(selectionStart.y - event.clientY);
  updateRegionBox({ left, top, width, height });
}

function onSelectionMouseUp(event) {
  if (!selectionMode || !selectionStart) return;
  event.preventDefault();
  const left = Math.min(selectionStart.x, event.clientX);
  const top = Math.min(selectionStart.y, event.clientY);
  const width = Math.abs(selectionStart.x - event.clientX);
  const height = Math.abs(selectionStart.y - event.clientY);
  selectionStart = null;
  selectionMode = false;
  if (width < 40 || height < 40) {
    selectedRect = null;
    hideRegionBox();
    setStatus("Selection too small. Try again.");
    updateButtons();
    return;
  }
  selectedRect = { left, top, width, height };
  showRegionBox(selectedRect);
  selectionOverlay.style.display = "none";
  setStatus("Region locked. Start scan to auto-scan.");
  updateButtons();
}

function onSelectionMouseLeave() {
  if (!selectionMode || !selectionStart) return;
}

function updateRegionBox(rect) {
  if (!regionBox) return;
  regionBox.style.display = "block";
  regionBox.style.left = `${rect.left}px`;
  regionBox.style.top = `${rect.top}px`;
  regionBox.style.width = `${rect.width}px`;
  regionBox.style.height = `${rect.height}px`;
}

function showRegionBox(rect) {
  updateRegionBox(rect);
}

function hideRegionBox() {
  if (!regionBox) return;
  regionBox.style.display = "none";
}

function getViewportRect() {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function startScan() {
  if (scanMode) return;
  scanMode = true;
  setStatus("Scanning once...");
  updateButtons();
  scanOnce();
}

function stopScan() {
  scanMode = false;
  queuedScan = null;
  updateButtons();
  setStatus("Scan stopped.");
}

function scanOnce() {
  const now = Date.now();
  if (now - lastCaptureTimestamp < 3000) {
    return;
  }
  if (inFlightScan && queuedScan) {
    return;
  }
  lastCaptureTimestamp = now;
  const rect = selectedRect || getViewportRect();
  const prefetchRect = selectedRect ? expandRect(rect, 0.2) : rect;
  initiateCapture(rect, prefetchRect).catch((err) => {
    const message = err?.message?.toLowerCase() || "";
    if (
      message.includes("active tab") ||
      message.includes("activetab") ||
      message.includes("extension context invalidated") ||
      message.includes("quota")
    ) {
      stopScan();
      setStatus(`Scan error: ${err.message}`, true);
      return;
    }
    console.error(err);
    setStatus(`Scan error: ${err.message}`, true);
  });
}

async function initiateCapture(rect, prefetchRect) {
  return new Promise((resolve, reject) => {
    console.log("initiateCapture start", { rect, prefetchRect, currentTabId });
    chrome.runtime.sendMessage({ action: "captureVisibleTab" }, async (response) => {
      if (chrome.runtime.lastError) {
        const message = chrome.runtime.lastError.message || 'Unknown runtime error';
        setStatus(`Capture failed: ${message}`, true);
        if (
          message.toLowerCase().includes('active tab') ||
          message.toLowerCase().includes('extension context invalidated') ||
          message.toLowerCase().includes('quota')
        ) {
          stopScan();
          return resolve();
        }
        return reject(new Error(message));
      }
      if (!response || response.error) {
        const message = response?.error || 'unknown';
        setStatus(`Capture failed: ${message}`, true);
        if (
          message.toLowerCase().includes('active tab') ||
          message.toLowerCase().includes('extension context invalidated') ||
          message.toLowerCase().includes('quota')
        ) {
          stopScan();
          return resolve();
        }
        return reject(new Error(message));
      }
      currentTabId = response.tabId || currentTabId;
      try {
        const croppedDataUrl = await cropDataUrl(response.dataUrl, rect);
        const croppedImageData = await getImageDataFromDataUrl(croppedDataUrl);
        console.log("initiateCapture cropped image", {
          width: croppedImageData.width,
          height: croppedImageData.height,
          cacheKey: hashImageData(croppedImageData),
        });
        const cacheKey = hashImageData(croppedImageData);
        const cropScale = rect.width > 0 ? croppedImageData.width / rect.width : (window.devicePixelRatio || 1);

        const prefetchDataUrl = prefetchRect && (prefetchRect.left !== rect.left || prefetchRect.top !== rect.top || prefetchRect.width !== rect.width || prefetchRect.height !== rect.height)
          ? await cropDataUrl(response.dataUrl, prefetchRect)
          : croppedDataUrl;
        const prefetchImageData = await getImageDataFromDataUrl(prefetchDataUrl);
        const prefetchHash = hashImageData(prefetchImageData);

        if (lastPrefetchData && !hasFrameChanged(lastPrefetchData, prefetchImageData)) {
          setStatus("No visual change detected in buffered viewport.");
          const cached = cacheGet(cacheKey);
          if (cached) {
            renderAnnotations(cached.items || cached, rect, cached.cropScale || cropScale);
          }
          return resolve();
        }

        if (scanBuffer.includes(prefetchHash)) {
          const cached = cacheGet(cacheKey);
          if (cached) {
            setStatus("Buffered scan hit, using cached translation.");
            renderAnnotations(cached.items || cached, rect, cached.cropScale || cropScale);
            lastPrefetchData = prefetchImageData;
            return resolve();
          }
        }

        lastPrefetchData = prefetchImageData;
        pushScanBuffer(prefetchHash);
        enqueueScan(croppedDataUrl, rect, cacheKey, cropScale);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function enqueueScan(dataUrl, rect, cacheKey, cropScale) {
  const cached = cacheGet(cacheKey);
  if (cached) {
    renderAnnotations(cached.items || cached, rect, cached.cropScale || cropScale);
    setStatus("Loaded translation from cache.");
    return;
  }

  const task = { dataUrl, rect, cacheKey, cropScale };
  if (inFlightScan) {
    queuedScan = task;
    setStatus("Scan queued.");
    return;
  }

  processScan(task);
}

async function processScan(task) {
  inFlightScan = true;
  try {
    await sendToServer(task.dataUrl, task.rect, task.cacheKey, task.cropScale);
  } finally {
    inFlightScan = false;
    if (queuedScan) {
      const next = queuedScan;
      queuedScan = null;
      processScan(next);
      return;
    }
    scanMode = false;
    updateButtons();
  }
}

function cropDataUrl(dataUrl, rect) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const pageWidth = window.innerWidth || 1;
      const pageHeight = window.innerHeight || 1;
      const scaleX = image.naturalWidth / pageWidth;
      const scaleY = image.naturalHeight / pageHeight;
      const scale = (scaleX + scaleY) / 2;
      const canvasWidth = Math.max(1, Math.round(rect.width * scale));
      const canvasHeight = Math.max(1, Math.round(rect.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const ctx = canvas.getContext("2d");
      console.log("cropDataUrl", {
        rect,
        pageWidth,
        pageHeight,
        scaleX,
        scaleY,
        scale,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        canvasWidth,
        canvasHeight,
      });
      ctx.drawImage(
        image,
        Math.round(rect.left * scale),
        Math.round(rect.top * scale),
        Math.round(rect.width * scale),
        Math.round(rect.height * scale),
        0,
        0,
        canvasWidth,
        canvasHeight
      );
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = (err) => {
      console.error("cropDataUrl failed to load image", err, { rect });
      reject(err);
    };
    image.src = dataUrl;
  });
}

function getImageDataFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function preprocessDataUrlForOCR(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const maxWidth = Math.max(1024, image.naturalWidth);
      const maxHeight = Math.max(128, image.naturalHeight);
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        const value = gray > 150 ? 255 : 0;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
      }
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function ensureMinDataUrlSize(dataUrl, minWidth = 300, minHeight = 48) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      let width = image.naturalWidth;
      let height = image.naturalHeight;
      let scale = 1;
      if (width < minWidth) {
        scale = Math.max(scale, minWidth / width);
      }
      if (height < minHeight) {
        scale = Math.max(scale, minHeight / height);
      }
      console.log("ensureMinDataUrlSize", {
        width,
        height,
        minWidth,
        minHeight,
        scale,
      });
      if (scale <= 1) {
        return resolve(dataUrl);
      }

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = (err) => {
      console.error("ensureMinDataUrlSize failed to load image", err);
      reject(err);
    };
    image.src = dataUrl;
  });
}

function hashImageData(imageData) {
  let hash = 5381;
  const data = imageData.data;
  const step = 32;
  for (let i = 0; i < data.length; i += step) {
    hash = (hash * 33) ^ data[i];
  }
  return (hash >>> 0).toString(36);
}

async function requestOCR(dataUrl) {
  if (!window.Tesseract || typeof window.Tesseract.recognize !== "function") {
    throw new Error("Tesseract.js is not loaded or not available.");
  }

  const localLangPath = chrome.runtime.getURL("tesseract");
  const baseOptions = {
    logger: (message) => {
      if (message.status && message.progress != null) {
        const percent = Math.round(message.progress * 100);
        setStatus(`OCR ${message.status}: ${percent}%`);
      }
    },
    workerPath: chrome.runtime.getURL("tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL("tesseract/tesseract-core.wasm.js"),
    gzip: false,
    psm: 6,
    tessedit_pageseg_mode: 6,
    preserve_interword_spaces: 1,
  };

  let data;
  console.log("requestOCR start", {
    localLangPath,
    language: TESSERACT_LANG,
  });

  // Track dimensions so we can map OCR bboxes back to original image space.
  // ensureMinDataUrlSize may upscale the image; OCR bboxes are in that scaled space.
  const origDims = await new Promise((res) => {
    const img = new Image();
    img.onload = () => res({ width: img.naturalWidth, height: img.naturalHeight });
    img.src = dataUrl;
  });

  const normalizedUrl = await ensureMinDataUrlSize(dataUrl);
  const ocrReadyUrl = await preprocessDataUrlForOCR(normalizedUrl);

  const ocrDims = await new Promise((res) => {
    const img = new Image();
    img.onload = () => res({ width: img.naturalWidth, height: img.naturalHeight });
    img.src = ocrReadyUrl;
  });

  // Factor to convert OCR pixel coords → original cropped image pixel coords
  const bboxScaleX = ocrDims.width > 0 ? origDims.width / ocrDims.width : 1;
  const bboxScaleY = ocrDims.height > 0 ? origDims.height / ocrDims.height : 1;
  console.log("requestOCR dims", { origDims, ocrDims, bboxScaleX, bboxScaleY });

  try {
    ({ data } = await window.Tesseract.recognize(ocrReadyUrl, TESSERACT_LANG, {
      ...baseOptions,
      langPath: localLangPath,
    }));
  } catch (err) {
    console.warn("Local Tesseract model failed, falling back to remote default langPath", err);
    ({ data } = await window.Tesseract.recognize(ocrReadyUrl, TESSERACT_LANG, {
      ...baseOptions,
      gzip: true,
    }));
  }

  const lines = (data.lines || []).map((line) => ({
    text: String(line.text || "").trim(),
    box: [
      (line.bbox?.x0 || 0) * bboxScaleX,
      (line.bbox?.y0 || 0) * bboxScaleY,
      (line.bbox?.x1 || 0) * bboxScaleX,
      (line.bbox?.y1 || 0) * bboxScaleY,
    ],
  })).filter((item) => item.text);

  if (lines.length) {
    return lines;
  }

  return [{ text: String(data.text || "").trim(), box: [0, 0, origDims.width, origDims.height] }].filter((item) => item.text);
}

function buildTranslationPrompt(lines) {
  const promptLines = lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
  return `Translate the following source text into Vietnamese only. Each source line may contain Chinese, English, or both. Translate the entire content of each line into fluent Vietnamese and return only a valid JSON array of strings in the same order. Do not include the original Chinese or English text, explanations, commentary, or any extra content. If a valid JSON array is not possible, return each translated line on a separate line only.\n\nSource lines:\n${promptLines}`;
}

function parseModelResponse(data) {
  if (!data) {
    throw new Error("Empty model response.");
  }

  if (data.choices && data.choices.length) {
    const choice = data.choices[0];
    return (choice.message?.content || choice.text || "").trim();
  }

  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (typeof data.response === "string" && data.response.trim()) {
    return data.response.trim();
  }

  if (typeof data.text === "string" && data.text.trim()) {
    return data.text.trim();
  }

  if (typeof data === "string") {
    return data.trim();
  }

  throw new Error("Unexpected model response format.");
}

function parseChatCompletionResponse(data) {
  const content = parseModelResponse(data);
  const normalized = typeof content === "string" ? content.trim() : String(content || "");
  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim());
    }
  } catch (err) {
    const normalizedJson = normalized.replace(/[“”]/g, '"').replace(/'/g, '"');
    try {
      const parsed = JSON.parse(normalizedJson);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim());
      }
    } catch (err2) {
      // fallback to quoted extraction
    }
    const quoted = Array.from(normalized.matchAll(/"([^"]+)"/g)).map((match) => match[1].trim()).filter(Boolean);
    if (quoted.length > 1) {
      return quoted;
    }
  }

  return normalized
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[\d\-\.\)\]]+\s*/, "").trim())
    .filter(Boolean);
}

function proxyFetch(url, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: "proxyFetch",
        url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!response) {
          return reject(new Error("No response from proxy fetch."));
        }
        if (response.error) {
          return reject(new Error(response.error));
        }
        resolve(response.data);
      }
    );
  });
}

async function translateLines(lines) {
  switch (backendConfig.type) {
    case "LMStudio":
    case "LMStudio Vision":
      return translateLinesWithLMStudio(lines);
    case "DeepL":
      return translateLinesWithDeepL(lines);
    case "Google":
      return translateLinesWithGoogle(lines);
    default:
      throw new Error(`Unsupported backend type: ${backendConfig.type}`);
  }
}

async function translateLinesWithLMStudio(lines) {
  const systemPrompt = "You are a professional translator. Translate the source text into natural Vietnamese only. Preserve tone, character names, and formatting. Do not add explanations, commentary, or extra text. Do not output the original Chinese or English under any circumstances.";
  const userPrompt = buildTranslationPrompt(lines);

  const endpoints = [
    {
      url: `${backendConfig.lmstudioUrl}/v1/chat/completions`,
      payload: {
        model: backendConfig.lmstudioModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 1100,
        top_p: 0.9,
      },
    },
    {
      url: `${backendConfig.lmstudioUrl}/api/v1/chat`,
      payload: {
        model: backendConfig.lmstudioModel,
        system_prompt: systemPrompt,
        input: userPrompt,
        temperature: 0.2,
        top_p: 0.9,
      },
    },
  ];

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const data = await proxyFetch(endpoint.url, endpoint.payload);
      const parsed = parseChatCompletionResponse(data);
      if (parsed.length === lines.length && parsed.length > 0) {
        return parsed;
      }
      lastError = new Error(`Unexpected translation length: ${parsed.length}`);
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  const fallbackPrompt = `Translate each source line into Vietnamese only. Return one Vietnamese line per input line, with no original text, explanation, commentary, or extra output.\n\nSource lines:\n${lines.map((line, index) => `${index + 1}. ${line}`).join("\n")}`;
  for (const endpoint of endpoints) {
    try {
      const payload = { ...endpoint.payload };
      if (payload.messages) {
        payload.messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: fallbackPrompt },
        ];
      } else {
        payload.input = fallbackPrompt;
      }
      const data = await proxyFetch(endpoint.url, payload);
      const parsed = parseChatCompletionResponse(data);
      if (parsed.length > 0) {
        return parsed;
      }
      lastError = new Error(`Unexpected fallback translation length: ${parsed.length}`);
    } catch (err) {
      lastError = err;
      continue;
    }
  }
  throw lastError || new Error("LMStudio backend request failed.");
}

async function translateLinesWithDeepL(lines) {
  if (!backendConfig.deeplAuthKey) {
    throw new Error("DeepL auth key is not configured.");
  }
  const params = new URLSearchParams();
  params.append("auth_key", backendConfig.deeplAuthKey);
  lines.forEach((line) => params.append("text", line));
  params.append("target_lang", "VI");
  params.append("source_lang", "AUTO");

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), LMSTUDIO_TIMEOUT_MS);
  const response = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    body: params,
    signal: controller.signal,
  });
  clearTimeout(timeout);
  if (!response.ok) {
    throw new Error(`DeepL returned ${response.status}`);
  }
  const data = await response.json();
  return (data.translations || []).map((item) => item.text || "");
}

async function translateLinesWithGoogle(lines) {
  if (!backendConfig.googleApiKey) {
    throw new Error("Google Translate API key is not configured.");
  }
  const body = {
    q: lines,
    source: "ja",
    target: "vi",
    format: "text",
  };

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), LMSTUDIO_TIMEOUT_MS);
  const response = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(backendConfig.googleApiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timeout);
  if (!response.ok) {
    throw new Error(`Google Translate returned ${response.status}`);
  }
  const data = await response.json();
  if (!data.data || !Array.isArray(data.data.translations)) {
    throw new Error("Unexpected Google Translate response.");
  }
  return data.data.translations.map((item) => item.translatedText || "");
}

async function visionDetectAndTranslate(dataUrl, rect, cropScale) {
  const prompt = [
    "This is a manga/manhwa/comic image.",
    "Find every Chinese (包括繁體) and English text block in the image.",
    "For each text block return its position as fractions of image size (0.0–1.0) and its Vietnamese translation.",
    "Return ONLY a valid JSON array — no other text:",
    '[{"x":0.05,"y":0.10,"w":0.90,"h":0.08,"vi":"Vietnamese translation here"}]',
    "If no Chinese or English text is found, return: []",
  ].join("\n");

  const payload = {
    model: backendConfig.lmstudioModel,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: prompt },
      ],
    }],
    temperature: 0.05,
    max_tokens: 1400,
  };

  const data = await proxyFetch(`${backendConfig.lmstudioUrl}/v1/chat/completions`, payload);
  const content = (data?.choices?.[0]?.message?.content || "").trim();
  console.log("[Vision] raw response:", content.slice(0, 400));

  const jsonStart = content.indexOf("[");
  const jsonEnd = content.lastIndexOf("]");
  if (jsonStart === -1 || jsonEnd === -1) throw new Error("Vision: no JSON array in response");

  const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("Vision: empty result array");

  const imgW = rect.width * cropScale;
  const imgH = rect.height * cropScale;

  return parsed
    .filter((item) => item.vi && item.w > 0 && item.h > 0)
    .map((item) => ({
      box: [
        (item.x || 0) * imgW,
        (item.y || 0) * imgH,
        Math.max((item.w || 0) * imgW, 20),
        Math.max((item.h || 0) * imgH, 20),
      ],
      text: item.src || "",
      translation: String(item.vi).trim(),
    }));
}

async function sendToServer(dataUrl, rect, cacheKey, cropScale) {
  if (!cropScale || cropScale <= 0) cropScale = window.devicePixelRatio || 1;
  try {
    let items = null;

    if (backendConfig.type === "LMStudio Vision") {
      setStatus("Detecting & translating with Vision AI…");
      try {
        items = await visionDetectAndTranslate(dataUrl, rect, cropScale);
        console.log("[Vision] detected items:", items.length);
      } catch (e) {
        console.warn("[Vision] falling back to OCR:", e.message);
        items = null;
      }
    }

    if (!items || !items.length) {
      setStatus("Running OCR in browser...");
      const ocrItems = await requestOCR(dataUrl);
      if (!ocrItems.length) {
        setStatus("No text detected during OCR.", true);
        return;
      }

      items = ocrItems.map((item) => ({
        box: item.box ? [item.box[0], item.box[1], item.box[2] - item.box[0], item.box[3] - item.box[1]] : [0, 0, 0, 0],
        text: item.text || "",
        translation: memoryGet(buildMemoryKey(item.text || "")) || "",
      }));

      const missingLines = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !item.translation && item.text)
        .map(({ item }) => item.text);

      if (missingLines.length) {
        setStatus(`Translating text with ${backendConfig.type}...`);
        const translated = await translateLines(missingLines);
        let missingIndex = 0;
        items.forEach((item) => {
          if (!item.translation && item.text) {
            item.translation = translated[missingIndex] || "";
            missingIndex += 1;
          }
          if (item.text) {
            memorySet(buildMemoryKey(item.text), item.translation);
          }
        });
      }
    }

    saveTranslationMemory();
    cacheSet(cacheKey, { items, cropScale });
    renderAnnotations(items, rect, cropScale);
    setStatus(`Translated ${items.length} items in browser.`);
  } catch (error) {
    console.error(error);
    if (error.name === "AbortError") {
      setStatus(`${backendConfig.type} request timed out. Check backend or network.`, true);
    } else if (error.message && error.message.includes("Failed to fetch")) {
      setStatus(`${backendConfig.type} backend or OCR server offline.`, true);
    } else {
      setStatus(`Translation error: ${error.message}`, true);
    }
  }
}

function dedupeTranslatedItems(items) {
  const merged = [];
  for (const item of items) {
    const duplicate = merged.find((existing) => {
      return (
        existing.translation === item.translation &&
        existing.text === item.text &&
        Math.abs(existing.box[0] - item.box[0]) < 12 &&
        Math.abs(existing.box[1] - item.box[1]) < 12 &&
        Math.abs(existing.box[2] - item.box[2]) < 16 &&
        Math.abs(existing.box[3] - item.box[3]) < 16
      );
    });
    if (!duplicate) {
      merged.push(item);
    }
  }
  return merged;
}

function renderAnnotations(items, rect, cropScale, cleanedImageUrl) {
  if (!annotationLayer) return;
  annotationLayer.innerHTML = "";
  const scale = (cropScale && cropScale > 0) ? cropScale : (window.devicePixelRatio || 1);

  if (cleanedImageUrl) {
    const overlay = document.createElement("div");
    overlay.className = "cleaned-overlay";
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.backgroundImage = `url(${cleanedImageUrl})`;
    overlay.style.backgroundSize = `${rect.width}px ${rect.height}px`;
    annotationLayer.appendChild(overlay);
  }

  const uniqueItems = dedupeTranslatedItems(items);
  uniqueItems.forEach((item) => {
    const label = item.translation || "";
    const top = rect.top + item.box[1] / scale;
    const left = rect.left + item.box[0] / scale;
    const width = Math.max(item.box[2] / scale, 120);
    const height = Math.max(item.box[3] / scale, 24);

    const box = document.createElement("div");
    box.className = "annotation-box";
    if (label) {
      box.textContent = label;
    }
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.minHeight = `${height}px`;
    box.style.fontSize = `${overlayFontSize}px`;
    box.style.padding = "8px 10px";
    annotationLayer.appendChild(box);
  });
}

createUI();

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.action) {
    return;
  }

  if (message.action === "toggle-auto-scan") {
    onStartStopClicked();
  }

  if (message.action === "capture-now") {
    scanOnce();
  }
});
