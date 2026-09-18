console.log('NSFW Filter: Active');

// Keep the background service worker alive so long-running inference requests
// (especially the 88MB ViT model load) don't kill the message channel.
function connectKeepalive() {
  try {
    const port = chrome.runtime.connect({ name: 'nsfw-keepalive' });
    port.onDisconnect.addListener(() => {
      // chrome.runtime.lastError is set when the context is invalidated
      // (e.g. extension reloaded). Stop reconnecting in that case.
      if (chrome.runtime.lastError) return;
      setTimeout(connectKeepalive, 250);
    });
  } catch (_) {
    // Extension context invalidated - content script is orphaned, nothing to do
  }
}
connectKeepalive();

const safeUrls = new Set();
const blockedUrls = new Set();
let isFilterActive = true;

function setDisabledState(disabled) {
  isFilterActive = !disabled;
  if (disabled) {
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
      scan(img, 'high');
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

const scan = (img, priority = 'low') => {
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
      (img.dataset.nsfwStatus === 'pending' || img.dataset.nsfwStatus === 'safe' ||
       img.dataset.nsfwStatus === 'blocked' || img.dataset.nsfwStatus === 'fallback_safe' ||
       img.dataset.nsfwStatus === 'error_safe')) {
    return;
  }

  processImage(img, safeUrls, blockedUrls);
};

const viewportObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      const img = entry.target;
      scan(img);
    }
  });
}, { threshold: 0.01, rootMargin: '300px 0px' });

const domObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.type === 'attributes' && (mutation.attributeName === 'src' || mutation.attributeName === 'srcset')) {
      const target = mutation.target;
      if (target instanceof HTMLImageElement) {
        viewportObserver.observe(target);
        scan(target);
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

async function processImage(img, safeUrls, blockedUrls) {
  const currentUrl = img.currentSrc || img.src;
  if (!currentUrl) return;

  if (img.dataset.nsfwStatus === 'pending' && img.dataset.nsfwLastUrl === currentUrl) {
    return;
  }

  img.dataset.nsfwStatus = 'pending';
  img.dataset.nsfwLastUrl = currentUrl;

  try {
    if (!img.complete) {
      await new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 3000);
      });
    }

    if (img.naturalWidth > 0 && img.naturalWidth < 32 && img.naturalHeight < 32) {
      img.classList.add('nsfw-safe');
      img.dataset.nsfwStatus = 'safe';
      safeUrls.add(currentUrl);
      viewportObserver.unobserve(img);
      return;
    }

    const result = await scanPixels(img, currentUrl);
    console.log('[NSFW Filter] Scanned:', currentUrl.slice(0, 60), result);

    if (result && result.label === 'model_loading') {
      // Model is still loading - leave image blurred and schedule rescan
      delete img.dataset.nsfwStatus;
      img.dataset.nsfwLastUrl = '';
      setTimeout(() => {
        if (img.isConnected && !img.dataset.nsfwStatus) {
          scan(img);
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
      // Relay or timeout error - unblur fallback to avoid locking safe images
      img.classList.remove('nsfw-blocked');
      img.classList.add('nsfw-safe');
      img.dataset.nsfwStatus = 'fallback_safe';
      viewportObserver.unobserve(img);
    }
  } catch (e) {
    console.warn('[NSFW Filter] Error scanning image:', e);
    img.classList.remove('nsfw-blocked');
    img.classList.add('nsfw-safe');
    img.dataset.nsfwStatus = 'error_safe';
  }
}

async function scanPixels(img, url) {
  if (url.startsWith('blob:')) {
    try {
      const canvas = new OffscreenCanvas(224, 224);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 224, 224);
      const pixels = ctx.getImageData(0, 0, 224, 224).data;
      return await chrome.runtime.sendMessage({
        type: 'CHECK_NSFW',
        url: url,
        pixelData: Array.from(pixels),
      });
    } catch (e) {}
  }

  return await chrome.runtime.sendMessage({
    type: 'CHECK_NSFW',
    url: url,
  });
}


