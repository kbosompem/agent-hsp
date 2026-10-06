#!/bin/bash
# Transcribe all 16 scored sermons with one engine config, JOBS at a time.
#   PY=/path/to/venv/bin/python scripts/stt-eval/run_all.sh <engine-name> [stream_transcribe.py args...]
# Output: fixtures/real/alt/<engine-name>/<slug>.finals.json
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ENGINE=$1; shift
PY=${PY:-python3}
JOBS=${JOBS:-4}
MODEL=${MODEL:-$ROOT/fixtures/real/alt/models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11}
OUT=$ROOT/fixtures/real/alt/$ENGINE
mkdir -p "$OUT"
for f in "$ROOT"/fixtures/real/app/*.finals.json; do
  s=$(basename "$f" .finals.json)
  [ -f "$ROOT/fixtures/real/labels/$s.labels.json" ] || continue
  [ -s "$OUT/$s.finals.json" ] && continue
  echo "$s"
done | ROOT=$ROOT PY=$PY MODEL=$MODEL OUT=$OUT xargs -n1 -P "$JOBS" bash -c '
  s=${!#}; set -- "${@:1:$#-1}"
  "$PY" "$ROOT/scripts/stt-eval/stream_transcribe.py" --model "$MODEL" --wav "$ROOT/fixtures/real/$s.wav" \
    --out "$OUT/$s.finals.json" --silence 1.6 "$@" > "$OUT/$s.log" 2>&1 && echo "done $s $(tail -1 "$OUT/$s.log")"
' _ "$@"
