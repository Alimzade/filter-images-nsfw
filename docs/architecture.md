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
|               Extracts image pixels or URLs                      |
+---------------------------------+--------------------------------+
                                  |
                                  | chrome.runtime.sendMessage
                                  v
+------------------------------------------------------------------+
| Background Service Worker (background.js)                       |
| - Manages Offscreen document lifecycle (single-instance mutex)   |
| - Retries message delivery while Offscreen boots                 |
| - Broadcasts FILTER_TOGGLED events to tabs                       |
+---------------------------------+--------------------------------+
                                  |
                                  | chrome.runtime.sendMessage
                                  v
+------------------------------------------------------------------+
| Offscreen Document (offscreen.html + offscreen.js)               |
| - Hosts ONNX Runtime Web WebAssembly engine                      |
| - Single-threaded WASM execution (ort.env.wasm.numThreads = 1)   |
| - Executes model inference and returns verdict                   |
+------------------------------------------------------------------+
```

## Security and Privacy Contracts

1. **Local Execution**: All inference is executed by ONNX Runtime Web in WebAssembly inside an isolated offscreen document.
2. **Zero-Flash Blur**: Images are styled with `filter: blur(50px) !important` via manifest-level CSS (`public/blur.css`) injected at `document_start`.
3. **No External Network Calls**: The AI pipeline operates strictly on local tensors and DOM representations.

## AI Runtime and Dependencies

The offscreen environment runs ONNX Runtime Web using local assets located in `public/onnx/`:
- `ort.all.min.js`: ONNX Runtime Web browser distribution bundle
- `ort-wasm-simd-threaded.jsep.mjs`: JavaScript glue module dynamically imported by `ort.all.min.js`
- `ort-wasm-simd-threaded.jsep.wasm`: WebAssembly engine binary loaded at runtime by the glue module

These files are declared under `web_accessible_resources` in `manifest.json` and loaded via `chrome.runtime.getURL('public/onnx/')`.

## AI Models and Classification Contracts

The extension uses a single local ONNX model:

### MobileNet V2
- **Path**: `public/nsfw_model.onnx`
- **Size**: 9.9 MB
- **Input Tensor**: `[1, 224, 224, 3]` (NHWC, float32, normalized to [0, 1])
- **Labels**: `Drawing`, `Hentai`, `Neutral`, `Porn`, `Sexy`
- **Classification Thresholds**:
  - Primary Class `Porn` or `Hentai` => Blocked
  - `Porn` > 0.28 or `Hentai` > 0.28 => Blocked
  - `Porn` + `Hentai` > 0.30 => Blocked
  - `Sexy` > 0.50 (with `Neutral` < 0.40) => Blocked
  - `Sexy` > 0.70 => Blocked
  - Combined NSFW (`Porn` + `Hentai` + `Sexy` > 0.55 with `Neutral` < 0.35) => Blocked
  - Partial Nudity / Porn signals (`Porn` + 0.5 * `Sexy` > 0.35 with `Neutral` < 0.30) => Blocked
  - Otherwise => Safe

## Message Contracts

### `CHECK_NSFW` (Content Script -> Background)
- **Request**: `{ type: 'CHECK_NSFW', url: string, pixelData?: number[], referrer?: string }`
- **Background Action**: Forwards to offscreen document with `{ type: 'CHECK_NSFW_OFFSCREEN' }` with up to 12 retries with exponential backoff.
- **Response**: `{ isSafe: boolean, label: string, score: number }`

### `FILTER_TOGGLED` (Popup -> Background -> Tabs)
- **Request**: `{ type: 'FILTER_TOGGLED', enabled: boolean }`
- **Background Action**: Iterates all active tabs and broadcasts the new state.
- **Content Action**: Adds or removes `.nsfw-disabled` on `document.documentElement` and flips existing image classes.
