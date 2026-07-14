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
  // Proxy non-streaming fetch requests (host_permissions make this CORS-exempt)
  if (message.action === "proxyFetch") {
    fetch(message.url, {
      method: message.method || "POST",
      headers: { "Content-Type": "application/json", ...(message.headers || {}) },
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

  // Use the sender tab's windowId so DevTools focus doesn't break capture
  const windowId = sender && sender.tab && typeof sender.tab.windowId === "number"
    ? sender.tab.windowId
    : null;
  const tabId = sender && sender.tab && sender.tab.id ? sender.tab.id : null;

  chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
    if (chrome.runtime.lastError || !dataUrl) {
      sendResponse({ error: chrome.runtime.lastError?.message || "Failed to capture tab.", tabId });
      return;
    }
    sendResponse({ dataUrl, tabId });
  });

  return true;
});

// Proxy SSE streaming requests via long-lived port connection
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "proxyStream") return;
  let tokenCount = 0;
  let heartbeatTimer = null;
  const HEARTBEAT_INTERVAL = 15000; // ping every 15s to prevent Chrome's 30s idle disconnect

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      try { port.postMessage({ _hb: true }); } catch (_) { stopHeartbeat(); }
    }, HEARTBEAT_INTERVAL);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // Start heartbeat immediately to keep port alive from the very first second
  startHeartbeat();

  port.onMessage.addListener(async (req) => {
    try {
      const resp = await fetch(req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(req.headers || {}) },
        body: req.body,
      });
      if (!resp.ok) {
        let detail = "";
        try { detail = (await resp.text()).slice(0, 200); } catch (_) {}
        port.postMessage({ error: `HTTP ${resp.status}${detail ? ": " + detail : ""}` });
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
            const payload = line.slice(5).trim();
            if (payload !== "[DONE]") tokenCount++;
            // Keep port alive by posting every chunk immediately
            port.postMessage({ line: payload });
          }
        }
      }
      if (buf.startsWith("data:")) {
        port.postMessage({ line: buf.slice(5).trim() });
      }
      port.postMessage({ done: true });
    } catch (err) {
      console.error("[proxyStream] exception:", err.message);
      try { port.postMessage({ error: err.message }); } catch (_) {}
    } finally {
      stopHeartbeat();
    }
  });

  port.onDisconnect.addListener(() => {
    stopHeartbeat();
  });
});
