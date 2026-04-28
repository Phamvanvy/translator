const SERVER_URL = "http://127.0.0.1:8000";
let ocrLang = localStorage.getItem("ocrLang") || "ch";
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
    .menu button { width: 100%; border: none; border-radius: 12px; padding: 10px 12px; margin: 6px 0; font-size: 13px; background: rgba(255,255,255,0.08); color: #f8fafc; cursor: pointer; transition: background .2s ease; }
    .menu button:hover { background: rgba(255,255,255,0.16); }
    .status { margin-top: 8px; font-size: 12px; color: #94a3b8; }
    .status strong { color: #e2e8f0; }
    .status.error strong { color: #fca5a5; }
    .selection-overlay { position: fixed; inset: 0; background: rgba(20, 24, 32, 0.22); cursor: crosshair; pointer-events: auto; display: none; }
    .region-box { position: fixed; border: 2px dashed #38bdf8; background: rgba(56, 189, 248, 0.16); pointer-events: none; display: none; }
    .annotation-layer { position: fixed; inset: 0; pointer-events: none; }
    .cleaned-overlay { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; background-repeat: no-repeat; background-position: top left; background-size: contain; opacity: 0.96; z-index: 0; }
    .annotation-box { position: absolute; display: flex; align-items: flex-start; justify-content: center; background: rgba(10, 10, 12, 0.92); backdrop-filter: blur(8px) saturate(1.4); -webkit-backdrop-filter: blur(8px) saturate(1.4); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 6px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6); padding: 6px 8px; box-sizing: border-box; z-index: 10000; overflow: hidden; }
    .annotation-text { color: #ffffff; font-size: 16px; font-family: 'Be Vietnam Pro', 'Lexend', 'Segoe UI', ui-sans-serif, sans-serif; font-weight: 600; line-height: 1.4; text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,0.9); word-break: break-word; white-space: pre-wrap; letter-spacing: 0; }
    .annotation-text.long { font-size: 14px; line-height: 1.35; }
  `;

  const root = document.createElement("div");
  root.className = "root";
  root.innerHTML = `
    <button class="fab" id="fab" title="Auto Translator">🔎</button>
    <div class="menu" id="menu">
      <h4>Auto Translator</h4>
      <button id="btn-start">Start Scan</button>
      <button id="btn-select">Select Region</button>
      <button id="btn-clear">Clear Region</button>
      <button id="btn-glossary">Glossary</button>
      <button id="btn-characters">Character Names</button>
      <button id="btn-lang">OCR: Chinese</button>
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
  selectButton.addEventListener("click", onSelectClicked);
  clearButton.addEventListener("click", onClearClicked);
  glossaryButton = shadow.getElementById("btn-glossary");
  glossaryButton.addEventListener("click", onGlossaryClicked);
  characterButton = shadow.getElementById("btn-characters");
  characterButton.addEventListener("click", onCharacterClicked);

  const langButton = shadow.getElementById("btn-lang");
  const langLabels = { ch: "OCR: Chinese", japan: "OCR: Japanese", en: "OCR: English" };
  langButton.textContent = langLabels[ocrLang] || `OCR: ${ocrLang}`;
  langButton.addEventListener("click", () => {
    const langs = ["ch", "japan", "en"];
    const idx = (langs.indexOf(ocrLang) + 1) % langs.length;
    ocrLang = langs[idx];
    localStorage.setItem("ocrLang", ocrLang);
    langButton.textContent = langLabels[ocrLang] || `OCR: ${ocrLang}`;
    setStatus(`OCR language set to ${ocrLang}.`);
  });

  selectionOverlay.addEventListener("mousedown", onSelectionMouseDown);
  loadGlossary();
  loadCharacterNames();
  loadTranslationMemory();
  selectionOverlay.addEventListener("mousemove", onSelectionMouseMove);
  selectionOverlay.addEventListener("mouseup", onSelectionMouseUp);
  selectionOverlay.addEventListener("mouseleave", onSelectionMouseLeave);

  window.addEventListener("scroll", clearAnnotations);
  window.addEventListener("resize", clearAnnotations);

  updateButtons();
}

function clearAnnotations() {
  if (!annotationLayer) return;
  annotationLayer.innerHTML = "";
  setStatus("Overlay cleared after scroll/resize.");
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

async function startScan() {
  if (scanMode) return;
  scanMode = true;
  setStatus("Scanning now...");
  updateButtons();
  try {
    await scanOnce();
  } finally {
    if (scanMode) {
      scanMode = false;
      updateButtons();
    }
  }
}

function stopScan() {
  scanMode = false;
  if (scanTimer) {
    window.clearInterval(scanTimer);
    scanTimer = null;
  }
  updateButtons();
  setStatus("Scan stopped.");
}

async function scanOnce() {
  const now = Date.now();
  if (now - lastCaptureTimestamp < 1000) {
    return;
  }
  lastCaptureTimestamp = now;
  const rect = selectedRect || getViewportRect();
  const prefetchRect = selectedRect ? expandRect(rect, 0.2) : rect;
  try {
    await initiateCapture(rect, prefetchRect);
  } catch (err) {
    const message = err?.message?.toLowerCase() || "";
    if (
      message.includes("active tab") ||
      message.includes("activetab") ||
      message.includes("extension context invalidated") ||
      message.includes("quota") ||
      message.includes("failed to fetch") ||
      message.includes("server returned") ||
      err?.name === "AbortError"
    ) {
      stopScan();
      setStatus(`Scan error: ${err.message}`, true);
      return;
    }
    console.error(err);
    setStatus(`Scan error: ${err.message}`, true);
  }
}

async function initiateCapture(rect, prefetchRect) {
  return new Promise((resolve, reject) => {
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
        const cacheKey = hashImageData(croppedImageData);

        const prefetchDataUrl = prefetchRect && (prefetchRect.left !== rect.left || prefetchRect.top !== rect.top || prefetchRect.width !== rect.width || prefetchRect.height !== rect.height)
          ? await cropDataUrl(response.dataUrl, prefetchRect)
          : croppedDataUrl;
        const prefetchImageData = await getImageDataFromDataUrl(prefetchDataUrl);
        const prefetchHash = hashImageData(prefetchImageData);

        if (lastPrefetchData && !hasFrameChanged(lastPrefetchData, prefetchImageData)) {
          setStatus("No visual change detected in buffered viewport.");
          const cached = cacheGet(cacheKey);
          if (cached) {
            renderAnnotations(cached, rect);
          }
          return resolve();
        }

        if (scanBuffer.includes(prefetchHash)) {
          const cached = cacheGet(cacheKey);
          if (cached) {
            setStatus("Buffered scan hit, using cached translation.");
            renderAnnotations(cached, rect);
            lastPrefetchData = prefetchImageData;
            return resolve();
          }
        }

        lastPrefetchData = prefetchImageData;
        pushScanBuffer(prefetchHash);
        enqueueScan(croppedDataUrl, rect, cacheKey);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function enqueueScan(dataUrl, rect, cacheKey) {
  const cached = cacheGet(cacheKey);
  if (cached) {
    renderAnnotations(cached, rect);
    setStatus("Loaded translation from cache.");
    return;
  }

  const task = { dataUrl, rect, cacheKey };
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
    await sendToServer(task.dataUrl, task.rect, task.cacheKey);
  } finally {
    inFlightScan = false;
    if (queuedScan) {
      const next = queuedScan;
      queuedScan = null;
      processScan(next);
    }
  }
}

function cropDataUrl(dataUrl, rect) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      // Compute the actual scale of the screenshot image vs CSS viewport.
      // Chrome captureVisibleTab gives 1x on Windows and DPR× on macOS Retina.
      // Using the measured ratio avoids hard-coding devicePixelRatio.
      const scaleX = image.naturalWidth  / window.innerWidth;
      const scaleY = image.naturalHeight / window.innerHeight;
      const canvas = document.createElement("canvas");
      // Output canvas is always at CSS-pixel resolution so OCR box
      // coordinates map 1:1 to CSS pixels — no DPR division needed later.
      canvas.width  = Math.round(rect.width);
      canvas.height = Math.round(rect.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(
        image,
        Math.round(rect.left   * scaleX),
        Math.round(rect.top    * scaleY),
        Math.round(rect.width  * scaleX),
        Math.round(rect.height * scaleY),
        0, 0, canvas.width, canvas.height
      );
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function splitRectIntoTwoRegions(rect) {
  if (rect.width > 880 && rect.width >= rect.height) {
    const half = Math.floor(rect.width / 2);
    return [
      { left: 0, top: 0, width: half + 20, height: rect.height },
      { left: half - 20, top: 0, width: rect.width - half + 20, height: rect.height },
    ];
  }
  if (rect.height > 1100 && rect.height > rect.width) {
    const half = Math.floor(rect.height / 2);
    return [
      { left: 0, top: 0, width: rect.width, height: half + 20 },
      { left: 0, top: half - 20, width: rect.width, height: rect.height - half + 20 },
    ];
  }
  return [{ left: 0, top: 0, width: rect.width, height: rect.height }];
}

function dedupeTranslatedItems(items) {
  const merged = [];
  for (const item of items) {
    const duplicate = merged.find((existing) => {
      return (
        existing.translation === item.translation &&
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

// Merge items whose bounding boxes are within `gap` physical pixels of each other.
// This turns fragmented per-column boxes into a single speech-bubble block.
function mergeNearbyBoxes(items, gap = 18) {
  if (!items.length) return [];

  let groups = items
    .filter(item => (item.translation || "").trim())
    .map(item => ({
      box: [...item.box], // [left, top, right, bottom] physical px
      translation: (item.translation || "").trim(),
    }));

  // Iteratively merge until stable
  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    const used = new Set();

    for (let i = 0; i < groups.length; i++) {
      if (used.has(i)) continue;
      const cur = { box: [...groups[i].box], translation: groups[i].translation };

      for (let j = i + 1; j < groups.length; j++) {
        if (used.has(j)) continue;
        const other = groups[j];

        // Gap between the two boxes on each axis
        const gapX = Math.max(0, Math.max(cur.box[0], other.box[0]) - Math.min(cur.box[2], other.box[2]));
        const gapY = Math.max(0, Math.max(cur.box[1], other.box[1]) - Math.min(cur.box[3], other.box[3]));

        if (gapX <= gap && gapY <= gap) {
          cur.box[0] = Math.min(cur.box[0], other.box[0]);
          cur.box[1] = Math.min(cur.box[1], other.box[1]);
          cur.box[2] = Math.max(cur.box[2], other.box[2]);
          cur.box[3] = Math.max(cur.box[3], other.box[3]);
          cur.translation = cur.translation + " " + other.translation;
          used.add(j);
          changed = true;
        }
      }

      next.push(cur);
      used.add(i);
    }

    groups = next;
  }

  return groups;
}

async function requestTileTranslation(tileDataUrl, tileRect) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 600000);
  try {
    const response = await fetch(`${SERVER_URL}/api/translate-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: tileDataUrl,
        lang: ocrLang,
        glossary,
        character_names: characterNames,
        domain_id: getDomainId(),
        tab_id: currentTabId,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }
    const data = await response.json();
    const results = (data.results || []).map((item) => ({
      ...item,
      box: [
        item.box[0] + tileRect.left,
        item.box[1] + tileRect.top,
        item.box[2] + tileRect.left,
        item.box[3] + tileRect.top,
      ],
    }));
    return { results, cleaned_image: data.cleaned_image };
  } finally {
    clearTimeout(timeout);
  }
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

function hashImageData(imageData) {
  let hash = 5381;
  const data = imageData.data;
  const step = 32;
  for (let i = 0; i < data.length; i += step) {
    hash = (hash * 33) ^ data[i];
  }
  return (hash >>> 0).toString(36);
}

async function sendToServer(dataUrl, rect, cacheKey) {
  let timeout = null;
  try {
    setStatus("Detecting text blobs...");
    const controller = new AbortController();
    timeout = window.setTimeout(() => controller.abort(), 600000);
    const response = await fetch(`${SERVER_URL}/api/translate-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: dataUrl,
        lang: ocrLang,
        glossary,
        character_names: characterNames,
        domain_id: getDomainId(),
        tab_id: currentTabId,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }
    const result = await response.json();
    const items = result.results || [];
    cacheSet(cacheKey, items);
    items.forEach((item) => {
      if (item.text && item.translation) {
        const memKey = buildMemoryKey(item.text);
        memorySet(memKey, item.translation);
      }
    });
    saveTranslationMemory();
    renderAnnotations(items, rect, result.cleaned_image);
    setStatus(`Translated ${items.length} items.`);
  } catch (error) {
    console.error(error);
    if (scanMode) {
      stopScan();
    }
    if (error.name === "AbortError") {
      setStatus("Server request timed out. Auto-scan stopped.", true);
    } else if (error.message && error.message.includes("Failed to fetch")) {
      setStatus("Server offline or network error. Auto-scan stopped.", true);
    } else {
      setStatus(`Server error: ${error.message}. Auto-scan stopped.`, true);
    }
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function groupAnnotationItems(items) {
  const rows = [];
  const sorted = [...items].filter((item) => item.translation || item.text).sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  for (const item of sorted) {
    const label = item.translation || item.text || "";
    if (!label) continue;
    const itemMid = (item.box[1] + item.box[3]) / 2;
    const itemH   = item.box[3] - item.box[1];
    const group = rows.find((row) => Math.abs(row.mid - itemMid) < Math.max(24, itemH * 0.6));
    if (group) {
      group.items.push(item);
      group.left   = Math.min(group.left, item.box[0]);
      group.top    = Math.min(group.top,  item.box[1]);
      group.right  = Math.max(group.right, item.box[2]);
      group.bottom = Math.max(group.bottom, item.box[3]);
      group.mid    = (group.top + group.bottom) / 2;
    } else {
      rows.push({
        items: [item],
        left:   item.box[0],
        top:    item.box[1],
        right:  item.box[2],
        bottom: item.box[3],
        mid: itemMid,
      });
    }
  }
  return rows.map((row) => ({
    left:   row.left,
    top:    row.top,
    width:  Math.max(row.right - row.left, 120),
    height: Math.max(row.bottom - row.top, 24),
    text:   row.items.map((item) => item.translation || item.text).join(" "),
  }));
}

function renderAnnotations(items, rect, cleanedImageUrl) {
  if (!annotationLayer) return;
  annotationLayer.innerHTML = "";

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
  const mergedGroups = mergeNearbyBoxes(uniqueItems, 30);  // 30px gap: merge fragments in same bubble without merging separate bubbles
  const BLEED = 4; // CSS px bleed on each side to cover source glyph edges
  const GAP   = 6; // minimum gap between two adjacent boxes after collision push

  // ── Pass 1: compute ideal geometry for every group ──────────────────────────
  // Box coordinates are in CSS pixels (cropDataUrl now outputs at CSS resolution).
  const defs = mergedGroups
    .map((group) => {
      let raw = group.translation.trim();
      if (!raw) return null;
      // Strip leaked Python-repr dict strings: {'box_id': 1, 'vietnamese_text': 'Xin chào'}
      const dictMatch = raw.match(/['"]\s*vietnamese_text\s*['"]\s*:\s*['"]([^'"]+)['"]/);
      if (dictMatch) raw = dictMatch[1].trim();
      if (!raw) return null;

      const srcLeft   = rect.left + group.box[0] - BLEED;
      const srcTop    = rect.top  + group.box[1] - BLEED;
      const srcRight  = rect.left + group.box[2] + BLEED;
      const srcBottom = rect.top  + group.box[3] + BLEED;
      const srcW = Math.max(srcRight - srcLeft, 1);
      const srcH = Math.max(srcBottom - srcTop, 1);

      const isVerticalSrc = srcH > srcW * 1.5;
      // Use translated text length to size the box, not source dimensions.
      // ~8.5px per character + 20px padding; cap vertical-source boxes at 180px
      // so they don't balloon into adjacent artwork.
      const charW = Math.round(raw.length * 8.5) + 20;
      const displayW = isVerticalSrc
        ? Math.min(Math.max(charW, srcW, 80), 180)
        : Math.min(Math.max(charW, srcW, 80), 300);
      // minH: for vertical sources keep srcH so we cover the original column;
      // for horizontal keep at least srcH.
      const displayMinH = srcH;

      return { raw, left: srcLeft, top: srcTop, width: displayW, minH: displayMinH };
    })
    .filter(Boolean);

  // ── Pass 2: resolve horizontal overlaps (sort left → right, push right) ────
  defs.sort((a, b) => a.left - b.left);
  for (let i = 0; i < defs.length; i++) {
    for (let j = i + 1; j < defs.length; j++) {
      const a = defs[i], b = defs[j];
      const overlapX = (a.left + a.width + GAP) - b.left;
      if (overlapX > 0) {
        // Check vertical overlap too — only push if rows actually intersect
        const aBottom = a.top + a.minH;
        const bBottom = b.top + b.minH;
        const vertOverlap = Math.min(aBottom, bBottom) - Math.max(a.top, b.top);
        if (vertOverlap > 0) {
          b.left = a.left + a.width + GAP;
        }
      }
    }
  }

  // ── Pass 3: clamp to viewport and render ────────────────────────────────────
  defs.forEach((def) => {
    let left = def.left;
    let top  = def.top;
    // Clamp horizontally
    if (left + def.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - def.width - 8);
    }
    if (left < 8) left = 8;
    // Clamp vertically: if the box bottom exceeds the viewport, shift up
    if (top + def.minH > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - def.minH - 8);
    }
    if (top < 8) top = 8;

    const box = document.createElement("div");
    box.className = "annotation-box";
    box.style.left      = `${left}px`;
    box.style.top       = `${top}px`;
    box.style.width     = `${def.width}px`;
    box.style.maxWidth  = `${def.width}px`;
    box.style.minHeight = `${def.minH}px`;
    const textEl = document.createElement("span");
    textEl.className = "annotation-text" + (def.raw.length > 30 ? " long" : "");
    textEl.textContent = def.raw;
    box.appendChild(textEl);
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
