const elements = {
  toggle: document.querySelector('#toggle'),
  error: document.querySelector('#error'),
  statusDot: document.querySelector('#status-dot'),
  statusText: document.querySelector('#status-text'),
  volumeBadge: document.querySelector('#volume-badge'),
  pitch: document.querySelector('#pitch-value'),
  clarity: document.querySelector('#clarity-value'),
  threshold: document.querySelector('#threshold'),
  thresholdValue: document.querySelector('#threshold-value'),
};

let currentTab = null;
let enabled = false;
let busy = false;

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function showError(message = '') {
  elements.error.hidden = !message;
  setText(elements.error, message);
}

function isYouTubeTab(tab) {
  return /^https:\/\/(www|m)\.youtube\.com\//.test(tab?.url || '');
}

function renderStatus(status) {
  const state = enabled ? status?.state || 'starting' : 'off';
  const labels = {
    off: 'Off',
    starting: 'Starting audio capture…',
    listening: 'Listening',
    detected: 'High pitch detected',
    'other-voice': 'Lower pitch detected',
  };
  setText(elements.statusText, labels[state] || 'Listening');
  elements.statusDot.className = `status-dot${state === 'detected' ? ' active' : state === 'listening' || state === 'other-voice' ? ' listening' : ''}`;

  const reduced = enabled && status?.active === true;
  setText(elements.volumeBadge, `${reduced ? 25 : 100}% volume`);
  elements.volumeBadge.classList.toggle('reduced', reduced);
  setText(elements.pitch, enabled && status?.pitch > 0 ? `${Math.round(status.pitch)} Hz` : '—');
  setText(elements.clarity, enabled && status?.clarity > 0 ? `${Math.round(status.clarity * 100)}%` : '—');
}

function renderToggle() {
  elements.toggle.disabled = busy;
  elements.toggle.classList.toggle('enabled', enabled);
  setText(elements.toggle, busy ? 'Working…' : enabled ? 'Disable for this tab' : 'Enable on this YouTube tab');
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  enabled = state.activeTabId === currentTab?.id;
  if (document.activeElement !== elements.threshold) {
    elements.threshold.value = state.threshold;
    setText(elements.thresholdValue, `${state.threshold} Hz`);
  }
  renderStatus(state.voiceStatus);
  renderToggle();
}

elements.toggle.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  showError();
  renderToggle();

  try {
    if (enabled) {
      await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
    } else {
      if (!isYouTubeTab(currentTab)) {
        throw new Error('Open a YouTube tab before enabling audio capture.');
      }
      const response = await chrome.runtime.sendMessage({
        type: 'START_CAPTURE',
        tabId: currentTab.id,
      });
      if (!response?.ok) throw new Error(response?.error || 'Could not start audio capture.');
    }
    await refresh();
  } catch (error) {
    showError(error.message);
    await refresh();
  } finally {
    busy = false;
    renderToggle();
  }
});

elements.threshold.addEventListener('input', () => {
  setText(elements.thresholdValue, `${elements.threshold.value} Hz`);
});

elements.threshold.addEventListener('change', async () => {
  const value = Number(elements.threshold.value);
  try {
    await chrome.runtime.sendMessage({ type: 'SET_THRESHOLD', value });
  } catch (error) {
    showError(`Could not update threshold: ${error.message}`);
  }
});

async function initialize() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isYouTubeTab(currentTab)) showError('Open YouTube in the active tab to use this extension.');
  await refresh();
}

initialize().catch((error) => showError(error.message));
setInterval(() => refresh().catch(() => {}), 250);
