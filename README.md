# NSFW Filter

A browser extension that uses local AI to filter NSFW content in real time.

## Documentation Index
Comprehensive technical documentation is maintained under `docs/`:
- [`docs/README.md`](file:///mnt/c/Users/anara/Projects/filter-images-nsfw/docs/README.md): Topic ownership map
- [`docs/architecture.md`](file:///mnt/c/Users/anara/Projects/filter-images-nsfw/docs/architecture.md): Runtime architecture and message contracts
- [`docs/decisions/0001-migration-to-vanilla-mv3.md`](file:///mnt/c/Users/anara/Projects/filter-images-nsfw/docs/decisions/0001-migration-to-vanilla-mv3.md): ADR-0001 Migration to Vanilla Manifest V3

## Features & Architecture

### Phase 1: Zero-Flash Blur (Completed)
- Images are blurred via manifest-level CSS (`public/blur.css`) injected at `document_start`.
- Failsafe protection ensures nothing is visible before the AI scan completes.

### Phase 2: AI Engine Integration (Completed)
- **Engine**: ONNX Runtime Web in WebAssembly.
- **Model**: NSFWJS (MobileNet V2, 9.9 MB): 5-class detection (Drawing, Hentai, Neutral, Porn, Sexy).
- **Architecture**: Offscreen Document Pipeline (`offscreen.html` + `offscreen.js`) managed by background service worker (`background.js`).
- **Local Privacy**: 100% on-device inference. Zero image data or telemetry ever leaves the browser.

### Phase 3: The Surgical Unblur (Completed)
- Real-time scanning of images as they enter the viewport via `IntersectionObserver`.
- Safe images unblur smoothly with CSS transitions.
- Multi-stage thresholding blocks NSFW content and applies deep grayscale blur.

### Phase 4: Dynamic Support & Controls (Completed)
- `MutationObserver` watches dynamically inserted images (infinite scroll) and DOM attribute swaps in Single Page Applications (SPAs).
- Prioritized queue scans visible images immediately and off-screen images in the background.
- Extension popup provides a Master Turn On / Turn Off toggle.

## Installation & Testing
1. Open `edge://extensions` in Microsoft Edge.
2. Enable "Developer mode" via the toggle on the left sidebar.
3. Click "Load unpacked" and select this project root directory (`C:\Users\anara\Projects\filter-images-nsfw`).
4. To test changes after editing any file, simply click the Reload icon on the extension card in `edge://extensions`.