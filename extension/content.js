const SERVER_URL = "http://127.0.0.1:8000";
let autoScanEnabled = false;
let currentImage = null;
let debounceTimer = null;
let overlayRoot = null;
let statusBox = null;
let toggleButton = null;
const visibleImages = new Map();

function log(...args) {
  console.log("[MangaAutoScan]", ...args);
}

function ensureOverlay() {
  if (overlayRoot) {
    return;
  }

  const styleLink = document.createElement("link");
  styleLink.rel = "stylesheet";
  styleLink.href = chrome.runtime.getURL("overlay.css");
  document.head.appendChild(styleLink);

  overlayRoot = document.createElement("div");
  overlayRoot.id = "autoScanOverlay";
  document.body.appendChild(overlayRoot);
}

function createStatusBox() {
  if (statusBox) {
    return;
  }

  statusBox = document.createElement("div");
  statusBox.id = "autoScanStatus";
  statusBox.textContent = "Auto-scan ready";
  document.body.appendChild(statusBox);
}

function updateStatus(message) {
  createStatusBox();
  statusBox.textContent = message;
}

function createToggleButton() {
  if (toggleButton) {
    return;
  }

  toggleButton = document.createElement("button");
  toggleButton.id = "mangaAutoScanButton";
  toggleButton.type = "button";
  toggleButton.textContent = "Auto-scan OFF (Alt+S)";
  toggleButton.addEventListener("click", () => {
    setAutoScan(!autoScanEnabled);
  });
  document.body.appendChild(toggleButton);
}

function setAutoScan(enabled) {
  autoScanEnabled = enabled;
  createToggleButton();
  createStatusBox();

  toggleButton.textContent = enabled ? "Auto-scan ON (Alt+S)" : "Auto-scan OFF (Alt+S)";
  updateStatus(enabled ? "Auto-scan bật, kéo trang để quét." : "Auto-scan tắt.");

  if (!enabled) {
    clearBoxes();
  }
}

function clearBoxes() {
  if (!overlayRoot) {
    return;
  }
  overlayRoot.innerHTML = "";
}

function createTextBox(result, offsetLeft, offsetTop) {
  const box = document.createElement("div");
  box.className = "autoScanTextBox";
  box.textContent = result.translation || result.text;
  box.style.left = `${offsetLeft + result.box[0]}px`;
  box.style.top = `${offsetTop + result.box[1]}px`;
  box.style.minWidth = "120px";
  box.style.maxWidth = "360px";
  overlayRoot.appendChild(box);
}

function sendCaptureRequest(rect) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "captureVisibleTab" }, resolve);
  });
}

function cropImage(dataUrl, rect) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(
        image,
        Math.round(rect.left * dpr),
        Math.round(rect.top * dpr),
        Math.round(rect.width * dpr),
        Math.round(rect.height * dpr),
        0,
        0,
        Math.round(rect.width * dpr),
        Math.round(rect.height * dpr)
      );
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function fetchTranslation(imageDataUrl) {
  const response = await fetch(`${SERVER_URL}/api/translate-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: imageDataUrl }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Server lỗi: ${response.status} ${body}`);
  }

  return response.json();
}

async function captureAndTranslate(rect) {
  ensureOverlay();
  updateStatus("Đang chụp... vui lòng đợi");

  const captureResponse = await sendCaptureRequest(rect);
  if (!captureResponse || captureResponse.error) {
    updateStatus(`Capture thất bại: ${captureResponse?.error || "Không nhận được ảnh"}`);
    return;
  }

  clearBoxes();
  const cropUrl = await cropImage(captureResponse.dataUrl, rect);
  updateStatus("Đang OCR và dịch..." );

  try {
    const payload = await fetchTranslation(cropUrl);
    const results = payload.results || [];

    const offsetLeft = rect.left + window.scrollX;
    const offsetTop = rect.top + window.scrollY;

    if (!results.length) {
      updateStatus("Không tìm thấy text để dịch.");
      return;
    }

    results.forEach((item) => createTextBox(item, offsetLeft, offsetTop));
    updateStatus(`Đã dịch ${results.length} khối text.`);
  } catch (error) {
    console.error(error);
    updateStatus(`Lỗi dịch: ${error.message}`);
  }
}

function scheduleCapture(rect) {
  if (!autoScanEnabled) {
    return;
  }

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    captureAndTranslate(rect).catch((err) => {
      console.error(err);
      updateStatus(`Lỗi: ${err.message}`);
    });
  }, 420);
}

function handleIntersection(entries) {
  if (!autoScanEnabled) {
    return;
  }

  entries.forEach((entry) => {
    if (entry.isIntersecting && entry.intersectionRatio > 0.2) {
      visibleImages.set(entry.target, entry);
    } else {
      visibleImages.delete(entry.target);
    }
  });

  const best = [...visibleImages.entries()].sort((a, b) => b[1].intersectionRatio - a[1].intersectionRatio)[0];
  if (!best) {
    return;
  }

  const image = best[0];
  const rect = image.getBoundingClientRect();
  if (currentImage !== image) {
    currentImage = image;
    scheduleCapture(rect);
  }
}

function initializeObserver() {
  const images = Array.from(document.querySelectorAll("img"))
    .filter((img) => img.naturalWidth > 160 && img.naturalHeight > 160);

  if (!images.length) {
    updateStatus("Không tìm thấy ảnh phù hợp để quét.");
  }

  const observer = new IntersectionObserver(handleIntersection, {
    root: null,
    rootMargin: "0px",
    threshold: [0.2, 0.4, 0.6, 0.8],
  });

  images.forEach((img) => observer.observe(img));
}

function handleMessage(message) {
  if (!message || !message.action) {
    return;
  }

  if (message.action === "toggle-auto-scan") {
    setAutoScan(!autoScanEnabled);
  }

  if (message.action === "capture-now") {
    const image = currentImage || document.querySelector("img");
    if (!image) {
      updateStatus("Không có ảnh để chụp ngay.");
      return;
    }
    const rect = image.getBoundingClientRect();
    captureAndTranslate(rect).catch((err) => {
      console.error(err);
      updateStatus(`Lỗi: ${err.message}`);
    });
  }
}

function handleKeydown(event) {
  if (event.altKey && event.code === "KeyS") {
    event.preventDefault();
    setAutoScan(!autoScanEnabled);
  }
  if (event.altKey && event.shiftKey && event.code === "KeyS") {
    event.preventDefault();
    handleMessage({ action: "capture-now" });
  }
}

window.addEventListener("keydown", handleKeydown, true);
chrome.runtime.onMessage.addListener((message) => {
  handleMessage(message);
});

createToggleButton();
ensureOverlay();
createStatusBox();
initializeObserver();
