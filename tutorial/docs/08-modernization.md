---
sidebar_position: 9
title: Modernization Plan
description: "What's shipped since the original migration, what's still on the backlog, and the integration gaps that surfaced from running it for real."
slug: /08-modernization
---

# Modernization Plan

The original post-OpenClaw stack used the SDK as it existed in early April 2026. This file tracks what's been adopted since, what's still pending, and the integration gaps that only became visible after running the stack for a few months.

> Source: re-audited 2026-05-19 against the live bridge (`~/conductor/slack-bridge/src/`) and dispatcher (`~/Work/paperclip-dispatcher/src/`).

## Shipped (already live)

| Item | Where | Notes |
| --- | --- | --- |
| **Tool Search + Programmatic Tool Calling** | `slack-bridge/src/session-manager.ts:30` | `betas: ["advanced-tool-use-2025-11-20"]`. Paperclip is `alwaysLoad: true`; per-domain [your-app] MCPs are deferred behind Tool Search and only attached when the channel maps to a tenant. |
| **`taskBudget` in dispatcher** | `paperclip-dispatcher/src/agent-options.ts` | Split-budget (input + output) folded into the SDK's `taskBudget.total`. Defaults from `TASK_BUDGET_INPUT`/`TASK_BUDGET_OUTPUT` env. Budget-exceeded detected via `terminal_reason === "blocking_limit"` or `stop_reason === "max_tokens"`. |
| **Supabase `sessionStore` adapter** | `slack-bridge/src/session-store-supabase.ts` + `migrations/0001_slack_bridge_sessions.sql` | Soft-fails on outage so the bridge stays startable when Supabase is unreachable. |
| **Deterministic thread → session ID** | `slack-bridge/src/session-manager.ts:84` | SHA-256 of `<channelId>:<threadTs>` → UUID-format. Replaces the old in-memory `Map`; threads survive bridge restarts and don't need the old `resume:` field. |
| **`excludeDynamicSections`** | `slack-bridge/src/session-manager.ts:391` | Keeps the cached system-prompt prefix actually static. Dynamic parts (cwd, auto-memory path, git status) are re-injected as the first user message instead of poisoning the cache prefix. |
| **Cache-aware system-prompt assembly** | `slack-bridge/src/session-manager.ts:356` | Static blocks concatenated into the preset's `append: string`; dynamic blocks routed to the user prompt. Platform applies its own TTL to the preset prefix. |
| **Per-channel tenant domain override** | `slack-bridge/src/session-manager.ts:177` | `buildMcpServers()` reads `~/.claude/settings.json` MCP transports, overrides `CONVERGEKIT_DOMAIN_ID` env per-message based on channel → domain mapping. Same transport script, different tenant. |
| **`startup()` pre-warm** | `slack-bridge/src/index.ts:235` | Pre-warms the SDK runtime after `app.start()` so the first Slack message doesn't pay cold-start. Logs elapsed ms; soft-fails on error. |
| **`strictMcpConfig` for the sub-agent** | `slack-bridge/src/config.ts` + `session-manager.ts` | Per-agent MCP allowlist via `AgentConfig.allowedMcpServers`. the sub-agent = `["paperclip"]` only + `strictMcp: true` so she can't inherit anything from `~/.claude/settings.json`. |
| **Per-thread cost cap** | `slack-bridge/src/config.ts` + `session-manager.ts` | `PER_THREAD_TOKEN_CAP` (env-overridable, default 5M) caps cumulative tokens per Slack thread since bridge boot. Captures usage from each `result` message; rejects new queries on capped threads with a friendly "start a new thread" reply. |
| **Sandbox in dispatcher** | `paperclip-dispatcher/src/agent-options.ts` | `sandbox: { enabled: true, failIfUnavailable: false }` is now the default for every cron agent run. macOS Seatbelt filesystem jail + proxied network. Override per-run with `PAPERCLIP_SANDBOX=0`. |

## Still on the backlog

### 1. Memory Tool (`context-management-2025-06-27`)

**Why it matters:** `main` and `secondary` personas accumulate facts only when *you* edit `MEMORY.md`, or via Honcho if you opt in. There's no client-side memory tool wired into the SDK call, so cross-thread learning isn't automatic.

**Fix:** add the memory tool with `betas: ["context-management-2025-06-27"]` and per-agent dirs:

- `~/Work/clawd-workspace/memory/main/`
- `~/Work/clawd-workspace/secondary/memory/`

Storage is client-side. Note: this overlaps with Honcho — pick one as the primary or split responsibilities explicitly (see *Honcho vs auto-memory* in [Identity and Memory](./03-identity-memory)).

**Source:** [https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool)

**Effort:** ~3h

### 2. `/goal` for drain-the-queue jobs

**Why it matters:** `gmail-triage` and `board-alerts` are "run once" today. A drain pattern ("keep going until the queue is empty") would let them clear backlogs in one launchd tick instead of waiting 30 min for the next one.

**Effort:** ~2h

### 3. Worktree isolation main ↔ secondary

**Status:** prototyped in `paperclip-dispatcher/src/worktree-dispatch.ts` but not yet wired into the bridge for the two interactive agents.

**Why it matters:** today both agents run in subdirs of the same workspace; if one touches a file the other is reading, results are undefined. Worktrees fix that without splitting repos.

**Effort:** ~2h to wire into bridge

### 4. Hook event streaming into Slack (`includeHookEvents: true`)

Renders PreToolUse / PostToolUse as collapsible Slack blocks ("🔧 Read paperclip://issue/PAP-39 …") so the user sees what the agent is doing in real time.

**Effort:** ~4h

### 5. OTEL trace propagation

Slack message → bridge → SDK → MCP → Paperclip → [your-app] MCP has no shared trace ID. SDK 0.2.113+ propagates spans; `agent_id` / `parent_agent_id` headers (Code 2.1.139+) let you attribute spend.

**Effort:** ~6h

### 6. Plugins / marketplaces — package the skills

Drop a `.claude-plugin/marketplace.json` at the root of `~/Work/clawd-workspace`. Get version pinning, the `/plugin` UI, and root-level `SKILL.md` surfaced as a skill.

**Effort:** ~3h

## Integration gaps surfaced by running the stack

These weren't on the original modernization plan but became visible after months of real use.

### 7. PR descriptions don't reach Paperclip — ✅ rule + audit shipped

**Status:** CLAUDE.md now has a "PR descriptions ≠ Paperclip approvals" rule that requires the agent opening such PRs to also file the matching Paperclip approval via the API. The `board-alerts-v2.md` heartbeat audits open PRs whose body asks for approval and cross-checks against pending Paperclip approvals to flag the gap. PR #76 was the original example; the retroactive approval was filed.

**Still possible:** a GitHub PR-opened webhook that auto-files the approval would close the human-opened-PR case the rule can't catch.

### 8. Stale BOARD-prefixed issues — ✅ audit shipped

**Status:** `prompts/board-alerts-v2.md` now detects BOARD-prefixed issues left in `in_progress` or `blocked` longer than 24h and posts them to `#board` with a "close or escalate" hint.

### 9. PR check status is invisible to agents

`engineering-lead` heartbeat doesn't poll `gh pr checks` so a stuck PR (failing Vercel build, failing E2E) doesn't show up anywhere except GitHub. Add a `gh pr checks` poll to the engineering-lead prompt, or a small GitHub MCP that surfaces status.

**Effort:** ~1h

### 10. No PR ↔ Paperclip issue link surfaced in the UI

CON-XX is mentioned in PR titles but Paperclip doesn't display the related PR back in the issue view. The relationship is one-way text. Adding a `paperclip__link_pr` MCP tool + a renderer in the Paperclip UI closes the loop.

**Effort:** ~3h

### 11. CHANGELOG.md / release.yml bloat — ✅ in flight

**Status:** root-caused — `release.yml` was failing at the `@semantic-release/git` prepare step because (a) newer Actions runners don't ship a default `git user.email`/`user.name` and the `git commit` exits 1 silently, and (b) `GITHUB_TOKEN` can't push `[skip ci]` commits to a `main` branch with required status checks. Each release rewrote `CHANGELOG.md` from full history without bumping the version, producing 166 repeated `## 1.0.0 (...)` headers and a 2.3 MB file.

**PRs landing the fix:**
- [`[your-app]#77`](https://github.com/iaminawe/[your-app]/pull/77) — buckets old changelog as `CHANGELOG-2026.md`, starts fresh `CHANGELOG.md`
- [`[your-app]#78`](https://github.com/iaminawe/[your-app]/pull/78) — adds git identity step + `secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN` resolution

**You still need to create** a `RELEASE_TOKEN` repo secret (fine-grained PAT with `contents:write` + branch-protection bypass) for the version bump commit to actually reach `main`. Until then, tags and releases will land but `package.json` won't update on `main`.

## Suggested order — what's left

Most of the Tier-1 list shipped in the 2026-05-19 audit pass. Remaining items in the order they'd be worth picking up:

1. **Create `RELEASE_TOKEN` repo secret** — the one human-only prerequisite from gap #11. Until this exists, `package.json` version bumps stop at the runner.
2. **(3h) Memory Tool wiring with Honcho coordination** (item #1) — needs the Honcho-vs-auto-memory decision (see `03-identity-memory.md`); the workspace-local vs cross-agent split is documented but not yet enforced in code.
3. **(2h) `/goal` drain for `gmail-triage`** (item #2) — the only true drain candidate; `board-alerts` is state-based, not queue-based.
4. **(2h) Worktree isolation main ↔ secondary** (item #3) — touches the sub-agent's persistent state, so plan a clean migration of her `memory/`.
5. **(4h) Hook event streaming into Slack** (item #4) — high-visibility UX win once it's in.
6. **(6h) OTEL trace propagation** (item #5) — biggest bite, biggest debugging payoff for the whole Slack → MCP → Paperclip chain.
7. **(3h) Plugins / marketplaces** (item #6) — only worth doing once at least two of the agent stack's machines need the skills.

Plus the still-open integration gaps in the section above (PR check status invisible to agents, no PR ↔ Paperclip linkage in the UI).

## Adoption checklist

When you ship any of these:

- [ ] Bump SDK version if needed
- [ ] Add the relevant `betas: [...]` array if it's a beta feature
- [ ] Test with one agent (the sub-agent) before rolling to main
- [ ] Update this file to move the item from "backlog" to "shipped"
- [ ] Note adoption in `~/Work/clawd-workspace/MEMORY.md`
