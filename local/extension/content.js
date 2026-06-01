// ===== Globals =====
const SERVER_URL = "http://127.0.0.1:8000";
let ocrLang = localStorage.getItem("ocrLang") || "ch";
let appMode = localStorage.getItem("appMode") || "translate"; // "translate" | "ask"
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
let fabDragState = { active: false, moved: false, startX: 0, startY: 0, originLeft: 0, originTop: 0 };
let llmButton = null;
let autoClickButton = null;
let autoClickAnswer = localStorage.getItem("autoClickAnswer") === "true";
// Chat state (shared with content-chat.js)
let attachedChatImages = []; // array of base64 data URLs
let lastAskContext = "";     // context for follow-up questions
const chatHistory = [];      // [{role, content}]

// ===== Favicon helper =====

function setPageFavicon(url) {
  try {
    const head = document.head || document.documentElement;
    if (!head) return;
    const selectors = ['link[rel="icon"]', 'link[rel="shortcut icon"]', 'link[rel="apple-touch-icon"]'];
    const icons = selectors.map(sel => Array.from(head.querySelectorAll(sel))).flat();
    if (icons.length === 0) {
      const link = document.createElement('link');
      link.rel = 'icon'; link.href = url;
      head.appendChild(link);
      return;
    }
    icons.forEach(icon => { icon.href = url; });
  } catch (err) { console.warn('Failed to set page favicon', err); }
}

// ===== createUI =====

function createUI() {
  if (shadowRootHost) return;

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
    .fab { position: fixed; right: 18px; bottom: 18px; width: 52px; height: 52px; border-radius: 50%; border: none; background: rgba(20,20,20,0.85); color: white; font-size: 24px; display: inline-flex; align-items: center; justify-content: center; cursor: grab; pointer-events: auto; transition: transform .2s ease, background .2s ease, box-shadow .2s ease, opacity .2s ease; box-shadow: 0 14px 40px rgba(0,0,0,0.25); opacity: 0.88; }
    .fab:hover { transform: scale(1.08); background: rgba(34,130,195,0.92); opacity: 1; }
    .fab.dragging { cursor: grabbing; transform: scale(1.08); box-shadow: 0 18px 44px rgba(0,0,0,0.35); }
    .fab.scanning { background: rgba(220,38,38,0.92); animation: pulse 1.2s infinite; }
    .fab.error { background: rgba(245,158,11,0.96); }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(220,38,38,0.5); } 70% { box-shadow: 0 0 0 18px rgba(220,38,38,0); } 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); } }
    .menu { position: fixed; right: 18px; bottom: 82px; width: 300px; background: rgba(14,18,24,0.97); border-radius: 18px; box-shadow: 0 24px 60px rgba(0,0,0,0.4); color: #f8fafc; font-family: ui-sans-serif, system-ui, sans-serif; pointer-events: auto; display: none; flex-direction: column; height: 500px; max-height: 88vh; overflow: hidden; }
    .menu.open { display: flex; }
    .menu button { border: none; border-radius: 10px; padding: 9px 12px; margin: 3px 0; font-size: 13px; background: rgba(255,255,255,0.07); color: #f8fafc; cursor: pointer; transition: background .2s ease; text-align: left; }
    .menu button:hover { background: rgba(255,255,255,0.14); }
    .menu-tab-bar { display: flex; gap: 4px; padding: 10px 10px 8px; flex-shrink: 0; border-bottom: 1px solid rgba(255,255,255,0.07); }
    .menu-tab-btn { flex: 1; border: 1px solid rgba(255,255,255,0.1) !important; border-radius: 10px !important; padding: 7px 4px !important; font-size: 12px !important; font-weight: 600 !important; background: rgba(255,255,255,0.05) !important; color: #64748b !important; cursor: pointer !important; transition: all .2s !important; margin: 0 !important; text-align: center !important; }
    .menu-tab-btn.active { background: rgba(56,189,248,0.18) !important; border-color: rgba(56,189,248,0.5) !important; color: #38bdf8 !important; }
    .menu-tab-btn:hover:not(.active) { background: rgba(255,255,255,0.1) !important; color: #e2e8f0 !important; }
    .menu-tab-pane { display: none; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
    .menu-tab-pane.active { display: flex; }
    #tab-control { overflow-y: auto; padding: 10px; }
    .mode-toggle { display: flex; gap: 6px; margin-bottom: 8px; }
    .mode-btn { flex: 1; border-radius: 9px !important; padding: 7px 4px !important; font-size: 12px !important; font-weight: 600 !important; border: 1px solid rgba(255,255,255,0.08) !important; margin: 0 !important; text-align: center !important; cursor: pointer; transition: all .2s ease; }
    .mode-btn.active { background: rgba(56,189,248,0.2) !important; border-color: rgba(56,189,248,0.6) !important; color: #38bdf8 !important; }
    .mode-btn:not(.active) { background: rgba(255,255,255,0.06) !important; color: #94a3b8 !important; }
    .mode-btn:hover:not(.active) { background: rgba(255,255,255,0.12) !important; color: #f8fafc !important; }
    .status { margin-top: 6px; font-size: 12px; color: #94a3b8; padding: 0 2px; }
    .status strong { color: #e2e8f0; }
    .status.error strong { color: #fca5a5; }
    #tab-chat { padding: 0; }
    .chat-header { display:flex; align-items:center; justify-content:space-between; padding:6px 10px 5px; border-bottom:1px solid rgba(255,255,255,0.07); flex-shrink:0; }
    .chat-header-title { font-size:10px; color:#475569; font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
    .chat-clear-btn { background:rgba(255,255,255,0.06) !important; border:1px solid rgba(255,255,255,0.1) !important; border-radius:7px !important; color:#64748b !important; font-size:12px !important; padding:3px 7px !important; cursor:pointer; transition:all .2s; width:auto !important; margin:0 !important; }
    .chat-clear-btn:hover { background:rgba(239,68,68,0.2) !important; border-color:rgba(239,68,68,0.4) !important; color:#f87171 !important; }
    .chat-area { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 10px; scroll-behavior: smooth; min-height: 0; }
    .chat-msg { padding: 9px 11px; border-radius: 12px; font-size: 12.5px; line-height: 1.55; word-break: break-word; }
    .chat-msg.bot { background: rgba(56,189,248,0.1); border: 1px solid rgba(56,189,248,0.2); color: #e2e8f0; align-self: flex-start; width: 100%; box-sizing: border-box; }
    .chat-msg.user { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); color: #cbd5e1; align-self: flex-end; max-width: 90%; }
    .chat-cursor { display: inline-block; width: 2px; height: 1em; background: #38bdf8; margin-left: 2px; vertical-align: text-bottom; animation: cur-blink 0.7s step-end infinite; }
    .chat-retry-btn { margin-top: 4px; padding: 4px 12px; border-radius: 6px; border: 1px solid #38bdf8; background: #0f172a; color: #38bdf8; font-size: 12px; cursor: pointer; }
    .chat-retry-btn:hover { background: #1e3a5f; }
    @keyframes cur-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
    .chat-q-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 3px; }
    .chat-q-text { color: #94a3b8; font-size: 11px; margin-bottom: 6px; border-left: 2px solid rgba(255,255,255,0.12); padding-left: 6px; }
    .chat-a-label { font-size: 10px; color: #4ade80; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 3px; }
    .chat-a-list { display: flex; flex-direction: column; gap: 3px; margin-bottom: 5px; }
    .chat-a-item { font-weight: 700; font-size: 13px; padding: 3px 6px; border-left: 3px solid; border-radius: 3px; background: rgba(255,255,255,0.04); }
    .chat-exp-label { font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: .04em; margin-top: 5px; margin-bottom: 2px; }
    .chat-exp-text { font-size: 11.5px; color: #94a3b8; line-height: 1.5; }
    .chat-sep { border: none; border-top: 1px solid rgba(255,255,255,0.07); margin: 8px 0; }
    .chat-attach-bar { display: none; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px solid rgba(255,255,255,0.06); background: rgba(10,13,18,0.8); flex-shrink: 0; overflow-x: auto; }
    .chat-attach-thumb { width: 40px; height: 40px; border-radius: 7px; object-fit: cover; border: 1px solid rgba(255,255,255,0.15); display: block; }
    .chat-attach-remove { position: absolute !important; top: -5px !important; right: -5px !important; background: rgba(20,20,20,0.9) !important; border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 50% !important; color: #f87171 !important; cursor: pointer !important; font-size: 9px !important; width: 16px !important; height: 16px !important; padding: 0 !important; line-height: 16px !important; text-align: center !important; transition: background .15s !important; }
    .chat-attach-remove:hover { background: rgba(239,68,68,0.85) !important; color: white !important; }
    .chat-img-preview { max-width: 100%; max-height: 160px; border-radius: 8px; margin-top: 5px; display: block; border: 1px solid rgba(255,255,255,0.1); object-fit: contain; }
    .chat-input-row { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; background: rgba(10,13,18,0.8); align-items: center; }
    .chat-attach-btn { background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; color: #94a3b8; font-size: 16px; padding: 7px 10px; cursor: pointer; flex-shrink: 0; transition: all .2s; }
    .chat-attach-btn:hover { background: rgba(255,255,255,0.14); color: #38bdf8; }
    .chat-input { flex: 1; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; color: #f8fafc; font-size: 12.5px; padding: 8px 10px; outline: none; font-family: inherit; min-width: 0; }
    .chat-input:focus { border-color: rgba(56,189,248,0.5); background: rgba(255,255,255,0.1); }
    .chat-input::placeholder { color: #475569; }
    .chat-input::-webkit-search-cancel-button,
    .chat-input::-webkit-search-decoration,
    .chat-input::-ms-clear { display: none; }
    .chat-msg.bot p { margin: 2px 0; }
    .chat-msg.bot ul, .chat-msg.bot ol { margin: 4px 0; padding-left: 18px; }
    .chat-msg.bot li { margin: 2px 0; line-height: 1.5; }
    .chat-msg.bot code { background: rgba(255,255,255,0.1); padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 11px; color: #7dd3fc; }
    .chat-msg.bot pre { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 8px 10px; overflow-x: auto; margin: 6px 0; }
    .chat-msg.bot pre code { background: none; padding: 0; color: #e2e8f0; }
    .chat-msg.bot strong { color: #f8fafc; font-weight: 700; }
    .chat-msg.bot em { color: #cbd5e1; font-style: italic; }
    #btn-auto-click { font-weight: 600 !important; }
    #btn-auto-click.active { background: rgba(74,222,128,0.18) !important; border: 1px solid rgba(74,222,128,0.5) !important; color: #4ade80 !important; }
    #btn-auto-click:not(.active) { color: #94a3b8 !important; }
    .chat-msg.bot h2, .chat-msg.bot h3 { font-size: 13px; font-weight: 700; color: #38bdf8; margin: 8px 0 3px; border-bottom: 1px solid rgba(56,189,248,0.2); padding-bottom: 2px; }
    .selection-overlay { position: fixed; inset: 0; background: rgba(20,24,32,0.22); cursor: crosshair; pointer-events: auto; display: none; }
    .region-box { position: fixed; border: 2px dashed #38bdf8; background: rgba(56,189,248,0.16); pointer-events: none; display: none; }
    .annotation-layer { position: fixed; inset: 0; pointer-events: none; }
    .cleaned-overlay { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; background-repeat: no-repeat; background-position: top left; background-size: contain; opacity: 0.96; z-index: 0; }
    .annotation-box { position: absolute; display: flex; align-items: flex-start; justify-content: center; background: rgba(10,10,12,0.92); backdrop-filter: blur(8px) saturate(1.4); -webkit-backdrop-filter: blur(8px) saturate(1.4); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,0.6); padding: 6px 8px; box-sizing: border-box; z-index: 10000; overflow: hidden; }
    .annotation-text { color: #ffffff; font-size: 16px; font-family: 'Be Vietnam Pro','Lexend','Segoe UI',ui-sans-serif,sans-serif; font-weight: 600; line-height: 1.4; text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,0.9); word-break: break-word; white-space: pre-wrap; }
    .annotation-text.long { font-size: 14px; line-height: 1.35; }
  `;

  const root = document.createElement("div");
  root.className = "root";
  root.innerHTML = `
    <button class="fab" id="fab" title="Auto Translator">&#128269;</button>
    <div class="menu" id="menu">
      <div class="menu-tab-bar">
        <button class="menu-tab-btn active" id="tab-btn-control">&#9881; Controls</button>
        <button class="menu-tab-btn" id="tab-btn-chat">&#128172; AI Chat</button>
      </div>
      <div class="menu-tab-pane active" id="tab-control">
        <div class="mode-toggle">
          <button class="mode-btn" id="btn-mode-translate">&#128260; Dịch</button>
          <button class="mode-btn" id="btn-mode-ask">&#10067; Ask</button>
        </div>
        <button id="btn-start">Start Scan</button>
        <button id="btn-fullpage">Scan Full Page</button>
        <button id="btn-agent">&#129302; Run Agent</button>
        <button id="btn-upload-ask">&#128228; Upload &amp; Ask</button>
        <button id="btn-auto-click">&#128432; Auto Click: OFF</button>
        <button id="btn-select">Select Region</button>
        <button id="btn-clear">Clear Region</button>
        <button id="btn-glossary">Glossary</button>
        <button id="btn-characters">Character Names</button>
        <button id="btn-llm">LLM backend</button>
        <button id="btn-qa">Q&amp;A Database</button>
        <button id="btn-lang">OCR: Chinese</button>
        <div class="status">Status: <strong id="status">Idle</strong></div>
      </div>
      <div class="menu-tab-pane" id="tab-chat">
        <div class="chat-header">
          <span class="chat-header-title">History</span>
          <button class="chat-clear-btn" id="chat-clear" title="Clear all chat history">&#128465; Clear</button>
        </div>
        <div class="chat-area" id="chat-area"></div>
        <div class="chat-attach-bar" id="chat-attach-bar"></div>
        <div class="chat-input-row">
          <input type="file" id="chat-file-input" accept="image/*" multiple style="display:none">
          <button class="chat-attach-btn" id="chat-attach" title="Attach image (or Ctrl+V to paste)">&#128206;</button>
          <input class="chat-input" id="chat-input" type="text" placeholder="Type or paste image, Enter to send…">
        </div>
      </div>
    </div>
    <div class="selection-overlay" id="selectionOverlay"></div>
    <div class="region-box" id="regionBox"></div>
    <div class="annotation-layer" id="annotationLayer"></div>
  `;

  shadow.appendChild(style);
  shadow.appendChild(root);

  fabButton       = shadow.getElementById("fab");
  menuPanel       = shadow.getElementById("menu");
  startButton     = shadow.getElementById("btn-start");
  selectButton    = shadow.getElementById("btn-select");
  clearButton     = shadow.getElementById("btn-clear");
  statusSpan      = shadow.getElementById("status");
  selectionOverlay = shadow.getElementById("selectionOverlay");
  regionBox       = shadow.getElementById("regionBox");
  annotationLayer = shadow.getElementById("annotationLayer");

  fabButton.addEventListener("mousedown", onFabMouseDown);
  fabButton.addEventListener("click", onFabClicked);
  startButton.addEventListener("click", onStartStopClicked);
  shadow.getElementById("btn-fullpage").addEventListener("click", () => scanFullPage());
  shadow.getElementById("btn-agent").addEventListener("click", () => {
    const task = window.prompt(
      "Mô tả nhiệm vụ cho Agent:\n(Agent sẽ tự scroll, click, điền form để hoàn thành)",
      "Answer all quiz questions on this page"
    );
    if (task === null) return;
    runAgentLoop(task.trim() || "Complete the task on this page");
  });
  selectButton.addEventListener("click", onSelectClicked);
  clearButton.addEventListener("click", onClearClicked);
  glossaryButton = shadow.getElementById("btn-glossary");
  glossaryButton.addEventListener("click", onGlossaryClicked);
  characterButton = shadow.getElementById("btn-characters");
  characterButton.addEventListener("click", onCharacterClicked);
  llmButton = shadow.getElementById("btn-llm");
  llmButton.addEventListener("click", onLLMSettingsClicked);

  shadow.getElementById("tab-btn-control").addEventListener("click", () => switchTab("control"));
  shadow.getElementById("tab-btn-chat").addEventListener("click", () => switchTab("chat"));

  shadow.getElementById("btn-mode-translate").addEventListener("click", () => setAppMode("translate"));
  shadow.getElementById("btn-mode-ask").addEventListener("click", () => setAppMode("ask"));
  autoClickButton = shadow.getElementById("btn-auto-click");
  autoClickButton.addEventListener("click", () => {
    autoClickAnswer = !autoClickAnswer;
    localStorage.setItem("autoClickAnswer", autoClickAnswer ? "true" : "false");
    updateAutoClickButton();
    setStatus("Auto Click: " + (autoClickAnswer ? "ON" : "OFF"));
  });
  updateAutoClickButton();
  updateModeUI();
  updateLLMButton();

  shadow.getElementById("btn-qa").addEventListener("click", onQAClicked);
  shadow.getElementById("btn-upload-ask").addEventListener("click", () => onUploadAskClicked());
  shadow.getElementById("chat-clear").addEventListener("click", () => clearChat());

  // --- Chat input wiring ---
  const chatInput     = shadow.getElementById("chat-input");
  const chatAttachBtn = shadow.getElementById("chat-attach");
  const chatFileInput = shadow.getElementById("chat-file-input");

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text && attachedChatImages.length === 0) return;
      chatInput.value = "";
      sendChatMessage(text);
    }
  });

  // Paste from clipboard — intercept images
  chatInput.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    let hadImage = false;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        hadImage = true;
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = (ev) => { attachedChatImages.push(ev.target.result); updateAttachBar(); };
        reader.readAsDataURL(file);
      }
    }
    if (hadImage) e.preventDefault();
  });

  // File-picker (multi-select)
  chatAttachBtn.addEventListener("click", () => chatFileInput.click());
  chatFileInput.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    chatFileInput.value = "";
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => { attachedChatImages.push(ev.target.result); updateAttachBar(); };
      reader.readAsDataURL(file);
    });
  });

  // OCR language toggle
  const langButton = shadow.getElementById("btn-lang");
  const langLabels = { ch: "OCR: Chinese", japan: "OCR: Japanese", en: "OCR: English" };
  langButton.textContent = langLabels[ocrLang] || ("OCR: " + ocrLang);
  langButton.addEventListener("click", () => {
    const langs = ["ch", "japan", "en"];
    const idx = (langs.indexOf(ocrLang) + 1) % langs.length;
    ocrLang = langs[idx];
    localStorage.setItem("ocrLang", ocrLang);
    langButton.textContent = langLabels[ocrLang] || ("OCR: " + ocrLang);
    setStatus("OCR language set to " + ocrLang + ".");
  });

  selectionOverlay.addEventListener("mousedown", onSelectionMouseDown);
  selectionOverlay.addEventListener("mousemove", onSelectionMouseMove);
  selectionOverlay.addEventListener("mouseup",   onSelectionMouseUp);
  selectionOverlay.addEventListener("mouseleave", onSelectionMouseLeave);

  loadGlossary();
  loadCharacterNames();
  loadTranslationMemory();

  window.addEventListener("scroll",    clearAnnotations, { capture: true, passive: true });
  window.addEventListener("resize",    clearAnnotations, { capture: true, passive: true });
  window.addEventListener("wheel",     clearAnnotations, { capture: true, passive: true });
  window.addEventListener("touchmove", clearAnnotations, { capture: true, passive: true });
  document.addEventListener("scroll",  clearAnnotations, { capture: true, passive: true });

  updateButtons();
}

// ===== UI helpers =====

function clearAnnotations() {
  if (!annotationLayer) return;
  annotationLayer.innerHTML = "";
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
  fabDragState.moved  = false;
  fabDragState.startX = event.clientX;
  fabDragState.startY = event.clientY;
  const rect = fabButton.getBoundingClientRect();
  fabDragState.originLeft = rect.left;
  fabDragState.originTop  = rect.top;
  fabButton.classList.add("dragging");
  window.addEventListener("mousemove", onFabMouseMove);
  window.addEventListener("mouseup",   onFabMouseUp);
}

function onFabMouseMove(event) {
  if (!fabDragState.active || !fabButton) return;
  const dx = event.clientX - fabDragState.startX;
  const dy = event.clientY - fabDragState.startY;
  if (Math.abs(dx) + Math.abs(dy) > 6) fabDragState.moved = true;
  const newLeft = Math.min(Math.max(8, fabDragState.originLeft + dx), window.innerWidth  - fabButton.offsetWidth  - 8);
  const newTop  = Math.min(Math.max(8, fabDragState.originTop  + dy), window.innerHeight - fabButton.offsetHeight - 8);
  fabButton.style.left   = newLeft + "px";
  fabButton.style.top    = newTop  + "px";
  fabButton.style.right  = "auto";
  fabButton.style.bottom = "auto";
}

function onFabMouseUp() {
  if (!fabDragState.active || !fabButton) return;
  fabDragState.active = false;
  fabButton.classList.remove("dragging");
  window.removeEventListener("mousemove", onFabMouseMove);
  window.removeEventListener("mouseup",   onFabMouseUp);
}

function onFabClicked() {
  if (fabDragState.moved) { fabDragState.moved = false; return; }
  toggleMenu();
}

function updateButtons() {
  if (!startButton || !selectButton || !clearButton || !fabButton) return;
  startButton.textContent  = scanMode ? "Stop Scan" : "Start Scan";
  selectButton.textContent = selectionMode ? "Cancel Select" : selectedRect ? "Change Region" : "Select Region";
  clearButton.style.display = selectedRect ? "block" : "none";
  fabButton.classList.toggle("scanning", scanMode);
}

function onStartStopClicked() {
  if (scanMode) { stopScan(); }
  else if (appMode === "ask") { scanFullPage(); }
  else { startScan(); }
  updateButtons();
}

function onSelectClicked() {
  if (selectionMode) { stopRegionSelection(); return; }
  startRegionSelection();
}

function onClearClicked() {
  selectedRect = null;
  hideRegionBox();
  setStatus("Region cleared.");
  updateButtons();
}

function getLLMSettings() {
  return {
    llmUrl: localStorage.getItem("autoScanLLMUrl") || "",
    llmModel: localStorage.getItem("autoScanLLMModel") || "",
  };
}

function saveLLMSettings(url, model) {
  if (url) localStorage.setItem("autoScanLLMUrl", url);
  else localStorage.removeItem("autoScanLLMUrl");
  if (model) localStorage.setItem("autoScanLLMModel", model);
  else localStorage.removeItem("autoScanLLMModel");
  updateLLMButton();
}

function updateLLMButton() {
  if (!llmButton) return;
  const { llmUrl, llmModel } = getLLMSettings();
  if (llmUrl || llmModel) {
    const shortUrl = llmUrl ? llmUrl.replace(/^https?:\/\//, "") : "env";
    const shortModel = llmModel || "env";
    llmButton.textContent = `LLM: ${shortUrl} / ${shortModel}`;
  } else {
    llmButton.textContent = "LLM backend";
  }
}

function onLLMSettingsClicked() {
  const current = getLLMSettings();
  const url = window.prompt(
    "LLM server URL (leave empty to use server env var):",
    current.llmUrl
  );
  if (url === null) return;
  const model = window.prompt(
    "LLM model name (leave empty to use server env var):",
    current.llmModel
  );
  if (model === null) return;
  saveLLMSettings(url.trim(), model.trim());
  if (url.trim() || model.trim()) {
    setStatus("LLM override saved. Scan will send override settings to the local server.");
  } else {
    setStatus("LLM override cleared. Server env vars will be used.");
  }
}

function setAppMode(mode) {
  appMode = mode;
  localStorage.setItem("appMode", mode);
  updateModeUI();
  clearAnnotations();
  setStatus("Mode: " + (mode === "ask" ? "Ask" : "Translate"));
}

let activeTab = "control";

function switchTab(tabId) {
  activeTab = tabId;
  if (!shadowRoot) return;
  ["control", "chat"].forEach(id => {
    const pane = shadowRoot.getElementById("tab-" + id);
    const btn  = shadowRoot.getElementById("tab-btn-" + id);
    if (pane) pane.classList.toggle("active", id === tabId);
    if (btn)  btn.classList.toggle("active",  id === tabId);
  });
  if (tabId === "chat") {
    const chatInput = shadowRoot.getElementById("chat-input");
    if (chatInput) requestAnimationFrame(() => chatInput.focus());
  }
}

function updateModeUI() {
  if (!shadowRoot) return;
  const btnT = shadowRoot.getElementById("btn-mode-translate");
  const btnA = shadowRoot.getElementById("btn-mode-ask");
  if (btnT) btnT.classList.toggle("active", appMode === "translate");
  if (btnA) btnA.classList.toggle("active", appMode === "ask");
}

function updateAutoClickButton() {
  if (!autoClickButton) return;
  autoClickButton.classList.toggle("active", autoClickAnswer);
  autoClickButton.textContent = (autoClickAnswer ? "\u{1F5B1} Auto Click: ON" : "\u{1F5B1} Auto Click: OFF");
}

// ===== Q&A / Glossary / Character =====

async function onQAClicked() {
  const choice = window.prompt(
    "Q&A Database:\n1 - Add new question\n2 - View count\n3 - Delete by ID\n\nEnter option number:", "1"
  );
  if (!choice) return;
  const t = choice.trim();
  if (t === "1") {
    const question = window.prompt("Enter question:"); if (!question) return;
    const answer   = window.prompt("Enter correct answer:"); if (!answer) return;
    const explanation = window.prompt("Explanation (optional):", "") || "";
    try {
      const resp = await fetch(SERVER_URL + "/api/qa", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, answer, explanation }),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      setStatus("Added Q&A #" + data.qa.id);
    } catch (err) { setStatus("Q&A add error: " + err.message, true); }
  } else if (t === "2") {
    try {
      const resp = await fetch(SERVER_URL + "/api/qa");
      const data = await resp.json();
      const count = (data.qa || []).length;
      window.alert("Q&A Database: " + count + " saved questions.");
      setStatus("Q&A database: " + count + " entries.");
    } catch (err) { setStatus("Q&A load error: " + err.message, true); }
  } else if (t === "3") {
    const idStr = window.prompt("Enter the ID to delete:"); if (!idStr) return;
    const id = parseInt(idStr, 10);
    if (isNaN(id)) { setStatus("Invalid ID.", true); return; }
    try {
      const resp = await fetch(SERVER_URL + "/api/qa/" + id, { method: "DELETE" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      setStatus("Deleted Q&A #" + id + ".");
    } catch (err) { setStatus("Lỗi xóa Q&A: " + err.message, true); }
  }
}

function onGlossaryClicked() {
  const entry = window.prompt("Enter glossary entry (source=target):", "");
  if (!entry) return;
  const parts = entry.split("=");
  const source = (parts[0] || "").trim();
  const target = (parts[1] || "").trim();
  if (!source || !target) { setStatus("Invalid format. Use source=target."); return; }
  glossary[source] = target;
  saveGlossary();
  setStatus("Glossary updated: " + source + " -> " + target);
}

function loadGlossary() {
  try { const raw = localStorage.getItem("autoScanGlossary"); if (raw) glossary = JSON.parse(raw); }
  catch (e) { glossary = {}; }
}

function saveGlossary() {
  try { localStorage.setItem("autoScanGlossary", JSON.stringify(glossary)); }
  catch (e) { /* ignore */ }
}

function loadCharacterNames() {
  try { const raw = localStorage.getItem("autoScanCharacterNames"); if (raw) characterNames = JSON.parse(raw); }
  catch (e) { characterNames = []; }
}

function saveCharacterNames() {
  try { localStorage.setItem("autoScanCharacterNames", JSON.stringify(characterNames)); }
  catch (e) { /* ignore */ }
}

function loadTranslationMemory() {
  try {
    const raw = localStorage.getItem("autoScanTranslationMemory");
    if (raw) { const p = JSON.parse(raw); translationMemory.clear(); Object.entries(p).forEach(([k, v]) => translationMemory.set(k, v)); }
  } catch (e) { /* ignore */ }
}

function saveTranslationMemory() {
  try { localStorage.setItem("autoScanTranslationMemory", JSON.stringify(Object.fromEntries(translationMemory))); }
  catch (e) { /* ignore */ }
}

function buildMemoryKey(text) {
  const sortedGlossary = Object.keys(glossary).sort().reduce((a, k) => { a[k] = glossary[k]; return a; }, {});
  return text + "||" + JSON.stringify(sortedGlossary) + "||" + JSON.stringify(characterNames);
}

function getDomainId() {
  const host = window.location.host;
  const segments = window.location.pathname.split("/").filter(Boolean);
  return segments.length >= 2
    ? host + "/" + segments[0] + "/" + segments[1]
    : host + "/" + segments.join("/");
}

function cacheGet(key) {
  if (!translationCache.has(key)) return undefined;
  const v = translationCache.get(key); translationCache.delete(key); translationCache.set(key, v); return v;
}

function cacheSet(key, value) {
  translationCache.delete(key); translationCache.set(key, value);
  while (translationCache.size > TRANSLATION_CACHE_LIMIT) translationCache.delete(translationCache.keys().next().value);
}

function memoryGet(key) {
  if (!translationMemory.has(key)) return undefined;
  const v = translationMemory.get(key); translationMemory.delete(key); translationMemory.set(key, v); return v;
}

function memorySet(key, value) {
  translationMemory.delete(key); translationMemory.set(key, value);
  while (translationMemory.size > TRANSLATION_MEMORY_LIMIT) translationMemory.delete(translationMemory.keys().next().value);
}

function onCharacterClicked() {
  const entry = window.prompt("Enter character names (comma-separated):", characterNames.join(", "));
  if (entry === null) return;
  characterNames = entry.split(",").map(n => n.trim()).filter(Boolean);
  saveCharacterNames();
  setStatus("Character names: " + (characterNames.length ? characterNames.join(", ") : "none"));
}

// ===== Region selection =====

function startRegionSelection() {
  selectionMode = true;
  if (!selectionOverlay) return;
  selectionOverlay.style.display = "block";
  selectionOverlay.style.cursor  = "crosshair";
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
  const top  = Math.min(selectionStart.y, event.clientY);
  updateRegionBox({ left, top, width: Math.abs(selectionStart.x - event.clientX), height: Math.abs(selectionStart.y - event.clientY) });
}

function onSelectionMouseUp(event) {
  if (!selectionMode || !selectionStart) return;
  event.preventDefault();
  const left   = Math.min(selectionStart.x, event.clientX);
  const top    = Math.min(selectionStart.y, event.clientY);
  const width  = Math.abs(selectionStart.x - event.clientX);
  const height = Math.abs(selectionStart.y - event.clientY);
  selectionStart = null;
  selectionMode  = false;
  if (width < 40 || height < 40) {
    selectedRect = null; hideRegionBox();
    setStatus("Selection too small. Try again."); updateButtons(); return;
  }
  selectedRect = { left, top, width, height };
  showRegionBox(selectedRect);
  selectionOverlay.style.display = "none";
  setStatus("Region locked. Start scan to auto-scan.");
  updateButtons();
}

function onSelectionMouseLeave() { /* intentionally empty */ }

function updateRegionBox(rect) {
  if (!regionBox) return;
  regionBox.style.cssText = "display:block;left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px;";
}

function showRegionBox(rect) { updateRegionBox(rect); }

function hideRegionBox() {
  if (!regionBox) return;
  regionBox.style.display = "none";
}

function getViewportRect() {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

// ===== Init =====

createUI();

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.action) return;
  if (message.action === "toggle-auto-scan") onStartStopClicked();
  if (message.action === "capture-now") scanOnce();
});
