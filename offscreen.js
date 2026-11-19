let stream = null;
let audioContext = null;
let workletNode = null;

async function reportStatus(status) {
  await chrome.runtime.sendMessage({ type: 'VOICE_STATUS', status });
}

async function stopAudio() {
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
    console.debug('[voice] detector stopped');
  }
}

async function startAudio(streamId, threshold) {
  await stopAudio();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('The selected tab did not provide an audio track.');
  track.addEventListener('ended', () => {
    chrome.runtime.sendMessage({ type: 'CAPTURE_ENDED' });
  }, { once: true });

  audioContext = new AudioContext({ latencyHint: 'playback' });
  await audioContext.audioWorklet.addModule('voice-worklet.js');
  const source = audioContext.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioContext, 'voice-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { threshold },
  });

  let loggedBadSamples = 0;
  workletNode.port.onmessage = (event) => {
    if (event.data.type === 'ready') {
      console.debug('[voice] detector ready', event.data);
      return;
    }
    if (event.data.type !== 'status') return;
    if (event.data.changed) {
      console.debug(`[voice] duck ${event.data.active ? 'on' : 'off'}`, {
        reason: event.data.reason,
        pitch: Math.round(event.data.pitch),
        score: Number(event.data.score.toFixed(1)),
      });
    }
    if (event.data.badSamples > loggedBadSamples) {
      loggedBadSamples = event.data.badSamples;
      console.warn('[voice] non-finite input samples replaced with silence', loggedBadSamples);
    }
    reportStatus({
      state: event.data.active ? 'detected' : event.data.voiced ? 'other-voice' : 'listening',
      active: event.data.active,
      pitch: event.data.pitch,
      clarity: event.data.clarity,
      volume: event.data.volume,
    });
  };

  source.connect(workletNode);
  workletNode.connect(audioContext.destination);
  await audioContext.resume();
  await reportStatus({ state: 'listening', active: false, volume: 100, pitch: 0, clarity: 0 });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.type === 'START') {
    startAudio(message.streamId, message.threshold)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'STOP') {
    stopAudio().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'THRESHOLD') {
    workletNode?.port.postMessage({ type: 'threshold', value: message.value });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
