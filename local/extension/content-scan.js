// ── Scan / Translate pipeline ─────────────────────────────────────────────────
// Loaded after content.js (globals defined there).

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
  const { threshold = 0.1 } = options;
  let diff = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const delta = Math.max(
        Math.abs(img1[idx]   - img2[idx]),
        Math.abs(img1[idx+1] - img2[idx+1]),
        Math.abs(img1[idx+2] - img2[idx+2]),
        Math.abs(img1[idx+3] - img2[idx+3])
      );
      if (delta / 255 > threshold) {
        diff += 1;
        if (output) { output[idx]=255; output[idx+1]=0; output[idx+2]=255; output[idx+3]=255; }
      } else if (output) {
        output[idx]=0; output[idx+1]=0; output[idx+2]=0; output[idx+3]=255;
      }
    }
  }
  return diff;
}

function hasFrameChanged(prev, next) {
  if (!prev || !next || prev.width !== next.width || prev.height !== next.height) return true;
  const diff = pixelmatch(prev.data, next.data, null, prev.width, prev.height, { threshold: 0.14 });
  return diff > (prev.width * prev.height) * 0.002;
}

async function startScan() {
  if (scanMode) return;
  lastPrefetchData = null;
  scanBuffer.length = 0;
  lastCaptureTimestamp = 0;
  scanMode = true;
  setStatus("Scanning now...");
  updateButtons();
  try {
    await scanOnce();
  } finally {
    if (scanMode) { scanMode = false; updateButtons(); }
  }
}

function stopScan() {
  scanMode = false;
  if (scanTimer) { window.clearInterval(scanTimer); scanTimer = null; }
  updateButtons();
  setStatus("Scan stopped.");
}

async function scanOnce() {
  const now = Date.now();
  if (now - lastCaptureTimestamp < 1000) return;
  lastCaptureTimestamp = now;
  const rect = selectedRect || getViewportRect();
  const prefetchRect = selectedRect ? expandRect(rect, 0.2) : rect;
  try {
    await initiateCapture(rect, prefetchRect);
  } catch (err) {
    const message = err?.message?.toLowerCase() || "";
    if (
      message.includes("active tab") || message.includes("activetab") ||
      message.includes("extension context invalidated") || message.includes("quota") ||
      message.includes("failed to fetch") || message.includes("server returned") ||
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
        if (message.toLowerCase().includes('active tab') ||
            message.toLowerCase().includes('extension context invalidated') ||
            message.toLowerCase().includes('quota')) {
          stopScan(); return resolve();
        }
        return reject(new Error(message));
      }
      if (!response || response.error) {
        const message = response?.error || 'unknown';
        setStatus(`Capture failed: ${message}`, true);
        if (message.toLowerCase().includes('active tab') ||
            message.toLowerCase().includes('extension context invalidated') ||
            message.toLowerCase().includes('quota')) {
          stopScan(); return resolve();
        }
        return reject(new Error(message));
      }
      currentTabId = response.tabId || currentTabId;
      try {
        const croppedDataUrl = await cropDataUrl(response.dataUrl, rect);
        const croppedImageData = await getImageDataFromDataUrl(croppedDataUrl);
        const cacheKey = hashImageData(croppedImageData);

        const prefetchSame = !prefetchRect || (
          prefetchRect.left === rect.left && prefetchRect.top === rect.top &&
          prefetchRect.width === rect.width && prefetchRect.height === rect.height
        );
        const prefetchDataUrl = prefetchSame ? croppedDataUrl : await cropDataUrl(response.dataUrl, prefetchRect);
        const prefetchImageData = prefetchSame ? croppedImageData : await getImageDataFromDataUrl(prefetchDataUrl);
        const prefetchHash = prefetchSame ? cacheKey : hashImageData(prefetchImageData);

        if (lastPrefetchData && !hasFrameChanged(lastPrefetchData, prefetchImageData)) {
          setStatus("No visual change detected in buffered viewport.");
          const cached = cacheGet(cacheKey);
          if (cached) renderAnnotations(cached, rect);
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
      } catch (error) { reject(error); }
    });
  });
}

function enqueueScan(dataUrl, rect, cacheKey) {
  const cached = cacheGet(cacheKey);
  if (cached) { renderAnnotations(cached, rect); setStatus("Loaded translation from cache."); return; }
  const task = { dataUrl, rect, cacheKey };
  if (inFlightScan) { queuedScan = task; setStatus("Scan queued."); return; }
  processScan(task);
}

async function processScan(task) {
  inFlightScan = true;
  try {
    await sendToServer(task.dataUrl, task.rect, task.cacheKey);
  } finally {
    inFlightScan = false;
    if (queuedScan) { const next = queuedScan; queuedScan = null; processScan(next); }
  }
}

function cropDataUrl(dataUrl, rect) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scaleX = image.naturalWidth  / window.innerWidth;
      const scaleY = image.naturalHeight / window.innerHeight;
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(rect.width);
      canvas.height = Math.round(rect.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image,
        Math.round(rect.left  * scaleX), Math.round(rect.top    * scaleY),
        Math.round(rect.width * scaleX), Math.round(rect.height * scaleY),
        0, 0, canvas.width, canvas.height);
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
    const dup = merged.find(e =>
      e.translation === item.translation &&
      Math.abs(e.box[0] - item.box[0]) < 12 && Math.abs(e.box[1] - item.box[1]) < 12 &&
      Math.abs(e.box[2] - item.box[2]) < 16 && Math.abs(e.box[3] - item.box[3]) < 16
    );
    if (!dup) merged.push(item);
  }
  return merged;
}

function mergeNearbyBoxes(items, gap = 18) {
  if (!items.length) return [];
  let groups = items
    .filter(item => (item.translation || "").trim())
    .map(item => ({ box: [...item.box], translation: (item.translation || "").trim() }));

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

function getLLMOverridePayload() {
  const payload = {};
  const llmUrl = localStorage.getItem("autoScanLLMUrl") || "";
  const llmModel = localStorage.getItem("autoScanLLMModel") || "";
  if (llmUrl) payload.llm_url = llmUrl;
  if (llmModel) payload.llm_model = llmModel;
  return payload;
}

async function requestTileTranslation(tileDataUrl, tileRect) {
  const body = JSON.stringify({
    image: tileDataUrl,
    lang: ocrLang,
    glossary,
    character_names: characterNames,
    domain_id: getDomainId(),
    tab_id: currentTabId,
    ...getLLMOverridePayload(),
  });
  const resp = await new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error("Request timed out")), 600000);
    chrome.runtime.sendMessage({ action: "proxyFetch", url: `${SERVER_URL}/api/translate-image`, method: "POST", body }, (r) => {
      clearTimeout(tid);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!r || !r.ok) return reject(new Error(r && r.error || "Server error"));
      resolve(r.data);
    });
  });
  const results = (resp.results || []).map(item => ({
    ...item,
    box: [item.box[0]+tileRect.left, item.box[1]+tileRect.top, item.box[2]+tileRect.left, item.box[3]+tileRect.top],
  }));
  return { results, cleaned_image: resp.cleaned_image };
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
  for (let i = 0; i < data.length; i += step) hash = (hash * 33) ^ data[i];
  return (hash >>> 0).toString(36);
}

async function sendToServer(dataUrl, rect, cacheKey) {
  if (appMode === "ask") return sendToServerAsk(dataUrl, rect);
  try {
    setStatus("Detecting text blobs...");
    const body = JSON.stringify({
      image: dataUrl,
      lang: ocrLang,
      glossary,
      character_names: characterNames,
      domain_id: getDomainId(),
      tab_id: currentTabId,
      ...getLLMOverridePayload(),
    });
    const result = await new Promise((resolve, reject) => {
      const tid = setTimeout(() => reject(new Error("AbortError")), 600000);
      chrome.runtime.sendMessage({ action: "proxyFetch", url: `${SERVER_URL}/api/translate-image`, method: "POST", body }, (r) => {
        clearTimeout(tid);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!r || !r.ok) return reject(new Error(r && r.error || "Server error"));
        resolve(r.data);
      });
    });
    const items = result.results || [];
    cacheSet(cacheKey, items);
    items.forEach(item => { if (item.text && item.translation) memorySet(buildMemoryKey(item.text), item.translation); });
    saveTranslationMemory();
    renderAnnotations(items, rect, result.cleaned_image);
    setStatus(`Translated ${items.length} items.`);
  } catch (error) {
    console.error(error);
    if (scanMode) stopScan();
    if (error.message === "AbortError" || error.name === "AbortError") setStatus("Server request timed out. Auto-scan stopped.", true);
    else if (error.message?.includes("Failed to fetch")) setStatus("Server offline or network error. Auto-scan stopped.", true);
    else setStatus(`Server error: ${error.message}. Auto-scan stopped.`, true);
  }
}

function groupAnnotationItems(items) {
  const rows = [];
  const sorted = [...items].filter(i => i.translation || i.text).sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  for (const item of sorted) {
    const label = item.translation || item.text || "";
    if (!label) continue;
    const itemMid = (item.box[1] + item.box[3]) / 2;
    const itemH   = item.box[3] - item.box[1];
    const group = rows.find(row => Math.abs(row.mid - itemMid) < Math.max(24, itemH * 0.6));
    if (group) {
      group.items.push(item);
      group.left   = Math.min(group.left, item.box[0]);
      group.top    = Math.min(group.top,  item.box[1]);
      group.right  = Math.max(group.right, item.box[2]);
      group.bottom = Math.max(group.bottom, item.box[3]);
      group.mid    = (group.top + group.bottom) / 2;
    } else {
      rows.push({ items: [item], left: item.box[0], top: item.box[1], right: item.box[2], bottom: item.box[3], mid: itemMid });
    }
  }
  return rows.map(row => ({
    left: row.left, top: row.top,
    width: Math.max(row.right - row.left, 120), height: Math.max(row.bottom - row.top, 24),
    text: row.items.map(i => i.translation || i.text).join(" "),
  }));
}

function renderAnnotations(items, rect, cleanedImageUrl) {
  if (!annotationLayer) return;
  annotationLayer.innerHTML = "";

  if (cleanedImageUrl) {
    const overlay = document.createElement("div");
    overlay.className = "cleaned-overlay";
    overlay.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background-image:url(${cleanedImageUrl});background-size:${rect.width}px ${rect.height}px;`;
    annotationLayer.appendChild(overlay);
  }

  const uniqueItems = dedupeTranslatedItems(items);
  const mergedGroups = mergeNearbyBoxes(uniqueItems, 30);
  const BLEED = 4;
  const GAP   = 6;

  const defs = mergedGroups.map(group => {
    let raw = group.translation.trim();
    if (!raw) return null;
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
    const charW = Math.round(raw.length * 8.5) + 20;
    const displayW = isVerticalSrc
      ? Math.min(Math.max(charW, srcW, 80), 180)
      : Math.min(Math.max(charW, srcW, 80), 300);

    return { raw, left: srcLeft, top: srcTop, width: displayW, minH: srcH };
  }).filter(Boolean);

  defs.sort((a, b) => a.left - b.left);
  for (let i = 0; i < defs.length; i++) {
    for (let j = i + 1; j < defs.length; j++) {
      const a = defs[i], b = defs[j];
      const overlapX = (a.left + a.width + GAP) - b.left;
      if (overlapX > 0) {
        const vertOverlap = Math.min(a.top + a.minH, b.top + b.minH) - Math.max(a.top, b.top);
        if (vertOverlap > 0) b.left = a.left + a.width + GAP;
      }
    }
  }

  defs.forEach(def => {
    let left = def.left;
    let top  = def.top;
    if (left + def.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - def.width - 8);
    if (left < 8) left = 8;
    if (top + def.minH > window.innerHeight - 8) top = Math.max(8, window.innerHeight - def.minH - 8);
    if (top < 8) top = 8;

    const box = document.createElement("div");
    box.className = "annotation-box";
    box.style.cssText = `left:${left}px;top:${top}px;width:${def.width}px;max-width:${def.width}px;min-height:${def.minH}px;`;
    const textEl = document.createElement("span");
    textEl.className = "annotation-text" + (def.raw.length > 30 ? " long" : "");
    textEl.textContent = def.raw;
    box.appendChild(textEl);
    annotationLayer.appendChild(box);
  });
}

// ── Full-page sequential scan ─────────────────────────────────────────────────

// ── Autonomous agent loop ─────────────────────────────────────────────────────

function getDomContext() {
  const sel = 'button, input:not([type="hidden"]), select, textarea, a[href], [role="button"], [role="radio"], [role="checkbox"], [role="option"], label';
  const result = [];
  try {
    document.querySelectorAll(sel).forEach(el => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return;
      const text = (el.getAttribute('aria-label') || el.textContent || el.value || el.placeholder || '')
        .trim().replace(/\s+/g, ' ').slice(0, 70);
      if (!text) return;
      result.push({
        tag: el.tagName.toLowerCase(),
        text,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      });
    });
  } catch (_) {}
  return result.slice(0, 60);
}

async function _agentCallStep(dataUrl, viewportW, viewportH, stepHistory, task, mode = "act") {
  const reqPayload = {
    image: dataUrl,
    viewport_width: viewportW,
    viewport_height: viewportH,
    step_history: stepHistory.slice(-6),
    dom_context: getDomContext(),
    task,
    mode,
  };
  const llmUrl = localStorage.getItem("autoScanLLMUrl") || "";
  const llmModel = localStorage.getItem("autoScanLLMModel") || "";
  if (llmUrl) reqPayload.llm_url = llmUrl;
  if (llmModel) reqPayload.llm_model = llmModel;
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error("Agent step timeout")), 90000);
    chrome.runtime.sendMessage(
      { action: "proxyFetch", url: `${SERVER_URL}/api/agent/step`, method: "POST", body: JSON.stringify(reqPayload) },
      (r) => {
        clearTimeout(tid);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!r || !r.ok) return reject(new Error(r?.error || "Server error"));
        resolve(r.data);
      }
    );
  });
}

async function _agentCapture() {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: "captureVisibleTab" }, async response => {
      if (!chrome.runtime.lastError && response && !response.error) {
        try {
          const rect = { left: 0, top: 0, width: viewportW, height: viewportH };
          resolve({ dataUrl: await cropDataUrl(response.dataUrl, rect), w: viewportW, h: viewportH });
        } catch (e) { resolve(null); }
      } else { resolve(null); }
    });
  });
}

async function runAgentLoop(task) {
  if (scanMode) return;
  scanMode = true;
  updateButtons();
  switchTab("chat");

  const MAX_STEPS = 50;
  const stepHistory = [];
  let stepsRun = 0;

  try {
    // ── Planning phase ──────────────────────────────────────────────────────
    setStatus("Agent: planning...");
    const cap0 = await _agentCapture();
    if (cap0) {
      try {
        const planResult = await _agentCallStep(cap0.dataUrl, cap0.w, cap0.h, [], task, "plan");
        const steps = planResult.plan || [];
        if (steps.length > 0) {
          const stepsHtml = steps.map((s, i) => `<div style="padding:2px 0">${i+1}. ${_escapeHtml(s)}</div>`).join('');
          appendChatMessage("bot",
            `<div class="chat-q-label">🤖 Agent Plan</div>${stepsHtml}` +
            (planResult.reason ? `<div style="color:#64748b;font-size:11px;margin-top:5px">${_escapeHtml(planResult.reason)}</div>` : '')
          );
        }
      } catch (_) { /* planning failed, continue anyway */ }
    }
    if (!scanMode) return;

    appendChatMessage("bot", `<em style="color:#4ade80">▶ Executing — press Stop to halt</em>`);

    // ── Execution loop ──────────────────────────────────────────────────────
    for (let step = 0; step < MAX_STEPS && scanMode; step++) {
      stepsRun = step + 1;
      setStatus(`Agent step ${stepsRun}/${MAX_STEPS}...`);

      const cap = await _agentCapture();
      if (!cap) { setStatus("Agent: capture failed.", true); break; }

      let agentAction;
      try {
        agentAction = await _agentCallStep(cap.dataUrl, cap.w, cap.h, stepHistory, task, "act");
      } catch (err) {
        setStatus(`Agent error: ${err.message}`, true);
        appendChatMessage("bot", `<em style="color:#f87171">❌ Agent error: ${_escapeHtml(err.message)}</em>`);
        break;
      }

      stepHistory.push(agentAction);
      const reason = agentAction.reason ? ` — ${agentAction.reason}` : "";

      if (agentAction.action === "done") {
        setStatus("✅ Agent complete.");
        appendChatMessage("bot", `<em>✅ Agent finished${reason}.</em>`);
        break;
      }

      if (agentAction.action === "scroll_down") {
        appendChatMessage("bot", `<em>⬇️ Scroll down${reason}</em>`);
        window.scrollBy({ top: Math.round(cap.h * 0.8), behavior: "smooth" });
        await new Promise(r => setTimeout(r, 900));
        continue;
      }

      if (agentAction.action === "scroll_up") {
        appendChatMessage("bot", `<em>⬆️ Scroll up${reason}</em>`);
        window.scrollBy({ top: -Math.round(cap.h * 0.8), behavior: "smooth" });
        await new Promise(r => setTimeout(r, 900));
        continue;
      }

      if (agentAction.action === "click") {
        const x = agentAction.x, y = agentAction.y;
        appendChatMessage("bot", `<em>🖱 Click (${x}, ${y})${reason}</em>`);
        showAutoClickFlash(x, y);
        await new Promise(r => setTimeout(r, 220));
        const target = document.elementFromPoint(x, y);
        if (target && target !== document.documentElement && target !== document.body) {
          target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          target.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          target.dispatchEvent(new MouseEvent("click",     { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        }
        await new Promise(r => setTimeout(r, 1400));
        continue;
      }

      if (agentAction.action === "type") {
        const x = agentAction.x, y = agentAction.y;
        const text = agentAction.text || "";
        appendChatMessage("bot", `<em>⌨️ Type "${_escapeHtml(text.slice(0, 40))}"${reason}</em>`);
        const target = document.elementFromPoint(x, y);
        if (target) {
          target.focus();
          target.click();
          await new Promise(r => setTimeout(r, 80));
          // Native input setter for React/Vue compatibility
          const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          if (nativeInputSetter && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
            nativeInputSetter.set.call(target, text);
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
          }
        }
        await new Promise(r => setTimeout(r, 600));
        continue;
      }

      if (agentAction.action === "press_key") {
        const key = agentAction.key || "Enter";
        appendChatMessage("bot", `<em>⌨️ Press ${_escapeHtml(key)}${reason}</em>`);
        const activeEl = document.activeElement || document.body;
        activeEl.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        activeEl.dispatchEvent(new KeyboardEvent("keyup",   { key, bubbles: true }));
        if (key === "Enter") {
          activeEl.dispatchEvent(new KeyboardEvent("keypress", { key, bubbles: true }));
        }
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      setStatus("Agent: unrecognized action, stopping.", true);
      break;
    }

    if (stepsRun >= MAX_STEPS) {
      setStatus("Agent: max steps reached.");
      appendChatMessage("bot", `<em>⚠️ Agent stopped after ${MAX_STEPS} steps.</em>`);
    }
  } finally {
    scanMode = false;
    updateButtons();
  }
}

async function scanFullPage() {
  if (scanMode) return;
  const originalScrollY = window.scrollY;
  scanMode = true;
  updateButtons();
  switchTab("chat");

  // ── Ask mode: process each viewport section one-by-one ───────────────────
  if (appMode === "ask") {
    try {
      window.scrollTo({ top: 0, behavior: "instant" });
      await new Promise(r => setTimeout(r, 600));
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      const totalPageH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const maxScrollY = Math.max(0, totalPageH - viewportH);
      const step = viewportH;
      const scrollTargets = [0];
      if (maxScrollY > 0) {
        for (let pos = step; pos < maxScrollY; pos += step) scrollTargets.push(pos);
        if (scrollTargets[scrollTargets.length - 1] < maxScrollY) scrollTargets.push(maxScrollY);
      }
      appendChatMessage("bot", `<em>🔍 Ask mode: scanning ${scrollTargets.length} section(s)...</em>`);
      let lastScrollY = -1;
      let lastSectionHash = null;
      for (let i = 0; i < scrollTargets.length && scanMode; i++) {
        window.scrollTo({ top: scrollTargets[i], behavior: "instant" });
        await new Promise(r => setTimeout(r, 500));
        const currentScrollY = window.scrollY || document.documentElement.scrollTop || 0;
        if (i > 0 && currentScrollY === lastScrollY) {
          setStatus("Page didn't scroll further, stopping.");
          break;
        }
        lastScrollY = currentScrollY;
        setStatus(`Asking section ${i + 1}/${scrollTargets.length}...`);
        const dataUrl = await new Promise(resolve => {
          chrome.runtime.sendMessage({ action: "captureVisibleTab" }, async response => {
            if (!chrome.runtime.lastError && response && !response.error) {
              try {
                const rect = { left: 0, top: 0, width: viewportW, height: viewportH };
                resolve(await cropDataUrl(response.dataUrl, rect));
              } catch (e) { resolve(null); }
            } else { resolve(null); }
          });
        });
        if (!dataUrl) continue;
        try {
          const imageData = await getImageDataFromDataUrl(dataUrl);
          const hash = hashImageData(imageData);
          if (lastSectionHash && hash === lastSectionHash) { setStatus("Duplicate section, stopping."); break; }
          lastSectionHash = hash;
        } catch (_) {}
        const viewRect = { left: 0, top: 0, width: viewportW, height: viewportH };
        await sendToServerAsk(dataUrl, viewRect);
        // Wait for page to react to click (auto-advance, animations, etc.)
        if (autoClickAnswer) await new Promise(r => setTimeout(r, 1800));
      }
      setStatus(`✅ Full page Ask complete.`);
    } finally {
      window.scrollTo({ top: originalScrollY, behavior: "smooth" });
      scanMode = false;
      updateButtons();
    }
    return;
  }

  // ── Translate mode: collect all sections then attach ─────────────────────
  try {
    window.scrollTo({ top: 0, behavior: "instant" });
    await new Promise(r => setTimeout(r, 600));
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const totalPageH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const maxScrollY = Math.max(0, totalPageH - viewportH);
    const step = viewportH; // full steps, no overlap
    const scrollTargets = [0];
    if (maxScrollY > 0) {
      for (let pos = step; pos < maxScrollY; pos += step) scrollTargets.push(pos);
      if (scrollTargets[scrollTargets.length - 1] < maxScrollY) scrollTargets.push(maxScrollY);
    }

    appendChatMessage("bot", `<em>📸 Capturing full page (${scrollTargets.length} sections)...</em>`);

    const sectionDataUrls = [];
    let lastSectionHash = null;
    let lastScrollY = 0;
    for (let i = 0; i < scrollTargets.length && scanMode; i++) {
      if (i > 0) {
        window.scrollTo({ top: scrollTargets[i], behavior: "instant" });
        await new Promise(r => setTimeout(r, 500));
        const currentScrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
        if (currentScrollY === lastScrollY) {
          setStatus("Scrolling did not change viewport, stopping capture.");
          break;
        }
        lastScrollY = currentScrollY;
      }
      setStatus(`Capturing section ${i + 1}/${scrollTargets.length}...`);

      const dataUrl = await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: "captureVisibleTab" }, async response => {
          if (!chrome.runtime.lastError && response && !response.error) {
            try {
              const rect = { left: 0, top: 0, width: viewportW, height: viewportH };
              resolve(await cropDataUrl(response.dataUrl, rect));
            } catch (e) { resolve(null); }
          } else {
            resolve(null);
          }
        });
      });
      if (!dataUrl) continue;

      try {
        const imageData = await getImageDataFromDataUrl(dataUrl);
        const hash = hashImageData(imageData);
        if (lastSectionHash && hash === lastSectionHash) {
          setStatus("Duplicate section detected, stopping capture.");
          break;
        }
        lastSectionHash = hash;
        sectionDataUrls.push(dataUrl);
      } catch (err) {
        sectionDataUrls.push(dataUrl);
      }
    }

    if (sectionDataUrls.length === 0) {
      setStatus("Unable to capture image.", true);
      return;
    }

    attachedChatImages = sectionDataUrls;
    updateAttachBar();
    setStatus(`✅ Captured ${sectionDataUrls.length} sections.`);
    appendChatMessage("bot", `<em>✅ Captured ${sectionDataUrls.length} sections. Enter your question below.</em>`);
  } finally {
    window.scrollTo({ top: originalScrollY, behavior: "smooth" });
    scanMode = false;
    updateButtons();
  }
}
