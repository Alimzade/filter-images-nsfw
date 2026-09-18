const DEFAULT_ENABLED = true;

async function init() {
  const statusBadge = document.querySelector('#status-badge');
  const powerBtn = document.querySelector('#master-power-btn');
  const powerBtnText = document.querySelector('#power-btn-text');

  if (!statusBadge || !powerBtn || !powerBtnText) {
    return;
  }

  let isEnabled = DEFAULT_ENABLED;

  try {
    const data = await chrome.storage.local.get(['filterEnabled']);
    if (data && data.filterEnabled !== undefined) {
      isEnabled = data.filterEnabled;
    }
  } catch (err) {
    console.warn('Could not read storage, using defaults:', err);
  }

  const updateUI = () => {
    statusBadge.textContent = isEnabled ? 'Active' : 'Paused';
    statusBadge.className = `badge ${isEnabled ? 'active' : 'paused'}`;

    powerBtn.className = `master-btn ${isEnabled ? 'btn-turn-off' : 'btn-turn-on'}`;
    powerBtnText.textContent = isEnabled ? 'Turn Off Filter' : 'Turn On Filter';
  };

  updateUI();

  powerBtn.addEventListener('click', async () => {
    isEnabled = !isEnabled;
    updateUI();

    try {
      await chrome.storage.local.set({ filterEnabled: isEnabled });
      chrome.runtime.sendMessage({ type: 'FILTER_TOGGLED', enabled: isEnabled }).catch(() => {});
    } catch (err) {
      console.error('Failed to save filter status:', err);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
