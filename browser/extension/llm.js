// ── Cloud LLM module ──────────────────────────────────────────────────────────
// Serverless port of local/server/translate.py + qa_store.py.
// Loaded FIRST (before content.js) so every later content script can call LLM.*.
// All network I/O is proxied through the background service worker (CORS-exempt
// via host_permissions) so we never depend on the public API's CORS headers.

// ── Settings ──────────────────────────────────────────────────────────────────

const LLM_DEFAULTS = {
  llmBaseUrl: "https://api-ai.grader.io.vn",
  llmModel: "Qwen3.6-35B-A3B-Q4_K_M",
  llmApiKey: "",          // optional Authorization: Bearer <key>
  streamEnabled: true,
};

let llmSettings = { ...LLM_DEFAULTS };

async function llmLoadSettings() {
  try {
    const stored = await chrome.storage.local.get(Object.keys(LLM_DEFAULTS));
    llmSettings = { ...LLM_DEFAULTS, ...stored };
    // One-time migration of the old per-site local-extension override keys.
    const legacyUrl = localStorage.getItem("autoScanLLMUrl");
    const legacyModel = localStorage.getItem("autoScanLLMModel");
    if (legacyUrl || legacyModel) {
      const patch = {};
      if (legacyUrl) patch.llmBaseUrl = legacyUrl;
      if (legacyModel) patch.llmModel = legacyModel;
      await llmSaveSettings(patch);
      localStorage.removeItem("autoScanLLMUrl");
      localStorage.removeItem("autoScanLLMModel");
    }
  } catch (_) {
    llmSettings = { ...LLM_DEFAULTS };
  }
  return llmSettings;
}

async function llmSaveSettings(patch) {
  llmSettings = { ...llmSettings, ...patch };
  try { await chrome.storage.local.set(patch); } catch (_) {}
  return llmSettings;
}

// Keep the in-memory cache fresh if another tab changes settings.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(LLM_DEFAULTS)) {
      if (changes[key]) llmSettings[key] = changes[key].newValue;
    }
  });
} catch (_) {}

function llmEndpoint() {
  return String(llmSettings.llmBaseUrl || LLM_DEFAULTS.llmBaseUrl).replace(/\/+$/, "") + "/v1/chat/completions";
}

function llmHeaders() {
  return llmSettings.llmApiKey ? { Authorization: "Bearer " + llmSettings.llmApiKey } : {};
}

// ── Text utilities (ported from translate.py) ─────────────────────────────────

// _strip_think_tokens (translate.py:106)
function stripThink(raw) {
  let cleaned = String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  if (cleaned.includes("</think>")) {
    // Some models emit the closing tag without an opener.
    cleaned = cleaned.split("</think>").pop();
  }
  return cleaned.trim();
}

// Strip markdown ``` fences (translate.py:152-153,766-767,912-913)
function stripCodeFences(s) {
  return String(s || "").replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
}

// _try_parse_json_relaxed (translate.py:132)
function tryParseJsonRelaxed(text) {
  try { return JSON.parse(text); } catch (_) {}
  try {
    // Convert single-quoted (Python-repr) strings to double-quoted JSON.
    const converted = String(text).replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g,
      (_m, g1) => '"' + g1.replace(/"/g, '\\"') + '"');
    return JSON.parse(converted);
  } catch (_) {}
  return null;
}

function extractJsonObject(text) {
  const trimmed = stripCodeFences(stripThink(text));
  let data = tryParseJsonRelaxed(trimmed);
  if (data && typeof data === "object") return data;
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m) { data = tryParseJsonRelaxed(m[0]); if (data) return data; }
  return null;
}

function extractJsonArray(text) {
  const trimmed = stripCodeFences(stripThink(text));
  let data = tryParseJsonRelaxed(trimmed);
  if (Array.isArray(data)) return data;
  const m = trimmed.match(/\[[\s\S]*\]/);
  if (m) { data = tryParseJsonRelaxed(m[0]); if (Array.isArray(data)) return data; }
  return null;
}

// CJK echo rejection (translate.py:224-237)
const LLM_CJK_RE = /[一-鿿㐀-䶿]/;
function isUntranslated(results, sources) {
  if (!results.length) return false;
  const cjkCount = results.filter(r => r && r.trim() && LLM_CJK_RE.test(r)).length;
  if (cjkCount > results.length * 0.5) return true;
  let identical = 0;
  for (let i = 0; i < Math.min(results.length, (sources || []).length); i++) {
    if ((results[i] || "").trim() && results[i].trim() === (sources[i] || "").trim()) identical++;
  }
  if (sources && identical > sources.length * 0.5) return true;
  return false;
}

// _is_token_overflow_error (translate.py:1025)
function isTokenOverflowError(msg) {
  const m = String(msg || "").toLowerCase();
  return ["context_length_exceeded", "no user query found", "maximum context length",
    "too many tokens", "jinja template", "prompt is too long", "exceeds the model's maximum"]
    .some(k => m.includes(k));
}

// Fix LLM forgetting "y": key — "x": 123, "456"  →  "x": 123, "y": 456 (translate.py:915)
function repairAgentYKey(content) {
  return String(content).replace(/("x"\s*:\s*[\d.]+)\s*,\s*"(\d+)"/, '$1, "y": $2');
}

// Stateful <think> filter for streaming: buffers while inside a think block,
// tolerates tags split across tokens. /nothink normally prevents these, safety net.
function createThinkFilter() {
  let buf = "";
  let inThink = false;
  // Longest suffix of buf that is a (proper) prefix of `tag`.
  function partialSuffixLen(tag) {
    const max = Math.min(buf.length, tag.length - 1);
    for (let n = max; n > 0; n--) {
      if (buf.slice(buf.length - n) === tag.slice(0, n)) return n;
    }
    return 0;
  }
  return {
    push(token) {
      buf += token || "";
      let out = "";
      while (true) {
        if (inThink) {
          const close = buf.indexOf("</think>");
          if (close >= 0) { buf = buf.slice(close + 8); inThink = false; continue; }
          // Keep only a possible partial closing tag; discard the rest.
          const keep = partialSuffixLen("</think>");
          buf = keep ? buf.slice(buf.length - keep) : "";
          break;
        } else {
          const open = buf.indexOf("<think>");
          if (open >= 0) { out += buf.slice(0, open); buf = buf.slice(open + 7); inThink = true; continue; }
          const keep = partialSuffixLen("<think>");
          out += keep ? buf.slice(0, buf.length - keep) : buf;
          buf = keep ? buf.slice(buf.length - keep) : "";
          break;
        }
      }
      return out;
    },
    flush() {
      const rest = inThink ? "" : buf;
      buf = "";
      return rest;
    },
  };
}

// ── Image downscale (D7): shrink + JPEG before upload to cut bytes/tokens ──────

function downscaleDataUrl(dataUrl, maxDim = 1280, quality = 0.85) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return resolve(dataUrl);
        const scale = Math.min(1, maxDim / Math.max(w, h));
        if (scale >= 1 && dataUrl.startsWith("data:image/jpeg")) return resolve(dataUrl);
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = cw; canvas.height = ch;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, cw, ch);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    } catch (_) { resolve(dataUrl); }
  });
}

// ── Transport ─────────────────────────────────────────────────────────────────

function extractContent(data) {
  if (!data) throw new Error("Empty response from LLM");
  let raw;
  if (data.choices && data.choices.length) {
    const choice = data.choices[0];
    raw = (choice.message && choice.message.content) || choice.text || "";
  } else if (typeof data.output_text === "string") {
    raw = data.output_text;
  } else if (typeof data.response === "string") {
    raw = data.response;
  } else if (typeof data.text === "string") {
    raw = data.text;
  } else {
    throw new Error("Unexpected LLM response format");
  }
  return stripThink(raw);
}

function llmChat(messages, { temperature = 0.4, maxTokens = 2048, topP = 0.9, timeoutMs = 180000 } = {}) {
  const body = JSON.stringify({
    model: llmSettings.llmModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    top_p: topP,
  });
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error("AbortError")), timeoutMs);
    chrome.runtime.sendMessage(
      { action: "proxyFetch", url: llmEndpoint(), method: "POST", headers: llmHeaders(), body },
      (r) => {
        clearTimeout(tid);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!r || !r.ok) return reject(new Error(r && r.error || "LLM request failed"));
        try { resolve(extractContent(r.data)); } catch (e) { reject(e); }
      }
    );
  });
}

// Streaming chat over the background proxyStream port. Parses raw OpenAI SSE
// deltas ({choices:[{delta:{content}}]}) and llama.cpp in-stream error objects.
function llmChatStream(messages, { onToken, onDone, onError, temperature = 0.5, maxTokens = 4096, topP = 0.9 } = {}) {
  const body = JSON.stringify({
    model: llmSettings.llmModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    top_p: topP,
    stream: true,
  });
  let settled = false;
  let gotToken = false;
  const finish = (fn, ...args) => { if (settled) return; settled = true; try { port.disconnect(); } catch (_) {} if (fn) fn(...args); };

  const port = chrome.runtime.connect({ name: "proxyStream" });
  port.postMessage({ url: llmEndpoint(), headers: llmHeaders(), body });

  port.onMessage.addListener((msg) => {
    if (msg._hb) return;
    if (msg.error) {
      finish(onError, msg.error, { tokenOverflow: isTokenOverflowError(msg.error), gotToken });
      return;
    }
    if (msg.done) { finish(onDone); return; }
    if (typeof msg.line !== "string") return;
    const payload = msg.line;
    if (!payload || payload === "[DONE]") return;
    let parsed;
    try { parsed = JSON.parse(payload); } catch (_) { return; }
    if (parsed.error) {
      const errObj = parsed.error;
      const errMsg = (errObj && typeof errObj === "object" ? errObj.message : errObj) || "LLM error";
      finish(onError, errMsg, { tokenOverflow: isTokenOverflowError(errMsg), gotToken });
      return;
    }
    const token = (((parsed.choices || [])[0] || {}).delta || {}).content || "";
    if (token) { gotToken = true; if (onToken) onToken(token); }
  });

  port.onDisconnect.addListener(() => {
    finish(onDone);
  });
}

// ── Prompts (ported/adapted from translate.py) ────────────────────────────────

const VISION_TRANSLATE_SYSTEM = (
  "You are an expert Manga translator (Chinese → Vietnamese). Your task is to READ the " +
  "text in the image and TRANSLATE it, not merely transcribe it.\n" +
  "\n" +
  "STEP 1 — VISION: Read ALL text blocks in the image, including vertical text (top to " +
  "bottom, columns ordered right to left). Correct obvious OCR-style errors from the image.\n" +
  "\n" +
  "STEP 2 — TRANSLATE: Translate every block into natural, concise Vietnamese. NEVER return " +
  "Chinese characters in the output. Keep trailing '...' or '!'. Keep it short enough to fit " +
  "a speech bubble.\n" +
  "\n" +
  "STEP 3 — RETURN JSON ONLY (no markdown, no explanation):\n" +
  '{"blocks":[{"box":[x1,y1,x2,y2],"src":"<original text>","vi":"<Vietnamese>"}]}\n' +
  "box values are FRACTIONS of the image size in the range 0.0-1.0, as [left, top, right, " +
  "bottom] with (0,0) at the top-left corner.\n" +
  "WARNING: if any \"vi\" value contains Chinese characters the result will be rejected."
);

function buildVisionTranslateUser(glossary, characterNames) {
  const parts = [];
  if (characterNames && characterNames.length) {
    parts.push(`Character names (keep as-is): ${characterNames.join(", ")}.`);
  }
  if (glossary && Object.keys(glossary).length) {
    const entries = Object.entries(glossary).map(([k, v]) => `"${k}" → "${v}"`).join(", ");
    parts.push(`Glossary (use exactly): ${entries}.`);
  }
  parts.push("Read every text block in the image and translate it into Vietnamese. " +
    "Return JSON immediately in the system-prompt format. /nothink");
  return parts.join("\n");
}

const ASK_SYSTEM = (
  "You are a quiz/test solver. Look at the image carefully.\n" +
  "Identify ALL questions visible in the image and their CORRECT answers.\n" +
  "For each correct answer option, provide its bounding box.\n\n" +
  "Return ONLY valid JSON (nothing else):\n" +
  "{\n" +
  '  "questions": [\n' +
  "    {\n" +
  '      "question_text": "question content",\n' +
  '      "answer_texts": ["correct answer 1"],\n' +
  '      "answer_boxes": [[left, top, right, bottom]],\n' +
  '      "confidence": 0.9,\n' +
  '      "explanation": "why this is correct"\n' +
  "    }\n" +
  "  ]\n" +
  "}\n" +
  "Rules:\n" +
  "- answer_boxes[i] is the bounding box of answer_texts[i] as FRACTIONS of the image size " +
  "(0.0-1.0), as [left, top, right, bottom] with (0,0) = top-left\n" +
  "- confidence is 0.0-1.0: how certain you are the chosen answer(s) are correct\n" +
  "- Include ALL correct answers for multi-select questions\n" +
  "- Return questions as an array even if there is only 1 question\n" +
  "- answer_texts and answer_boxes must always be arrays of equal length"
);

const ASK_DOM_REFS_ADDENDUM = (
  "\nThe user message lists text blocks extracted from the page, numbered 1..N.\n" +
  'For each question ALSO return "answer_refs": an array of those block numbers,\n' +
  "one per entry of answer_texts (same length and order), where answer_refs[i] is the\n" +
  "block number containing answer_texts[i]. Use null when no block matches that answer."
);

const AGENT_SYSTEM_PROMPT = (
  "You are an AI agent controlling a web browser to complete tasks for the user.\n" +
  "\n" +
  "You receive:\n" +
  "1. A screenshot of the current viewport\n" +
  "2. A list of visible interactive elements (tag, text, x, y) — use these for precise coordinates\n" +
  "3. Your recent action history — do NOT repeat the same action consecutively\n" +
  "\n" +
  "Return ONLY valid JSON — no markdown, no extra text:\n" +
  '  Click:       {"action": "click",      "x": 320, "y": 450, "reason": "..."}\n' +
  '  Type text:   {"action": "type",       "x": 320, "y": 450, "text": "...", "reason": "..."}\n' +
  '  Press key:   {"action": "press_key",  "key": "Enter", "reason": "..."}\n' +
  '  Scroll down: {"action": "scroll_down","reason": "..."}\n' +
  '  Scroll up:   {"action": "scroll_up",  "reason": "..."}\n' +
  '  Done:        {"action": "done",       "reason": "..."}\n' +
  "\n" +
  "Decision rules (follow in priority order):\n" +
  "1. Prefer the element list over the screenshot for locating click targets. The screenshot " +
  "may be scaled; the element list coordinates are authoritative.\n" +
  "2. Unanswered question visible → click the CORRECT answer.\n" +
  "3. All answers selected and Next/Submit/Continue visible → click it.\n" +
  "4. Input field needs filling → use type action.\n" +
  "5. Need more content → scroll_down (or scroll_up if you overshot).\n" +
  "6. Task fully done or nothing actionable remains → done."
);

const AGENT_PLAN_PROMPT = (
  "You are an AI browser agent. Analyze the current page and output a concise execution plan.\n" +
  "\n" +
  "You receive a screenshot and list of visible interactive elements.\n" +
  "Return ONLY valid JSON:\n" +
  '{"plan": ["Step 1: ...", "Step 2: ..."], "reason": "Brief overview"}\n' +
  "\n" +
  "Keep it concise (max 8 steps). Only describe what you can infer from the current view."
);

const CHAT_SYSTEM_PROMPT = (
  "You are an intelligent assistant helping the user with study and question answering.\n" +
  "When you receive an image containing multiple-choice questions, do the following:\n" +
  "1. Read the question and all answer choices carefully.\n" +
  "2. Identify the CORRECT answer and explain briefly why.\n" +
  "3. Answer in Vietnamese clearly and concisely.\n" +
  "No long-winded reasoning needed — answer directly.\n"
);

function imagePart(dataUrl) {
  const url = dataUrl.startsWith("data:") ? dataUrl : `data:image/png;base64,${dataUrl}`;
  return { type: "image_url", image_url: { url } };
}

// ── High-level calls ──────────────────────────────────────────────────────────

// Returns [{ boxFrac:[l,t,r,b], src, vi }]
async function llmVisionTranslate(dataUrl, { glossary, characterNames } = {}) {
  const messages = [
    { role: "system", content: VISION_TRANSLATE_SYSTEM },
    { role: "user", content: [imagePart(dataUrl), { type: "text", text: buildVisionTranslateUser(glossary, characterNames) }] },
  ];
  let content = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    content = await llmChat(messages, { temperature: 0.4, maxTokens: 2048, timeoutMs: 180000 });
    const blocks = parseVisionBlocks(content);
    if (blocks.length) {
      const vis = blocks.map(b => b.vi);
      const srcs = blocks.map(b => b.src);
      if (!isUntranslated(vis, srcs)) return blocks;
    }
  }
  return parseVisionBlocks(content); // return whatever we got (may be empty)
}

function _clampFrac(v) { const n = Number(v); return isFinite(n) ? Math.min(1, Math.max(0, n)) : null; }

function _normBoxFrac(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const b = box.map(_clampFrac);
  if (b.some(v => v === null)) return null;
  const [l, t, r, bo] = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
  return [l, t, r, bo];
}

function parseVisionBlocks(content) {
  const out = [];
  if (!content) return out;
  const obj = extractJsonObject(content);
  let list = null;
  if (obj && Array.isArray(obj.blocks)) list = obj.blocks;
  else if (obj && Array.isArray(obj.translations)) list = obj.translations;
  if (!list) { const arr = extractJsonArray(content); if (arr) list = arr; }
  if (list) {
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const vi = String(item.vi || item.vietnamese_text || "").trim();
      if (!vi) continue;
      out.push({ boxFrac: _normBoxFrac(item.box), src: String(item.src || "").trim(), vi });
    }
    if (out.length) return out;
  }
  // Regex fallback: pull "vi"/"vietnamese_text" values (translate.py:186)
  const vals = [...content.matchAll(/['"](?:vi|vietnamese_text)['"]\s*:\s*['"]([^'"]+)['"]/g)].map(m => m[1].trim());
  return vals.map(v => ({ boxFrac: null, src: "", vi: v }));
}

// Returns { status:"ok"|"no_questions"|"llm_error", error, questions:[...] }
// Box resolution to page pixels happens client-side (content-chat.js).
async function llmAsk(dataUrl, { domBlocks = [], qaContext = [] } = {}) {
  const ocrRan = domBlocks.length > 0;
  const system = ASK_SYSTEM + (ocrRan ? ASK_DOM_REFS_ADDENDUM : "");
  const parts = [];
  if (qaContext && qaContext.length) {
    parts.push("Refer to similar questions in the knowledge base:");
    for (const qa of qaContext) {
      parts.push(`  Q: ${qa.question || ""}`);
      parts.push(`  A: ${qa.answer || ""}`);
      if (qa.explanation) parts.push(`  Reason: ${qa.explanation}`);
    }
    parts.push("");
  }
  if (ocrRan) {
    parts.push(`Text blocks detected on the page (${domBlocks.length} blocks, numbered 1-based):`);
    domBlocks.forEach((b, i) => parts.push(`  ${i + 1}. "${b.text}"`));
    parts.push("");
  }
  parts.push("Look at the image and return the correct answer(s) with bounding box coordinates. /nothink");

  const messages = [
    { role: "system", content: system },
    { role: "user", content: [imagePart(dataUrl), { type: "text", text: parts.join("\n") }] },
  ];

  let parsed = { questions: [] };
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await llmChat(messages, { temperature: 0.1, maxTokens: 3000, timeoutMs: 180000 });
      parsed = parseAskJson(content);
      if (parsed.questions && parsed.questions.length) { lastError = null; break; }
      lastError = "LLM returned no questions";
    } catch (e) {
      lastError = "LLM request failed: " + e.message;
    }
  }
  let status;
  if (parsed.questions && parsed.questions.length) status = "ok";
  else if (lastError === "LLM returned no questions") status = "no_questions";
  else status = "llm_error";
  return { status, error: status !== "ok" ? lastError : null, questions: parsed.questions || [] };
}

// _parse_ask_json (translate.py:762)
function parseAskJson(text) {
  const data = extractJsonObject(text);
  if (!data || typeof data !== "object") return { questions: [] };
  if (Array.isArray(data.questions)) {
    for (const q of data.questions) {
      if (q && typeof q === "object" && !q.answer_refs && q.answer_box_ids) q.answer_refs = q.answer_box_ids;
    }
    return data;
  }
  // Backward compat: single-question shape → wrap
  if ("answer_text" in data || "answer_box_ids" in data || "answer_refs" in data) {
    return {
      questions: [{
        question_text: data.question_text || "",
        answer_texts: typeof data.answer_text === "string" ? [data.answer_text] : (data.answer_texts || []),
        answer_refs: data.answer_refs || data.answer_box_ids || [],
        answer_boxes: data.answer_boxes || [],
        confidence: data.confidence,
        explanation: data.explanation || "",
      }],
    };
  }
  return { questions: [] };
}

// agent_step (translate.py:844). mode 'act' → action object; 'plan' → {plan, reason}.
async function llmAgentStep(dataUrl, { viewportW = 1280, viewportH = 720, stepHistory = [], domContext = [], task = "", mode = "act" } = {}) {
  const system = mode === "plan" ? AGENT_PLAN_PROMPT : AGENT_SYSTEM_PROMPT;
  const text = [];
  if (task) text.push(`TASK: ${task}\n`);
  text.push(`Viewport: ${viewportW}x${viewportH} px`);
  if (domContext && domContext.length) {
    text.push(`\nVisible interactive elements (${Math.min(domContext.length, 50)} shown):`);
    domContext.slice(0, 50).forEach((el, i) => {
      text.push(`  ${i + 1}. [${el.tag || ""}] "${el.text || ""}" at (${el.x || 0}, ${el.y || 0})`);
    });
  }
  if (mode === "plan") {
    text.push("\nOutput your execution plan as JSON.");
  } else {
    if (stepHistory && stepHistory.length) {
      text.push("\nPrevious steps taken:");
      stepHistory.slice(-5).forEach((entry, i) => text.push(`  ${i + 1}. ${JSON.stringify(entry)}`));
    }
    text.push("\nDecide the single best next action. Return only JSON.");
  }
  const messages = [
    { role: "system", content: system },
    { role: "user", content: [imagePart(dataUrl), { type: "text", text: text.join("\n") + "\n/nothink" }] },
  ];

  try {
    let content = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      content = await llmChat(messages, { temperature: 0.1, maxTokens: 1024, timeoutMs: 120000 });
      if (content) break;
    }
    let c = repairAgentYKey(stripCodeFences(stripThink(content)));
    const m = c.match(/\{[\s\S]*\}/);
    if (m) c = m[0];
    const parsed = tryParseJsonRelaxed(c);
    if (!parsed) throw new Error("Could not parse agent JSON: " + String(content).slice(0, 120));

    if (mode === "plan") {
      return { plan: parsed.plan || [], reason: String(parsed.reason || "") };
    }
    const _toInt = (v) => {
      if (Array.isArray(v)) v = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
      return Math.trunc(Number(v) || 0);
    };
    const action = parsed.action || "done";
    const result = { action, reason: String(parsed.reason || "") };
    if (action === "click" || action === "type") { result.x = _toInt(parsed.x); result.y = _toInt(parsed.y); }
    if (action === "type") result.text = String(parsed.text || "");
    if (action === "press_key") result.key = String(parsed.key || "Enter");
    return result;
  } catch (exc) {
    return { action: "done", reason: "Error: " + exc.message };
  }
}

// chat_with_model message assembly (translate.py:1057). images: array of data URLs.
function llmBuildChatMessages(userText, { context = "", history = [], images = [] } = {}) {
  const messages = [{ role: "system", content: CHAT_SYSTEM_PROMPT }];
  if (context) messages.push({ role: "system", content: `Most recent question context:\n${context}` });
  for (const turn of (history || []).slice(-8)) {
    const role = turn.role || "user";
    const content = turn.content || "";
    if ((role === "user" || role === "assistant") && content) messages.push({ role, content });
  }
  if (images && images.length) {
    const parts = images.map(imagePart);
    const text = (userText || "Please read the image and answer the question in the image. " +
      "Identify the correct answer and explain briefly in Vietnamese.") + " /nothink";
    parts.push({ type: "text", text });
    messages.push({ role: "user", content: parts });
  } else {
    messages.push({ role: "user", content: (userText || "") + " /nothink" });
  }
  return messages;
}

// ── Q&A knowledge base (ported from qa_store.py, backed by chrome.storage.local) ─

const QA_STORAGE_KEY = "qaKnowledge";

async function qaGetAll() {
  try {
    const stored = await chrome.storage.local.get(QA_STORAGE_KEY);
    const list = stored[QA_STORAGE_KEY];
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

async function qaAdd(question, answer, explanation = "") {
  const list = await qaGetAll();
  const nextId = list.reduce((mx, e) => Math.max(mx, e.id || 0), 0) + 1;
  const entry = {
    id: nextId,
    question: String(question || "").trim(),
    answer: String(answer || "").trim(),
    explanation: String(explanation || "").trim(),
  };
  list.push(entry);
  try { await chrome.storage.local.set({ [QA_STORAGE_KEY]: list }); } catch (_) {}
  return entry;
}

async function qaRemove(qaId) {
  const list = await qaGetAll();
  const next = list.filter(e => e.id !== qaId);
  if (next.length === list.length) return false;
  try { await chrome.storage.local.set({ [QA_STORAGE_KEY]: next }); } catch (_) {}
  return true;
}

// find_relevant_qa (qa_store.py:57). Pure over the provided list.
function qaFindRelevant(list, questionText, topK = 5) {
  if (!list || !list.length) return [];
  const qLower = String(questionText || "").toLowerCase();
  const words = qLower.split(/\s+/).filter(w => w.length > 2);
  const scored = [];
  for (const entry of list) {
    const entryQ = String(entry.question || "").toLowerCase();
    let score = words.reduce((s, w) => s + (entryQ.includes(w) ? 1 : 0), 0);
    for (let length = 12; length > 4; length--) {
      let found = false;
      for (let i = 0; i <= qLower.length - length; i++) {
        if (entryQ.includes(qLower.slice(i, i + length))) { score += 3; found = true; break; }
      }
      if (found) break;
    }
    if (score > 0) scored.push([score, entry]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, topK).map(x => x[1]);
}
