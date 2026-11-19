const OFFSCREEN_DOCUMENT = 'offscreen.html';

async function getState() {
  const [{ activeTabId = null, voiceStatus = null }, { threshold = 180 }] = await Promise.all([
    chrome.storage.session.get(['activeTabId', 'voiceStatus']),
    chrome.storage.local.get({ threshold: 180 }),
  ]);
  const hasDocument = await chrome.offscreen.hasDocument();
  return {
    activeTabId: hasDocument ? activeTabId : null,
    voiceStatus: hasDocument ? voiceStatus : null,
    threshold,
  };
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT,
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Analyze captured YouTube audio locally and play it through the volume filter.',
  });
}

async function stopCapture() {
  if (await chrome.offscreen.hasDocument()) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP' });
    } finally {
      await chrome.offscreen.closeDocument();
    }
  }
  await chrome.storage.session.remove(['activeTabId', 'voiceStatus']);
}

async function startCapture(tabId) {
  await stopCapture();
  try {
    const [{ threshold = 180 }, streamId] = await Promise.all([
      chrome.storage.local.get({ threshold: 180 }),
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }),
    ]);
    await ensureOffscreenDocument();
    await chrome.storage.session.set({
      activeTabId: tabId,
      voiceStatus: { state: 'starting', active: false, volume: 100 },
    });

    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'START',
      streamId,
      threshold,
    });
    if (!response?.ok) throw new Error(response?.error || 'Audio capture did not start.');
    return { ok: true };
  } catch (error) {
    await stopCapture();
    return { ok: false, error: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'offscreen') return false;

  if (message.type === 'START_CAPTURE') {
    startCapture(message.tabId).then(sendResponse);
    return true;
  }

  if (message.type === 'STOP_CAPTURE') {
    stopCapture().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'GET_STATE') {
    getState().then(sendResponse);
    return true;
  }

  if (message.type === 'SET_THRESHOLD') {
    Promise.all([
      chrome.storage.local.set({ threshold: message.value }),
      chrome.offscreen.hasDocument().then((exists) => exists && chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'THRESHOLD',
        value: message.value,
      })),
    ]).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'VOICE_STATUS' && sender.url?.endsWith('/offscreen.html')) {
    chrome.storage.session.set({ voiceStatus: message.status }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'CAPTURE_ENDED' && sender.url?.endsWith('/offscreen.html')) {
    stopCapture().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { activeTabId } = await getState();
  if (tabId === activeTabId) await stopCapture();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const { activeTabId } = await getState();
  if (tabId === activeTabId && !/^https:\/\/(www|m)\.youtube\.com\//.test(changeInfo.url)) {
    await stopCapture();
  }
});
