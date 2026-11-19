#!/usr/bin/env bash
# Downloads and decodes the audio that score.js needs into tools/score/data.
# About 1.4 GB, safe to delete, skips anything already there. Needs yt-dlp, ffmpeg, curl.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data="${SCORE_DATA:-$here/data}"
mkdir -p "$data/video" "$data/librispeech" "$data/pcm/readers"

# 1. Test video: 48 kHz mono float, mixed the same way the worklet mixes channels.
if [[ ! -s "$data/pcm/video.f32" ]]; then
  if ! compgen -G "$data/video/audio.*" > /dev/null; then
    echo "fetch: downloading test video audio"
    yt-dlp --no-playlist --no-progress -f 'bestaudio[acodec=opus]/bestaudio' \
      -o "$data/video/audio.%(ext)s" 'https://www.youtube.com/watch?v=FTGLWP9ZYmc'
  fi
  source_file="$(compgen -G "$data/video/audio.*" | head -n 1)"
  echo "fetch: decoding $source_file"
  ffmpeg -nostdin -v error -y -i "$source_file" -ac 1 -ar 48000 -f f32le "$data/pcm/video.f32.part"
  mv "$data/pcm/video.f32.part" "$data/pcm/video.f32"
fi

# 2. Labeled readers: Mini LibriSpeech dev-clean-2 (126 MB), first 150 s of each reader.
if [[ ! -d "$data/librispeech/LibriSpeech/dev-clean-2" ]]; then
  if [[ ! -s "$data/librispeech/dev-clean-2.tar.gz" ]]; then
    echo "fetch: downloading labeled readers"
    curl -sS -L --fail -o "$data/librispeech/dev-clean-2.tar.gz.part" https://www.openslr.org/resources/31/dev-clean-2.tar.gz
    mv "$data/librispeech/dev-clean-2.tar.gz.part" "$data/librispeech/dev-clean-2.tar.gz"
  fi
  tar -xzf "$data/librispeech/dev-clean-2.tar.gz" -C "$data/librispeech"
fi

list="$(mktemp)"
trap 'rm -f "$list"' EXIT
while read -r id code; do
  [[ -z "$id" || "$id" == \#* ]] && continue
  out="$data/pcm/readers/$code-$id.f32"
  [[ -s "$out" ]] && continue
  find "$data/librispeech/LibriSpeech/dev-clean-2/$id" -name '*.flac' | sort | sed "s/^/file '/; s/$/'/" > "$list"
  ffmpeg -nostdin -v error -y -f concat -safe 0 -i "$list" -t 150 -ac 1 -ar 48000 -f f32le "$out.part"
  mv "$out.part" "$out"
done < "$here/labels/readers.tsv"

echo "fetch: ready in $data ($(du -sh "$data" | cut -f1))"
