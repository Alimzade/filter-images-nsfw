export default defineContentScript({
  matches: ['<all_urls>'],
  // runAt: 'document_start' is default, but we'll keep it explicit
  runAt: 'document_start',
  main() {
    console.log('NSFW Filter: Zero-Flash Blur Active');
  },
});
