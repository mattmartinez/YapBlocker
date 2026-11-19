const ANALYSIS_RATE = 16000;
const FRAME_SIZE = 1024;
const HOP_SIZE = 256;
const HOP_SECONDS = HOP_SIZE / ANALYSIS_RATE;
const MIN_FREQUENCY = 75;
// Animated speech goes well past 320 Hz; pitch above the ceiling is heard as nothing or as half.
const MAX_FREQUENCY = 500;
const RMS_THRESHOLD = 0.006;
const MIN_LAG = Math.floor(ANALYSIS_RATE / MAX_FREQUENCY);
const MAX_LAG = Math.ceil(ANALYSIS_RATE / MIN_FREQUENCY);
const WINDOW_SIZE = FRAME_SIZE - MAX_LAG - 1;

// Only this band reaches the pitch tracker: it holds the voice's low harmonics and leaves
// out rumble, hiss and consonant noise.
const BAND_LOW_HZ = 60;
const BAND_HIGH_HZ = 1200;

// On/off rule: every voiced frame votes by how far its pitch is from the threshold.
const VOTE_OCTAVES = 0.25; // distance from the threshold that earns one full vote
const VOTE_LIMIT = 2; // most a single frame can vote, so a stray octave error cannot flip the state
const SCORE_LIMIT = 10; // how much evidence is remembered
const SCORE_TRIGGER = 3; // evidence needed to switch
const HYSTERESIS_RATIO = 2 ** (1 / 12); // one semitone either side of the threshold
const IDLE_SECONDS = 1.5; // sound with no voice in it for this long switches off
const SOUND_RMS = 0.012;

export const SETTINGS = Object.freeze({
  analysisRate: ANALYSIS_RATE,
  hopSeconds: HOP_SECONDS,
  pitchRangeHz: [MIN_FREQUENCY, MAX_FREQUENCY],
  bandHz: [BAND_LOW_HZ, BAND_HIGH_HZ],
  scoreTrigger: SCORE_TRIGGER,
  scoreLimit: SCORE_LIMIT,
  idleSeconds: IDLE_SECONDS,
});

class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
    this.z1 = 0;
    this.z2 = 0;
  }

  static lowpass(sampleRate, cutoff, q) {
    const w0 = (2 * Math.PI * cutoff) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    return new Biquad((1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  static highpass(sampleRate, cutoff, q) {
    const w0 = (2 * Math.PI * cutoff) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    return new Biquad((1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/**
 * Streaming YIN pitch detector. It tells high-pitched voiced audio from low and
 * decides when to turn it down. The worklet applies the resulting gain.
 */
export class VoiceDetector {
  constructor(sourceSampleRate, threshold = 180) {
    this.sourceSampleRate = sourceSampleRate;
    this.threshold = threshold;
    this.resampleRatio = sourceSampleRate / ANALYSIS_RATE;
    this.resampleCounter = 0;
    this.previousFiltered = 0;
    // Fourth-order Butterworth low-pass (also the anti-alias filter) and a rumble high-pass.
    this.lowpassA = Biquad.lowpass(sourceSampleRate, BAND_HIGH_HZ, 0.5412);
    this.lowpassB = Biquad.lowpass(sourceSampleRate, BAND_HIGH_HZ, 1.3066);
    this.highpass = Biquad.highpass(sourceSampleRate, BAND_LOW_HZ, Math.SQRT1_2);
    this.badSamples = 0;

    this.frame = new Float32Array(FRAME_SIZE);
    this.ordered = new Float32Array(FRAME_SIZE);
    this.difference = new Float32Array(MAX_LAG + 1);
    this.normalized = new Float32Array(MAX_LAG + 1);
    this.writeIndex = 0;
    this.samplesUntilAnalysis = HOP_SIZE;
    this.score = 0;
    this.idleSeconds = 0;
    this.active = false;
    this.lastResult = {
      active: false,
      voiced: false,
      pitch: 0,
      clarity: 0,
      rms: 0,
      changed: false,
      reason: null,
      score: 0,
    };
  }

  setThreshold(threshold) {
    this.threshold = threshold;
  }

  push(sample) {
    // A NaN would stay in the filter state forever, so it never gets in.
    if (!Number.isFinite(sample)) {
      this.badSamples += 1;
      sample = 0;
    }
    const filtered = this.highpass.process(this.lowpassB.process(this.lowpassA.process(sample)));

    let result = null;
    this.resampleCounter += 1;
    // Each pass emits one 16 kHz sample; more than one only when the source rate is below 16 kHz.
    while (this.resampleCounter >= this.resampleRatio) {
      this.resampleCounter -= this.resampleRatio;
      // The output instant lies `resampleCounter` source samples back from this one.
      const resampled = filtered + (this.previousFiltered - filtered) * this.resampleCounter;

      this.frame[this.writeIndex] = resampled;
      this.writeIndex = (this.writeIndex + 1) % FRAME_SIZE;
      this.samplesUntilAnalysis -= 1;

      if (this.samplesUntilAnalysis === 0) {
        this.samplesUntilAnalysis = HOP_SIZE;
        result = this.analyze();
      }
    }
    this.previousFiltered = filtered;
    return result;
  }

  analyze() {
    // Unroll the ring into chronological order for the difference function.
    const ordered = this.ordered;
    ordered.set(this.frame.subarray(this.writeIndex));
    ordered.set(this.frame.subarray(0, this.writeIndex), FRAME_SIZE - this.writeIndex);

    let squareSum = 0;
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      squareSum += ordered[i] * ordered[i];
    }
    const rms = Math.sqrt(squareSum / FRAME_SIZE);

    const difference = this.difference;
    const normalized = this.normalized;
    normalized.fill(0);
    normalized[0] = 1;

    for (let lag = 1; lag <= MAX_LAG; lag += 1) {
      let sum = 0;
      for (let i = 0; i < WINDOW_SIZE; i += 1) {
        const delta = ordered[i] - ordered[i + lag];
        sum += delta * delta;
      }
      difference[lag] = sum;
    }

    let runningSum = 0;
    let selectedLag = -1;
    let minimumNormalized = 1;
    let minimumLag = -1;

    for (let lag = 1; lag <= MAX_LAG; lag += 1) {
      runningSum += difference[lag];
      normalized[lag] = runningSum === 0 ? 1 : (difference[lag] * lag) / runningSum;
      if (lag >= MIN_LAG && normalized[lag] < minimumNormalized) {
        minimumNormalized = normalized[lag];
        minimumLag = lag;
      }
    }

    // YIN's absolute-threshold step picks the first period, not a harmonic.
    for (let lag = MIN_LAG; lag < MAX_LAG; lag += 1) {
      if (normalized[lag] >= 0.18) continue;
      while (lag + 1 <= MAX_LAG && normalized[lag + 1] < normalized[lag]) lag += 1;
      selectedLag = lag;
      break;
    }

    if (selectedLag === -1 && minimumNormalized < 0.28) {
      selectedLag = minimumLag;
    }

    let pitch = 0;
    let clarity = 0;
    if (selectedLag > 0) {
      const refinedLag = this.parabolicInterpolation(normalized, selectedLag);
      pitch = ANALYSIS_RATE / refinedLag;
      clarity = 1 - normalized[selectedLag];
    }

    const voiced = rms >= RMS_THRESHOLD && pitch >= MIN_FREQUENCY && pitch <= MAX_FREQUENCY && clarity >= 0.72;
    const reason = this.updateActive(voiced, pitch, rms);
    this.lastResult = { active: this.active, voiced, pitch, clarity, rms, changed: reason !== null, reason, score: this.score };
    return this.lastResult;
  }

  parabolicInterpolation(values, index) {
    if (index <= 0 || index >= values.length - 1) return index;
    const left = values[index - 1];
    const center = values[index];
    const right = values[index + 1];
    const denominator = left - 2 * center + right;
    if (Math.abs(denominator) < 1e-9) return index;
    const adjustment = Math.max(-1, Math.min(1, (0.5 * (left - right)) / denominator));
    return index + adjustment;
  }

  /**
   * Adds this frame's vote to the running score and switches when the score crosses the
   * trigger. Pauses and unvoiced consonants do not vote, so they neither restore the volume
   * nor restart the count. Returns why the state changed, or null if it did not.
   */
  updateActive(voiced, pitch, rms) {
    const previous = this.active;
    let reason = null;

    if (voiced) {
      this.idleSeconds = 0;
      // Lean the pivot against the current state so a voice sitting on the threshold cannot flap it.
      const pivot = this.active ? this.threshold / HYSTERESIS_RATIO : this.threshold * HYSTERESIS_RATIO;
      const vote = Math.max(-VOTE_LIMIT, Math.min(VOTE_LIMIT, Math.log2(pitch / pivot) / VOTE_OCTAVES));
      this.score = Math.max(-SCORE_LIMIT, Math.min(SCORE_LIMIT, this.score + vote));
      if (this.score >= SCORE_TRIGGER) {
        this.active = true;
        reason = 'high-voice';
      } else if (this.score <= -SCORE_TRIGGER) {
        this.active = false;
        reason = 'low-voice';
      }
    } else if (rms >= SOUND_RMS) {
      // Something is playing but nobody is talking: music, applause, noise.
      this.idleSeconds += HOP_SECONDS;
      if (this.idleSeconds >= IDLE_SECONDS) {
        this.score = 0;
        this.active = false;
        reason = 'no-voice';
      }
    }

    return previous === this.active ? null : reason;
  }
}
