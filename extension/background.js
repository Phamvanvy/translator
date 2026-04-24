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
  if (message.action !== "captureVisibleTab") {
    return false;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0] || typeof tabs[0].windowId !== "number") {
      sendResponse({ error: "No active tab found." });
      return;
    }

    chrome.tabs.captureVisibleTab(tabs[0].windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ error: chrome.runtime.lastError?.message || "Failed to capture tab." });
        return;
      }
      sendResponse({ dataUrl });
    });
  });

  return true;
});
