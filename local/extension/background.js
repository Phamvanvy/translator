chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0] || !tabs[0].id) {
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { action: command }, () => {
      if (chrome.runtime.lastError) {
        console.warn("Background command failed:", chrome.runtime.lastError.message);
      }
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Proxy non-streaming fetch requests (bypasses mixed-content block in content scripts)
  if (message.action === "proxyFetch") {
    fetch(message.url, {
      method: message.method || "POST",
      headers: message.headers || { "Content-Type": "application/json" },
      body: message.body,
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (message.action !== "captureVisibleTab") {
    return false;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0] || typeof tabs[0].windowId !== "number") {
      sendResponse({ error: "No active tab found." });
      return;
    }

    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ error: chrome.runtime.lastError?.message || "Failed to capture tab." });
        return;
      }
      sendResponse({ dataUrl, tabId: tabs[0].id });
    });
  });

  return true;
});

// Proxy SSE streaming requests via long-lived port connection
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "proxyStream") return;
  port.onMessage.addListener(async (req) => {
    try {
      const resp = await fetch(req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: req.body,
      });
      if (!resp.ok) {
        port.postMessage({ error: `HTTP ${resp.status}` });
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith("data:")) {
            port.postMessage({ line: line.slice(5).trim() });
          }
        }
      }
      if (buf.startsWith("data:")) port.postMessage({ line: buf.slice(5).trim() });
      port.postMessage({ done: true });
    } catch (err) {
      try { port.postMessage({ error: err.message }); } catch (_) {}
    }
  });
});
