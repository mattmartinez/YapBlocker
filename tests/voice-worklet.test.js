import assert from 'node:assert/strict';
import test from 'node:test';

// Minimal stand-ins for the AudioWorklet globals so the processor can run under node.
const messages = [];
let Processor;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage: (message) => messages.push(structuredClone(message)) };
  }
};
globalThis.registerProcessor = (name, constructor) => {
  assert.equal(name, 'voice-processor');
  Processor = constructor;
};
await import('../voice-worklet.js');

function runTone(processor, frequency, seconds, startBlock = 0) {
  const blocks = Math.round((seconds * 48000) / 128);
  let input;
  let output;
  for (let block = 0; block < blocks; block += 1) {
    input = [new Float32Array(128), new Float32Array(128)];
    output = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 128; i += 1) {
      const time = ((startBlock + block) * 128 + i) / 48000;
      input[0][i] = 0.1 * Math.sin(2 * Math.PI * frequency * time);
      input[1][i] = input[0][i];
    }
    assert.equal(processor.process([input], [output]), true);
  }
  return { input, output };
}

function peak(samples) {
  return samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
}

test('worklet announces itself, reduces the output and says why', () => {
  const processor = new Processor({ processorOptions: { threshold: 180 } });
  assert.equal(messages[0].type, 'ready');
  assert.equal(messages[0].sampleRate, 48000);
  assert.equal(messages[0].threshold, 180);
  assert.deepEqual(messages[0].settings.pitchRangeHz, [75, 500]);

  const high = runTone(processor, 220, 1);
  const on = messages.filter((m) => m.type === 'status' && m.changed);
  assert.equal(on.length, 1);
  assert.equal(on[0].active, true);
  assert.equal(on[0].reason, 'high-voice');
  assert.equal(on[0].volume, 25);
  assert.ok(Math.abs(peak(high.output[0]) / peak(high.input[0]) - 0.25) < 0.01);
  assert.ok(Math.abs(peak(high.output[1]) / peak(high.input[1]) - 0.25) < 0.01);

  const low = runTone(processor, 120, 1, 375);
  const changes = messages.filter((m) => m.type === 'status' && m.changed);
  assert.equal(changes.length, 2);
  assert.equal(changes[1].active, false);
  assert.equal(changes[1].reason, 'low-voice');
  assert.ok(Math.abs(peak(low.output[0]) / peak(low.input[0]) - 1) < 0.01);

  const periodic = messages.filter((m) => m.type === 'status' && !m.changed);
  assert.ok(periodic.length >= 8, 'still reports about five times a second');
  assert.ok(periodic.every((m) => m.reason === null && m.badSamples === 0));
});

test('worklet applies threshold messages', () => {
  const processor = new Processor({ processorOptions: { threshold: 180 } });
  runTone(processor, 170, 0.5);
  assert.equal(processor.detector.active, false);
  processor.port.onmessage({ data: { type: 'threshold', value: 140 } });
  runTone(processor, 170, 0.5, 188);
  assert.equal(processor.detector.active, true);
});
