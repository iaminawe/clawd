#!/bin/bash
# Generic task runner: runs claude CLI with a prompt, optionally posts result to Slack
# Usage: run-task.sh <task-name> <prompt-file> [slack-channel] [cwd]
set -euo pipefail

export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

TASK_NAME="${1:?Usage: run-task.sh <task-name> <prompt-file> [slack-channel] [cwd]}"
PROMPT_FILE="${2:?Missing prompt file}"
SLACK_CHANNEL="${3:-}"
CWD="${4:-$HOME/Work/clawd-workspace}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load env for Slack token
if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a
  source "$SCRIPT_DIR/../.env"
  set +a
fi

LOG_DIR="$HOME/Library/Logs/clawd-tasks"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$TASK_NAME.log"

echo "$(date -Iseconds) Starting task: $TASK_NAME" >> "$LOG_FILE"

# Read prompt (resolve to absolute path before cd)
PROMPT_FILE="$(cd "$(dirname "$PROMPT_FILE")" && pwd)/$(basename "$PROMPT_FILE")"
PROMPT=$(cat "$PROMPT_FILE")

# Change to working directory so claude uses it as context
cd "$CWD" || {
  echo "$(date -Iseconds) Task FAILED: $TASK_NAME — could not cd to $CWD" >> "$LOG_FILE"
  exit 1
}

# Run claude in print mode
RESULT=$(claude -p "$PROMPT" \
  --dangerously-skip-permissions \
  --output-format text \
  2>> "$LOG_FILE") || {
    echo "$(date -Iseconds) Task FAILED: $TASK_NAME" >> "$LOG_FILE"
    exit 1
  }

echo "$(date -Iseconds) Task completed: $TASK_NAME (${#RESULT} chars)" >> "$LOG_FILE"

# Post to Slack if channel specified and result is not empty/silent
if [ -n "$SLACK_CHANNEL" ] && [ -n "$RESULT" ] && ! echo "$RESULT" | grep -q "^HEARTBEAT_OK" && ! echo "$RESULT" | grep -q "^NO_ALERT"; then
  # Truncate if too long for Slack
  if [ ${#RESULT} -gt 3900 ]; then
    RESULT="${RESULT:0:3900}... (truncated)"
  fi

  PAYLOAD=$(_SLACK_CH="$SLACK_CHANNEL" python3 -c "
import json, sys, os
text = sys.stdin.read()
channel = os.environ.get('_SLACK_CH', '')
print(json.dumps({'channel': channel, 'text': text, 'unfurl_links': False}))
" <<< "$RESULT")

  curl -s -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" >> "$LOG_FILE" 2>&1
fi
