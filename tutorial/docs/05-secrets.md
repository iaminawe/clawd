---
sidebar_position: 6
title: Secrets via bw serve
description: "Bitwarden CLI in serve mode on localhost:8087, unlocked from macOS Keychain, queried by get-secret.sh."
slug: /05-secrets
---

# Secrets via bw serve

OpenClaw had its own secret store. The replacement uses **Bitwarden CLI in `serve` mode** running locally on `127.0.0.1:8087`. Every script, skill, and dispatcher fetches secrets via this single endpoint, with macOS Keychain as the unlock source.

The crucial property: agents never see your master password, never write secrets to log files, and never store secrets in environment variables that survive a restart.

## The flow

```
boot → ai.vaultwarden.serve LaunchAgent
         ↓
       start-bw-serve.sh
         ↓
       reads master password from macOS Keychain (service: bw-master-password)
         ↓
       bw unlock --passwordfile ... --raw
         ↓
       saves session to ~/Library/Application Support/clawd/.bw-session  (mode 600)
         ↓
       bw serve --hostname 127.0.0.1 --port 8087  (foreground, KeepAlive=true)
         ↓
       any caller: get-secret.sh "Cloudflare API Token"
                    ↓
                  curl http://127.0.0.1:8087/list/object/items?search=...
                    ↓
                  echoes the value
```

When the daemon is running, no master password is needed for retrieval — the local API is unauthenticated by design (Bitwarden's choice; it binds to localhost). Anyone on your machine with shell access could query it; that's the trade-off for headless agent use.

## Step 1 — Master password into Keychain

```bash
# Add (will prompt for the value, which is hidden)
security add-generic-password -a "$USER" -s "bw-master-password" -w
# Verify
security find-generic-password -a "$USER" -s "bw-master-password" -w
```

The first command creates a Keychain item that's automatically unlocked when you log into your Mac. The `-w` flag prompts for the value without echoing.

## Step 2 — bw login (one-time)

```bash
bw config server https://your-vaultwarden.example.com  # or use bitwarden.com
bw login                                                 # interactive, needs email + password + 2FA
bw login --check                                         # confirms
```

You only do this once per Mac. The login state lives in `~/.config/Bitwarden CLI/`.

## Step 3 — `start-bw-serve.sh`

Save to `~/Work/clawd-workspace/scripts/start-bw-serve.sh`:

```bash
#!/bin/bash
# start-bw-serve.sh — Start Bitwarden CLI API server (bw serve)
# Unlocks vault using master password from macOS Keychain, then starts local API.
# Agents query http://localhost:8087 for secrets.

LOG="$HOME/Library/Logs/clawd/bw-serve.log"
BW_PORT=8087
BW_SESSION_FILE="$HOME/Library/Application Support/clawd/.bw-session"

mkdir -p "$(dirname "$LOG")" "$(dirname "$BW_SESSION_FILE")"
exec >> "$LOG" 2>&1
echo "=== $(date) — Starting bw serve ==="

# Already running? Bail.
if lsof -ti :"$BW_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "bw serve already running on port $BW_PORT"
  exit 0
fi

# Pull master password from keychain into a temp file (handles special chars)
PW_FILE=$(mktemp); chmod 600 "$PW_FILE"
security find-generic-password -a "$USER" -s bw-master-password -w 2>/dev/null \
  | tr -d '\n' > "$PW_FILE"
if [ ! -s "$PW_FILE" ]; then
  rm -f "$PW_FILE"
  echo "ERROR: Master password not found in keychain (service: bw-master-password)"
  exit 1
fi

# Unlock and capture session
BW_SESSION=$(bw unlock --passwordfile "$PW_FILE" --raw 2>/dev/null)
rm -f "$PW_FILE"
if [ -z "$BW_SESSION" ]; then
  echo "ERROR: Failed to unlock vault"
  exit 1
fi

# Save session for direct CLI users
echo "$BW_SESSION" > "$BW_SESSION_FILE"
chmod 600 "$BW_SESSION_FILE"
echo "Session saved to $BW_SESSION_FILE"

export BW_SESSION

echo "Starting bw serve on localhost:$BW_PORT..."
bw serve --hostname 127.0.0.1 --port "$BW_PORT" &
BW_PID=$!
echo "bw serve started (PID $BW_PID)"

# Wait for it to be ready
for i in $(seq 1 10); do
  if curl -s "http://127.0.0.1:$BW_PORT/status" >/dev/null 2>&1; then
    echo "bw serve is ready"; break
  fi
  sleep 1
done

# Stay foreground so launchd's KeepAlive sees it
wait $BW_PID
```

`chmod +x ~/Work/clawd-workspace/scripts/start-bw-serve.sh`.

## Step 4 — LaunchAgent

`~/Library/LaunchAgents/ai.vaultwarden.serve.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.vaultwarden.serve</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/USERNAME/Work/clawd-workspace/scripts/start-bw-serve.sh</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key>
    <string>/Users/USERNAME/Library/Logs/clawd/bw-serve.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/USERNAME/Library/Logs/clawd/bw-serve.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.vaultwarden.serve.plist
launchctl list | grep vaultwarden    # should show a PID
lsof -i :8087 -sTCP:LISTEN           # should show node listening
curl -s http://127.0.0.1:8087/status # should return JSON with status: "Unlocked"
```

## Step 5 — `get-secret.sh`

The universal secret-fetcher. Save to `~/Work/clawd-workspace/scripts/get-secret.sh`:

```bash
#!/bin/bash
# get-secret.sh — Retrieve a secret from Vaultwarden (Bitwarden)
# Tries: bw serve API → bw CLI with session → macOS Keychain fallback
# Usage: ./get-secret.sh "Cloudflare API Token"
#        SECRET=$(./get-secret.sh "OpenAI API Key")

NAME="${1}"
BW_PORT=8087
BW_SESSION_FILE="$HOME/Library/Application Support/clawd/.bw-session"

if [ -z "$NAME" ]; then
  echo "Usage: $0 <SECRET_NAME>" >&2
  exit 1
fi

# Method 1: bw serve local API (no session needed if daemon's unlocked)
if curl -s "http://127.0.0.1:${BW_PORT}/status" >/dev/null 2>&1; then
  RESP=$(curl -s "http://127.0.0.1:${BW_PORT}/list/object/items?search=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$NAME")")
  VALUE=$(NAME="$NAME" python3 -c "
import json, sys, os
name = os.environ['NAME']
try:
    data = json.load(sys.stdin)
    for item in data.get('data', {}).get('data', []):
        if item.get('name') == name and item.get('notes'):
            print(item['notes'])
            break
except: pass
" <<< "$RESP")
  if [ -n "$VALUE" ]; then echo "$VALUE"; exit 0; fi
fi

# Method 2: bw CLI with session
if command -v bw &>/dev/null; then
  SESSION="${BW_SESSION:-}"
  [ -z "$SESSION" ] && [ -f "$BW_SESSION_FILE" ] && SESSION=$(cat "$BW_SESSION_FILE")
  if [ -n "$SESSION" ]; then
    VALUE=$(bw get notes "$NAME" --session "$SESSION" 2>/dev/null)
    [ -n "$VALUE" ] && { echo "$VALUE"; exit 0; }
  fi
fi

# Method 3: Keychain fallback
VALUE=$(security find-generic-password -a "$USER" -s "clawd-${NAME}" -w 2>/dev/null)
if [ -n "$VALUE" ]; then
  echo "WARNING: fell back to keychain for '$NAME'" >&2
  echo "$VALUE"
  exit 0
fi

echo "Secret not found: $NAME" >&2
exit 1
```

`chmod +x ~/Work/clawd-workspace/scripts/get-secret.sh`.

Test:

```bash
~/Work/clawd-workspace/scripts/get-secret.sh "Cloudflare API Token"
```

Should print the value. Anywhere else that needs a secret can do:

```bash
TOKEN=$(~/Work/clawd-workspace/scripts/get-secret.sh "Cloudflare API Token")
curl -H "Authorization: Bearer $TOKEN" ...
```

## Storing secrets

The `notes` field of each Vaultwarden item is the secret value (because Bitwarden's API returns notes in the search response). Create one secure-note item per secret:

- **Name:** "Cloudflare API Token" (this is what you pass to `get-secret.sh`)
- **Notes:** the actual token value
- **Type:** Secure Note

You can do this via the web UI or via CLI:

```bash
ITEM=$(bw get template item | jq '.type=2 | .name="My Secret" | .notes="VALUE_HERE" | .secureNote={type:0}')
echo "$ITEM" | bw encode | bw create item
```

## Sync to repo `.env` files

`sync-env-secrets.sh` reads from Vaultwarden and updates per-project `.env` files. Run after rotating a secret. Skeleton:

```bash
#!/bin/bash
# sync-env-secrets.sh — Sync secrets from Vaultwarden into .env files
set -e

GET_SECRET="$HOME/Work/clawd-workspace/scripts/get-secret.sh"
DRY_RUN=""
[ "$1" = "--dry-run" ] && DRY_RUN=1

update_env() {
  local file="$1" key="$2" vault_name="$3"
  [ ! -f "$file" ] && { echo "  SKIP  $file (not found)"; return; }
  local new_val
  new_val=$("$GET_SECRET" "$vault_name" 2>/dev/null)
  [ -z "$new_val" ] && { echo "  SKIP  $key — not in vault"; return; }
  if ! grep -q "^${key}=" "$file" 2>/dev/null; then
    echo "  SKIP  $key — not in $file"; return
  fi
  local cur_val
  cur_val=$(grep "^${key}=" "$file" | head -1 | sed 's/^[^=]*=//' | sed 's/^"//' | sed 's/"$//')
  [ "$cur_val" = "$new_val" ] && { echo "  OK    $key — already current"; return; }
  if [ -n "$DRY_RUN" ]; then echo "  WOULD UPDATE  $key in $file"
  else
    perl -i -pe "s|^\Q${key}\E=.*|${key}=\"${new_val}\"|" "$file"
    echo "  UPDATED  $key in $file"
  fi
}

# === [your-app] ===
CK="$HOME/Work/[your-app]"
for envfile in "$CK/.env.dev-secrets" "$CK/.env.prod-secrets"; do
  echo "=== $(basename "$envfile") ==="
  update_env "$envfile" "MAPBOX_ACCESS_TOKEN" "Mapbox Access Token"
  update_env "$envfile" "RESEND_API_KEY" "Resend API Key"
  update_env "$envfile" "STRIPE_SECRET_KEY" "Stripe Secret Key ([your-app])"
  echo ""
done

echo "Done. Vault is the source of truth — rotate there, then run this script."
```

## Backup of the Vaultwarden server itself

Separate plist `ai.vaultwarden.backup.plist` runs nightly at 03:00, calling `backup-vaultwarden.sh` which `rsync`s `/var/lib/docker/volumes/<vw-volume>/_data/` from your Vaultwarden host to `~/Backups/vaultwarden/`. Hardlinks against the previous backup for dedup; 30-day retention.

## Security notes

- **`bw serve` is unauthenticated on localhost.** Any process with shell access to your Mac can hit it. Acceptable for personal use; **not** acceptable on a shared box.
- **`.bw-session` lives in `~/Library/Application Support/clawd/`.** Mode 600. Treat backups carefully (the `~/Backups/` rsync target should be on an encrypted volume).
- **Master password rotation.** When you rotate, update the keychain item, then `launchctl kickstart -k gui/$UID/ai.vaultwarden.serve` to force a re-unlock.
- **Network egress.** `bw serve` does NOT mediate access to Vaultwarden — it requires the daemon to have already unlocked, which uses your stored credentials. If your laptop is offline at boot, the daemon will fail and retry until network is available.

## Common gotchas

- **`Unable to refresh login credentials: Invalid refresh token`** — your `bw login` session has expired. Run `bw logout && bw login`, then restart the daemon.
- **`bw serve` crashes immediately** — port 8087 already in use (run `lsof -i :8087`), or master password missing from keychain.
- **`get-secret.sh` returns the wrong value** — you have two items with the same name. Vaultwarden returns the first match. Rename one.
- **Secret returns with trailing newline** — your secret was stored with a newline in the notes field. Strip with `tr -d '\n'`.
- **Tirith / shell-hardening tools blocking writes to `~/.bw-session`** — that's why the new path is `~/Library/Application Support/clawd/.bw-session` instead of a dotfile in `$HOME`.

Next: [Paperclip Control Plane](./06-paperclip) — agent orchestration and the board-approval loop.
