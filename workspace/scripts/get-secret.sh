#!/bin/bash
# get-secret.sh — Retrieve a secret from Vaultwarden (Bitwarden)
#
# Lookup order:
#   1. bw serve local API (fastest, no session needed)
#   2. bw CLI with session (from env or session file)
#   3. macOS Keychain (legacy fallback)
#
# Usage:
#   ./get-secret.sh "Cloudflare API Token"
#   SECRET=$(./get-secret.sh "OpenAI API Key")
#
# Env vars:
#   BW_PORT          (default: 8087)        — port bw serve is listening on
#   BW_SESSION_FILE  (default: $HOME/.bw-session) — file holding the unlock session
#   BW_SESSION                                — unlock session, takes precedence over file
#   KEYCHAIN_SERVICE (default: clawd)         — macOS Keychain service prefix used by the fallback

set -u

NAME="${1:-}"
BW_PORT="${BW_PORT:-8087}"
BW_SESSION_FILE="${BW_SESSION_FILE:-$HOME/.bw-session}"
KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-clawd}"

if [ -z "$NAME" ]; then
  echo "Usage: $0 <SECRET_NAME>" >&2
  echo "Examples:" >&2
  echo "  $0 'Cloudflare API Token'" >&2
  echo "  $0 'OpenAI API Key'" >&2
  exit 1
fi

# Method 1: bw serve local API
if curl -s "http://127.0.0.1:${BW_PORT}/status" >/dev/null 2>&1; then
  RESP=$(curl -s "http://127.0.0.1:${BW_PORT}/list/object/items?search=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$NAME")" 2>/dev/null)
  VALUE=$(NAME="$NAME" python3 -c "
import json, os, sys
try:
    data = json.load(sys.stdin)
    target = os.environ['NAME']
    for item in data.get('data', {}).get('data', []):
        if item.get('name') == target and item.get('notes'):
            print(item['notes'])
            break
except Exception:
    pass
" <<< "$RESP" 2>/dev/null)
  if [ -n "$VALUE" ]; then
    echo "$VALUE"
    exit 0
  fi
fi

# Method 2: bw CLI with session
if command -v bw &>/dev/null; then
  SESSION="${BW_SESSION:-}"
  if [ -z "$SESSION" ] && [ -f "$BW_SESSION_FILE" ]; then
    SESSION=$(cat "$BW_SESSION_FILE")
  fi
  if [ -n "$SESSION" ]; then
    VALUE=$(bw get notes "$NAME" --session "$SESSION" 2>/dev/null)
    if [ -n "$VALUE" ]; then
      echo "$VALUE"
      exit 0
    fi
  fi
fi

# Method 3: macOS Keychain fallback
if command -v security &>/dev/null; then
  VALUE=$(security find-generic-password -a "$USER" -s "${KEYCHAIN_SERVICE}-${NAME}" -w 2>/dev/null)
  if [ -n "$VALUE" ]; then
    echo "WARNING: fell back to Keychain for '$NAME'" >&2
    echo "$VALUE"
    exit 0
  fi
fi

echo "Secret not found: $NAME" >&2
exit 1
