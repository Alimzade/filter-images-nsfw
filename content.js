console.log('NSFW Filter: Active');

// Keep the background service worker alive so long-running inference requests
// don't kill the message channel.
function connectKeepalive() {
  try {
    const port = chrome.runtime.connect({ name: 'nsfw-keepalive' });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) return;
      setTimeout(connectKeepalive, 250);
    });
  } catch (_) {
    // Extension context invalidated; content script is orphaned
  }
}
connectKeepalive();

const safeUrls = new Set();
const blockedUrls = new Set();
let isFilterActive = true;

// Concurrency control and viewport prioritization
const MAX_CONCURRENT_SCANS = 4;
let activeScans = 0;
const scanQueue = [];
const visibleImages = new WeakSet();

function setDisabledState(disabled) {
  isFilterActive = !disabled;
  if (disabled) {
    scanQueue.length = 0;
    document.documentElement.classList.add('nsfw-disabled');
    document.querySelectorAll('img').forEach((img) => {
      img.classList.remove('nsfw-blocked');
      img.classList.add('nsfw-safe');
      img.dataset.nsfwStatus = 'safe';
    });
  } else {
    document.documentElement.classList.remove('nsfw-disabled');
    document.querySelectorAll('img').forEach((img) => {
      delete img.dataset.nsfwStatus;
      img.classList.remove('nsfw-safe');
      viewportObserver.observe(img);
    });
  }
}

chrome.storage.local.get(['filterEnabled']).then((data) => {
  if (data && data.filterEnabled === false) {
    setDisabledState(true);
  }
}).catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.filterEnabled !== undefined) {
    setDisabledState(!changes.filterEnabled.newValue);
  }
});

function removeFromQueue(img) {
  const index = scanQueue.findIndex((item) => item.img === img);
  if (index !== -1) {
    scanQueue.splice(index, 1);
    if (img.dataset.nsfwStatus === 'pending') {
      delete img.dataset.nsfwStatus;
    }
  }
}

function requestScan(img) {
  if (!chrome.runtime?.id) return;
  const url = img.currentSrc || img.src;
  if (!url) return;

  if (!isFilterActive) {
    img.classList.remove('nsfw-blocked');
    img.classList.add('nsfw-safe');
    img.dataset.nsfwStatus = 'safe';
    return;
  }

  // Handle SPA image changes where src was updated on existing img tag
  if (img.dataset.nsfwLastUrl && img.dataset.nsfwLastUrl !== url) {
    img.classList.remove('nsfw-safe');
    img.classList.remove('nsfw-blocked');
    delete img.dataset.nsfwStatus;
    removeFromQueue(img);
  }

  if (safeUrls.has(url)) {
    img.classList.remove('nsfw-blocked');
    img.classList.add('nsfw-safe');
    img.dataset.nsfwStatus = 'safe';
    img.dataset.nsfwLastUrl = url;
    viewportObserver.unobserve(img);
    return;
  }
  if (blockedUrls.has(url)) {
    img.classList.remove('nsfw-safe');
    img.classList.add('nsfw-blocked');
    img.dataset.nsfwStatus = 'blocked';
    img.dataset.nsfwLastUrl = url;
    viewportObserver.unobserve(img);
    return;
  }

  if (img.dataset.nsfwLastUrl === url &&
      (img.dataset.nsfwStatus === 'pending' || img.dataset.nsfwStatus === 'processing' ||
       img.dataset.nsfwStatus === 'safe' || img.dataset.nsfwStatus === 'blocked' ||
       img.dataset.nsfwStatus === 'fallback_safe' || img.dataset.nsfwStatus === 'error_safe')) {
    return;
  }

  img.dataset.nsfwStatus = 'pending';
  img.dataset.nsfwLastUrl = url;

  // Prioritize recently visible images (LIFO)
  removeFromQueue(img);
  scanQueue.unshift({ img, url });
  pumpQueue();
}

function pumpQueue() {
  if (!isFilterActive) return;

  while (activeScans < MAX_CONCURRENT_SCANS && scanQueue.length > 0) {
    const item = scanQueue.shift();
    const { img, url } = item;

    // Discard if element is detached or no longer intersecting viewport
    if (!img.isConnected || !visibleImages.has(img)) {
      if (img.isConnected && img.dataset.nsfwStatus === 'pending') {
        delete img.dataset.nsfwStatus;
      }
      continue;
    }

    const currentUrl = img.currentSrc || img.src;
    if (currentUrl !== url) {
      delete img.dataset.nsfwStatus;
      continue;
    }

    activeScans++;
    img.dataset.nsfwStatus = 'processing';

    processImage(img, currentUrl, safeUrls, blockedUrls)
      .finally(() => {
        activeScans--;
        pumpQueue();
      });
  }
}

const viewportObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    const img = entry.target;
    if (entry.isIntersecting) {
      visibleImages.add(img);
      requestScan(img);
    } else {
      visibleImages.delete(img);
      removeFromQueue(img);
    }
  });
}, { threshold: 0.01, rootMargin: '200px 0px' });

const domObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.type === 'attributes' && (mutation.attributeName === 'src' || mutation.attributeName === 'srcset')) {
      const target = mutation.target;
      if (target instanceof HTMLImageElement) {
        viewportObserver.observe(target);
      }
      return;
    }

    mutation.addedNodes.forEach((node) => {
      if (node instanceof HTMLImageElement) {
        viewportObserver.observe(node);
      } else if (node instanceof HTMLElement) {
        node.querySelectorAll('img').forEach((img) => {
          viewportObserver.observe(img);
        });
      }
    });
  });
});

document.querySelectorAll('img').forEach((img) => {
  viewportObserver.observe(img);
});

domObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'srcset'],
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'FILTER_TOGGLED') {
    setDisabledState(!message.enabled);
  }
});

async function processImage(img, currentUrl, safeUrls, blockedUrls) {
  try {
    if (!img.complete) {
      await new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 3000);
      });
    }

    if (!img.isConnected) {
      delete img.dataset.nsfwStatus;
      return;
    }

    if (img.complete && img.naturalWidth === 0) {
      img.classList.add('nsfw-safe');
      img.dataset.nsfwStatus = 'safe';
      viewportObserver.unobserve(img);
      return;
    }

    if (img.naturalWidth > 0 && img.naturalWidth < 32 && img.naturalHeight < 32) {
      img.classList.add('nsfw-safe');
      img.dataset.nsfwStatus = 'safe';
      safeUrls.add(currentUrl);
      viewportObserver.unobserve(img);
      return;
    }

    const result = await scanPixels(img, currentUrl);

    if (result && result.label === 'model_loading') {
      delete img.dataset.nsfwStatus;
      img.dataset.nsfwLastUrl = '';
      setTimeout(() => {
        if (img.isConnected && !img.dataset.nsfwStatus && visibleImages.has(img)) {
          requestScan(img);
        }
      }, 1500);
    } else if (result && result.isSafe) {
      safeUrls.add(currentUrl);
      img.classList.remove('nsfw-blocked');
      img.classList.add('nsfw-safe');
      img.dataset.nsfwStatus = 'safe';
      viewportObserver.unobserve(img);
    } else if (result && !result.isSafe && result.label !== 'relay_error') {
      blockedUrls.add(currentUrl);
      img.classList.remove('nsfw-safe');
      img.classList.add('nsfw-blocked');
      img.dataset.nsfwStatus = 'blocked';
      viewportObserver.unobserve(img);
    } else {
      img.classList.remove('nsfw-blocked');
      img.classList.add('nsfw-safe');
      img.dataset.nsfwStatus = 'fallback_safe';
      viewportObserver.unobserve(img);
    }
  } catch (e) {
    if (!chrome.runtime?.id || String(e).includes('Extension context invalidated')) {
      return;
    }
    if (String(e).includes('message channel closed') || String(e).includes('listener indicated an asynchronous response')) {
      delete img.dataset.nsfwStatus;
      img.dataset.nsfwLastUrl = '';
      setTimeout(() => {
        if (img.isConnected && visibleImages.has(img)) requestScan(img);
      }, 1000);
      return;
    }
    console.warn('[NSFW Filter] Error scanning image:', e);
    img.classList.remove('nsfw-blocked');
    img.classList.add('nsfw-safe');
    img.dataset.nsfwStatus = 'error_safe';
  }
}

async function scanPixels(img, url) {
  // Only extract pixels on client for non-HTTP data/blob URLs where offscreen fetch cannot access context.
  // For standard HTTP/HTTPS URLs (like YouTube thumbnails), dispatching the URL directly saves 200K serialized array integers.
  const isInline = url.startsWith('data:') || url.startsWith('blob:');
  if (isInline) {
    try {
      const canvas = new OffscreenCanvas(224, 224);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 224, 224);
      const pixels = ctx.getImageData(0, 0, 224, 224).data;
      return await chrome.runtime.sendMessage({
        type: 'CHECK_NSFW',
        url: url,
        pixelData: Array.from(pixels),
        referrer: window.location.href,
      });
    } catch (e) {
      if (String(e).includes('message channel closed') ||
          String(e).includes('listener indicated an asynchronous response') ||
          String(e).includes('Extension context invalidated')) {
        throw e;
      }
    }
  }

  return await chrome.runtime.sendMessage({
    type: 'CHECK_NSFW',
    url: url,
    referrer: window.location.href,
  });
}
