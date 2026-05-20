---
sidebar_position: 8
title: Teardown Checklist
description: "Exact commands to remove OpenClaw cleanly while preserving skills, agents, and dependent infrastructure."
slug: /07-teardown
---

# Teardown Checklist

The exact commands I ran to remove OpenClaw, in order. Reproducible. Each step is reversible until you `rm -rf ~/.openclaw`.

## Pre-flight (don't skip)

### Confirm the new system is responsible

If both OpenClaw and the Slack bridge are running, you don't actually know which one is replying. Stop OpenClaw briefly:

```bash
launchctl bootout gui/$UID/ai.openclaw.gateway
```

Now DM the bot in Slack. If it still answers, the new bridge is the active responder. Bring OpenClaw back up while you do the rest of the prep:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

### Find OpenClaw's tendrils

```bash
# Plists referencing OpenClaw paths (scripts or logs)
grep -l "openclaw" ~/Library/LaunchAgents/*.plist 2>/dev/null

# Source files in your work dirs
grep -rn "\.openclaw\b" ~/Work/ 2>/dev/null | grep -v node_modules | grep -v "\.git/"

# Cron / launchd jobs that depend on its scripts
grep -B1 -A1 "openclaw" ~/Library/LaunchAgents/*.plist 2>/dev/null
```

In my case, **4 unrelated plists** depended on `~/.openclaw/scripts/` or `~/.openclaw/logs/`:

- `ai.vaultwarden.serve` (uses `start-bw-serve.sh`)
- `ai.vaultwarden.backup` (uses `backup-vaultwarden.sh`)
- `dev.honcho.service` (logs only)
- `net.iaminawe.dev-services` (uses `start-dev-services.sh`)

These need to be re-pointed BEFORE you delete `~/.openclaw/`.

## Step 1 — Preserve what matters

```bash
# Skills (markdown playbooks)
rsync -a ~/.openclaw/skills/ ~/Work/clawd-workspace/skills/

# Per-agent session history (optional but cheap to keep)
rsync -a ~/.openclaw/agents/ ~/Work/clawd-workspace/agents-archive/

# Shared scripts
mkdir -p ~/Work/clawd-workspace/scripts
cp -n ~/.openclaw/scripts/* ~/Work/clawd-workspace/scripts/
cp -n ~/.openclaw/workspace/scripts/* ~/Work/clawd-workspace/scripts/
```

Total preserved in my run: 27 skills, 4 agents, 9 scripts.

## Step 2 — Archive secrets

If your Vaultwarden CLI is healthy, archive directly. If not (mine wasn't — refresh token expired), tarball them and add to Vaultwarden manually later:

```bash
mkdir -p ~/Documents/secret-archives
STAGING=$(mktemp -d)
mkdir "$STAGING/paperclip"
cp ~/.openclaw/.env "$STAGING/env.txt"
cp ~/.openclaw/workspace/paperclip-*-api-key.json "$STAGING/paperclip/" 2>/dev/null
cp ~/.openclaw/workspace/paperclip-*-join-request.json "$STAGING/paperclip/" 2>/dev/null
cp ~/.openclaw/credentials/slack-pairing.json "$STAGING/" 2>/dev/null
tar -czf ~/Documents/secret-archives/openclaw-secrets-$(date +%Y-%m-%d).tar.gz -C "$STAGING" .
chmod 600 ~/Documents/secret-archives/openclaw-secrets-*.tar.gz
rm -rf "$STAGING"
```

The archive is mode 600, plain text inside; you have N weeks before you need to think about it again, and the secrets are the only thing irrecoverable from the Vaultwarden vault itself.

## Step 3 — Migrate dependent scripts

```bash
mkdir -p ~/Library/Logs/clawd "$HOME/Library/Application Support/clawd"
```

For each script in `~/Work/clawd-workspace/scripts/` that references `~/.openclaw/`, replace with new paths:

| Old reference                          | New reference                                       |
| -------------------------------------- | --------------------------------------------------- |
| `~/.openclaw/.bw-session`              | `$HOME/Library/Application Support/clawd/.bw-session` |
| `~/.openclaw/logs/<file>`              | `$HOME/Library/Logs/clawd/<file>`                   |
| `~/.openclaw/scripts/<script>`         | `$HOME/Work/clawd-workspace/scripts/<script>`       |
| `~/.openclaw/workspace/scripts/<x>`    | `$HOME/Work/clawd-workspace/scripts/<x>`            |

```bash
# Find them
grep -n "\.openclaw" ~/Work/clawd-workspace/scripts/*

# Edit each one — examples (use whatever editor)
sed -i '' 's|/Users/.*/.openclaw/logs/|$HOME/Library/Logs/clawd/|g' ~/Work/clawd-workspace/scripts/start-bw-serve.sh
# etc.
```

Drop any "openclaw" sections in `sync-env-secrets.sh` (they updated `~/.openclaw/.env` which is about to disappear).

## Step 4 — Re-point dependent plists

For each plist found in the pre-flight (`ai.vaultwarden.serve`, `ai.vaultwarden.backup`, `dev.honcho.service`, `net.iaminawe.dev-services`), edit:

- **`ProgramArguments`** script paths → `~/Work/clawd-workspace/scripts/...`
- **`StandardOutPath` / `StandardErrorPath`** → `~/Library/Logs/clawd/...`

Then reload each:

```bash
for label in ai.vaultwarden.serve ai.vaultwarden.backup dev.honcho.service net.iaminawe.dev-services; do
  echo "=== $label ==="
  launchctl bootout gui/$UID/$label 2>&1
  sleep 1
  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/${label}.plist
done

launchctl list | grep -E "vaultwarden|honcho|dev-services"
```

Verify the bw daemon came back up on the new paths:

```bash
sleep 5
ls -la "$HOME/Library/Application Support/clawd/.bw-session"   # ~89 bytes, fresh
tail ~/Library/Logs/clawd/bw-serve.log                          # should show "bw serve is ready"
lsof -i :8087 -sTCP:LISTEN                                       # listening
~/Work/clawd-workspace/scripts/get-secret.sh "Cloudflare API Token" >/dev/null && echo OK
```

## Step 5 — Tear down OpenClaw services

```bash
# Stop both
launchctl bootout gui/$UID/ai.openclaw.gateway 2>&1
launchctl bootout gui/$UID/ai.openclaw.node 2>&1

# Verify nothing's running
launchctl list | grep openclaw       # empty
pgrep -f "openclaw-gateway"          # empty

# Remove plists
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist
rm -f ~/Library/LaunchAgents/ai.openclaw.node.plist
```

## Step 6 — Clean shell config

Edit `~/.zshrc` (and `~/.bashrc` / `~/.bash_profile` if you use bash):

```diff
-export PATH="/opt/homebrew/bin:$HOME/.local/bin:$HOME/.openclaw/lib/node_modules/.bin:$PATH"
+export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

-# OpenClaw Completion (load after compinit)
-autoload -Uz compinit && compinit
-source "/Users/USERNAME/.openclaw/completions/openclaw.zsh"
```

(Keep `compinit` if you have other completion sources; remove only the OpenClaw ones.)

## Step 7 — Uninstall the package

```bash
npm uninstall -g openclaw
```

Brew users: `brew uninstall openclaw` first if you installed via brew. In my case it was npm.

```bash
which openclaw   # in a fresh shell — should be empty
```

(Your *current* shell will still find it via the `~/.openclaw/lib/.../bin/` path until you `rm -rf` next.)

## Step 8 — Last reference fixes

Check for any code that imports OpenClaw paths inside your custom apps:

```bash
grep -rn "\.openclaw" ~/Work/ 2>/dev/null | grep -v node_modules | grep -v "\.git/" | grep -v "agents-archive/"
```

In my case, `paperclip-dispatcher` had a constant pointing at `~/.openclaw/cron/jobs.json`. Edited to `~/Library/Application Support/clawd/cron/jobs.json` (a path that doesn't exist yet — the dispatcher checks existence and skips). Rebuilt with `npm run build`.

## Step 9 — Nuke

```bash
rm -rf ~/.openclaw
ls ~/.openclaw   # No such file or directory
```

## Step 10 — Verify nothing broke

```bash
launchctl list | grep -E "clawd|paperclip|vaultwarden|honcho|dev-services"
# Expect:
#   ai.paperclip.run                       — running
#   ai.vaultwarden.serve                   — running
#   ai.vaultwarden.backup                  — loaded (fires daily at 03:00)
#   dev.honcho.service                     — running
#   net.iaminawe.dev-services              — loaded
#   net.iaminawe.clawd.slack-bridge        — running
#   net.iaminawe.clawd.morning-digest      — loaded (fires daily at 06:30)
#   ... and the rest of your clawd jobs

# Slack bridge talks to Slack
DM the bot. Should respond within 2-3 seconds.

# Cron secrets retrieval still works
~/Work/clawd-workspace/scripts/get-secret.sh "Cloudflare API Token" >/dev/null && echo OK

# Paperclip is up
curl -s http://127.0.0.1:3100/api/companies | jq 'length'
```

## Rollback (if something breaks badly)

```bash
# Restore OpenClaw from npm (you'll need to re-onboard)
npm install -g openclaw

# Recreate the plists from a backup or from the snapshot you made
# (you DID make a snapshot, right? — see "Pre-teardown snapshot" below)

# Restore secrets from the tarball
tar -xzf ~/Documents/secret-archives/openclaw-secrets-*.tar.gz -C ~/.openclaw/
```

## Pre-teardown snapshot (recommended)

Before doing any of this, save a snapshot:

```bash
mkdir -p <your-archive-dir>/openclaw-teardown-snapshot
cd ~/.openclaw && find . -maxdepth 3 -type d > <your-archive-dir>/openclaw-teardown-snapshot/dir-tree.txt
cp ~/.openclaw/openclaw.json <your-archive-dir>/openclaw-teardown-snapshot/
cp ~/.openclaw/workspace/{AGENTS,IDENTITY,SOUL,USER,TOOLS,SECRETS,HEARTBEAT,BOOTSTRAP}.md \
   <your-archive-dir>/openclaw-teardown-snapshot/ 2>/dev/null
cp ~/.openclaw/workspace/scripts/* <your-archive-dir>/openclaw-teardown-snapshot/ 2>/dev/null
```

That's enough to reconstruct the layout and identity if you need to roll back or document the migration later.

## Time taken (my run)

- Pre-flight + confirmation: **15 min**
- Skill/agent preservation: **2 min**
- Secret archival: **10 min** (would've been 2 if Vaultwarden CLI hadn't gone sideways)
- Script migration: **15 min**
- Plist re-pointing + reload: **10 min**
- OpenClaw teardown + uninstall: **5 min**
- Verification: **10 min**

**Total: about 1 hour 10 min**, with most variability in the secret-archival step.

## What was preserved

After teardown, in `~/Work/clawd-workspace/`:

- 27 skills under `skills/`
- 4 agents under `agents-archive/` (secondary, claude-code, liatrio, main)
- 9 helper scripts under `scripts/`
- The original CLAUDE.md, MEMORY.md, memory/ tree (which were already there)

In `~/Documents/secret-archives/`:

- `openclaw-secrets-YYYY-MM-DD.tar.gz` (mode 600, ~3 KB)

In `<your-archive-dir>/openclaw-teardown-snapshot/`:

- The 8 identity .md files
- `openclaw.json` (the runtime config)
- The 4 helper scripts
- `dir-tree.txt`

## Done

The system is fully on first-party Anthropic tooling. Anthropic's restriction on subscription use through third-party harnesses no longer applies — both the Slack bridge (Agent SDK) and the cron jobs (Claude Code CLI) use the subscription cleanly.

For what to do next, see [Modernization Plan](./08-modernization).
