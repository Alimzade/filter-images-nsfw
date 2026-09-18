const MODEL_PATH = 'public/nsfw_model.onnx';
let currentSession = null;
let sessionPromise = null;
let isSessionReady = false;
let inferenceQueue = Promise.resolve();

const MOBILENET_LABELS = ['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy'];

async function getSession() {
  if (sessionPromise && currentSession) {
    return sessionPromise;
  }

  isSessionReady = false;
  sessionPromise = (async () => {
    try {
      console.log('NSFW Filter: Loading MobileNet V2 model...');
      ort.env.wasm.wasmPaths = chrome.runtime.getURL('public/onnx/');
      ort.env.wasm.numThreads = 1;

      const modelUrl = chrome.runtime.getURL(MODEL_PATH);
      const response = await fetch(modelUrl);
      if (!response.ok && response.status !== 0) {
        throw new Error(`Failed to fetch model binary: ${response.status}`);
      }
      const modelBuffer = await response.arrayBuffer();
      console.log(`NSFW Filter: Model buffer ready (${modelBuffer.byteLength} bytes). Creating session...`);

      let session;
      const hasWebGpu = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
      if (hasWebGpu) {
        try {
          console.log('NSFW Filter: Attempting WebGPU session...');
          session = await ort.InferenceSession.create(modelBuffer, {
            executionProviders: ['webgpu', 'wasm'],
          });
          console.log('NSFW Filter: WebGPU session ready.');
        } catch (gpuErr) {
          console.warn('NSFW Filter: WebGPU session failed, falling back to WASM:', gpuErr);
        }
      }

      if (!session) {
        session = await ort.InferenceSession.create(modelBuffer, {
          executionProviders: ['wasm'],
        });
        console.log('NSFW Filter: WASM session ready.');
      }

      currentSession = session;
      isSessionReady = true;
      return session;
    } catch (err) {
      console.error('NSFW Filter: Failed to initialize session:', err);
      sessionPromise = null;
      currentSession = null;
      isSessionReady = false;
      throw err;
    }
  })();

  return sessionPromise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_NSFW_OFFSCREEN') {
    if (!isSessionReady) {
      sendResponse({ isSafe: true, label: 'model_loading' });
      return true;
    }
    (async () => {
      try {
        const session = await getSession();

        // 1. Fetch, decode, and rasterize pixels concurrently in parallel outside the inference queue
        let pixels;
        try {
          pixels = await extractPixels(message);
        } catch (fetchErr) {
          const errMsg = fetchErr instanceof Error ? `${fetchErr.name}: ${fetchErr.message}` : String(fetchErr);
          console.warn(`Could not fetch image directly for scan (${errMsg}), unblurring fallback:`, message.url ? message.url.slice(0, 80) : '');
          sendResponse({ isSafe: true, label: 'fetch_fallback', score: 1.0 });
          return;
        }

        // 2. Strictly serialize the fast ~20ms neural net pass to prevent WASM 'Session already started' collisions
        const targetSize = 224;
        const inputName = session.inputNames[0];
        const task = () => classifyMobileNet(session, inputName, pixels, targetSize);

        const resultPromise = inferenceQueue.then(task, task);
        inferenceQueue = resultPromise.catch(() => {});
        const result = await resultPromise;
        sendResponse(result);
      } catch (err) {
        console.error('Inference Error:', err);
        sendResponse({ isSafe: true, label: 'error_fallback' });
      }
    })();
    return true;
  }
});

async function extractPixels(message) {
  const targetSize = 224;
  let pixels;

  if (message.pixelData && message.pixelData.length > 0) {
    const expectedLength = targetSize * targetSize * 4;
    if (message.pixelData.length === expectedLength) {
      pixels = message.pixelData instanceof Uint8ClampedArray
        ? message.pixelData
        : new Uint8ClampedArray(message.pixelData.buffer || message.pixelData);
    } else {
      const srcSize = Math.round(Math.sqrt(message.pixelData.length / 4));
      const srcCanvas = new OffscreenCanvas(srcSize, srcSize);
      const srcCtx = srcCanvas.getContext('2d');
      const rawBytes = message.pixelData instanceof Uint8ClampedArray
        ? message.pixelData
        : new Uint8ClampedArray(message.pixelData.buffer || message.pixelData);
      const imageData = new ImageData(rawBytes, srcSize, srcSize);
      srcCtx.putImageData(imageData, 0, 0);

      const dstCanvas = new OffscreenCanvas(targetSize, targetSize);
      const dstCtx = dstCanvas.getContext('2d');
      dstCtx.drawImage(srcCanvas, 0, 0, targetSize, targetSize);
      pixels = dstCtx.getImageData(0, 0, targetSize, targetSize).data;
    }
  } else {
    const fetchOptions = {};
    if (message.referrer) {
      fetchOptions.referrer = message.referrer;
    }
    const response = await fetch(message.url, fetchOptions);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error('Empty image blob (0 bytes)');
    }
    const bitmap = await createImageBitmap(blob, { resizeWidth: targetSize, resizeHeight: targetSize });
    const canvas = new OffscreenCanvas(targetSize, targetSize);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    if (typeof bitmap.close === 'function') {
      bitmap.close();
    }
    pixels = ctx.getImageData(0, 0, targetSize, targetSize).data;
  }

  return pixels;
}

// MobileNet V2 (NSFWJS) classifier with calibrated Balanced threshold profile
async function classifyMobileNet(session, inputName, pixels, targetSize) {
  const floatData = new Float32Array(targetSize * targetSize * 3);
  for (let i = 0; i < targetSize * targetSize; i++) {
    floatData[i * 3 + 0] = pixels[i * 4 + 0] / 255.0;
    floatData[i * 3 + 1] = pixels[i * 4 + 1] / 255.0;
    floatData[i * 3 + 2] = pixels[i * 4 + 2] / 255.0;
  }
  const tensor = new ort.Tensor('float32', floatData, [1, targetSize, targetSize, 3]);

  const results = await session.run({ [inputName]: tensor });
  const output = results[session.outputNames[0]].data;

  const scores = {};
  MOBILENET_LABELS.forEach((label, i) => {
    scores[label] = output[i];
  });

  const drawing = scores['Drawing'] || 0;
  const hentai  = scores['Hentai']  || 0;
  const neutral = scores['Neutral'] || 0;
  const porn    = scores['Porn']    || 0;
  const sexy    = scores['Sexy']    || 0;

  const pornHentai   = porn + hentai;
  const nsfwCombined = porn + hentai + sexy;
  const topLabel = MOBILENET_LABELS.reduce((a, b) => (scores[a] > scores[b] ? a : b));

  let isSafe = true;
  let blockReason = '';

  // Escape hatch: strong neutral confidence means image is safe
  const isHighlyNeutral = neutral > 0.65;

  // Drawing guard: elevated drawing score suppresses hentai false positives on anime/manga
  const isLikelyDrawing = drawing > 0.30;

  if (!isHighlyNeutral) {
    if (topLabel === 'Porn') {
      isSafe = false;
      blockReason = `Primary class is Porn (${(porn * 100).toFixed(1)}%)`;
    } else if (topLabel === 'Hentai' && !isLikelyDrawing) {
      isSafe = false;
      blockReason = `Primary class is Hentai (${(hentai * 100).toFixed(1)}%)`;
    } else if (porn > 0.60) {
      isSafe = false;
      blockReason = `Explicit Porn (>60%: ${(porn * 100).toFixed(1)}%)`;
    } else if (hentai > 0.65 && !isLikelyDrawing) {
      isSafe = false;
      blockReason = `Explicit Hentai (>65%: ${(hentai * 100).toFixed(1)}%)`;
    } else if (pornHentai > 0.70) {
      isSafe = false;
      blockReason = `Porn + Hentai combined (>70%: ${(pornHentai * 100).toFixed(1)}%)`;
    } else if (sexy > 0.70 && neutral < 0.20) {
      isSafe = false;
      blockReason = `Suggestive content (>70% Sexy, ${(sexy * 100).toFixed(1)}% with low neutral)`;
    } else if (sexy > 0.85) {
      isSafe = false;
      blockReason = `High-confidence Sexy (>85%: ${(sexy * 100).toFixed(1)}%)`;
    } else if (nsfwCombined > 0.75 && neutral < 0.15) {
      isSafe = false;
      blockReason = `Blended NSFW (>75%: ${(nsfwCombined * 100).toFixed(1)}%)`;
    }
  }

  const topScore = scores[topLabel];
  const logDetails = MOBILENET_LABELS.map((l) => `${l}: ${(scores[l] * 100).toFixed(1)}%`).join(' | ');
  console.log(`[MobileNet][${isSafe ? 'SAFE' : 'BLOCK'}] ${blockReason ? blockReason + ' ' : ''}-> ${logDetails}`);

  return { isSafe, label: topLabel, score: topScore };
}

getSession();
