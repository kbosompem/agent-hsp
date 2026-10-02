#!/bin/sh
# Run the verse harness over every fixture for one model.
#   scripts/latency-fixture/run-all.sh tiny.en [fixture dir] [extra harness args]
# Prints one line per fixture: found/expected, wrong-verse hits, latency.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MODEL="$1"; shift
DIR="${1:-$ROOT/fixtures/latency}"; [ $# -gt 0 ] && shift
MDIR="$HOME/Library/Application Support/com.amcpreso.desktop/models"
BIN="$ROOT/desktop/target/release/examples/latency"
for f in "$DIR"/*.json; do
  case "$f" in *.ref.json) continue;; esac
  out=$("$BIN" "$MDIR/ggml-$MODEL.bin" "$f" streaming "$@" 2>/dev/null)
  found=$(echo "$out" | grep -o 'found [0-9]*/[0-9]*' | cut -d' ' -f2)
  mean=$(echo "$out" | grep -o 'mean [0-9.]*s' | cut -d' ' -f2)
  extra=$(echo "$out" | grep -c 'extra' || true)
  missed=$(echo "$out" | grep 'MISSED' | awk '{print $2" "$3}' | tr '\n' ',' | sed 's/ *,$//')
  wms=$(echo "$out" | grep -o 'whisper_total=[0-9]*' | cut -d= -f2)
  printf "%-22s found %-6s wrong %-2s mean %-6s whisper %6sms  missed: %s\n" "$(basename "$f" .json)" "$found" "$extra" "$mean" "$wms" "$missed"
done
