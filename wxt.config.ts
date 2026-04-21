import { defineConfig } from 'wxt';

export default defineConfig({
  runner: {
    browser: 'edge',
    binaries: {
      edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    },
  },
  manifest: {
    content_scripts: [
      {
        matches: ['<all_urls>'],
        css: ['blur.css'],
        run_at: 'document_start',
      },
    ],
    permissions: ['offscreen'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    web_accessible_resources: [
      {
        resources: ['onnx/*', 'nsfw_model.onnx'],
        matches: ['<all_urls>'],
      },
    ],
  },
});
