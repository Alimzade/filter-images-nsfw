export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    console.log('NSFW Filter: Phase 2 (Messenger Mode) Active');
    
    // In Phase 3, this script will find images and send them to the background for scanning.
  },
});
