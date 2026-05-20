#!/bin/bash
# start-bw-serve.sh — Start the Bitwarden CLI API server (`bw serve`)
#
# Unlocks the vault using a master password read from macOS Keychain, then
# binds `bw serve` to localhost. Scripts (and the Slack bridge) query
# http://127.0.0.1:$BW_PORT/ for secrets.
#
# Typical install: run from a LaunchAgent on boot, or invoke manually.
#
# Env vars:
#   BW_PORT            (default: 8087)
#   BW_SESSION_FILE    (default: $HOME/.bw-session)
#   KEYCHAIN_ACCOUNT   (default: $USER)               — Keychain account name
#   KEYCHAIN_PW_SERVICE (default: bw-master-password) — Keychain service name
#                                                       holding the vault master password
#   LOG_FILE           (default: $HOME/Library/Logs/clawd-bw-serve.log on macOS,
#                                $HOME/.cache/clawd/bw-serve.log elsewhere)
#
# Prerequisites: `brew install bitwarden-cli` (or equivalent), then run
# `bw login` once interactively and store the master password in Keychain
# with: `security add-generic-password -a "$USER" -s "bw-master-password" -w`

set -u

BW_PORT="${BW_PORT:-8087}"
BW_SESSION_FILE="${BW_SESSION_FILE:-$HOME/.bw-session}"
KEYCHAIN_ACCOUNT="${KEYCHAIN_ACCOUNT:-$USER}"
KEYCHAIN_PW_SERVICE="${KEYCHAIN_PW_SERVICE:-bw-master-password}"

if [ -z "${LOG_FILE:-}" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    LOG_FILE="$HOME/Library/Logs/clawd-bw-serve.log"
  else
    LOG_FILE="$HOME/.cache/clawd/bw-serve.log"
  fi
fi
mkdir -p "$(dirname "$LOG_FILE")"
exec >> "$LOG_FILE" 2>&1
echo "=== $(date) — Starting bw serve ==="

if ! command -v bw >/dev/null 2>&1; then
  echo "ERROR: bw CLI not found in PATH. Install Bitwarden CLI first."
  exit 1
fi

# Already running?
if lsof -ti :"$BW_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "bw serve already running on port $BW_PORT"
  exit 0
fi

# Read master password from Keychain into a temp file (handles special chars)
if ! command -v security >/dev/null 2>&1; then
  echo "ERROR: this script reads the master password from macOS Keychain (security(1))."
  echo "       Adapt to your platform's secret store or set BW_MASTER_PASSWORD via a"
  echo "       different mechanism."
  exit 1
fi

PW_FILE=$(mktemp)
chmod 600 "$PW_FILE"
security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_PW_SERVICE" -w 2>/dev/null \
  | tr -d '\n' > "$PW_FILE"
if [ ! -s "$PW_FILE" ]; then
  rm -f "$PW_FILE"
  echo "ERROR: master password not found in Keychain"
  echo "       account: $KEYCHAIN_ACCOUNT  service: $KEYCHAIN_PW_SERVICE"
  exit 1
fi

BW_SESSION=$(bw unlock --passwordfile "$PW_FILE" --raw 2>/dev/null)
rm -f "$PW_FILE"

if [ -z "$BW_SESSION" ]; then
  echo "ERROR: failed to unlock vault"
  exit 1
fi

# Persist session so get-secret.sh and other CLI users can find it
echo "$BW_SESSION" > "$BW_SESSION_FILE"
chmod 600 "$BW_SESSION_FILE"
echo "Session saved to $BW_SESSION_FILE"

export BW_SESSION

echo "Starting bw serve on 127.0.0.1:$BW_PORT..."
bw serve --hostname 127.0.0.1 --port "$BW_PORT" &
BW_PID=$!
echo "bw serve started (PID $BW_PID)"

# Wait for readiness
for _ in $(seq 1 10); do
  if curl -s "http://127.0.0.1:$BW_PORT/status" >/dev/null 2>&1; then
    echo "bw serve is ready"
    break
  fi
  sleep 1
done

# Keep running in foreground (LaunchAgent / systemd will keep-alive)
wait $BW_PID
