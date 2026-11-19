let currentModelName = 'public/nsfw_model.onnx';
let currentSession = null;
let sessionPromise = null;
let isSessionReady = false;
let inferenceQueue = Promise.resolve();

const MOBILENET_V2_LABELS = ['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy'];
const MOBILENET_V3_LABELS = ['safe', 'r15', 'r18'];

function resolveModelPath(modelName) {
  const bare = (modelName || currentModelName).replace(/^public\//, '');
  return `public/${bare}`;
}

function isV3Model(modelPath) {
  const lower = modelPath.toLowerCase();
  return lower.includes('v3') || lower.includes('mobilenetv3');
}

// Each load gets a generation number. Only the newest load may publish its session,
// so a slow, superseded load can never overwrite the active model.
let loadGeneration = 0;

// Resolves to { session, modelPath } so every inference keeps the pre/post-processing
// that matches the session it actually runs on, even if the model is switched mid-request.
async function getSession(modelName) {
  const targetPath = resolveModelPath(modelName);

  if (sessionPromise && currentModelName === targetPath) {
    return sessionPromise;
  }

  const generation = ++loadGeneration;
  isSessionReady = false;
  currentSession = null;
  currentModelName = targetPath;
  const promise = (async () => {
    try {
      console.log(`NSFW Filter: Loading model: ${targetPath}...`);
      ort.env.wasm.wasmPaths = chrome.runtime.getURL('public/onnx/');
      ort.env.wasm.numThreads = 1;

      const modelUrl = chrome.runtime.getURL(targetPath);
      console.log(`NSFW Filter: Fetching model from ${modelUrl}`);
      const response = await fetch(modelUrl);
      if (!response.ok && response.status !== 0) {
        throw new Error(`Failed to fetch model binary: ${response.status}`);
      }
      const modelBuffer = await response.arrayBuffer();
      console.log(`NSFW Filter: Model ready (${modelBuffer.byteLength} bytes). Creating session...`);

      let session;
      const hasWebGpu = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
      if (hasWebGpu) {
        try {
          console.log('NSFW Filter: Attempting WebGPU session...');
          session = await ort.InferenceSession.create(modelBuffer, {
            executionProviders: ['webgpu', 'wasm'],
          });
          console.log(`NSFW Filter: WebGPU session ready (${targetPath}).`);
        } catch (gpuErr) {
          console.warn('NSFW Filter: WebGPU initialization failed, falling back to WASM:', gpuErr);
        }
      }

      if (!session) {
        session = await ort.InferenceSession.create(modelBuffer, {
          executionProviders: ['wasm'],
        });
        console.log(`NSFW Filter: WASM session ready (${targetPath}).`);
      }

      if (generation === loadGeneration) {
        currentSession = session;
        isSessionReady = true;
      }
      return { session, modelPath: targetPath };
    } catch (err) {
      console.error('NSFW Filter: Failed to initialize session:', err);
      if (generation === loadGeneration) {
        sessionPromise = null;
        currentSession = null;
        isSessionReady = false;
      }
      throw err;
    }
  })();

  sessionPromise = promise;
  return promise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_NSFW_OFFSCREEN') {
    if (!isSessionReady) {
      sendResponse({ isSafe: true, label: 'model_loading' });
      return true;
    }
    (async () => {
      try {
        const { session, modelPath } = await getSession(message.selectedModel);

        // 1. Fetch, decode, and rasterize pixels concurrently outside the inference queue
        let pixels;
        try {
          pixels = await extractPixels(message);
        } catch (fetchErr) {
          const errMsg = fetchErr instanceof Error ? `${fetchErr.name}: ${fetchErr.message}` : String(fetchErr);
          console.warn(`Could not fetch image directly for scan (${errMsg}), unblurring fallback:`, message.url ? message.url.slice(0, 80) : '');
          sendResponse({ isSafe: true, label: 'fetch_fallback', score: 1.0 });
          return;
        }

        // 2. Strictly serialize the fast model inference pass to prevent WASM Session already started collisions
        const targetSize = 224;
        const inputName = session.inputNames[0];
        const task = () => {
          if (isV3Model(modelPath)) {
            return classifyMobileNetV3(session, inputName, pixels, targetSize);
          } else {
            return classifyMobileNetV2(session, inputName, pixels, targetSize);
          }
        };

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
    const previousPath = currentModelName;
    getSession(newPath)
      .then(() => {
        sendResponse({ success: true, model: message.model });
      })
      .catch((err) => {
        console.error('Model switch failed:', err);
        if (previousPath && previousPath !== newPath) {
          getSession(previousPath).catch(() => {});
        }
        sendResponse({ success: false, error: String(err) });
      });
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

// ---------------------------------------------------------------------------
// MobileNetV3-Large Classifier (deepghs/anime_rating)
// Input: Planar NCHW [1, 3, 224, 224], ImageNet normalized (mean [0.485, 0.456, 0.406], std [0.229, 0.224, 0.225])
// Output: [1, 3] probabilities for [safe, r15, r18] (the export ends in a softmax)
// ---------------------------------------------------------------------------
async function classifyMobileNetV3(session, inputName, pixels, targetSize) {
  const planeSize = targetSize * targetSize;
  const floatData = new Float32Array(3 * planeSize);

  for (let i = 0; i < planeSize; i++) {
    const r = pixels[i * 4 + 0] / 255.0;
    const g = pixels[i * 4 + 1] / 255.0;
    const b = pixels[i * 4 + 2] / 255.0;

    floatData[0 * planeSize + i] = (r - 0.485) / 0.229; // Red channel
    floatData[1 * planeSize + i] = (g - 0.456) / 0.224; // Green channel
    floatData[2 * planeSize + i] = (b - 0.406) / 0.225; // Blue channel
  }
  const tensor = new ort.Tensor('float32', floatData, [1, 3, targetSize, targetSize]);

  const results = await session.run({ [inputName]: tensor });
  const rawOutput = results[session.outputNames[0]].data;

  // The bundled deepghs export already ends in a softmax, so its output is a probability
  // distribution. Re-applying softmax would flatten every score below ~0.58 and the R18
  // thresholds could never fire. Only apply softmax if the output looks like raw logits.
  const values = Array.from(rawOutput);
  const total = values.reduce((a, b) => a + b, 0);
  const isDistribution = values.every((v) => v >= 0 && v <= 1) && Math.abs(total - 1) < 1e-2;
  let probs = values;
  if (!isDistribution) {
    const maxLogit = Math.max(...values);
    const exps = values.map((v) => Math.exp(v - maxLogit));
    const sumExp = exps.reduce((a, b) => a + b, 0);
    probs = exps.map((v) => v / sumExp);
  }

  const safeScore = probs[0];
  const r15Score  = probs[1];
  const r18Score  = probs[2];

  const topIdx = probs.indexOf(Math.max(...probs));
  const topLabel = MOBILENET_V3_LABELS[topIdx];

  let isSafe = true;
  let blockReason = '';

  // MobileNetV3 (deepghs/anime_rating) is trained exclusively on anime/manga illustrations.
  // Real-world photos (cars, scenery, everyday objects) are out-of-distribution and produce noisy logits.
  // Require decisive high confidence on explicit R18 before blocking to prevent false positives on photos.
  if (topLabel === 'r18' && r18Score >= 0.70) {
    isSafe = false;
    blockReason = `Explicit Adult R18 (${(r18Score * 100).toFixed(1)}%)`;
  } else if (r18Score >= 0.85) {
    isSafe = false;
    blockReason = `Decisive Adult R18 (${(r18Score * 100).toFixed(1)}%)`;
  }

  const logDetails = `safe: ${(safeScore * 100).toFixed(1)}% | r15: ${(r15Score * 100).toFixed(1)}% | r18: ${(r18Score * 100).toFixed(1)}%`;
  console.log(`[MobileNetV3][${isSafe ? 'SAFE' : 'BLOCK'}] ${blockReason ? blockReason + ' ' : ''}-> ${logDetails}`);

  return { isSafe, label: topLabel, score: isSafe ? safeScore : r18Score };
}

// ---------------------------------------------------------------------------
// MobileNet V2 (NSFWJS) Classifier - Balanced threshold profile
// Input: Interleaved NHWC [1, 224, 224, 3], normalized to [0, 1]
// Output: [1, 5] softmax for [Drawing, Hentai, Neutral, Porn, Sexy]
// ---------------------------------------------------------------------------
async function classifyMobileNetV2(session, inputName, pixels, targetSize) {
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
  MOBILENET_V2_LABELS.forEach((label, i) => {
    scores[label] = output[i];
  });

  const drawing = scores['Drawing'] || 0;
  const hentai  = scores['Hentai']  || 0;
  const neutral = scores['Neutral'] || 0;
  const porn    = scores['Porn']    || 0;
  const sexy    = scores['Sexy']    || 0;

  const pornHentai   = porn + hentai;
  const nsfwCombined = porn + hentai + sexy;
  const topLabel = MOBILENET_V2_LABELS.reduce((a, b) => (scores[a] > scores[b] ? a : b));

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
  const logDetails = MOBILENET_V2_LABELS.map((l) => `${l}: ${(scores[l] * 100).toFixed(1)}%`).join(' | ');
  console.log(`[MobileNetV2][${isSafe ? 'SAFE' : 'BLOCK'}] ${blockReason ? blockReason + ' ' : ''}-> ${logDetails}`);

  return { isSafe, label: topLabel, score: topScore };
}

// Offscreen documents can't read chrome.storage, so ask the background which model the
// user selected and load only that one. Fall back to the default if the background
// doesn't answer.
async function loadSelectedModel() {
  let model;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SELECTED_MODEL' });
    model = response && response.model;
  } catch (err) {
    console.warn('NSFW Filter: Could not get selected model, using default:', err);
  }
  // A scan or model switch may already have started a load; don't start a second one.
  if (!sessionPromise) {
    getSession(model).catch(() => {});
  }
}

loadSelectedModel();
