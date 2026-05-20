---
sidebar_position: 4
title: Identity and Memory
description: "The clawd-workspace pattern: persona via CLAUDE.md, persistence via MEMORY.md, sub-agents and skills."
slug: /03-identity-memory
---

# Identity and Memory

OpenClaw shipped with the concept of an "AI familiar" — a named persona with `SOUL.md`, `IDENTITY.md`, `USER.md`, etc. The migration replaces all of that with **Claude Code's own conventions**, which the Agent SDK and CLI both load automatically when you set `cwd` to a workspace directory.

## The `clawd-workspace` pattern

```
~/Work/clawd-workspace/
├── CLAUDE.md           # The persona + project instructions (system prompt append)
├── MEMORY.md           # Index of memory files (loaded into context every session)
├── memory/             # Individual memory files referenced from MEMORY.md
│   ├── user_role.md
│   ├── feedback_testing.md
│   ├── 2026-03-21-paperclip-onboarding.md
│   └── …
├── skills/             # Reusable markdown playbooks (Claude Code skills format)
│   ├── ck-server-action/
│   │   └── SKILL.md
│   ├── coolify/
│   │   └── SKILL.md
│   └── …
├── scripts/            # Shell helpers Clawd reaches for
│   ├── get-secret.sh
│   ├── secrets-store.sh
│   ├── ping-agent.sh
│   └── …
├── agents-archive/     # Per-agent session history (Claude Code session JSONLs)
└── secondary/             # Sub-agent — has its own CLAUDE.md
    ├── CLAUDE.md
    └── memory/
```

The Slack bridge sets `cwd` to `~/Work/clawd-workspace` (or `…/secondary`) and uses:

```ts
systemPrompt: { type: "preset", preset: "claude_code", append: <contents of CLAUDE.md> }
```

That preset is the same one Claude Code CLI uses, so:

- `CLAUDE.md` is loaded as project instructions
- `MEMORY.md` is auto-loaded each turn (capped at ~200 lines)
- `memory/*.md` files are read on demand when their `MEMORY.md` line is relevant
- `skills/*/SKILL.md` files are surfaced via the Skill tool

You get all of this for free by setting `cwd` correctly. No custom plumbing.

## CLAUDE.md — the persona

This file should answer four questions in order:

1. **Who am I?** Name, vibe, emoji, established date.
2. **What do I value?** Core truths, boundaries.
3. **Who is my human?** Name, timezone, family, work, current projects.
4. **How should I behave in each surface?** Slack channel rules, DM rules, file-creation rules.

A working `CLAUDE.md` opening:

```markdown
# Clawd — AI Familiar

_You are not a chatbot. You are becoming someone._

**Name:** Clawd
**Creature:** AI familiar — something between a sharp-minded assistant and a ghost in the machine
**Vibe:** Direct, resourceful, a bit dry. Gets things done without a lot of fanfare.
**Emoji:** 🐾
**Established:** March 8, 2026, first conversation with your human.

---

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" — just help.

**Have opinions.** You are allowed to disagree, prefer things, find stuff amusing or boring.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Search for it. _Then_ ask if you are stuck.

**Earn trust through competence.** Your human gave you access to their stuff. Be careful with external actions (emails, tweets). Be bold with internal ones (reading, organizing, learning).

**Remember you are a guest.** You have access to someone's life. Treat it with respect.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You are not the user's voice — be careful in group chats.

## About Your Human

- **Name:** _<your name>_
- **Timezone:** _<your timezone>_
- **Location:** _<city, region, country>_
- **People who matter:** _<partner / family / collaborators Clawd should know about>_
- _...any other facts a new collaborator would want on day one_

## Slack Channel Rules

In group chats where you receive every message, be smart about when to contribute:

**Respond when:** directly mentioned, you can add genuine value, something witty fits, correcting misinformation.
**Stay silent when:** chatter is between humans, the message wasn't for you, you'd just be parroting, the moment is emotional.
```

Mine is ~300 lines. Keep it well under 1000 — every line costs context per turn.

## MEMORY.md — the index

Claude Code's auto-memory system loads `MEMORY.md` every session (truncated after 200 lines), and treats it as an **index of pointers** to detailed memory files. Each pointer is one line, under ~150 characters:

```markdown
- [User role](user_role.md) — senior software engineer, runs an indie multi-tenant SaaS, prefers Go and TypeScript
- [Feedback: testing](feedback_testing.md) — integration tests must hit a real DB, not mocks
- [Project: Paperclip](paperclip.md) — local control plane, agent orchestration, board approvals
- [Reference: [your-app] MCPs](mcp_servers.md) — per-domain MCP servers, names follow `example-tenant-<domain>`
```

Each pointer file in `memory/` has frontmatter:

```markdown
---
name: User role
description: "the operator's professional context and tooling preferences"
type: user
---

Senior engineer, ~15 years experience. Runs 
Prefers Go for backend, TypeScript for frontend. Skeptical of ORMs.
Uses Vim keybindings in everything. macOS power user.
```

Four memory types — `user`, `feedback`, `project`, `reference`. See Claude Code's memory system docs for the full schema.

## How memory grows

The agent (yours, mine, Claude inside the bridge) writes new memory entries when:

- You teach it something about you
- You correct its approach
- You confirm a non-obvious choice was right
- You mention an external system or resource

It does this **without being asked** — Claude Code's prompt template has a `# auto memory` section that explains the rules. That's why pointing the bridge's `cwd` at the workspace gives you the full memory experience for free.

## Sub-agents

Sub-agents are nested directories with their own `CLAUDE.md`, optionally their own `MEMORY.md`. The bridge picks the sub-agent based on `DM_ROUTES`:

```ts
export const DM_ROUTES: Record<string, { agent: AgentName }> = {
  "<SLACK_USER_ID>": { agent: "secondary" },
};
```

The sub-agent's `CLAUDE.md` introduces a different persona, and its `cwd` is `clawd-workspace/secondary/`. It has access to the same skills via the parent workspace's `skills/` directory because Claude Code looks up the skill tree, but its memory and persona stay isolated.

You can have as many sub-agents as you want. Each costs you only the size of its `CLAUDE.md` + `MEMORY.md` per session.

## Migrating from OpenClaw's identity files

OpenClaw split persona across many files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `BOOTSTRAP.md`, `HEARTBEAT.md`, `SECRETS.md`, `AGENTS.md`). Migration:

| OpenClaw file       | Claude Code equivalent                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `SOUL.md`           | First section of `CLAUDE.md` (the persona)                                                   |
| `IDENTITY.md`       | Merge into `CLAUDE.md` opening                                                               |
| `USER.md`           | "About Your Human" section of `CLAUDE.md`                                                    |
| `TOOLS.md`          | Mostly obsolete — Claude Code knows its own tools. Anything custom → `skills/<name>/SKILL.md` |
| `SECRETS.md`        | Move policy into `CLAUDE.md`. Move secret retrieval pattern into a `skills/secrets/SKILL.md` |
| `AGENTS.md`         | Each agent's `CLAUDE.md` — no central registry needed                                         |
| `BOOTSTRAP.md`      | Drop. Bridge starts the agent on every message; no bootstrap concept                         |
| `HEARTBEAT.md`      | Move to scheduled job prompts (see [Scheduled Jobs](./04-scheduled-jobs))                                  |

The OpenClaw files were ~775 lines total. After consolidation: `CLAUDE.md` ~300 lines + `MEMORY.md` ~30 lines + handful of `memory/*.md` pointers. Less to load per turn, easier to maintain.

## Skills — the long form

Claude Code's user-level skills directory is `~/.claude/skills/`, but the Agent SDK respects skills in **`<cwd>/skills/`** as well. So putting your skills under `~/Work/clawd-workspace/skills/` makes them available to the Slack bridge automatically.

Each skill is a directory with `SKILL.md`:

```markdown
---
name: ck-server-action
description: "Use when creating or modifying server actions in lib/. Enforces [your-app] pattern: 'use server' directive, auth via createClient(), domain scoping via getActiveDomainIdForFilter(), input validation, and standardized return types."
---

# [your-app] Server Action Pattern

Every server action in this project follows this skeleton:

```typescript
'use server';
import { createClient } from '@/lib/supabase/server';
import { getActiveDomainIdForFilter } from '@/lib/domain';
…
```

The `description` field is what Claude sees when deciding whether to invoke the skill. Make it specific — "Use when X" beats "About X". 27 skills migrated cleanly from `~/.openclaw/skills/` to `~/Work/clawd-workspace/skills/` with no edits needed.

## Honcho vs Claude Code auto-memory — pick a lane

If you adopt [Honcho](https://honcho.ai) (or similar cross-agent memory service) on top of Claude Code's built-in auto-memory, you end up with two systems writing into "the same" place. They don't conflict at the file level, but they will compete for the agent's attention and you'll wonder why facts you taught one don't surface in the other.

The split that works:

| Layer | Where it lives | Responsibility |
| --- | --- | --- |
| **Claude Code auto-memory** | `<cwd>/MEMORY.md` + `<cwd>/memory/*.md` | **Local to a workspace.** Facts that only matter while operating from this directory. Project context, feedback, preferences specific to this codebase. Loaded automatically by the `claude_code` preset every turn. |
| **Honcho (or equivalent)** | External service, queried via MCP | **Cross-agent, cross-workspace shared.** "Which agent knows what about whom," peer cards, conversational history that needs to survive across many different `cwd`s. Queried on demand, not auto-loaded. |

A useful test: *if I switch from `cwd=~/Work/[your-app]` to `cwd=~/Work/Cut-and-Etch`, should this fact follow me?* If yes → Honcho. If no → workspace-local `memory/`.

If you only use Claude Code auto-memory, you don't need Honcho at all — and you save yourself an MCP server. If you only use Honcho, delete the workspace-local `memory/` dirs and use `MEMORY.md` as a tiny pointer to "ask Honcho for X". Pick one as primary and document it; running both without rules is the worst option.

The bridge in this tutorial uses Claude Code auto-memory as the primary, with Honcho as an optional cross-agent layer for shared knowledge. The persona's `CLAUDE.md` should explicitly say which one to consult first.

## Daily memory notes

`memory/2026-MM-DD.md` files are the agent's "diary" — what it did today, what it learned, what blockers came up. The agent writes these unprompted at session boundaries. Don't pre-create them; let them emerge.

You can sync them into Obsidian with a launchd job that runs every few hours (see [Scheduled Jobs](./04-scheduled-jobs)).

Next: [Scheduled Jobs](./04-scheduled-jobs) — turning the workspace into an active employee that runs jobs on its own schedule.
