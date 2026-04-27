console.log("Manga AutoScan offscreen document loaded.");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "ping") {
    sendResponse({ pong: true });
  }
});
