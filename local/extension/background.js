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
  console.log("[proxyStream] port connected");
  let tokenCount = 0;
  let heartbeatTimer = null;
  const HEARTBEAT_INTERVAL = 15000; // send ping every 15s to prevent Chrome's 30s idle disconnect

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
    console.log("[proxyStream] request to:", req.url);
    try {
      // Immediately start forwarding SSE data to keep port alive
      // This must happen BEFORE awaiting fetch so the port doesn't die during server processing
      const resp = await fetch(req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: req.body,
      });
      console.log("[proxyStream] fetch done, status:", resp.status);
      if (!resp.ok) {
        console.error("[proxyStream] HTTP error:", resp.status);
        port.postMessage({ error: `HTTP ${resp.status}` });
        return;
      }
      console.log("[proxyStream] starting SSE read loop");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let firstChunk = true;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log("[proxyStream] reader done after", tokenCount, "tokens");
          break;
        }
        const text = decoder.decode(value, { stream: true });
        console.log("[proxyStream] raw chunk:", text.substring(0, 200));
        buf += text;
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") {
              console.log("[proxyStream] received [DONE] after", tokenCount, "tokens");
            } else {
              tokenCount++;
              if (tokenCount <= 5) console.log("[proxyStream] token", tokenCount, ":", payload.substring(0, 100));
            }
            console.log("[proxyStream] forwarding to content:", payload.substring(0, 100));
            // Keep port alive by posting every chunk immediately
            port.postMessage({ line: payload });
            // Signal on first chunk that the connection is good
            if (firstChunk) { firstChunk = false; }
          }
        }
      }
      // Check last buffered line
      if (buf.startsWith("data:")) {
        console.log("[proxyStream] final buffer:", buf.substring(0, 60));
        port.postMessage({ line: buf.slice(5).trim() });
      }
      console.log("[proxyStream] sending { done: true }");
      port.postMessage({ done: true });
    } catch (err) {
      console.error("[proxyStream] exception:", err.message);
      try { port.postMessage({ error: err.message }); } catch (_) {}
    } finally {
      stopHeartbeat();
    }
  });

  port.onDisconnect.addListener(() => {
    console.log("[proxyStream] port disconnected after", tokenCount, "tokens");
    stopHeartbeat();
  });
});
