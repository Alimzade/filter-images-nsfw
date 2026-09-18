let currentModelName = 'public/nsfw_model.onnx';
let sessionPromise = null;
let isSessionReady = false;
let inferenceQueue = Promise.resolve();
const MOBILENET_LABELS = ['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy'];

function resolveModelPath(modelName) {
  // Strip any existing 'public/' prefix then re-add, preventing double-prefixing
  const bare = (modelName || currentModelName).replace(/^public\//, '');
  return `public/${bare}`;
}

async function getSession(modelName) {
  const targetPath = resolveModelPath(modelName);

  if (sessionPromise && currentModelName === targetPath) {
    return sessionPromise;
  }

  isSessionReady = false;
  currentModelName = targetPath;
  sessionPromise = (async () => {
    try {
      console.log(`NSFW Filter: Central AI Brain waking up with model: ${currentModelName}...`);
      ort.env.wasm.wasmPaths = chrome.runtime.getURL('public/onnx/');
      ort.env.wasm.numThreads = 1;

      const modelUrl = chrome.runtime.getURL(currentModelName);
      console.log(`NSFW Filter: Loading model binary from ${modelUrl}`);
      const response = await fetch(modelUrl);
      if (!response.ok && response.status !== 0) {
        throw new Error(`Failed to fetch model binary: ${response.status}`);
      }
      const modelBuffer = await response.arrayBuffer();
      console.log(`NSFW Filter: Model buffer ready (${modelBuffer.byteLength} bytes). Compiling session...`);

      const session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['wasm'],
      });
      console.log(`NSFW Filter: Central AI Brain is Ready (${currentModelName}).`);
      isSessionReady = true;
      return session;
    } catch (err) {
      console.error('NSFW Filter: Failed to initialize AI session:', err);
      sessionPromise = null;
      isSessionReady = false;
      throw err;
    }
  })();

  return sessionPromise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_NSFW_OFFSCREEN') {
    // If the model is still loading, respond immediately so the background can
    // retry rather than holding the channel open until Chrome kills it.
    if (!isSessionReady) {
      sendResponse({ isSafe: true, label: 'model_loading' });
      return true;
    }
    (async () => {
      try {
        const session = await getSession(message.selectedModel);
        // Serialize inference to prevent 'Session already started' WASM collisions
        const task = () => processImage(session, message);
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

  if (message.type === 'SET_MODEL_OFFSCREEN') {
    const newPath = resolveModelPath(message.model);
    sessionPromise = null;
    getSession(newPath)
      .then(() => {
        sendResponse({ success: true, model: message.model });
      })
      .catch((err) => {
        console.error('Model switch failed:', err);
        sendResponse({ success: false, error: String(err) });
      });
    return true;
  }
});

async function processImage(session, message) {
  try {
    const inputName = session.inputNames[0];
    const targetSize = 224;

    let pixels;

    if (message.pixelData && message.pixelData.length > 0) {
      const expectedLength = targetSize * targetSize * 4;
      if (message.pixelData.length === expectedLength) {
        // Pixel data is already the right size
        pixels = new Uint8ClampedArray(message.pixelData);
      } else {
        // Pixel data is the wrong size - rescale via an OffscreenCanvas so
        // blob: URLs (which can't be fetched from the offscreen context) are
        // still processed correctly.
        const srcSize = Math.round(Math.sqrt(message.pixelData.length / 4));
        const srcCanvas = new OffscreenCanvas(srcSize, srcSize);
        const srcCtx = srcCanvas.getContext('2d');
        const imageData = new ImageData(new Uint8ClampedArray(message.pixelData), srcSize, srcSize);
        srcCtx.putImageData(imageData, 0, 0);

        const dstCanvas = new OffscreenCanvas(targetSize, targetSize);
        const dstCtx = dstCanvas.getContext('2d');
        dstCtx.drawImage(srcCanvas, 0, 0, targetSize, targetSize);
        pixels = dstCtx.getImageData(0, 0, targetSize, targetSize).data;
      }
    } else {
      try {
        const response = await fetch(message.url);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob, { resizeWidth: targetSize, resizeHeight: targetSize });
        const canvas = new OffscreenCanvas(targetSize, targetSize);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        pixels = ctx.getImageData(0, 0, targetSize, targetSize).data;
      } catch (fetchErr) {
        console.warn('Could not fetch image directly for scan, unblurring fallback:', fetchErr);
        return { isSafe: true, label: 'fetch_fallback', score: 1.0 };
      }
    }

    // MobileNet V2 expects NHWC [1, 224, 224, 3] with [0, 1] range
    const floatData = new Float32Array(224 * 224 * 3);
    for (let i = 0; i < 224 * 224; i++) {
      floatData[i * 3 + 0] = pixels[i * 4 + 0] / 255.0;
      floatData[i * 3 + 1] = pixels[i * 4 + 1] / 255.0;
      floatData[i * 3 + 2] = pixels[i * 4 + 2] / 255.0;
    }
    const tensor = new ort.Tensor('float32', floatData, [1, 224, 224, 3]);

    const results = await session.run({ [inputName]: tensor });
    const output = results[session.outputNames[0]].data;

    // MobileNet V2: 5 classes
    const scores = {};
    MOBILENET_LABELS.forEach((label, i) => {
      scores[label] = output[i];
    });

    const sexy = scores['Sexy'] || 0;
    const porn = scores['Porn'] || 0;
    const hentai = scores['Hentai'] || 0;
    const neutral = scores['Neutral'] || 0;

    const pornHentai = porn + hentai;

    let isSafe = true;
    let blockReason = '';
    if (porn > 0.45) {
      isSafe = false;
      blockReason = 'Explicit Porn (>45%)';
    } else if (hentai > 0.45) {
      isSafe = false;
      blockReason = 'Explicit Hentai (>45%)';
    } else if (pornHentai > 0.40) {
      isSafe = false;
      blockReason = 'Porn + Hentai Combined (>40%)';
    } else if (sexy > 0.75 && neutral < 0.20) {
      isSafe = false;
      blockReason = 'High Confidence Sexy (>75%)';
    } else if (pornHentai > 0.25 && sexy > 0.45 && neutral < 0.25) {
      isSafe = false;
      blockReason = 'Combined NSFW (>70%)';
    }

    const topLabel = MOBILENET_LABELS.reduce((a, b) => (scores[a] > scores[b] ? a : b));
    const topScore = scores[topLabel];
    const logDetails = MOBILENET_LABELS.map((l) => `${l}: ${(scores[l] * 100).toFixed(1)}%`).join(' | ');
    console.log(`[${isSafe ? 'SAFE' : 'BLOCK'}] ${blockReason ? blockReason + ' ' : ''}-> ${logDetails}`);

    return { isSafe, label: topLabel, score: topScore };
  } catch (e) {
    console.error('Image processing failed:', e);
    return { isSafe: true, label: 'error_fallback' };
  }
}

getSession();
