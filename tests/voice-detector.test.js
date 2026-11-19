import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceDetector } from '../voice-detector.js';

function runTone(detector, frequency, seconds, amplitude = 0.08) {
  let result;
  const sampleCount = Math.round(detector.sourceSampleRate * seconds);
  for (let i = 0; i < sampleCount; i += 1) {
    const time = i / detector.sourceSampleRate;
    const sample = amplitude * Math.sin(2 * Math.PI * frequency * time) +
      0.2 * amplitude * Math.sin(2 * Math.PI * frequency * 2 * time);
    result = detector.push(sample) || result;
  }
  return { result, active: detector.active };
}

// Repeatable broadband noise: sound with no voice in it.
function runNoise(detector, seconds, amplitude = 0.2) {
  let state = 12345;
  const sampleCount = Math.round(detector.sourceSampleRate * seconds);
  for (let i = 0; i < sampleCount; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    detector.push(amplitude * (state / 2147483648));
  }
}

test('reduces for sustained voiced audio above the pitch threshold', () => {
  const detector = new VoiceDetector(48000, 180);
  const { result, active } = runTone(detector, 220, 1.2);
  assert.equal(active, true);
  assert.ok(result.pitch > 210 && result.pitch < 230, `estimated ${result.pitch} Hz`);
  assert.ok(result.clarity > 0.9);
});

test('does not reduce for voiced audio below the pitch threshold', () => {
  const detector = new VoiceDetector(48000, 180);
  const { result, active } = runTone(detector, 120, 1.2);
  assert.equal(active, false);
  assert.ok(result.pitch > 110 && result.pitch < 130, `estimated ${result.pitch} Hz`);
});

test('does not reduce for silence', () => {
  const detector = new VoiceDetector(48000, 180);
  const { active } = runTone(detector, 220, 1.2, 0);
  assert.equal(active, false);
});

test('ignores a blip but reduces within a syllable', () => {
  const detector = new VoiceDetector(48000, 180);
  runTone(detector, 220, 0.04);
  assert.equal(detector.active, false);
  runTone(detector, 220, 0.25);
  assert.equal(detector.active, true);
});

test('reduces for syllables too short to give 200 ms of unbroken pitch', () => {
  const detector = new VoiceDetector(48000, 180);
  for (let syllable = 0; syllable < 8; syllable += 1) {
    runTone(detector, 220, 0.12);
    runTone(detector, 220, 0.06, 0);
  }
  assert.equal(detector.active, true);
});

test('keeps reducing through a pause', () => {
  const detector = new VoiceDetector(48000, 180);
  runTone(detector, 220, 0.5);
  assert.equal(detector.active, true);
  runTone(detector, 220, 0.8, 0);
  assert.equal(detector.active, true);
  runTone(detector, 220, 3, 0);
  assert.equal(detector.active, true);
});

test('restores when a low voice takes over', () => {
  const detector = new VoiceDetector(48000, 180);
  runTone(detector, 220, 0.5);
  assert.equal(detector.active, true);
  const { result } = runTone(detector, 120, 0.35);
  assert.equal(detector.active, false);
  assert.equal(result.voiced, true);
});

test('restores after sound with no voice in it', () => {
  const detector = new VoiceDetector(48000, 180);
  runTone(detector, 220, 0.5);
  assert.equal(detector.active, true);
  runNoise(detector, 1);
  assert.equal(detector.active, true);
  runNoise(detector, 1);
  assert.equal(detector.active, false);
  assert.equal(detector.lastResult.voiced, false);
});

test('reports why the state changed', () => {
  const detector = new VoiceDetector(48000, 180);
  const reasons = [];
  const feed = (frequency, seconds) => {
    const sampleCount = Math.round(48000 * seconds);
    for (let i = 0; i < sampleCount; i += 1) {
      const result = detector.push(0.08 * Math.sin((2 * Math.PI * frequency * i) / 48000));
      if (result?.changed) reasons.push(result.reason);
    }
  };
  feed(220, 0.5);
  feed(120, 0.5);
  feed(220, 0.5);
  runNoise(detector, 2);
  assert.deepEqual(reasons, ['high-voice', 'low-voice', 'high-voice']);
  assert.equal(detector.active, false);
  assert.equal(detector.score, 0);
});

test('tracks pitch above the old 320 Hz ceiling', () => {
  for (const frequency of [340, 450]) {
    const detector = new VoiceDetector(48000, 180);
    const { result, active } = runTone(detector, frequency, 0.6);
    assert.equal(active, true, `${frequency} Hz should reduce`);
    assert.ok(Math.abs(result.pitch / frequency - 1) < 0.03, `${frequency} Hz estimated as ${result.pitch} Hz`);
  }
});

test('supports threshold changes while running', () => {
  const detector = new VoiceDetector(44100, 180);
  runTone(detector, 170, 0.5);
  assert.equal(detector.active, false);
  detector.setThreshold(140);
  runTone(detector, 170, 0.5);
  assert.equal(detector.active, true);
});

test('a voice sitting on the threshold does not flip the state', () => {
  const detector = new VoiceDetector(48000, 180);
  runTone(detector, 220, 0.5);
  assert.equal(detector.active, true);
  runTone(detector, 178, 2);
  assert.equal(detector.active, true);

  const other = new VoiceDetector(48000, 180);
  runTone(other, 120, 0.5);
  runTone(other, 183, 2);
  assert.equal(other.active, false);
});

test('works when the output device runs at or below 16 kHz', () => {
  for (const rate of [8000, 16000]) {
    const detector = new VoiceDetector(rate, 180);
    const { result, active } = runTone(detector, 220, 0.6);
    assert.equal(active, true, `${rate} Hz source should reduce`);
    assert.ok(result.pitch > 210 && result.pitch < 230, `${rate} Hz source estimated ${result.pitch} Hz`);
  }
});

test('non-finite input does not poison the filter', () => {
  const detector = new VoiceDetector(48000, 180);
  for (const bad of [NaN, Infinity, -Infinity, NaN]) detector.push(bad);
  assert.equal(detector.badSamples, 4);
  const { result, active } = runTone(detector, 220, 0.6);
  assert.equal(active, true);
  assert.ok(result.pitch > 210 && result.pitch < 230, `estimated ${result.pitch} Hz`);
});
