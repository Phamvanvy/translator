// ===== Shared click simulation & answer matching =====
// Loaded after content.js (globals) and before content-scan.js / content-chat.js,
// which both use these helpers.

const FLASH_STYLE_ID = "mas-click-flash-style";

function ensureFlashStyle() {
  if (document.getElementById(FLASH_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = FLASH_STYLE_ID;
  style.textContent = `
    @keyframes auto-click-flash {
      0%   { transform: scale(0.5); opacity: 1; }
      100% { transform: scale(2.5); opacity: 0; }
    }
    .auto-click-flash {
      position: fixed;
      pointer-events: none;
      border-radius: 50%;
      border: 3px solid #4ade80;
      box-shadow: 0 0 14px #4ade80, 0 0 4px #fff;
      animation: auto-click-flash 0.45s ease-out forwards;
      z-index: 2147483647;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function showAutoClickFlash(screenX, screenY) {
  ensureFlashStyle();
  const SIZE = 36;
  const el = document.createElement("div");
  el.className = "auto-click-flash";
  el.style.cssText = `left:${Math.round(screenX - SIZE / 2)}px;top:${Math.round(screenY - SIZE / 2)}px;width:${SIZE}px;height:${SIZE}px;`;
  // Flash must live outside shadow DOM to overlay any element on page
  document.documentElement.appendChild(el);
  el.addEventListener("animationend", () => el.remove(), { once: true });
  // animationend never fires when the tab is hidden or animations are disabled
  setTimeout(() => el.remove(), 1200);
}

const ACTIONABLE_SELECTOR = [
  "input", "button", "select", "textarea", "a[href]", "label",
  '[role="button"]', '[role="radio"]', '[role="checkbox"]', '[role="option"]',
  '[role="menuitem"]', '[role="tab"]', "[onclick]", '[tabindex]:not([tabindex="-1"])',
].join(", ");

function resolveActionable(el) {
  let node = el;
  for (let depth = 0; node && node !== document.body && depth < 8; depth++) {
    if (node.matches && node.matches(ACTIONABLE_SELECTOR)) return node;
    node = node.parentElement;
  }
  return null;
}

function simulateClick(target, clientX, clientY) {
  const el = resolveActionable(target) || target;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY, button: 0 };
  const ptr = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
  try { el.dispatchEvent(new PointerEvent("pointerdown", ptr)); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mousedown", base));
  try { el.dispatchEvent(new PointerEvent("pointerup", ptr)); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mouseup", base));
  el.dispatchEvent(new MouseEvent("click", base));
  // Native fallback for radios/checkboxes that frameworks didn't toggle
  let input = null;
  if (el.matches && el.matches('input[type="radio"], input[type="checkbox"]')) input = el;
  else if (el.tagName === "LABEL" && el.control) input = el.control;
  else if (el.querySelector) input = el.querySelector('input[type="radio"], input[type="checkbox"]');
  if (input && (input.type === "radio" || input.type === "checkbox") && !input.checked) input.click();
  return el;
}

function simulateClickAt(x, y, { flash = true } = {}) {
  const cx = Math.min(Math.max(x, 0), window.innerWidth - 1);
  const cy = Math.min(Math.max(y, 0), window.innerHeight - 1);
  if (flash) showAutoClickFlash(cx, cy);
  const target = document.elementFromPoint(cx, cy);
  if (!target || target === document.documentElement || target === document.body) return null;
  if (shadowRootHost && (target === shadowRootHost || shadowRootHost.contains(target))) return null;
  return simulateClick(target, cx, cy);
}

// ===== Answer text matching (kept in sync with server-side _normalize_answer_text) =====

function normalizeAnswerText(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/^[a-d][.)]\s*|^\d+[.)]\s*|^[•○◯□☐■◉●*-]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,:;!?]+|[\s.,:;!?]+$/g, "");
}

function bigramDice(a, b) {
  if (a.length < 2 || b.length < 2) return a && a === b ? 1 : 0;
  const bigrams = s => { const set = new Set(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; };
  const setA = bigrams(a), setB = bigrams(b);
  let shared = 0;
  for (const bg of setA) if (setB.has(bg)) shared++;
  return (2 * shared) / (setA.size + setB.size);
}

function levenshteinSim(a, b) {
  a = a.slice(0, 80); b = b.slice(0, 80);
  if (a === b) return 1;
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr.push(Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = curr;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

function textSimilarity(a, b) {
  return Math.max(bigramDice(a, b), levenshteinSim(a, b));
}

const ANSWER_MATCH_THRESHOLD = 0.6;

const ANSWER_CANDIDATE_SELECTOR = [
  "label", "button", "a", "li", "td",
  '[role="radio"]', '[role="checkbox"]', '[role="option"]', '[role="button"]',
  'input[type="radio"]', 'input[type="checkbox"]',
].join(", ");

function _isChoiceLike(el) {
  if (el.matches('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="option"]')) return true;
  if (el.tagName === "LABEL" && el.control) return true;
  return !!(el.querySelector && el.querySelector('input[type="radio"], input[type="checkbox"]'));
}

// Scan the DOM once per auto-click run; answers are scored against this cache.
function collectCandidates(regionRect) {
  const PAD = 40;
  const left = regionRect.left - PAD, top = regionRect.top - PAD;
  const right = regionRect.left + regionRect.width + PAD, bottom = regionRect.top + regionRect.height + PAD;
  const candidates = [];
  for (const el of document.querySelectorAll(ANSWER_CANDIDATE_SELECTOR)) {
    if (shadowRootHost && (el === shadowRootHost || shadowRootHost.contains(el))) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right < left || r.left > right || r.bottom < top || r.top > bottom) continue;
    if (getComputedStyle(el).visibility === "hidden") continue;
    let text;
    if (el.tagName === "INPUT") {
      text = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("aria-label") || "";
    } else {
      text = el.innerText || el.textContent || "";
    }
    const normText = normalizeAnswerText(text);
    if (!normText) continue;
    candidates.push({ el, normText, rect: r, choiceLike: _isChoiceLike(el) });
  }
  return candidates;
}

function findAnswerElement(answerText, candidates, exclude, expectedCenter) {
  const norm = normalizeAnswerText(answerText);
  if (!norm) return null;
  let best = null;
  for (const c of candidates) {
    if (exclude && exclude.has(c.el)) continue;
    let score;
    if (c.normText === norm) {
      score = 3;
    } else if (Math.min(c.normText.length, norm.length) >= 4 &&
               (c.normText.includes(norm) || norm.includes(c.normText))) {
      score = 2;
    } else {
      const sim = textSimilarity(norm, c.normText);
      if (sim < ANSWER_MATCH_THRESHOLD) continue;
      score = sim;
    }
    const dist = expectedCenter
      ? Math.hypot(c.rect.left + c.rect.width / 2 - expectedCenter.x, c.rect.top + c.rect.height / 2 - expectedCenter.y)
      : 0;
    const entry = { ...c, score, dist };
    if (!best ||
        entry.score > best.score ||
        (entry.score === best.score && entry.choiceLike && !best.choiceLike) ||
        (entry.score === best.score && entry.choiceLike === best.choiceLike && entry.normText.length < best.normText.length) ||
        (entry.score === best.score && entry.choiceLike === best.choiceLike && entry.normText.length === best.normText.length && entry.dist < best.dist)) {
      best = entry;
    }
  }
  return best ? best.el : null;
}
