# ADR-0001: Migration from WXT to Vanilla Manifest V3

## Status
Accepted

## Date
2026-09-18

## Context
The project was originally initialized with the WXT framework and TypeScript. During development on Windows 11 (Build 26200), executing `pnpm dev` caused `wxt --browser edge` to terminate abruptly due to a subshell launching bug in `web-ext-run`/`chrome-launcher`. Additionally, running a background Node development server is unnecessary for browser extension testing when standard browser developer mode ("Load unpacked") directly reloads files from disk upon clicking the reload icon.

Furthermore, ONNX Runtime Web prebuilt bundles (`ort.all.min.js` and WASM binaries) are self-contained and run natively in browser contexts without requiring bundlers, transpilation steps, or Node runtime dependencies.

## Decision
Migrate the entire extension codebase from WXT and TypeScript to a 100% native Vanilla Manifest V3 architecture:
1. Place standard `manifest.json`, `background.js`, `content.js`, `offscreen.html`, and `offscreen.js` directly in the project root.
2. Structure the popup interface in `popup/` using native HTML, CSS, and JavaScript.
3. Keep ONNX Runtime Web and models in `public/`.
4. Remove WXT configuration (`wxt.config.ts`, `web-ext.config.ts`), TypeScript configuration (`tsconfig.json`), and build artifacts (`.output/`, `.wxt/`).

## Consequences
- **Instant Testing**: Loading the extension unpacked in `edge://extensions` works out of the box with zero build steps or dev server crashes.
- **Zero Build Dependencies**: No need to maintain `node_modules` or bundler toolchains for everyday extension development.
- **Direct Code Inspection**: Debugging in Edge DevTools maps 1:1 to live files on disk without sourcemap mismatch.
- **Maintenance**: Standard Web APIs (`chrome.*`) are used directly according to W3C and Chromium Manifest V3 specifications.
