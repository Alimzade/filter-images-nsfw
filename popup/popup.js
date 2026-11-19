const DEFAULT_ENABLED = true;
const DEFAULT_MODEL = 'public/nsfw_model.onnx';

const MODEL_INFO = {
  'public/nsfw_model.onnx': {
    hint: 'MobileNet V2 (NSFWJS). 9.9 MB. Balanced 5-class general web filtering (Default).',
  },
  'public/mobilenet_v3.onnx': {
    hint: 'MobileNet V3-Large. 16.8 MB. Fast 20-30ms 3-class anime & illustration filter.',
  },
};

async function init() {
  const statusBadge = document.querySelector('#status-badge');
  const powerBtn = document.querySelector('#master-power-btn');
  const powerBtnText = document.querySelector('#power-btn-text');

  const modelRadios = document.querySelectorAll('input[name="model"]');
  const modelStatus = document.querySelector('#model-status-badge');
  const modelHint = document.querySelector('#model-hint');

  if (!statusBadge || !powerBtn || !powerBtnText) return;

  let isEnabled = DEFAULT_ENABLED;
  let selectedModel = DEFAULT_MODEL;

  try {
    const data = await chrome.storage.local.get(['filterEnabled', 'selectedModel']);
    if (data) {
      if (data.filterEnabled !== undefined) isEnabled = data.filterEnabled;
      if (data.selectedModel) selectedModel = data.selectedModel;
    }
  } catch (err) {
    console.warn('Could not read settings from storage:', err);
  }

  const updatePowerUI = () => {
    statusBadge.textContent = isEnabled ? 'Active' : 'Paused';
    statusBadge.className = `badge ${isEnabled ? 'active' : 'paused'}`;

    if (isEnabled) {
      powerBtn.className = 'master-btn btn-turn-off';
      powerBtnText.textContent = 'Turn Off Filter';
    } else {
      powerBtn.className = 'master-btn btn-turn-on';
      powerBtnText.textContent = 'Turn On Filter';
    }
  };

  const updateModelUI = (modelValue) => {
    modelRadios.forEach((radio) => {
      radio.checked = radio.value === modelValue;
    });
    if (modelHint) {
      modelHint.textContent = MODEL_INFO[modelValue]?.hint || '';
    }
  };

  updatePowerUI();
  updateModelUI(selectedModel);

  powerBtn.addEventListener('click', async () => {
    isEnabled = !isEnabled;
    updatePowerUI();

    try {
      await chrome.storage.local.set({ filterEnabled: isEnabled });
      chrome.runtime.sendMessage({
        type: 'FILTER_TOGGLED',
        enabled: isEnabled,
      }).catch(() => {});
    } catch (err) {
      console.error('Failed to save filter status:', err);
    }
  });

  modelRadios.forEach((radio) => {
    radio.addEventListener('change', async (e) => {
      const newModel = e.target.value;
      if (newModel === selectedModel) return;

      const previousModel = selectedModel;
      selectedModel = newModel;

      if (modelStatus) {
        modelStatus.textContent = 'Loading...';
        modelStatus.className = 'model-status-badge loading';
      }
      if (modelHint) {
        modelHint.textContent = 'Loading model weights into memory...';
      }

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'MODEL_CHANGED',
          model: newModel,
        });

        if (response && response.success) {
          if (modelStatus) {
            modelStatus.textContent = 'Ready';
            modelStatus.className = 'model-status-badge';
          }
          if (modelHint) {
            modelHint.textContent = MODEL_INFO[selectedModel]?.hint || '';
          }
        } else {
          // Revert to previously working model
          selectedModel = previousModel;
          updateModelUI(selectedModel);
          if (modelStatus) {
            modelStatus.textContent = 'Error';
            modelStatus.className = 'model-status-badge loading';
          }
          if (modelHint) {
            modelHint.textContent = `Failed to load model: ${(response && response.error) || 'unknown error'}`;
          }
          setTimeout(() => {
            if (modelStatus) {
              modelStatus.textContent = 'Ready';
              modelStatus.className = 'model-status-badge';
            }
            if (modelHint) {
              modelHint.textContent = MODEL_INFO[selectedModel]?.hint || '';
            }
          }, 3500);
        }
      } catch (err) {
        console.error('Failed to switch model:', err);
        selectedModel = previousModel;
        updateModelUI(selectedModel);
        if (modelStatus) {
          modelStatus.textContent = 'Error';
          modelStatus.className = 'model-status-badge loading';
        }
        setTimeout(() => {
          if (modelStatus) {
            modelStatus.textContent = 'Ready';
            modelStatus.className = 'model-status-badge';
          }
          if (modelHint) {
            modelHint.textContent = MODEL_INFO[selectedModel]?.hint || '';
          }
        }, 3500);
      }
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
