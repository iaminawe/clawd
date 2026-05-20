#!/bin/bash
# Start the Clawd Slack bridge
set -euo pipefail

export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."

# Load environment
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

exec node dist/index.js
