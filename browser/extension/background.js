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
  if (message.action === "captureVisibleTab") {
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
  }

  if (message.action === "proxyFetch") {
    const { url, init } = message;
    const body = init?.body;
    const requestInit = {
      method: init?.method || "GET",
      headers: init?.headers || {},
      mode: "cors",
    };
    if (body != null) {
      requestInit.body = typeof body === "string" ? body : JSON.stringify(body);
      if (typeof body !== "string") {
        requestInit.headers = { ...requestInit.headers, "Content-Type": "application/json" };
      }
    }

    fetch(url, requestInit)
      .then(async (response) => {
        const contentType = response.headers.get("content-type") || "";
        const result = contentType.includes("application/json")
          ? await response.json()
          : await response.text();
        if (!response.ok) {
          sendResponse({ error: `HTTP ${response.status}`, status: response.status, data: result });
        } else {
          sendResponse({ data: result });
        }
      })
      .catch((err) => {
        sendResponse({ error: err.message || "Proxy fetch failed." });
      });
    return true;
  }

  return false;
});
