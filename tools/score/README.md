# Scoring the detector

Runs `voice-detector.js` over real audio and reports how much of a high voice and how much of a low voice gets ducked. Run it before and after any change to detection.

## Run it

1. `tools/score/fetch.sh` (once). Downloads the test video's audio and 25 labeled audiobook readers into `tools/score/data` and decodes them. About 1.4 GB, safe to delete. Needs `yt-dlp`, `ffmpeg` and `curl`.
2. `npm run score` (about 25 s).
3. Compare with the reference numbers below.

Options go after `--`:

- `npm run score -- --threshold 165,180,190` scores other slider positions.
- `npm run score -- --detector /path/to/other/voice-detector.js` scores another copy, for a before and after.

## Reference numbers (2026-11-19)

| Threshold 180 | First draft, never released | v1.0.0 |
|---|---|---|
| Video: high voice ducked | 51.7% | 97.6% |
| Video: low voice ducked | 3.7% | 13.0% |
| Video: both at once ducked | 13.3% | 70.4% |
| Video: time to duck, median | 1.15 s | 0.10 s |
| Video: time to restore, median | 0.00 s | 0.27 s |
| Readers in turns: high voices ducked | 45.5% | 80.6% |
| Readers in turns: low voices ducked | 1.7% | 7.3% |

Other slider positions on the video in v1.0.0, high / low: 165 Hz 98.9% / 19.0%, 190 Hz 94.4% / 9.7%, 220 Hz 73.0% / 3.5%.

## What it measures

- **Test video.** https://www.youtube.com/watch?v=FTGLWP9ZYmc, a 36-minute two-person debate with one high voice (median pitch about 240 Hz) and one low voice (about 125 Hz). Both talk at once for about a fifth of it.
- **Labeled readers.** 25 audiobook readers from Mini LibriSpeech, 150 s each: 13 high voices (median pitch 172 to 242 Hz) and 12 low voices (97 to 147 Hz). They are scored alone and spliced into alternating turns of 3 to 12 s.
- Only frames where someone is talking count (raw level above 0.02), so silence does not help or hurt.
- Time to duck and time to restore run from the first speech after a change of speaker.

## Where the labels come from

The labels say who is talking, and they are made without looking at pitch, so they can check a pitch detector. They keep the codes their sources use: `F` is the high voice and `M` the low one.

- `labels/video-FTGLWP9ZYmc.tsv` is machine-made and nobody has checked it by ear. A diarizer groups the speech into speaker clusters, an audio tagger tells the two speakers apart with its female-speech and male-speech classes, and a piece gets a label only when the two agree. The same tagger got 1181 of 1193 three-second windows right on the labeled readers.
- `labels/readers.tsv` comes from the speaker list that ships with LibriSpeech, which sorts readers by sex. In this set that is also a clean split by pitch.

## Remaking the video labels

Takes about 5 minutes. Work in a scratch folder outside the repo, with `REPO` set to where this repo is checked out. A rerun can flip a few near-tie pieces (5 of 1165 when tried); the scores did not move.

1. `uv venv venv && VIRTUAL_ENV=$PWD/venv uv pip install sherpa-onnx soundfile numpy`
2. Download and unpack from `https://github.com/k2-fsa/sherpa-onnx/releases/download/`:
   `speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
   `speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx` (the typo is in the real URL),
   `audio-tagging-models/sherpa-onnx-ced-mini-audio-tagging-2024-04-19.tar.bz2`.
3. `ffmpeg -i "$REPO/tools/score/data/video/audio.webm" -ac 1 -ar 16000 video-16k.wav`
4. Run the labeler:

   ```bash
   venv/bin/python -I "$REPO/tools/score/labeling/label.py" video-16k.wav \
     sherpa-onnx-pyannote-segmentation-3-0/model.onnx wespeaker_en_voxceleb_resnet34_LM.onnx \
     sherpa-onnx-ced-mini-audio-tagging-2024-04-19/model.onnx \
     sherpa-onnx-ced-mini-audio-tagging-2024-04-19/class_labels_indices.csv \
     "$REPO/tools/score/labels/video-FTGLWP9ZYmc.tsv" 'https://www.youtube.com/watch?v=FTGLWP9ZYmc'
   ```
