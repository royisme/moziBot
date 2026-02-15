#!/usr/bin/env bash
# Downloads Live2D sample models from the official CubismWebSamples repository.
# These models are provided by Live2D Inc. under the Free Material License Agreement.
# See: https://www.live2d.com/en/terms/live2d-sample-model-terms-of-use/
#
# Usage: bash scripts/download-models.sh

set -euo pipefail

BASE_URL="https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${SCRIPT_DIR}/public/models"
LIB_DIR="${SCRIPT_DIR}/public/lib"

# ── Cubism 4 Core Runtime ──

mkdir -p "$LIB_DIR"
CORE_FILE="${LIB_DIR}/live2dcubismcore.min.js"
if [ ! -f "$CORE_FILE" ]; then
  echo "Downloading Cubism 4 Core runtime..."
  curl -fsSL "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js" -o "$CORE_FILE"
  echo "  ✓ Cubism Core downloaded"
else
  echo "Cubism Core already exists, skipping."
fi

download() {
  local model="$1"
  local file="$2"
  local dir
  dir="$(dirname "${OUT_DIR}/${model}/${file}")"
  mkdir -p "$dir"
  local url="${BASE_URL}/${model}/${file}"
  local dest="${OUT_DIR}/${model}/${file}"
  if [ -f "$dest" ]; then
    return
  fi
  echo "  ↓ ${model}/${file}"
  curl -fsSL "$url" -o "$dest"
}

download_model() {
  local model="$1"
  shift
  echo "Downloading ${model}..."
  for file in "$@"; do
    download "$model" "$file"
  done
  echo "  ✓ ${model} complete"
}

# ── Hiyori (standard female model, Cubism 3) ──

download_model "Hiyori" \
  "Hiyori.model3.json" \
  "Hiyori.moc3" \
  "Hiyori.cdi3.json" \
  "Hiyori.physics3.json" \
  "Hiyori.pose3.json" \
  "Hiyori.userdata3.json" \
  "Hiyori.2048/texture_00.png" \
  "Hiyori.2048/texture_01.png" \
  "motions/Hiyori_m01.motion3.json" \
  "motions/Hiyori_m02.motion3.json" \
  "motions/Hiyori_m03.motion3.json" \
  "motions/Hiyori_m04.motion3.json" \
  "motions/Hiyori_m05.motion3.json" \
  "motions/Hiyori_m06.motion3.json" \
  "motions/Hiyori_m07.motion3.json" \
  "motions/Hiyori_m08.motion3.json" \
  "motions/Hiyori_m09.motion3.json" \
  "motions/Hiyori_m10.motion3.json"

# ── Mark (simple male model, good for learning) ──

download_model "Mark" \
  "Mark.model3.json" \
  "Mark.moc3" \
  "Mark.cdi3.json" \
  "Mark.physics3.json" \
  "Mark.userdata3.json"

# Mark textures + motions — fetch listing dynamically is fragile, so we check
# what's available in the model3.json and download accordingly.
# Mark has Mark.2048/texture_00.png and motions/Mark_m*.motion3.json
for file in "Mark.2048/texture_00.png"; do
  download "Mark" "$file"
done

for i in $(seq -w 1 6); do
  download "Mark" "motions/Mark_m0${i}.motion3.json" 2>/dev/null || true
done

echo ""
echo "Done. Models saved to: ${OUT_DIR}"
echo "Default model: /models/Hiyori/Hiyori.model3.json"
