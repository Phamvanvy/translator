// ── Chat / Ask / Markdown logic ───────────────────────────────────────────────
// Loaded after content.js, content-click.js and content-scan.js.

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
    const isUl = /^[\-\*•] /.test(line);
    const isOl = /^\d+\. /.test(line);
    if (!isUl && inUl) { html += '</ul>'; inUl = false; }
    if (!isOl && inOl) { html += '</ol>'; inOl = false; }
    if (/^#{1,3} /.test(line)) {
      html += `<h3>${_applyInline(line.replace(/^#{1,3} /, ''))}</h3>`;
    } else if (isUl) {
      if (!inUl) { html += '<ul>'; inUl = true; }
      html += `<li>${_applyInline(line.replace(/^[\-\*•] /, ''))}</li>`;
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

// ── Export chat (text + images) to a Word-openable .doc ───────────────────────

function exportChatToWord() {
  const area = getChatArea();
  if (!area || !area.children.length) {
    setStatus("Không có nội dung chat để xuất.", true);
    return;
  }

  const style = `
    body { font-family: Calibri, Arial, sans-serif; font-size: 14px; color:#1e293b; }
    h2 { font-size: 18px; margin-bottom: 16px; }
    .chat-msg { margin-bottom: 14px; padding: 10px 12px; border-radius: 8px; border: 1px solid #e2e8f0; }
    .chat-msg.user { background:#e0f2fe; }
    .chat-msg.bot { background:#f8fafc; }
    img { max-width: 480px; display:block; margin: 6px 0; }
    .chat-q-label, .chat-a-label, .chat-exp-label { font-weight:bold; margin-top:6px; display:block; }
    .chat-a-item { display:block; margin: 2px 0; }
    button { display:none; }
  `;
  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>AI Chat Export</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
<style>${style}</style>
</head>
<body>
<h2>AI Chat Export — ${new Date().toLocaleString("vi-VN")}</h2>
${area.innerHTML}
</body>
</html>`;

  const blob = new Blob(["﻿", html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ai-chat-${Date.now()}.doc`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 5000);
  setStatus("Đã xuất chat sang Word (kèm ảnh).");
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

const CHAT_RESET_MSG = '<em style="color:#64748b;font-size:11px">⚡ Context reset — starting a new conversation.</em>';
const CHAT_OVERFLOW_MSG = '<em style="color:#f59e0b;font-size:11px">⚡ Context too large — resetting and retrying...</em>';

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

  const sendImages = await Promise.all(images.map(i => downscaleDataUrl(i)));
  const messages = llmBuildChatMessages(userText, {
    context: lastAskContext,
    history: chatHistory.slice(-8),
    images: sendImages,
  });

  let fullText = "";
  let tokenOverflow = false;

  const render = () => {
    msgEl.innerHTML = formatMarkdown(fullText);
    msgEl.appendChild(cursor);
    requestAnimationFrame(() => { if (area) area.scrollTop = area.scrollHeight; });
  };
  const showError = (m) => {
    if (cursor.parentNode) cursor.remove();
    msgEl.innerHTML = `<span style="color:#f87171">Lỗi: ${_escapeHtml(m)}</span>`;
  };
  const renderRetry = () => {
    if (cursor.parentNode) cursor.remove();
    msgEl.innerHTML = '';
    const retryBtn = document.createElement("button");
    retryBtn.className = "chat-retry-btn";
    retryBtn.textContent = "🔄 Retry";
    retryBtn.addEventListener("click", async () => {
      if (chatHistory.length >= 2) chatHistory.splice(-2, 2);
      else chatHistory.length = 0;
      msgEl.remove();
      const allBubbles = area ? area.querySelectorAll(".chat-msg.user") : [];
      if (allBubbles.length) allBubbles[allBubbles.length - 1].remove();
      attachedChatImages = [...images];
      await sendChatMessage(userText);
    });
    msgEl.appendChild(retryBtn);
  };

  async function runNonStream() {
    try {
      const reply = await llmChat(messages, { temperature: 0.5, maxTokens: 4096, timeoutMs: 300000 });
      fullText = reply;
      if (cursor.parentNode) cursor.remove();
      if (fullText) msgEl.innerHTML = formatMarkdown(fullText);
      else renderRetry();
    } catch (e) {
      if (isTokenOverflowError(e.message)) {
        tokenOverflow = true;
        if (cursor.parentNode) cursor.remove();
        msgEl.innerHTML = CHAT_OVERFLOW_MSG;
        return;
      }
      showError(e.message);
    }
  }

  if (!llmSettings.streamEnabled) {
    await runNonStream();
  } else {
    const filter = createThinkFilter();
    let fellBack = false;
    await new Promise((resolve) => {
      llmChatStream(messages, {
        temperature: 0.5,
        maxTokens: 4096,
        onToken(tok) { fullText += filter.push(tok); render(); },
        onDone() {
          const tail = filter.flush();
          if (tail) fullText += tail;
          if (cursor.parentNode) cursor.remove();
          if (fullText) msgEl.innerHTML = formatMarkdown(fullText);
          else if (!tokenOverflow) renderRetry();
          resolve();
        },
        onError(err, info) {
          if (info && info.tokenOverflow) {
            tokenOverflow = true;
            if (cursor.parentNode) cursor.remove();
            msgEl.innerHTML = CHAT_OVERFLOW_MSG;
            resolve();
            return;
          }
          if (info && !info.gotToken) { fellBack = true; resolve(); return; }
          showError(err);
          resolve();
        },
      });
    });
    // Stream failed before producing any token (e.g. proxy buffering) → try once non-streaming
    if (fellBack) await runNonStream();
  }

  if (fullText && !chatHistory.find(m => m.role === "assistant" && m.content === fullText)) {
    chatHistory.push({ role: "assistant", content: fullText });
  }

  // Auto-retry after token overflow: reset history, remove old bubbles, resend
  if (tokenOverflow) {
    chatHistory.length = 0;
    lastAskContext = "";
    const allBubbles = area ? area.querySelectorAll(".chat-msg.user") : [];
    if (allBubbles.length) allBubbles[allBubbles.length - 1].remove();
    msgEl.remove();
    appendChatMessage("bot", CHAT_RESET_MSG);
    attachedChatImages = [...images];
    await sendChatMessage(userText);
  }
}

// ── Auto-click answers (hybrid: DOM text match → LLM box fallback) ─────────────

const AUTO_CLICK_MIN_CONFIDENCE = 0.5;   // question-level gate on q.confidence
const BOX_FALLBACK_MIN_CONF = 0.3;       // lower gate for the LLM-box fallback click

function autoClickAnswers(result, rect, scrollAnchor) {
  if (!result || !rect) return;
  const questions = result.questions || [];
  const results = result.results || [];
  if (questions.length === 0 && results.length === 0) return;

  // The page may have scrolled while the LLM was thinking — shift the region back
  const dx = scrollAnchor ? scrollAnchor.x - window.scrollX : 0;
  const dy = scrollAnchor ? scrollAnchor.y - window.scrollY : 0;
  const adjRect = { left: rect.left + dx, top: rect.top + dy, width: rect.width, height: rect.height };

  const candidates = collectCandidates(adjRect);
  const answered = new Set();
  const clickedRadioGroups = new Set();
  const usedResults = new Set();
  let matched = 0, boxClicked = 0, lowConf = 0, missed = 0;
  let delay = 0;

  questions.forEach((q, qi) => {
    const qConf = typeof q.confidence === "number" ? q.confidence : 0.7;
    (q.answer_texts || []).forEach(answerText => {
      const normAnswer = normalizeAnswerText(answerText);
      let rIdx = results.findIndex((r, idx) =>
        !usedResults.has(idx) && (r.question_indices || []).includes(qi) &&
        normalizeAnswerText(r.text) === normAnswer);
      if (rIdx < 0) rIdx = results.findIndex((r, idx) => !usedResults.has(idx) && (r.question_indices || []).includes(qi));
      const rEntry = rIdx >= 0 ? results[rIdx] : null;
      if (rIdx >= 0) usedResults.add(rIdx);

      if (qConf < AUTO_CLICK_MIN_CONFIDENCE) { lowConf++; return; }

      const expectedCenter = rEntry ? {
        x: adjRect.left + (rEntry.box[0] + rEntry.box[2]) / 2,
        y: adjRect.top + (rEntry.box[1] + rEntry.box[3]) / 2,
      } : null;

      setTimeout(() => {
        const el = findAnswerElement(answerText, candidates, answered, expectedCenter);
        if (el) {
          const actionable = resolveActionable(el) || el;
          const radio = actionable.matches && actionable.matches('input[type="radio"]') ? actionable
            : (actionable.querySelector ? actionable.querySelector('input[type="radio"]') : null);
          if (radio && radio.name && clickedRadioGroups.has(radio.name)) {
            missed++; // multi-answer output on a single-select group — don't fight it
            return;
          }
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          showAutoClickFlash(cx, cy);
          simulateClick(el, cx, cy);
          answered.add(el);
          answered.add(actionable);
          if (radio && radio.name) clickedRadioGroups.add(radio.name);
          matched++;
        } else if (expectedCenter && rEntry &&
                   (typeof rEntry.confidence !== "number" || rEntry.confidence >= BOX_FALLBACK_MIN_CONF)) {
          // No DOM element matched — fall back to the LLM box center, but only if
          // something clickable actually sits there (guards against stray coords).
          const probe = document.elementFromPoint(
            Math.min(Math.max(expectedCenter.x, 0), window.innerWidth - 1),
            Math.min(Math.max(expectedCenter.y, 0), window.innerHeight - 1));
          if (probe && !(shadowRootHost && shadowRootHost.contains(probe)) && resolveActionable(probe)) {
            const clicked = simulateClickAt(expectedCenter.x, expectedCenter.y);
            if (clicked) { answered.add(clicked); boxClicked++; } else missed++;
          } else missed++;
        } else {
          missed++;
        }
      }, delay);
      delay += 350;
    });
  });

  setTimeout(() => {
    const parts = [`${matched} matched`];
    if (boxClicked) parts.push(`${boxClicked} by box`);
    if (lowConf) parts.push(`${lowConf} skipped (low confidence)`);
    if (missed) parts.push(`${missed} not found`);
    setStatus(`Auto-click: ${parts.join(", ")}`);
  }, delay + 300);
}

// ── Answer-box resolution (client port of translate.py _resolve_answer_boxes) ──
// Degraded ladder without OCR: answer_refs → DOM fuzzy match → LLM fractional box
// (IoU-snapped to a DOM block when possible). Boxes are rect-relative CSS px.

function _answerMatchScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = Math.min(a.length, b.length);
  if (shorter >= 4 && (a.includes(b) || b.includes(a))) return 0.85;
  return Math.max(bigramDice(a, b), levenshteinSim(a, b));
}

function _boxIou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function _fracBoxToPx(box, rect) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const n = box.map(Number);
  if (n.some(v => !isFinite(v))) return null;
  let [l, t, r, bo] = [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
  l = Math.min(1, Math.max(0, l)); t = Math.min(1, Math.max(0, t));
  r = Math.min(1, Math.max(0, r)); bo = Math.min(1, Math.max(0, bo));
  const area = (r - l) * (bo - t);
  if (area <= 0 || area > 0.3) return null;
  return [l * rect.width, t * rect.height, r * rect.width, bo * rect.height];
}

function resolveAnswerEntries(parsed, domBlocks, rect) {
  const results = [];
  const blocks = domBlocks || [];
  const blockNorms = blocks.map(b => normalizeAnswerText(b.text || ""));

  (parsed.questions || []).forEach((q, qIdx) => {
    const answerTexts = q.answer_texts || [];
    const refs = q.answer_refs || [];
    const llmBoxes = q.answer_boxes || [];
    let qConf = Number(q.confidence);
    if (!isFinite(qConf)) qConf = 0.7;
    qConf = Math.min(Math.max(qConf, 0), 1);

    answerTexts.forEach((text, i) => {
      let box = null, source = null, locConf = 0;

      const ref = i < refs.length ? refs[i] : null;
      if (ref !== null && ref !== undefined) {
        const bid = parseInt(ref, 10);
        if (!isNaN(bid) && bid >= 1 && bid <= blocks.length) {
          box = blocks[bid - 1].box; source = "dom_id"; locConf = 0.95;
        }
      }

      if (box === null && blocks.length) {
        const answerNorm = normalizeAnswerText(text);
        let bestIdx = -1, bestScore = 0;
        blockNorms.forEach((bn, bIdx) => {
          const s = _answerMatchScore(answerNorm, bn);
          if (s > bestScore) { bestIdx = bIdx; bestScore = s; }
        });
        if (bestIdx >= 0 && bestScore >= ANSWER_MATCH_THRESHOLD) {
          box = blocks[bestIdx].box; source = "dom_matched"; locConf = bestScore;
        }
      }

      const llmPx = box === null ? _fracBoxToPx(i < llmBoxes.length ? llmBoxes[i] : null, rect) : null;

      if (box === null && llmPx && blocks.length) {
        let bestIdx = -1, bestIou = 0;
        blocks.forEach((b, bIdx) => { const iou = _boxIou(llmPx, b.box); if (iou > bestIou) { bestIdx = bIdx; bestIou = iou; } });
        if (bestIdx >= 0 && bestIou > 0) {
          box = blocks[bestIdx].box; source = "dom_snapped"; locConf = bestIou;
        } else {
          const cx = (llmPx[0] + llmPx[2]) / 2, cy = (llmPx[1] + llmPx[3]) / 2;
          let nIdx = -1, nDist = Infinity;
          blocks.forEach((b, bIdx) => {
            const [bl, bt, br, bb] = b.box;
            const d = ((bl + br) / 2 - cx) ** 2 + ((bt + bb) / 2 - cy) ** 2;
            if (d < nDist) { nIdx = bIdx; nDist = d; }
          });
          if (nIdx >= 0) {
            const [, bt, , bb] = blocks[nIdx].box;
            if (Math.sqrt(nDist) <= 1.5 * Math.max(bb - bt, 1)) {
              box = blocks[nIdx].box; source = "dom_snapped"; locConf = 0.4;
            }
          }
        }
      }

      if (box === null && llmPx) { box = llmPx; source = "llm"; locConf = 0.3; }

      if (box !== null) {
        results.push({
          box: box.map(Number),
          text,
          is_answer: true,
          question_indices: [qIdx],
          source,
          confidence: Math.round(Math.min(locConf, qConf) * 1000) / 1000,
        });
      }
    });
  });
  return results;
}

// ── Ask / Quiz (serverless) ───────────────────────────────────────────────────

async function runAskScan(dataUrl, rect, { allowAutoClick = true } = {}) {
  try {
    setStatus("Analyzing question...");
    const scrollAnchor = { x: window.scrollX, y: window.scrollY };

    // DOM text acts as the "OCR blocks" — only for the live page (not uploads).
    const domBlocks = allowAutoClick ? getRegionDomText(rect) : [];
    let qaContext = [];
    if (domBlocks.length) {
      const all = await qaGetAll();
      qaContext = qaFindRelevant(all, domBlocks.map(b => b.text).join(" "), 5);
    }

    const sendUrl = await downscaleDataUrl(dataUrl);
    const result = await llmAsk(sendUrl, { domBlocks, qaContext });

    switchTab("chat");

    if (result.status === "llm_error") {
      setStatus(`Ask failed: ${result.error || "LLM error"}`, true);
      appendChatMessage("bot", `<em>❌ Ask failed: ${_escapeHtml(result.error || "LLM error")}</em>`);
      return;
    }
    const questions = result.questions || [];
    if (result.status === "no_questions" || questions.length === 0) {
      setStatus("No questions detected in the scan.", true);
      return;
    }
    const totalAnswers = questions.reduce((s, q) => s + (q.answer_texts || []).length, 0);
    setStatus(`✅ ${questions.length} questions, ${totalAnswers} answers`);

    // Auto-click correct answers on the page if enabled (never for uploaded images)
    if (autoClickAnswer && allowAutoClick) {
      const clickResult = { questions, results: resolveAnswerEntries({ questions }, domBlocks, rect) };
      autoClickAnswers(clickResult, rect, scrollAnchor);
    }

    lastAskContext = questions.map((q, i) => {
      const ans = (q.answer_texts || []).join(", ");
      return `Q${i + 1}: ${q.question_text} → Answer: ${ans}. ${q.explanation || ""}`;
    }).join("\n");

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
      if (typeof q.confidence === "number" && q.confidence < AUTO_CLICK_MIN_CONFIDENCE) {
        html += `<div class="chat-exp-text" style="color:#fbbf24">⚠ Độ tin cậy thấp (${Math.round(q.confidence * 100)}%) — không auto-click</div>`;
      }
      if (q.explanation) html += `<div class="chat-exp-label">💡 Explanation</div><div class="chat-exp-text">${_escapeHtml(q.explanation)}</div>`;
    });
    appendChatMessage("bot", html);
  } catch (error) {
    if (error.message === "AbortError" || error.name === "AbortError") setStatus("Request timed out.", true);
    else if (error.message?.includes("Failed to fetch")) setStatus("Không kết nối được API.", true);
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
      // Uploaded images are unrelated to the live page — never auto-click from them
      await runAskScan(dataUrl, rect, { allowAutoClick: false });
    };
    reader.readAsDataURL(file);
  });
  document.body.appendChild(fileInput);
  fileInput.click();
  setTimeout(() => { if (fileInput.parentNode) fileInput.remove(); }, 60000);
}
