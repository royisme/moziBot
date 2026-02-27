#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."  # repo root

OUT_DIR="docs/tasks"
PROMPT_FILE="$OUT_DIR/exec-supervisor-qwen-prompt.md"
LOG_FILE="$OUT_DIR/qwen-exec-supervisor.out"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Missing prompt file: $PROMPT_FILE" >&2
  exit 1
fi

echo "Running qwen non-interactive; logging to $LOG_FILE"

nohup qwen \
  --approval-mode yolo \
  --chat-recording=false \
  --output-format text \
  "$(cat "$PROMPT_FILE")" \
  > "$LOG_FILE" 2>&1 &

echo "Started. Tail logs: tail -f $LOG_FILE"
