---
sidebar_position: 5
title: Scheduled Jobs
description: "launchd plists with run-task.sh (Claude CLI) and run-dispatch.sh (Agent SDK) for digests, alerts, triage."
slug: /04-scheduled-jobs
---

# Scheduled Jobs

OpenClaw had a built-in cron / heartbeat scheduler. The replacement is `launchd` — Mac's native job scheduler — with two thin shell wrappers that handle the Claude side. There is no central daemon to babysit; if a plist is loaded, it runs.

## The two patterns

| Wrapper                | Runtime                           | When to use                                                                                |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `run-task.sh`          | `claude -p` (CLI, headless)       | Anything that doesn't need MCP tools — markdown summaries, alerts, simple bash + LLM jobs. |
| `run-dispatch.sh`      | `paperclip-dispatcher` (Agent SDK) | Anything that fetches data from MCP servers — digests across domains, board-alerts.        |

Both write to Slack via `chat.postMessage` if a channel is supplied. Both skip the post if the prompt returns a sentinel (`HEARTBEAT_OK`, `NO_ALERT`, `NO_REPLY`).

## `run-task.sh` — the simple path

`~/conductor/slack-bridge/scripts/run-task.sh`:

```bash
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

# Load Slack token from bridge's .env
if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a; source "$SCRIPT_DIR/../.env"; set +a
fi

LOG_DIR="$HOME/Library/Logs/clawd-tasks"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$TASK_NAME.log"

echo "$(date -Iseconds) Starting task: $TASK_NAME" >> "$LOG_FILE"

PROMPT_FILE="$(cd "$(dirname "$PROMPT_FILE")" && pwd)/$(basename "$PROMPT_FILE")"
PROMPT=$(cat "$PROMPT_FILE")

cd "$CWD" || { echo "$(date -Iseconds) Task FAILED: $TASK_NAME — could not cd to $CWD" >> "$LOG_FILE"; exit 1; }

RESULT=$(claude -p "$PROMPT" \
  --dangerously-skip-permissions \
  --output-format text \
  2>> "$LOG_FILE") || {
    echo "$(date -Iseconds) Task FAILED: $TASK_NAME" >> "$LOG_FILE"
    exit 1
  }

echo "$(date -Iseconds) Task completed: $TASK_NAME (${#RESULT} chars)" >> "$LOG_FILE"

# Post to Slack unless empty or sentinel
if [ -n "$SLACK_CHANNEL" ] && [ -n "$RESULT" ] \
    && ! echo "$RESULT" | grep -q "^HEARTBEAT_OK" \
    && ! echo "$RESULT" | grep -q "^NO_ALERT"; then
  if [ ${#RESULT} -gt 3900 ]; then RESULT="${RESULT:0:3900}... (truncated)"; fi

  PAYLOAD=$(_SLACK_CH="$SLACK_CHANNEL" python3 -c "
import json, sys, os
text = sys.stdin.read()
print(json.dumps({'channel': os.environ['_SLACK_CH'], 'text': text, 'unfurl_links': False}))
" <<< "$RESULT")

  curl -s -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" >> "$LOG_FILE" 2>&1
fi
```

Why this wrapper exists:

- **`cwd` isolation** — every job runs from `~/Work/clawd-workspace` (or a job-specific dir) so Claude loads the right CLAUDE.md / MEMORY.md / skills.
- **Sentinel-based silence** — sometimes a job correctly produces no output (no alerts to send, no triage needed). The prompt can `echo "NO_ALERT"` and the wrapper skips the Slack post.
- **Truncation** — Slack caps messages at 4000 chars; we cap at 3900 with an ellipsis.
- **One log file per task** under `~/Library/Logs/clawd-tasks/<task>.log` so you can `tail -f` any one job without noise from others.

## `run-dispatch.sh` — Agent SDK path

`~/conductor/slack-bridge/scripts/run-dispatch.sh`:

```bash
#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

TASK_NAME="${1:?Usage: run-dispatch.sh <task-name> <prompt-file> [slack-channel]}"
PROMPT_FILE="${2:?Missing prompt file}"
SLACK_CHANNEL="${3:-}"

LOG_DIR="$HOME/Library/Logs/clawd-tasks"
mkdir -p "$LOG_DIR"
echo "$(date -Iseconds) Starting dispatch: $TASK_NAME" >> "$LOG_DIR/$TASK_NAME.log"

PROMPT=$(cat "$PROMPT_FILE")

if [ -n "$SLACK_CHANNEL" ]; then
  node "$HOME/Work/paperclip-dispatcher/dist/index.js" run "$PROMPT" \
    --channel "$SLACK_CHANNEL" --timeout 180 \
    >> "$LOG_DIR/$TASK_NAME.log" 2>&1
else
  node "$HOME/Work/paperclip-dispatcher/dist/index.js" run "$PROMPT" \
    --timeout 180 \
    >> "$LOG_DIR/$TASK_NAME.log" 2>&1
fi

echo "$(date -Iseconds) Dispatch complete: $TASK_NAME" >> "$LOG_DIR/$TASK_NAME.log"
```

`paperclip-dispatcher` is a small Node app that:

1. Loads the prompt
2. Calls `query()` from `@anthropic-ai/claude-agent-sdk` with full MCP server access
3. Streams the result
4. Posts to Slack via `chat.postMessage`

Skeleton (`~/Work/paperclip-dispatcher/src/index.ts`):

```ts
#!/usr/bin/env node
import { query } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const LOG_DIR = join(process.env.HOME ?? "/tmp", "Library/Logs/paperclip-dispatcher");
const SILENT = new Set(["HEARTBEAT_OK", "NO_ALERT", "NO_REPLY"]);

async function postToSlack(channel: string, text: string) {
  if (!SLACK_BOT_TOKEN) return;
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text: text.slice(0, 3900), unfurl_links: false }),
  });
}

async function runOnce(prompt: string, channel?: string, timeoutSec = 180) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
  let lastText = "";
  try {
    const result = query({
      prompt,
      options: {
        cwd: process.env.HOME + "/Work/clawd-workspace",
        permissionMode: "bypassPermissions",
        maxTurns: 25,
        abortController: ctrl,
      },
    });
    for await (const m of result) {
      if (m.type === "assistant" && m.message?.content) {
        let t = "";
        for (const b of m.message.content) if ("text" in b && b.text) t += b.text;
        if (t.trim()) lastText = t;
      }
    }
    if (channel && lastText && ![...SILENT].some(s => lastText.startsWith(s))) {
      await postToSlack(channel, lastText);
    }
  } finally { clearTimeout(t); }
}

// CLI dispatch
const [, , subcmd, ...args] = process.argv;
if (subcmd === "run") {
  const prompt = args[0];
  const ch = args.includes("--channel") ? args[args.indexOf("--channel") + 1] : undefined;
  const to = args.includes("--timeout") ? Number(args[args.indexOf("--timeout") + 1]) : 180;
  await runOnce(prompt, ch, to);
}
```

Build with `npm run build` and you're done. The launchd plist points at `dist/index.js`.

## Anatomy of a launchd plist

`~/Library/LaunchAgents/net.iaminawe.clawd.morning-digest.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>net.iaminawe.clawd.morning-digest</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/USERNAME/conductor/slack-bridge/scripts/run-task.sh</string>
    <string>morning-digest</string>
    <string>/Users/USERNAME/conductor/slack-bridge/prompts/morning-digest.md</string>
    <string>C0AMZMZEA3G</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>6</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/USERNAME/Library/Logs/clawd-tasks/morning-digest.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/USERNAME/Library/Logs/clawd-tasks/morning-digest.stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/USERNAME</string>
  </dict>
</dict>
</plist>
```

Key bits:

- **`StartCalendarInterval` (single dict)** — fires once a day at 06:30
- **Multiple times in one plist** — pass an `<array>` of dicts:

  ```xml
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  ```

- **Interval-based**:

  ```xml
  <key>StartInterval</key><integer>1800</integer>   <!-- every 30 min -->
  ```

- **`HOME` env var matters** — without it, `~` expansions break in the wrapper script.
- **`PATH` env var** — launchd has a minimal PATH; without this, `bw`, `claude`, `node` won't be found.

## The standard prompt format

Each prompt is a markdown file in `~/conductor/slack-bridge/prompts/`. Pattern:

```markdown
# Morning Digest

You are Clawd, running an automated morning briefing for your human.

It's currently {{ date }}. Read these inputs and produce a 5-bullet summary:

1. Pending Paperclip approvals (use the `paperclip` MCP server, query `list_approvals status=pending`)
2. Today's calendar events (use the `Google_Calendar` MCP server)
3. Unread VIP emails (use the `Gmail` MCP server, search `from:VIP-LIST is:unread`)
4. Overnight [your-app] deploy status (read latest `example-tenant-platform` MCP `get_dashboard_stats`)
5. Weather (Vancouver) — fetch via WebFetch

Output format:
- Lead with one short headline ("Today: …")
- Then 5 bullets, each ≤ 100 chars
- If nothing to report in a category, omit the bullet (don't say "no events")
- If everything is fine and there's nothing actionable, just output `NO_ALERT`

Don't ask questions. Don't include "I'll do X" — just produce the digest.
```

Note the `NO_ALERT` sentinel: if there's truly nothing worth saying, the wrapper skips Slack entirely.

## Loading + reloading

```bash
# load
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/net.iaminawe.clawd.morning-digest.plist

# unload (and remove from launchd)
launchctl bootout gui/$UID/net.iaminawe.clawd.morning-digest

# reload after editing the plist
launchctl bootout gui/$UID/net.iaminawe.clawd.morning-digest && \
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/net.iaminawe.clawd.morning-digest.plist

# check what's loaded
launchctl list | grep clawd

# trigger immediately for testing
launchctl kickstart gui/$UID/net.iaminawe.clawd.morning-digest
```

## My active jobs (for reference)

| Plist                                    | Schedule              | Wrapper            | Purpose                          |
| ---------------------------------------- | --------------------- | ------------------ | -------------------------------- |
| `net.iaminawe.clawd.morning-digest`      | 06:30 daily           | `run-task.sh`      | Morning briefing in #general     |
| `net.iaminawe.clawd.digest-all`          | 09:00 + 18:00 daily   | `run-dispatch.sh`  | Cross-business roundup           |
| `net.iaminawe.clawd.digest-example-tenant-b`    | 09:00 + 18:00 daily   | `run-dispatch.sh`  | [example-tenant-b] metrics → #example-tenant-b   |
| `net.iaminawe.clawd.digest-example-tenant`  | 09:00 + 18:00 daily   | `run-dispatch.sh`  | [your-app] metrics              |
| `net.iaminawe.clawd.digest-example-tenant-a`   | 09:00 + 18:00 daily   | `run-dispatch.sh`  | [example-tenant-a] sales/orders          |
| `net.iaminawe.clawd.gmail-triage`        | every 30 min          | `run-task.sh`      | Triage VIP unread, post to #board |
| `net.iaminawe.clawd.healthcheck`         | every 15 min          | `run-task.sh`      | Ping all production URLs         |
| `net.iaminawe.clawd.board-alerts`        | every 30 min          | `run-dispatch.sh`  | Surface new Paperclip approvals  |
| `net.iaminawe.clawd.meeting-triage`      | 06:00 + 12:00 + 17:00 | `run-task.sh`      | Pre/post-meeting summary         |
| `net.iaminawe.clawd.obsidian-sync`       | every 6 hours         | `run-task.sh`      | Sync workspace memory → Obsidian |
| `net.iaminawe.clawd.supabase-backup`     | 03:30 daily           | `run-task.sh`      | Trigger DB backup                |

## Adding a new job (3-step recipe)

1. **Write the prompt** at `~/conductor/slack-bridge/prompts/<job-name>.md`. Include the `NO_ALERT` sentinel rule.
2. **Copy an existing plist** under `~/Library/LaunchAgents/net.iaminawe.clawd.*.plist`, edit the Label, `<string>job-name</string>` arg, prompt path, channel ID, schedule.
3. **Load it**: `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/net.iaminawe.clawd.<job-name>.plist`

Test immediately with `launchctl kickstart` and tail `~/Library/Logs/clawd-tasks/<job-name>.log`.

## Common gotchas

- **`Posix spawn` errors** — your `ProgramArguments` script doesn't have `+x` permission. `chmod +x ~/conductor/slack-bridge/scripts/*.sh`.
- **Job runs but produces nothing in Slack** — check the log. Either Claude returned the sentinel, or `SLACK_BOT_TOKEN` isn't loaded (the bridge's `.env` is the source).
- **Job runs every minute instead of once** — `KeepAlive: true` + missing `StartCalendarInterval` makes launchd treat it as a long-running daemon. Use `KeepAlive: false` for cron-style jobs.
- **Time zone** — `StartCalendarInterval` uses **system local time** (yours), not UTC. If you travel, schedules shift.
- **Console.app spam** — every plist load logs. To silence verbose stdout, set `StandardOutPath` to `/dev/null` (you'll still see app-level errors via the app's own logger).

Next: [Secrets via bw serve](./05-secrets) — the secret-retrieval daemon every job and skill depends on.
