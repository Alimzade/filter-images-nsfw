const OFFSCREEN_PATH = 'offscreen.html';

// Keep the MV3 service worker alive while any tab has the content script open.
// Without this, Chrome terminates the SW mid-request, closing the message
// channel before sendResponse is ever called.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'nsfw-keepalive') return;
  port.onDisconnect.addListener(() => {});
});

let creatingOffscreenPromise = null;

async function setupOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) return;
  } else if (chrome.runtime.getContexts) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts.length > 0) return;
  }

  if (creatingOffscreenPromise) {
    return creatingOffscreenPromise;
  }

  creatingOffscreenPromise = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL(OFFSCREEN_PATH),
        reasons: ['DOM_PARSER'],
        justification: 'Running AI model for image classification',
      });
    } catch (err) {
      if (!String(err).includes('Only a single offscreen document')) {
        throw err;
      }
    } finally {
      creatingOffscreenPromise = null;
    }
  })();

  return creatingOffscreenPromise;
}

async function sendToOffscreenWithRetry(payload, maxAttempts = 12) {
  await setupOffscreen();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage(payload);
      if (response !== undefined) {
        // Offscreen responded but model is still loading - wait and retry
        if (response.label === 'model_loading') {
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            continue;
          }
        }
        return response;
      }
    } catch (err) {
      const errStr = String(err);
      // "Receiving end does not exist" = offscreen not yet created
      // "message channel closed" = offscreen is loading the model,
      //   sendResponse not called before Chrome closed the channel
      const isRetryable =
        errStr.includes('Receiving end does not exist') ||
        errStr.includes('Could not establish connection') ||
        errStr.includes('message channel closed');
      if (isRetryable && attempt < maxAttempts) {
        // Exponential backoff capped at 3s; gives up to ~20s total for model load
        const delay = Math.min(300 * attempt, 3000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        await setupOffscreen();
        continue;
      }
      throw err;
    }
  }
  throw new Error('Offscreen document failed to respond after retries');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_NSFW') {
    chrome.storage.local.get(['filterEnabled']).then((settings) => {
      if (settings && settings.filterEnabled === false) {
        sendResponse({ isSafe: true, label: 'disabled', score: 1.0 });
        return;
      }
      sendToOffscreenWithRetry({
        ...message,
        type: 'CHECK_NSFW_OFFSCREEN',
      })
        .then((result) => sendResponse(result))
        .catch((e) => {
          console.error('Offscreen Check Error:', e);
          sendResponse({ isSafe: true, label: 'relay_error' });
        });
    }).catch(() => {
      sendToOffscreenWithRetry({
        ...message,
        type: 'CHECK_NSFW_OFFSCREEN',
      })
        .then((result) => sendResponse(result))
        .catch((e) => {
          console.error('Offscreen Check Error:', e);
          sendResponse({ isSafe: true, label: 'relay_error' });
        });
    });
    return true;
  }

  if (message.type === 'FILTER_TOGGLED') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, {
              type: 'FILTER_TOGGLED',
              enabled: message.enabled,
            }).catch(() => {});
          }
        }
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true;
  }
});

