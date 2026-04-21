# Nudity Blocker - Project Status

A browser extension that uses local AI to filter NSFW content.

## Phase 1: Zero-Flash Blur (Completed)
- Images are blurred via manifest-level CSS before they load.
- Failsafe protection ensures nothing is visible before the AI scan.

## Phase 2: AI Engine Integration (Completed)
- **Engine:** ONNX Runtime Web.
- **Model:** NSFWJS (MobileNet V2) in ONNX format.
- **Architecture:** "Offscreen Pipeline".
  - **Offscreen Document:** A hidden HTML page where the AI engine runs with full permissions.
  - **Background Script:** Manages the offscreen room and relays messages.
  - **Local Privacy:** 100% browser-based inference. No images or data leave the user's device.
- **Security:** Configured Content Security Policy (CSP) to allow WebAssembly safely.

## Phase 3: The Surgical Unblur (Next)
- Real-time scanning of images as they appear.
- Detection of "Porn" and "Sexy" (suggestive/porn-like) categories.
- Selective unblurring for "Neutral" and "Safe" content.
