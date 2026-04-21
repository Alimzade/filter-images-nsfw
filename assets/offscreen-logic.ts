import { InferenceSession, env } from 'onnxruntime-web';

// Initialize the AI Brain
async function initAI() {
  console.log('NSFW Filter: Initializing AI Brain in Offscreen Document...');
  
  // Configure WASM paths
  env.wasm.wasmPaths = browser.runtime.getURL('onnx/');

  try {
    const modelUrl = browser.runtime.getURL('nsfw_model.onnx');
    const session = await InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
    });
    console.log('Alhamdulillah: AI Offscreen Engine Ready.');

    // Listen for scan requests from the background script
    browser.runtime.onMessage.addListener(async (message) => {
      if (message.type === 'CHECK_NSFW_OFFSCREEN') {
        // We will implement actual inference here in Phase 3
        return { status: 'ready', verdict: 'pending' };
      }
    });

  } catch (e) {
    console.error('NSFW Filter: AI Init Error in Offscreen:', e);
  }
}

initAI();
