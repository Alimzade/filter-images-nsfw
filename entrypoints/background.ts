export default defineBackground(() => {
  const OFFSCREEN_PATH = 'offscreen.html';

  // Function to ensure the offscreen document is open
  async function setupOffscreen() {
    // Check if it's already open
    const existingContexts = await browser.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });

    if (existingContexts.length > 0) {
      return;
    }

    // Open it if not
    await (browser as any).offscreen.createDocument({
      url: browser.runtime.getURL(OFFSCREEN_PATH),
      reasons: ['DOM_PARSER'], // Required reason for image processing
      justification: 'Running AI model for image classification',
    });
    
    console.log('NSFW Filter: Offscreen Document Created');
  }

  setupOffscreen();

  // Forward messages from Content Script -> Offscreen Document
  browser.runtime.onMessage.addListener(async (message, sender) => {
    if (message.type === 'CHECK_NSFW') {
      await setupOffscreen();
      // Relay message to offscreen document
      return await browser.runtime.sendMessage({
        ...message,
        type: 'CHECK_NSFW_OFFSCREEN'
      });
    }
  });
});
