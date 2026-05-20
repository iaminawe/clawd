---
sidebar_position: 1
title: Overview
description: "Why I migrated off OpenClaw to Claude-native tooling, and what the result looks like."
slug: /00-overview
---

# Overview

This series documents how I tore out [OpenClaw](https://openclaw.ai) (a third-party Claude wrapper) and replaced every piece of it with first-party tools — Claude Code CLI, the Claude Agent SDK, a hand-rolled Slack bot, and Paperclip — while keeping the same persistent "AI familiar" experience.

If you're considering the same move, this is the playbook.

## Why migrate

OpenClaw was a heavyweight gateway that bundled:

- A Slack provider (socket-mode bot)
- A scheduled-task / cron system
- An "embedded agent" runtime that ran Claude on your Max subscription
- A secrets manager
- A skills / agents / workspace abstraction

It worked well — until **Anthropic restricted third-party harnesses from using paid subscriptions for embedded agent calls**. From late April 2026 onward, every embedded run started returning:

```
400 invalid_request_error
"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."
```

even though my Max plan had plenty of headroom. Continuing meant either (a) paying API rates on top of the subscription, or (b) replacing the harness with first-party tools that the subscription supports.

I picked (b).

## Result

Every capability that mattered now runs on standard Anthropic infrastructure:

| Capability                      | OpenClaw (before)                  | Claude-native (after)                                     |
| ------------------------------- | ---------------------------------- | --------------------------------------------------------- |
| Slack bot                       | OpenClaw Slack provider (gateway)  | `@slack/bolt` + `@anthropic-ai/claude-agent-sdk`          |
| Per-thread session memory       | OpenClaw embedded runtime          | Agent SDK `resume:` parameter                             |
| Scheduled tasks (digests, etc.) | OpenClaw cron + heartbeat          | `launchd` + `claude -p` or `paperclip-dispatcher`         |
| Skills (markdown playbooks)     | `~/.openclaw/skills/`              | `~/Work/clawd-workspace/skills/` + Claude Code skills dir |
| Identity / memory               | `~/.openclaw/workspace/SOUL.md` …  | `~/Work/clawd-workspace/CLAUDE.md` + `MEMORY.md`          |
| Secrets retrieval               | OpenClaw's `get-secret` helper     | `bw serve` on `localhost:8087` (unchanged, just re-pathed) |
| Agent orchestration / approvals | OpenClaw → Paperclip via gateway   | Slack bridge → Paperclip API directly                     |

The bot is two distinct Slack apps now (OpenClaw's was paired by setup-token; my new one uses standard bot/app tokens). They co-existed for weeks before I confirmed the new one was the active responder and pulled OpenClaw out.

## What you need

- Mac (this guide is macOS-specific for `launchd` + Keychain)
- Claude Max or Pro subscription (for Claude Code CLI) **and/or** an Anthropic API key (for the Agent SDK)
- A Slack workspace where you can install a custom app
- Vaultwarden (or Bitwarden) — optional but strongly recommended for secrets
- [Paperclip](https://paperclip.ai) — optional, only if you want the orchestration / approval loop
- ~6 hours total

## Reading order

1. **[Overview](./00-overview)** — you are here
2. **[Architecture](./01-architecture)** — the four-layer design and how requests flow
3. **[Building the Slack Bridge](./02-slack-bridge)** — TypeScript bot using `@slack/bolt` + Agent SDK
4. **[Identity and Memory](./03-identity-memory)** — the `clawd-workspace` pattern, persona via `CLAUDE.md`, persistence via `MEMORY.md`
5. **[Scheduled Jobs](./04-scheduled-jobs)** — `launchd` plists, `run-task.sh` (Claude CLI), `paperclip-dispatcher` (Agent SDK)
6. **[Secrets via bw serve](./05-secrets)** — `bw serve` daemon + `get-secret.sh` API
7. **[Paperclip Control Plane](./06-paperclip)** — issues, approvals, board commands from Slack
8. **[Teardown Checklist](./07-teardown)** — exact commands I ran when removing OpenClaw

## Conventions used in this series

- Replace `USERNAME` in example file paths with your own macOS username throughout
- Replace `clawd-workspace` directory name with whatever you call your bot's home
- Slack channel IDs and bot user IDs are unique per-workspace — find yours via `auth.test` or `conversations.list`
- All paths use `~` to mean `$HOME`

## Status of my system after migration

```
launchctl list | grep -E "clawd|paperclip|vaultwarden"

ai.paperclip.run                               # Paperclip control plane
ai.vaultwarden.serve                           # bw serve on :8087
ai.vaultwarden.backup                          # nightly rsync of vault data
net.iaminawe.clawd.slack-bridge                # Slack bot (Agent SDK)
net.iaminawe.clawd.morning-digest              # 06:30 daily
net.iaminawe.clawd.digest-all                  # 09:00 + 18:00 daily
net.iaminawe.clawd.digest-example-tenant-b            # 09:00 + 18:00 daily
net.iaminawe.clawd.digest-example-tenant          # 09:00 + 18:00 daily
net.iaminawe.clawd.digest-example-tenant-a           # 09:00 + 18:00 daily
net.iaminawe.clawd.gmail-triage                # every 30 min
net.iaminawe.clawd.healthcheck                 # every 15 min
net.iaminawe.clawd.board-alerts                # every 30 min
net.iaminawe.clawd.meeting-triage              # 06:00 + 12:00 + 17:00 daily
net.iaminawe.clawd.obsidian-sync               # every 6 hours
net.iaminawe.clawd.supabase-backup             # 03:30 daily
```

Everything is owned by `me`. Nothing depends on a third-party gateway. The subscription works.
