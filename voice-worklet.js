import { SETTINGS, VoiceDetector } from './voice-detector.js';

const REDUCED_GAIN = 0.25;
const GAIN_TIME_CONSTANT = 0.035;

class VoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.detector = new VoiceDetector(sampleRate, options.processorOptions.threshold);
    this.gain = 1;
    this.gainStep = 1 - Math.exp(-1 / (sampleRate * GAIN_TIME_CONSTANT));
    this.framesSinceReport = 0;
    this.lastResult = this.detector.lastResult;
    this.mono = new Float32Array(128);

    this.port.onmessage = (event) => {
      if (event.data.type === 'threshold') {
        this.detector.setThreshold(event.data.value);
      }
    };
    // The audio thread stays quiet; the offscreen page logs what it is told here.
    this.port.postMessage({ type: 'ready', sampleRate, threshold: this.detector.threshold, settings: SETTINGS });
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;

    const frameLength = output[0].length;
    if (this.mono.length !== frameLength) this.mono = new Float32Array(frameLength);
    const mono = this.mono;
    mono.fill(0);
    for (let channel = 0; channel < input.length; channel += 1) {
      const samples = input[channel];
      for (let i = 0; i < frameLength; i += 1) mono[i] += samples[i] / input.length;
    }

    for (let i = 0; i < frameLength; i += 1) {
      const result = this.detector.push(mono[i]);
      if (result) {
        this.lastResult = result;
        if (result.changed) this.report(true);
      }
    }

    const targetGain = this.detector.active ? REDUCED_GAIN : 1;
    for (let channel = 0; channel < output.length; channel += 1) {
      const samples = output[channel];
      const source = input[Math.min(channel, input.length - 1)];
      let gain = this.gain;
      for (let i = 0; i < frameLength; i += 1) {
        gain += (targetGain - gain) * this.gainStep;
        samples[i] = source[i] * gain;
      }
      // Channels use the same gain trajectory; retain one value for the next block.
      if (channel === output.length - 1) this.gain = gain;
    }

    this.framesSinceReport += frameLength;
    if (this.framesSinceReport >= sampleRate / 5) {
      this.framesSinceReport = 0;
      this.report(false);
    }
    return true;
  }

  report(changed) {
    const result = this.lastResult;
    this.port.postMessage({
      type: 'status',
      active: this.detector.active,
      voiced: result.voiced,
      pitch: result.pitch,
      clarity: result.clarity,
      volume: this.detector.active ? 25 : 100,
      // For the debug log only: set when this report is an on/off switch.
      changed,
      reason: changed ? result.reason : null,
      score: result.score,
      badSamples: this.detector.badSamples,
    });
  }
}

registerProcessor('voice-processor', VoiceProcessor);
