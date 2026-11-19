// Scores a detector against real audio: how much of a high voice and of a low voice gets ducked.
// usage: node tools/score/score.js [--detector path] [--threshold 180,165] [--data dir]
// See README.md. Audio comes from fetch.sh; labels live in labels/.
import { readFileSync, existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOP_SECONDS = 0.016; // the detector reports once per 256 samples at 16 kHz
const FRAME_LAG_SECONDS = 0.04; // a report describes audio centred about 40 ms earlier
const SPEECH_RMS = 0.02; // raw level above which a frame counts as "someone is talking"
const PAUSE_RMS = 0.01;
const READER_LEVEL = 0.1; // readers are scaled to this RMS, close to YouTube speech levels
const NOBODY = 0, LOW = 1, HIGH = 2, BOTH = 3, UNKNOWN = 4;
// The label files keep the codes their sources use. In this audio F is the high voice, M the low one.
const VOICE = { F: HIGH, M: LOW };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- worker

function loadAudio(path, level = 0) {
  const bytes = readFileSync(path);
  const audio = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (level > 0) {
    let sum = 0;
    for (let i = 0; i < audio.length; i += 1) sum += audio[i] * audio[i];
    const gain = level / Math.sqrt(sum / audio.length);
    for (let i = 0; i < audio.length; i += 1) audio[i] *= gain;
  }
  return audio;
}

/** Raw level per 16 ms hop over the trailing 64 ms, independent of any detector. */
function hopLevels(audio, sampleRate) {
  const hop = Math.round(sampleRate * HOP_SECONDS);
  const window = hop * 4;
  const levels = new Float32Array(Math.floor(audio.length / hop));
  for (let n = 0; n < levels.length; n += 1) {
    const end = (n + 1) * hop;
    let sum = 0;
    for (let i = Math.max(0, end - window); i < end; i += 1) sum += audio[i] * audio[i];
    levels[n] = Math.sqrt(sum / window);
  }
  return levels;
}

/** Alternate chunks of a high-voiced and a low-voiced reader, cutting at pauses, 3-12 s per turn. */
function spliceReaders(high, low, sampleRate, seed) {
  const rand = mulberry32(seed);
  const hop = Math.round(sampleRate * HOP_SECONDS);
  const source = { [HIGH]: high, [LOW]: low };
  const levels = { [HIGH]: hopLevels(high, sampleRate), [LOW]: hopLevels(low, sampleRate) };
  const cursor = { [HIGH]: 0, [LOW]: 0 };
  const chunks = [];
  let who = rand() < 0.5 ? HIGH : LOW;
  for (;;) {
    const level = levels[who];
    const start = cursor[who];
    if (start >= level.length - 200) break;
    let end = Math.min(level.length, start + Math.round((3 + rand() * 9) / HOP_SECONDS));
    let quiet = 0;
    while (end < level.length && quiet < 6) {
      quiet = level[end] < PAUSE_RMS ? quiet + 1 : 0;
      end += 1;
    }
    chunks.push({ who, audio: source[who].subarray(start * hop, end * hop) });
    cursor[who] = end;
    who = who === HIGH ? LOW : HIGH;
  }
  const audio = new Float32Array(chunks.reduce((n, c) => n + c.audio.length, 0));
  const turns = [];
  let at = 0;
  for (const chunk of chunks) {
    audio.set(chunk.audio, at);
    turns.push({ who: chunk.who, start: at / sampleRate, end: (at + chunk.audio.length) / sampleRate });
    at += chunk.audio.length;
  }
  return { audio, turns };
}

async function runJob(job) {
  const { VoiceDetector } = await import(pathToFileURL(job.detector).href);
  let audio;
  let turns = null;
  if (job.kind === 'turns') {
    ({ audio, turns } = spliceReaders(loadAudio(job.high, READER_LEVEL), loadAudio(job.low, READER_LEVEL), job.sampleRate, job.seed));
  } else {
    audio = loadAudio(job.file, job.kind === 'reader' ? READER_LEVEL : 0);
  }
  const detector = new VoiceDetector(job.sampleRate, job.threshold);
  const window = Math.round(job.sampleRate * HOP_SECONDS * 4);
  const active = [];
  const level = [];
  const time = [];
  for (let i = 0; i < audio.length; i += 1) {
    const result = detector.push(audio[i]);
    if (!result) continue;
    let sum = 0;
    for (let j = Math.max(0, i + 1 - window); j <= i; j += 1) sum += audio[j] * audio[j];
    active.push(result.active ? 1 : 0);
    level.push(Math.sqrt(sum / window));
    time.push((i + 1) / job.sampleRate - FRAME_LAG_SECONDS);
  }
  return { id: job.id, active: Uint8Array.from(active), level: Float32Array.from(level), time: Float64Array.from(time), turns };
}

if (!isMainThread) {
  parentPort.on('message', (job) => {
    runJob(job).then(
      (result) => parentPort.postMessage({ ok: true, result }),
      (error) => parentPort.postMessage({ ok: false, id: job.id, error: String(error?.stack || error) }),
    );
  });
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const options = { detector: resolve(HERE, '../../voice-detector.js'), thresholds: [180], data: process.env.SCORE_DATA || resolve(HERE, 'data') };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === '--detector') { options.detector = resolve(value); i += 1; }
    else if (argv[i] === '--threshold') { options.thresholds = value.split(',').map(Number); i += 1; }
    else if (argv[i] === '--data') { options.data = resolve(value); i += 1; }
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (options.thresholds.some((t) => !(t > 0))) throw new Error('--threshold wants numbers, e.g. 180 or 165,180');
  return options;
}

function readTable(path) {
  return readFileSync(path, 'utf8').split('\n').filter((row) => row && !row.startsWith('#')).map((row) => row.split(/\s+/));
}

function runPool(jobs) {
  const size = Math.min(jobs.length, Math.max(1, availableParallelism() - 1));
  return new Promise((resolveAll, rejectAll) => {
    const results = new Map();
    let next = 0;
    let finished = 0;
    const workers = [];
    const stop = (error) => { for (const w of workers) w.terminate(); rejectAll(error); };
    for (let w = 0; w < size; w += 1) {
      const worker = new Worker(fileURLToPath(import.meta.url));
      workers.push(worker);
      const feed = () => { if (next < jobs.length) worker.postMessage(jobs[next++]); else worker.terminate(); };
      worker.on('message', (message) => {
        if (!message.ok) return stop(new Error(`job ${message.id} failed: ${message.error}`));
        results.set(message.result.id, message.result);
        finished += 1;
        if (finished === jobs.length) resolveAll(results);
        return feed();
      });
      worker.on('error', stop);
      feed();
    }
  });
}

const median = (values) => (values.length ? Float64Array.from(values).sort()[values.length >> 1] : NaN);
const quantile = (values, q) => (values.length ? Float64Array.from(values).sort()[Math.min(values.length - 1, Math.floor(q * values.length))] : NaN);
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
const fmt = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : 'n/a');

/** Per-report label for the video from the piece table (see labels/). */
function videoLabels(pieces, time) {
  const label = new Uint8Array(time.length);
  const owner = new Int32Array(time.length).fill(-1);
  for (const [startText, endText, clusterText, code] of pieces) {
    const start = Number(startText);
    const end = Number(endText);
    const cluster = Number(clusterText);
    const value = VOICE[code] ?? UNKNOWN;
    // Reports are evenly spaced, so jump straight to the first one inside the piece.
    let n = Math.max(0, Math.ceil((start - time[0]) / HOP_SECONDS));
    for (; n < time.length && time[n] <= end; n += 1) {
      if (owner[n] === -1) { owner[n] = cluster; label[n] = value; } else if (owner[n] !== cluster) label[n] = BOTH;
    }
  }
  return label;
}

/** Shares of speech ducked per label, plus how long each change of speaker takes to register. */
function scoreLabeled(active, level, label) {
  const on = [0, 0, 0, 0, 0];
  const total = [0, 0, 0, 0, 0];
  let starts = 0;
  let flips = 0;
  for (let n = 0; n < active.length; n += 1) {
    if (n > 0 && active[n] !== active[n - 1]) { flips += 1; if (active[n]) starts += 1; }
    if (level[n] < SPEECH_RMS) continue;
    total[label[n]] += 1;
    on[label[n]] += active[n];
  }
  const toDuck = [];
  const toRestore = [];
  let previous = NOBODY;
  let turnStart = -1;
  let wanted = 0;
  let changes = 0;
  const close = (end) => {
    if (turnStart < 0 || (end - turnStart) * HOP_SECONDS < 1) return;
    let first = turnStart;
    while (first < end && level[first] < SPEECH_RMS) first += 1;
    let n = first;
    while (n < end && active[n] !== wanted) n += 1;
    (wanted ? toDuck : toRestore).push((n - first) * HOP_SECONDS);
    changes += 1;
  };
  for (let n = 0; n < label.length; n += 1) {
    const l = label[n];
    if (l === BOTH) { close(n); turnStart = -1; continue; }
    if (l !== LOW && l !== HIGH) continue;
    if (l !== previous) {
      close(n);
      turnStart = previous === NOBODY ? -1 : n;
      wanted = l === HIGH ? 1 : 0;
      previous = l;
    }
  }
  close(label.length);
  return { on, total, starts, flips, toDuck, toRestore, changes, seconds: active.length * HOP_SECONDS };
}

function report(threshold, results, readers, pairs) {
  const lines = [`\nthreshold ${threshold} Hz`];
  const video = results.get(`video@${threshold}`);
  if (video) {
    const pieces = readTable(resolve(HERE, 'labels/video-FTGLWP9ZYmc.tsv'));
    const s = scoreLabeled(video.active, video.level, videoLabels(pieces, video.time));
    const share = (l) => fmt((100 * s.on[l]) / s.total[l]);
    const secs = (l) => Math.round(s.total[l] * HOP_SECONDS);
    lines.push(
      `  test video (high voice ${secs(HIGH)} s, low voice ${secs(LOW)} s, both at once ${secs(BOTH)} s)`,
      `    high voice ducked      ${share(HIGH).padStart(5)} %`,
      `    low voice ducked       ${share(LOW).padStart(5)} %`,
      `    both at once ducked    ${share(BOTH).padStart(5)} %`,
      `    duck starts            ${fmt(s.starts / (s.seconds / 60)).padStart(5)} per minute`,
      `    time to duck           ${fmt(median(s.toDuck), 2).padStart(5)} s median, ${fmt(quantile(s.toDuck, 0.9), 2)} s p90 (${s.toDuck.length} turns)`,
      `    time to restore        ${fmt(median(s.toRestore), 2).padStart(5)} s median, ${fmt(quantile(s.toRestore, 0.9), 2)} s p90 (${s.toRestore.length} turns)`,
    );
  }
  const alone = { [HIGH]: [], [LOW]: [] };
  for (const [id, code] of readers) {
    const r = results.get(`reader-${id}@${threshold}`);
    let speech = 0;
    let on = 0;
    for (let n = 0; n < r.active.length; n += 1) if (r.level[n] >= SPEECH_RMS) { speech += 1; on += r.active[n]; }
    alone[VOICE[code]].push((100 * on) / speech);
  }
  if (alone[HIGH].length) {
    const sum = { on: [0, 0, 0, 0, 0], total: [0, 0, 0, 0, 0], toDuck: [], toRestore: [], flips: 0, changes: 0 };
    for (let p = 0; p < pairs.length; p += 1) {
      const r = results.get(`turns-${p}@${threshold}`);
      const label = new Uint8Array(r.active.length);
      for (const turn of r.turns) for (let n = 0; n < r.time.length; n += 1) if (r.time[n] >= turn.start && r.time[n] < turn.end) label[n] = turn.who;
      const s = scoreLabeled(r.active, r.level, label);
      for (const l of [LOW, HIGH]) { sum.on[l] += s.on[l]; sum.total[l] += s.total[l]; }
      sum.toDuck.push(...s.toDuck);
      sum.toRestore.push(...s.toRestore);
      sum.flips += s.flips;
      sum.changes += s.changes;
    }
    lines.push(
      `  labeled readers (${alone[HIGH].length} high voices, ${alone[LOW].length} low voices)`,
      `    alone: high voices ducked ${fmt(mean(alone[HIGH])).padStart(5)} % mean, ${fmt(Math.min(...alone[HIGH]))} % worst reader`,
      `    alone: low voices ducked  ${fmt(mean(alone[LOW])).padStart(5)} % mean, ${fmt(Math.max(...alone[LOW]))} % worst reader`,
      `    turns: high voices ducked ${fmt((100 * sum.on[HIGH]) / sum.total[HIGH]).padStart(5)} %`,
      `    turns: low voices ducked  ${fmt((100 * sum.on[LOW]) / sum.total[LOW]).padStart(5)} %`,
      `    turns: time to duck       ${fmt(median(sum.toDuck), 2).padStart(5)} s median, ${fmt(quantile(sum.toDuck, 0.9), 2)} s p90`,
      `    turns: time to restore    ${fmt(median(sum.toRestore), 2).padStart(5)} s median, ${fmt(quantile(sum.toRestore, 0.9), 2)} s p90`,
      `    turns: on/off changes     ${fmt(sum.flips / sum.changes, 2).padStart(5)} per change of speaker (1.00 is ideal)`,
    );
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.detector)) throw new Error(`no detector at ${options.detector}`);
  const sampleRate = 48000;
  const videoFile = resolve(options.data, 'pcm/video.f32');
  const readerFile = ([id, code]) => resolve(options.data, `pcm/readers/${code}-${id}.f32`);
  const readers = readTable(resolve(HERE, 'labels/readers.tsv')).filter((reader) => existsSync(readerFile(reader)));
  if (!existsSync(videoFile) && readers.length === 0) throw new Error(`no audio under ${options.data}; run tools/score/fetch.sh first`);

  // Three random pairings of every high-voiced reader with a low-voiced one.
  const rand = mulberry32(20261119);
  const highs = readers.filter(([, code]) => VOICE[code] === HIGH);
  const lows = readers.filter(([, code]) => VOICE[code] === LOW);
  const pairs = [];
  if (lows.length) {
    for (let round = 0; round < 3; round += 1) {
      const order = lows.map((reader) => [rand(), reader]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      highs.forEach((reader, i) => pairs.push({ high: readerFile(reader), low: readerFile(order[i % order.length]), seed: 1000 * round + i }));
    }
  }

  const jobs = [];
  for (const threshold of options.thresholds) {
    const base = { detector: options.detector, threshold, sampleRate };
    if (existsSync(videoFile)) jobs.push({ ...base, id: `video@${threshold}`, kind: 'video', file: videoFile });
    for (const reader of readers) jobs.push({ ...base, id: `reader-${reader[0]}@${threshold}`, kind: 'reader', file: readerFile(reader) });
    pairs.forEach((pair, p) => jobs.push({ ...base, id: `turns-${p}@${threshold}`, kind: 'turns', ...pair }));
  }
  // Longest jobs first so the video does not start last.
  jobs.sort((a, b) => (a.kind === 'video' ? -1 : 0) - (b.kind === 'video' ? -1 : 0));

  const started = Date.now();
  console.log(`detector ${options.detector}`);
  console.log(`audio    ${options.data} (${existsSync(videoFile) ? 'video' : 'no video'}, ${readers.length} readers, ${pairs.length} spliced streams)`);
  const results = await runPool(jobs);
  for (const threshold of options.thresholds) console.log(report(threshold, results, readers, pairs));
  console.log(`\n${jobs.length} runs in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

if (isMainThread) {
  main().catch((error) => {
    console.error(`score failed: ${error.message}`);
    process.exitCode = 1;
  });
}
