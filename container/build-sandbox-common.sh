#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

TARGET_IMAGE="${TARGET_IMAGE:-mozi-sandbox-common:node22}"

docker build -t "$TARGET_IMAGE" -f Dockerfile.sandbox-common .

echo "Built sandbox image: $TARGET_IMAGE"
