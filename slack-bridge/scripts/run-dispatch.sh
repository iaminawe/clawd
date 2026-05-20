#!/bin/bash
# Wrapper for paperclip-dispatcher: runs a prompt file via Agent SDK
# Usage: run-dispatch.sh <task-name> <prompt-file> [slack-channel]
set -euo pipefail

export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

TASK_NAME="${1:?Usage: run-dispatch.sh <task-name> <prompt-file> [slack-channel]}"
PROMPT_FILE="${2:?Missing prompt file}"
SLACK_CHANNEL="${3:-}"

LOG_DIR="$HOME/Library/Logs/clawd-tasks"
mkdir -p "$LOG_DIR"

echo "$(date -Iseconds) Starting dispatch: $TASK_NAME" >> "$LOG_DIR/$TASK_NAME.log"

PROMPT=$(cat "$PROMPT_FILE")

# Run via dispatcher (uses Agent SDK with MCP servers)
ARGS="run"
if [ -n "$SLACK_CHANNEL" ]; then
  node "$HOME/Work/paperclip-dispatcher/dist/index.js" run "$PROMPT" --channel "$SLACK_CHANNEL" --timeout 180 \
    >> "$LOG_DIR/$TASK_NAME.log" 2>&1
else
  node "$HOME/Work/paperclip-dispatcher/dist/index.js" run "$PROMPT" --timeout 180 \
    >> "$LOG_DIR/$TASK_NAME.log" 2>&1
fi

echo "$(date -Iseconds) Dispatch complete: $TASK_NAME" >> "$LOG_DIR/$TASK_NAME.log"
