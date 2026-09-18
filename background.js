const OFFSCREEN_PATH = 'offscreen.html';

// Keep the MV3 service worker alive while any tab has the content script open.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'nsfw-keepalive') return;
  port.onDisconnect.addListener(() => {});
});

let isOffscreenCreated = false;
let creatingOffscreenPromise = null;

// Synchronously cached configuration to avoid disk-backed LevelDB lookups on every image
let cachedFilterEnabled = true;

chrome.storage.local.get(['filterEnabled']).then((settings) => {
  if (settings && settings.filterEnabled !== undefined) {
    cachedFilterEnabled = settings.filterEnabled;
  }
}).catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.filterEnabled !== undefined) {
    cachedFilterEnabled = changes.filterEnabled.newValue;
  }
});

async function setupOffscreen() {
  if (isOffscreenCreated) return;

  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) {
      isOffscreenCreated = true;
      return;
    }
  } else if (chrome.runtime.getContexts) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts.length > 0) {
      isOffscreenCreated = true;
      return;
    }
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
      isOffscreenCreated = true;
    } catch (err) {
      if (String(err).includes('Only a single offscreen document')) {
        isOffscreenCreated = true;
      } else {
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
        if (response.label === 'model_loading') {
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            continue;
          }
        }
        return response;
      }
    } catch (err) {
      const errStr = String(err);
      const isRetryable =
        errStr.includes('Receiving end does not exist') ||
        errStr.includes('Could not establish connection') ||
        errStr.includes('message channel closed');
      if (isRetryable && attempt < maxAttempts) {
        const delay = Math.min(250 * attempt, 2500);
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
    if (!cachedFilterEnabled) {
      sendResponse({ isSafe: true, label: 'disabled', score: 1.0 });
      return false;
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
    return true;
  }

  if (message.type === 'FILTER_TOGGLED') {
    cachedFilterEnabled = message.enabled;
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
