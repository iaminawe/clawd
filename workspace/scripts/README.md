# workspace/scripts

Reusable helper scripts for the Clawd workspace. These two cover the secret-retrieval pattern that the rest of the stack assumes; everything else (`launchd` plists, backup jobs, per-tenant dispatchers) is install-specific and lives outside this repo.

## Scripts

### `start-bw-serve.sh`

Boots the Bitwarden CLI in API server mode (`bw serve`) bound to `127.0.0.1:$BW_PORT`. Unlocks the vault using a master password read from the OS keystore. Wire into `launchd` (macOS) or `systemd` (Linux) to keep it always-on.

### `get-secret.sh`

Reads a single secret from the vault by name. Tries `bw serve` first, falls back to `bw` CLI with a saved session, then to the macOS Keychain. Returns the secret on stdout.

```bash
SECRET=$(./get-secret.sh "Cloudflare API Token")
```

## Configuration

Both scripts are env-driven — no hardcoded paths or accounts. Override any of:

| Var | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `BW_PORT` | `8087` | both | port `bw serve` listens on |
| `BW_SESSION_FILE` | `$HOME/.bw-session` | both | path where the unlock session is persisted |
| `BW_SESSION` | _(unset)_ | `get-secret.sh` | session string, takes precedence over `BW_SESSION_FILE` |
| `KEYCHAIN_ACCOUNT` | `$USER` | `start-bw-serve.sh` | macOS Keychain account to read master password from |
| `KEYCHAIN_PW_SERVICE` | `bw-master-password` | `start-bw-serve.sh` | macOS Keychain service name for the master password |
| `KEYCHAIN_SERVICE` | `clawd` | `get-secret.sh` | prefix for legacy Keychain fallback (`<service>-<name>`) |
| `LOG_FILE` | platform default | `start-bw-serve.sh` | where to append start/health logs |

## Setup (macOS)

```bash
# 1. Install Bitwarden CLI
brew install bitwarden-cli

# 2. Log in to your vault (interactive, one-time)
bw login

# 3. Store the master password in Keychain
security add-generic-password -a "$USER" -s "bw-master-password" -w

# 4. Boot bw serve
./start-bw-serve.sh

# 5. Verify
./get-secret.sh "Some Secret Name"
```

## Calling from the Slack bridge / scheduled jobs

Anywhere a secret is needed, shell out to `get-secret.sh` instead of baking it into `.env`:

```bash
export STRIPE_KEY="$(/path/to/workspace/scripts/get-secret.sh 'Stripe Secret Key')"
```

Or call the HTTP API directly:

```bash
curl -s "http://127.0.0.1:8087/object/notes/Stripe%20Secret%20Key" | jq -r '.data.value'
```
