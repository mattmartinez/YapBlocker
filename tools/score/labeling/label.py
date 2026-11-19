"""Make who-is-speaking labels for a two-person video, for score.js.

Steps: (1) a diarizer groups the speech into speaker clusters, (2) an AudioSet tagger calls
each piece of at most 3 s male or female, (3) a cluster takes the sex most of its pieces got,
and a piece keeps a label only when its own call agrees with its cluster.

usage: python -I label.py <audio16k.wav> <segmentation.onnx> <embedding.onnx> <tagger.onnx>
                          <tagger_labels.csv> <out.tsv> [source description]
Needs: pip install sherpa-onnx soundfile numpy. See ../README.md for the model downloads.
"""
import sys
import time

import numpy as np
import sherpa_onnx
import soundfile as sf

PIECE_SECONDS = 3.0
FEMALE_CLUSTER_SHARE = 0.6  # at least this share of female calls makes a female cluster
MALE_CLUSTER_SHARE = 0.25  # at most this share makes a male cluster; in between stays unknown
MALE_CLASS, FEMALE_CLASS = 1, 2  # AudioSet: "Male speech, man speaking", "Female speech, woman speaking"


def log(message):
    print(f"label: {message}", file=sys.stderr, flush=True)


def diarize(samples, rate, segmentation_model, embedding_model):
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=segmentation_model),
            num_threads=6,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=embedding_model, num_threads=6),
        # Let it over-split: calm and shouting come out as separate clusters, which is fine here.
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.5),
        min_duration_on=0.2,
        min_duration_off=0.3,
    )
    if not config.validate():
        raise SystemExit("label: diarization config rejected, check the model paths")
    diarizer = sherpa_onnx.OfflineSpeakerDiarization(config)
    if diarizer.sample_rate != rate:
        raise SystemExit(f"label: audio must be {diarizer.sample_rate} Hz, got {rate}")
    return [(s.start, s.end, s.speaker) for s in diarizer.process(samples).sort_by_start_time()]


def tag_pieces(samples, rate, segments, tagger_model, tagger_labels):
    config = sherpa_onnx.AudioTaggingConfig(
        model=sherpa_onnx.AudioTaggingModelConfig(ced=tagger_model, num_threads=4), labels=tagger_labels, top_k=527)
    if not config.validate():
        raise SystemExit("label: tagger config rejected, check the model paths")
    tagger = sherpa_onnx.AudioTagging(config)
    pieces = []
    for start, end, cluster in segments:
        count = max(1, int(np.ceil((end - start) / PIECE_SECONDS)))
        step = (end - start) / count
        for k in range(count):
            piece_start, piece_end = start + k * step, start + (k + 1) * step
            # Short pieces borrow their surroundings so the tagger sees at least 1 s.
            centre = (piece_start + piece_end) / 2
            half = max(0.5, (piece_end - piece_start) / 2)
            chunk = samples[max(0, int((centre - half) * rate)): int((centre + half) * rate)]
            stream = tagger.create_stream()
            stream.accept_waveform(sample_rate=rate, waveform=np.ascontiguousarray(chunk))
            probs = {event.index: event.prob for event in tagger.compute(stream, top_k=527)}
            pieces.append({"start": piece_start, "end": piece_end, "cluster": cluster,
                           "male": probs.get(MALE_CLASS, 0.0), "female": probs.get(FEMALE_CLASS, 0.0)})
    return pieces


def main():
    if len(sys.argv) < 7:
        raise SystemExit(__doc__)
    wav, segmentation_model, embedding_model, tagger_model, tagger_labels, out = sys.argv[1:7]
    source = sys.argv[7] if len(sys.argv) > 7 else wav
    samples, rate = sf.read(wav, dtype="float32", always_2d=False)
    if samples.ndim != 1:
        raise SystemExit("label: audio must be mono")
    samples = np.ascontiguousarray(samples)
    log(f"start: {len(samples) / rate:.0f} s of audio from {wav}")

    started = time.time()
    segments = diarize(samples, rate, segmentation_model, embedding_model)
    log(f"diarized into {len(segments)} segments, {len({s[2] for s in segments})} clusters in {time.time() - started:.0f} s")

    started = time.time()
    pieces = tag_pieces(samples, rate, segments, tagger_model, tagger_labels)
    log(f"tagged {len(pieces)} pieces in {time.time() - started:.0f} s")

    total, female = {}, {}
    for p in pieces:
        seconds = p["end"] - p["start"]
        total[p["cluster"]] = total.get(p["cluster"], 0.0) + seconds
        if p["female"] > p["male"]:
            female[p["cluster"]] = female.get(p["cluster"], 0.0) + seconds
    cluster_sex = {}
    for cluster, seconds in total.items():
        share = female.get(cluster, 0.0) / seconds
        cluster_sex[cluster] = "F" if share >= FEMALE_CLUSTER_SHARE else "M" if share <= MALE_CLUSTER_SHARE else "?"

    seconds_by_label = {"M": 0.0, "F": 0.0, "?": 0.0}
    with open(out, "w") as handle:
        handle.write(f"# Who is speaking in {source}, in pieces of at most 3 s.\n")
        handle.write(f"# Machine-made on {time.strftime('%Y-%m-%d')} (see ../README.md), not checked by a person.\n")
        handle.write("# label: M or F when the speaker cluster and the per-piece tagger agree, ? otherwise.\n")
        handle.write("# Where pieces from two clusters overlap, both people are talking.\n")
        handle.write("# start_s\tend_s\tcluster\tlabel\tp_male\tp_female\n")
        for p in sorted(pieces, key=lambda p: (p["start"], p["end"], p["cluster"])):
            call = "F" if p["female"] > p["male"] else "M"
            label = call if cluster_sex[p["cluster"]] == call else "?"
            seconds_by_label[label] += p["end"] - p["start"]
            handle.write(f"{p['start']:.3f}\t{p['end']:.3f}\t{p['cluster']}\t{label}\t{p['male']:.4f}\t{p['female']:.4f}\n")
    log("done: " + ", ".join(f"{k} {v:.0f} s" for k, v in seconds_by_label.items()) + f" -> {out}")


if __name__ == "__main__":
    main()
