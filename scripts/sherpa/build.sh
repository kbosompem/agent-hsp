#!/bin/sh
# Build sherpa-onnx (the runtime for the Nemotron streaming speech model) as
# static libraries for the desktop app's optional `nemotron` feature.
#
# We pin a commit on main because Bible-book hotword boosting for streaming
# NeMo transducers landed after the v1.13.8 release.
#
#   scripts/sherpa/build.sh            # clones the pinned commit
#   SRC=/path/to/sherpa-onnx scripts/sherpa/build.sh   # reuse a checkout
#
# Output: desktop/vendor/sherpa-onnx/lib (not in git). The app's
# .cargo/config.toml points SHERPA_ONNX_LIB_DIR there.
set -e
COMMIT=99ddefa
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$ROOT/desktop/vendor/sherpa-onnx"
SRC="${SRC:-$ROOT/desktop/vendor/sherpa-onnx-src}"
if [ ! -d "$SRC/.git" ]; then
  git clone https://github.com/k2-fsa/sherpa-onnx "$SRC"
fi
git -C "$SRC" checkout -q "$COMMIT" 2>/dev/null || { git -C "$SRC" fetch -q origin && git -C "$SRC" checkout -q "$COMMIT"; }
BUILD="$SRC/build-agenthsp"
mkdir -p "$BUILD"
cd "$BUILD"
cmake \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$OUT" \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_BUILD_C_API_EXAMPLES=OFF \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  ..
cmake --build . --config Release -j 8
cmake --install . --config Release
echo "sherpa-onnx $COMMIT installed to $OUT"
ls "$OUT/lib"
