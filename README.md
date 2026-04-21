# Nudity Blocker - Phase 1: Safety First

A browser extension that uses local AI to filter NSFW content.

## Phase 1: Zero-Flash Blur
The current implementation ensures that no NSFW image is ever visible, even for a single frame, by using **Manifest-level CSS Injection**.

### How it works:
1. **Hardcoded CSS:** `public/blur.css` is injected by the browser itself at `document_start`.
2. **Zero-Flash Timing:** Because the blur is defined in the extension manifest, the browser applies the filter before the website's images are even downloaded.
3. **Failsafe:** All `<img>` tags are blurred by default (`blur(50px)`). Images are only unblurred if they are explicitly marked with the `.nsfw-safe` class (to be implemented in Phase 2).

## Tech Stack
- **Framework:** WXT (Web Extension Toolkit)
- **Bundler:** Vite / Rolldown
- **Browser:** Edge (Chromium)
- **Package Manager:** pnpm
