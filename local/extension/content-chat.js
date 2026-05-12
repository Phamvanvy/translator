// ── Chat / Ask / Markdown logic ───────────────────────────────────────────────
// Loaded after content.js and content-scan.js.

// Color palette for multiple questions
const QUESTION_COLORS = [
  "#ef4444", "#3b82f6", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899",
];

// ── Utilities ─────────────────────────────────────────────────────────────────

function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _applyInline(text) {
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  return text;
}

function formatMarkdown(raw) {
  if (!raw) return '';
  const lines = raw.split('\n');
  let html = '';
  let inUl = false, inOl = false, inPre = false;
  for (const rawLine of lines) {
    if (rawLine.trim().startsWith('```')) {
      if (!inPre) {
        if (inUl) { html += '</ul>'; inUl = false; }
        if (inOl) { html += '</ol>'; inOl = false; }
        html += '<pre><code>'; inPre = true;
      } else { html += '</code></pre>'; inPre = false; }
      continue;
    }
    if (inPre) { html += rawLine.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '\n'; continue; }
    const line = rawLine.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const isUl = /^[\-\*\u2022] /.test(line);
    const isOl = /^\d+\. /.test(line);
    if (!isUl && inUl) { html += '</ul>'; inUl = false; }
    if (!isOl && inOl) { html += '</ol>'; inOl = false; }
    if (/^#{1,3} /.test(line)) {
      html += `<h3>${_applyInline(line.replace(/^#{1,3} /, ''))}</h3>`;
    } else if (isUl) {
      if (!inUl) { html += '<ul>'; inUl = true; }
      html += `<li>${_applyInline(line.replace(/^[\-\*\u2022] /, ''))}</li>`;
    } else if (isOl) {
      if (!inOl) { html += '<ol>'; inOl = true; }
      html += `<li>${_applyInline(line.replace(/^\d+\. /, ''))}</li>`;
    } else if (line.trim() === '') {
      html += '<br>';
    } else {
      html += _applyInline(line) + '<br>';
    }
  }
  if (inUl) html += '</ul>';
  if (inOl) html += '</ol>';
  if (inPre) html += '</code></pre>';
  return html.replace(/<br>$/, '');
}

// ── Attach bar (multi-image) ──────────────────────────────────────────────────

function updateAttachBar() {
  if (!shadowRoot) return;
  const bar = shadowRoot.getElementById('chat-attach-bar');
  if (!bar) return;
  bar.innerHTML = '';
  if (attachedChatImages.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  attachedChatImages.forEach((src, idx) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;';
    const img = document.createElement('img');
    img.className = 'chat-attach-thumb';
    img.src = src;
    img.alt = 'Image ' + (idx + 1);
    const btn = document.createElement('button');
    btn.className = 'chat-attach-remove';
    btn.textContent = '✕';
    btn.title = 'Remove this image';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      attachedChatImages = attachedChatImages.filter((_, i) => i !== idx);
      updateAttachBar();
    });
    wrap.appendChild(img);
    wrap.appendChild(btn);
    bar.appendChild(wrap);
  });
}

function clearAttachedImages() {
  attachedChatImages = [];
  updateAttachBar();
}

function clearChat() {
  chatHistory.length = 0;
  lastAskContext = "";
  clearAttachedImages();
  const area = getChatArea();
  if (area) area.innerHTML = "";
}

// ── Chat helpers ──────────────────────────────────────────────────────────────

function getChatArea() {
  return shadowRoot ? shadowRoot.getElementById("chat-area") : null;
}

function appendChatMessage(role, htmlContent, extraClass = "") {
  const area = getChatArea();
  if (!area) return;
  const msg = document.createElement("div");
  msg.className = `chat-msg ${role}${extraClass ? " " + extraClass : ""}`;
  msg.innerHTML = htmlContent;
  area.appendChild(msg);
  requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
}

// ── Main chat send ────────────────────────────────────────────────────────────

// Maximum characters for the entire history before auto-reset (~4000 tokens)
const CHAT_HISTORY_MAX_CHARS = 14000;

async function sendChatMessage(userText) {
  const images = [...attachedChatImages]; // snapshot before clearing
  clearAttachedImages();

  const displayText = userText || (images.length > 0 ? `[${images.length > 1 ? images.length + ' images' : 'Image'} attached]` : "");
  if (!displayText) return;

  // Auto-reset context when it gets too long
  const totalChars = chatHistory.reduce((n, m) => n + (m.content || "").length, 0);
  if (totalChars > CHAT_HISTORY_MAX_CHARS) {
    chatHistory.length = 0;
    lastAskContext = "";
    appendChatMessage("bot", '<em style="color:#64748b;font-size:11px">⚡ Context too long — automatically started a new conversation.</em>');
  }

  chatHistory.push({ role: "user", content: displayText });

  // Build user bubble HTML
  let userHtml = '';
  images.forEach(src => { userHtml += `<img class="chat-img-preview" src="${src}">`; });
  if (userText) { if (userHtml) userHtml += '<br>'; userHtml += _escapeHtml(userText); }
  appendChatMessage("user", userHtml || _escapeHtml(displayText));

  // Create bot bubble to stream into
  const area = getChatArea();
  const msgEl = document.createElement("div");
  msgEl.className = "chat-msg bot";
  const cursor = document.createElement("span");
  cursor.className = "chat-cursor";
  msgEl.appendChild(cursor);
  if (area) { area.appendChild(msgEl); requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; }); }

  let fullText = "";
  let tokenOverflow = false;

  const reqBody = JSON.stringify({
    message: userText || "",
    context: lastAskContext,
    history: chatHistory.slice(-8),
    ...(images.length > 0 ? { images } : {}),
  });
  await new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: "proxyStream" });
    port.postMessage({ url: `${SERVER_URL}/api/chat/stream`, body: reqBody });
    port.onMessage.addListener((msg) => {
      if (msg.error) {
        if (cursor.parentNode) cursor.remove();
        msgEl.innerHTML = `<span style="color:#f87171">Lỗi: ${_escapeHtml(msg.error)}</span>`;
        port.disconnect();
        resolve();
        return;
      }
      if (msg.done) {
        chatHistory.push({ role: "assistant", content: fullText });
        if (fullText) {
          msgEl.innerHTML = formatMarkdown(fullText);
        } else if (!tokenOverflow) {
          // No response — show retry button
          msgEl.innerHTML = '';
          const retryBtn = document.createElement("button");
          retryBtn.className = "chat-retry-btn";
          retryBtn.textContent = "🔄 Retry";
          retryBtn.addEventListener("click", async () => {
            // Delete this bot bubble and the last user bubble, then resend
            if (chatHistory.length >= 2) chatHistory.splice(-2, 2);
            else chatHistory.length = 0;
            msgEl.remove();
            const allBubbles = area ? area.querySelectorAll(".chat-msg.user") : [];
            if (allBubbles.length) allBubbles[allBubbles.length - 1].remove();
            attachedChatImages = [...images];
            await sendChatMessage(userText);
          });
          msgEl.appendChild(retryBtn);
        }
        port.disconnect();
        resolve();
        return;
      }
      if (msg.line) {
        const payload = msg.line;
        if (payload === "[DONE]") return;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.error) {
            if (parsed.type === "token_overflow") {
              // Mark for auto-retry after the promise completes
              tokenOverflow = true;
              if (cursor.parentNode) cursor.remove();
              msgEl.innerHTML = '<em style="color:#f59e0b;font-size:11px">⚡ Context too large — resetting and retrying...</em>';
              port.disconnect();
              resolve();
              return;
            }
            if (cursor.parentNode) cursor.remove();
            msgEl.innerHTML = `<span style="color:#f87171">Lỗi: ${_escapeHtml(parsed.error)}</span>`;
            port.disconnect();
            resolve();
            return;
          }
          const token = parsed.token || "";
          if (token) {
            fullText += token;
            msgEl.innerHTML = formatMarkdown(fullText);
            msgEl.appendChild(cursor);
            requestAnimationFrame(() => { if (area) area.scrollTop = area.scrollHeight; });
          }
        } catch (_) { /* skip malformed chunk */ }
      }
    });
    port.onDisconnect.addListener(() => {
      if (fullText && !chatHistory.find(m => m.role === "assistant" && m.content === fullText)) {
        chatHistory.push({ role: "assistant", content: fullText });
      }
      if (!msgEl.querySelector(".chat-cursor") && msgEl.innerHTML === "") {
        msgEl.innerHTML = formatMarkdown(fullText) || `<span style="color:#f87171">Error: Connection lost.</span>`;
      } else if (fullText) {
        msgEl.innerHTML = formatMarkdown(fullText);
      }
      resolve();
    });
  });

  // Auto-retry after token overflow: reset history, remove old bubbles, resend
  if (tokenOverflow) {
    chatHistory.length = 0;
    lastAskContext = "";
    // Remove the recently added user bubble
    const allBubbles = area ? area.querySelectorAll(".chat-msg.user") : [];
    if (allBubbles.length) allBubbles[allBubbles.length - 1].remove();
    // Remove the "resetting" bot bubble
    msgEl.remove();
    appendChatMessage("bot", '<em style="color:#64748b;font-size:11px">⚡ Context reset — starting a new conversation.</em>');
    attachedChatImages = [...images];
    await sendChatMessage(userText);
  }
}

// ── Ask / Quiz result display ─────────────────────────────────────────────────

async function sendToServerAsk(dataUrl, rect) {
  try {
    setStatus("Analyzing question...");
    const payload = {
      image: dataUrl,
      lang: ocrLang,
      domain_id: getDomainId(),
    };
    const llmUrl = localStorage.getItem("autoScanLLMUrl") || "";
    const llmModel = localStorage.getItem("autoScanLLMModel") || "";
    if (llmUrl) payload.llm_url = llmUrl;
    if (llmModel) payload.llm_model = llmModel;
    const body = JSON.stringify(payload);
    const result = await new Promise((resolve, reject) => {
      const tid = setTimeout(() => reject(new Error("AbortError")), 120000);
      chrome.runtime.sendMessage({ action: "proxyFetch", url: `${SERVER_URL}/api/ask`, method: "POST", body }, (r) => {
        clearTimeout(tid);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!r || !r.ok) return reject(new Error(`Server returned ${r && r.error || "error"}`));
        resolve(r.data);
      });
    });

    switchTab("chat");
    const questions = result.questions || [];
    const totalAnswers = questions.reduce((s, q) => s + (q.answer_texts || []).length, 0);
    setStatus(`✅ ${questions.length} questions, ${totalAnswers} answers`);

    lastAskContext = questions.map((q, i) => {
      const ans = (q.answer_texts || []).join(", ");
      return `Q${i + 1}: ${q.question_text} → Answer: ${ans}. ${q.explanation || ""}`;
    }).join("\n");

    if (questions.length > 0) {
      let html = "";
      questions.forEach((q, idx) => {
        const color = QUESTION_COLORS[idx % QUESTION_COLORS.length];
        const answerTexts = q.answer_texts || (q.answer_text ? [q.answer_text] : []);
        if (idx > 0) html += `<hr class="chat-sep">`;
        if (questions.length > 1) html += `<div class="chat-q-label" style="color:${color}">📋 Question ${idx + 1}</div>`;
        if (q.question_text) html += `<div class="chat-q-label">❓ Question</div><div class="chat-q-text">${_escapeHtml(q.question_text)}</div>`;
        html += `<div class="chat-a-label">✅ Answer</div><div class="chat-a-list">`;
        answerTexts.forEach(a => { html += `<div class="chat-a-item" style="color:${color};border-color:${color}">${_escapeHtml(a)}</div>`; });
        html += `</div>`;
        if (q.explanation) html += `<div class="chat-exp-label">💡 Explanation</div><div class="chat-exp-text">${_escapeHtml(q.explanation)}</div>`;
      });
      appendChatMessage("bot", html);
    }
  } catch (error) {
    if (error.message === "AbortError" || error.name === "AbortError") setStatus("Server timeout.", true);
    else if (error.message?.includes("Failed to fetch")) setStatus("Server offline.", true);
    else setStatus(`Lỗi Ask: ${error.message}`, true);
  }
}

function onUploadAskClicked() {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.style.display = "none";
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target.result;
      const rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      switchTab("chat");
      appendChatMessage("bot", `<em>📤 Analyzing image: ${_escapeHtml(file.name)}...</em>`);
      await sendToServerAsk(dataUrl, rect);
    };
    reader.readAsDataURL(file);
  });
  document.body.appendChild(fileInput);
  fileInput.click();
  setTimeout(() => { if (fileInput.parentNode) fileInput.remove(); }, 60000);
}
