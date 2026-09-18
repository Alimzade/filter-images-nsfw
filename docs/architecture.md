# NSFW Filter Architecture

This document describes the runtime architecture, message contracts, and execution model of the NSFW Filter extension.

## Overview

The extension operates entirely locally without sending any image data or telemetry outside the browser. It conforms to Chrome and Edge Manifest V3 specifications.

```
+------------------------------------------------------------------+
| Web Page (DOM)                                                   |
| - public/blur.css: Immediately blurs all <img> tags              |
| - content.js: Tracks viewport via IntersectionObserver           |
|               Watches DOM mutations via MutationObserver         |
|               Concurrency queue (max 4 parallel scans)           |
|               Dispatches image URLs or raw pixels                |
+---------------------------------+--------------------------------+
                                  |
                                  | chrome.runtime.sendMessage
                                  v
+------------------------------------------------------------------+
| Background Service Worker (background.js)                       |
| - Manages Offscreen document lifecycle (single-instance mutex)   |
| - Synchronous in-memory cache for filterEnabled state            |
| - Retries message delivery while Offscreen boots                 |
| - Broadcasts FILTER_TOGGLED events to tabs                       |
+---------------------------------+--------------------------------+
                                  |
                                  | chrome.runtime.sendMessage
                                  v
+------------------------------------------------------------------+
| Offscreen Document (offscreen.html + offscreen.js)               |
| - Decoupled I/O: fetches and rasterizes images in parallel       |
| - Serialized Inference Queue: prevents WASM collision errors     |
| - WebGPU hardware acceleration with automatic WASM fallback      |
| - Calibrated Balanced threshold profile for MobileNet V2         |
+------------------------------------------------------------------+
```

## Security and Privacy Contracts

1. **Local Execution**: All inference is executed by ONNX Runtime Web in WebGPU/WebAssembly inside an isolated offscreen document.
2. **Zero-Flash Blur**: Images are styled with `filter: blur(50px) !important` via manifest-level CSS (`public/blur.css`) injected at `document_start`.
3. **No External Network Calls**: The AI pipeline operates strictly on local tensors and DOM representations.

## Concurrency and Performance Architecture

1. **Content Script Concurrency Queue**: `content.js` enforces `MAX_CONCURRENT_SCANS = 4` with LIFO prioritization so the most recently visible elements are scanned first, while offscreen elements are purged.
2. **Zero-IPC Image Routing**: Standard HTTP/HTTPS images send only the URL string to the background (~150 bytes), eliminating the overhead of serializing 200,000-element pixel arrays over IPC.
3. **In-Memory Settings Caching**: `background.js` caches `filterEnabled` in RAM, eliminating LevelDB disk lookups on every image scan request and keeping the service worker immediately responsive.
4. **Decoupled Pipelining in Offscreen**: `offscreen.js` fetches and rasterizes multiple images in parallel off the DOM thread, then serializes only the fast ~20ms model forward passes via `inferenceQueue` to prevent WebAssembly re-entrance collisions.

## AI Runtime and Dependencies

The offscreen environment runs ONNX Runtime Web using local assets located in `public/onnx/`:
- `ort.all.min.js`: ONNX Runtime Web browser distribution bundle
- `ort-wasm-simd-threaded.jsep.mjs`: JavaScript glue module dynamically imported by `ort.all.min.js`
- `ort-wasm-simd-threaded.jsep.wasm`: WebAssembly engine binary loaded at runtime by the glue module (supports WebGPU via JSEP)

These files are declared under `web_accessible_resources` in `manifest.json` and loaded via `chrome.runtime.getURL('public/onnx/')`.

## AI Model: MobileNet V2

The extension uses a compact, locally bundled MobileNet V2 model optimized for low latency in browser environments.

- **File**: `public/nsfw_model.onnx`
- **Size**: 9.9 MB
- **Input Tensor**: `[1, 224, 224, 3]` (NHWC, float32, normalized to [0, 1])
- **Labels**: `Drawing`, `Hentai`, `Neutral`, `Porn`, `Sexy`
- **Classification**: Balanced threshold profile calibrated for automated browser content moderation.

### Balanced Threshold Profile (MobileNet V2)

Rules apply only when `neutral <= 0.65` (escape hatch: high neutral confidence skips all rules).
Hentai rules are suppressed when `drawing > 0.30` (guard against anime/manga false positives).

| Rule | Condition | Reason |
|------|-----------|--------|
| Primary class Porn | `topLabel === 'Porn'` | Argmax is unambiguous |
| Primary class Hentai | `topLabel === 'Hentai'` and not likely drawing | Argmax, suppressed for illustrated content |
| Direct Porn | `porn > 0.60` | Community auto-block floor |
| Direct Hentai | `hentai > 0.65` and not likely drawing | Drawing/Hentai confusion guard |
| Combined Porn+Hentai | `porn + hentai > 0.70` | Prevents firing on model noise in uncertain images |
| Suggestive | `sexy > 0.70` and `neutral < 0.20` | Reduces swimwear/fitness false positives |
| Unconditional Sexy | `sexy > 0.85` | High confidence threshold |
| Blended NSFW | `porn + hentai + sexy > 0.75` and `neutral < 0.15` | Multi-class signal aggregation |

## Message Contracts

### `CHECK_NSFW` (Content Script -> Background)
- **Request**: `{ type: 'CHECK_NSFW', url: string, pixelData?: number[], referrer?: string }`
- **Background Action**: Forwards to offscreen as `CHECK_NSFW_OFFSCREEN` with up to 12 retries with exponential backoff.
- **Response**: `{ isSafe: boolean, label: string, score: number }`

### `FILTER_TOGGLED` (Popup -> Background -> Tabs)
- **Request**: `{ type: 'FILTER_TOGGLED', enabled: boolean }`
- **Background Action**: Iterates all active tabs and broadcasts the new state.
- **Content Action**: Adds or removes `.nsfw-disabled` on `document.documentElement` and flips existing image classes.
