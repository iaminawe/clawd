---
sidebar_position: 2
title: Architecture
description: "The four-layer design — Slack interface, Clawd identity, scheduled jobs, Paperclip control plane."
slug: /01-architecture
---

# Architecture

The replacement is four loosely-coupled layers. Each can be built and tested independently.

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1 — Slack interface                                      │
│  ~/conductor/slack-bridge   (Bolt + Agent SDK, Socket Mode)     │
└─────────────────────────────────────────────────────────────────┘
        │
        │ routes to named agent ("main" / "secondary" / …)
        │ resumes per-thread session via Agent SDK
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2 — The "Clawd" identity                                 │
│  ~/Work/clawd-workspace                                         │
│    ├── CLAUDE.md          (system prompt — persona, rules)      │
│    ├── MEMORY.md          (long-term memory)                    │
│    ├── memory/            (daily notes)                         │
│    ├── skills/            (markdown playbooks, 27 of them)      │
│    ├── scripts/           (bw helpers, dev-services, etc.)      │
│    ├── agents-archive/    (per-agent session history)           │
│    └── secondary/            (sub-agent with own CLAUDE.md)        │
└─────────────────────────────────────────────────────────────────┘
        │                                    ▲
        │ MCP tool calls                     │ board-command webhook
        ▼                                    │
┌──────────────────────────────────┐  ┌──────────────────────────┐
│  LAYER 3 — Paperclip            │  │  LAYER 4 — Scheduled     │
│  control plane (:3100)          │  │  jobs (launchd plists)   │
│    issues, approvals,           │  │    digest-*              │
│    cron agents, heartbeat       │  │    gmail-triage          │
│  embedded postgres :54329       │  │    board-alerts          │
└──────────────────────────────────┘  │    healthcheck           │
                                      │  → run-task.sh           │
                                      │    or paperclip-         │
                                      │      dispatcher          │
                                      └──────────────────────────┘
                                                │
                                                ▼
                                        Posts to Slack via curl
                                        or Agent SDK delivery

┌─────────────────────────────────────────────────────────────────┐
│  CROSSCUTTING — Secrets                                         │
│  bw serve on 127.0.0.1:8087   (Bitwarden CLI, daemonised)       │
│  ~/Work/clawd-workspace/scripts/get-secret.sh "<vault item>"    │
└─────────────────────────────────────────────────────────────────┘
```

## Layer 1 — Slack interface

A standalone Node service (`~/conductor/slack-bridge/`) that:

- Connects to Slack via Socket Mode (`@slack/bolt`)
- Listens to channel messages + DMs
- For each message, picks an **agent** (via channel-routing table or DM map) and calls the **Agent SDK** with `cwd` set to that agent's workspace and `systemPrompt` loaded from its `CLAUDE.md`
- Streams the assistant's text back into Slack with throttled `chat.update` calls
- Persists a **Slack thread → Agent SDK session_id** mapping so replies in the same thread continue the same conversation
- Handles **board commands** (`approve PAP-39 looks good`) by POSTing to Paperclip's API directly, no LLM call needed

Concurrency: 4 active sessions, queue of 10. Per-query timeout: 5 minutes. Partial responses on timeout, not errors.

Built in [Building the Slack Bridge](./02-slack-bridge).

## Layer 2 — Clawd identity

`~/Work/clawd-workspace/` is the **cwd** every `claude -p` and Agent SDK call gets pointed at. Anthropic's tools then auto-load:

- `CLAUDE.md` as project instructions (persona, boundaries, channel rules)
- `MEMORY.md` as the persistent memory entry point (a small index)
- `memory/*.md` as individual memory files (Claude Code's auto-memory format)
- `skills/<name>/SKILL.md` as user-level skills the agent can invoke

Sub-agents (e.g. the sub-agent) live in subdirectories with their own `CLAUDE.md`. The Slack bridge picks which one to use based on routing.

Built in [Identity and Memory](./03-identity-memory).

## Layer 3 — Scheduled jobs

A series of `launchd` user agents under `~/Library/LaunchAgents/net.iaminawe.clawd.*.plist`. Each runs one of two wrapper scripts:

- **`run-task.sh`** — the simple path. Calls `claude -p "$PROMPT" --dangerously-skip-permissions --output-format text` from inside `~/Work/clawd-workspace`. Captures stdout, posts to Slack via `chat.postMessage` if a channel was supplied. Skips the post if the prompt returns sentinel strings (`HEARTBEAT_OK`, `NO_ALERT`).

- **`run-dispatch.sh`** — the Agent SDK path. Calls `paperclip-dispatcher run "$PROMPT" --channel <ch>`. Same behaviour but uses Agent SDK with full MCP tool access — needed for jobs that have to fetch data from MCP servers (Paperclip MCPs, [your-app] MCPs).

Each plist references a markdown prompt file from `~/conductor/slack-bridge/prompts/`.

Built in [Scheduled Jobs](./04-scheduled-jobs).

## Layer 4 — Paperclip control plane

Optional but highly useful. Local daemon on `:3100` with embedded postgres on `:54329`. Tracks:

- Companies ([example-tenant-a], [your-app], …)
- Agents (engineering-lead, manager, qa, …) with org-chart relationships
- Issues with statuses, assignees, comments
- Heartbeat schedule per agent (cron-like)
- Approval queue — agents call `await board.approve(thing)` and execution pauses until you approve via Slack command

The Slack bridge **only talks to Paperclip** for board commands. Agents themselves call MCP tools to read/write Paperclip data; you don't need a custom integration in the bridge.

Covered in [Paperclip Control Plane](./06-paperclip).

## Crosscutting — Secrets

Started with the assumption that everything would query [Vaultwarden](https://github.com/dani-garcia/vaultwarden). The actual flow:

1. macOS Keychain stores the Vaultwarden master password
2. `start-bw-serve.sh` (run by `ai.vaultwarden.serve` plist on boot):
   - Reads the master password from keychain
   - Runs `bw unlock --passwordfile <tmp> --raw`
   - Saves the session string to `~/Library/Application Support/clawd/.bw-session`
   - Starts `bw serve --hostname 127.0.0.1 --port 8087` in the foreground (so launchd keeps it alive)
3. Any caller wanting a secret runs `~/Work/clawd-workspace/scripts/get-secret.sh "Cloudflare API Token"` which:
   - Tries the local API first (no session needed once bw serve is running)
   - Falls back to the saved CLI session
   - Falls back to keychain (legacy)

The `sync-env-secrets.sh` script keeps repo-local `.env` files in sync with the vault.

Built in [Secrets via bw serve](./05-secrets).

## Why this layering

OpenClaw bundled all of this. The bundling was its strength (single `brew install`) and its weakness (one rejected LLM call broke the Slack bot, the digest jobs, the board notifier — everything). Splitting them means:

- Slack bridge can be redeployed without touching jobs
- Adding a new digest is two files (a prompt and a plist), no service restart
- Secrets daemon is independent and survives any agent change
- Paperclip is replaceable with another orchestrator (or removed entirely)
- `claude -p` and Agent SDK both work — pick per job based on whether you need MCP

Trade-off: more moving parts. If the Slack bot dies you don't get a notification — you have to notice replies stopping, or check `launchctl list`. Add a heartbeat job that pings each plist (covered in `04 - Scheduled Jobs`).
