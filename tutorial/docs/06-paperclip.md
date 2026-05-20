---
sidebar_position: 7
title: Paperclip Control Plane
description: "Local agent orchestration with companies, agents, issues, and the board-approval loop driven from Slack."
slug: /06-paperclip
---

# Paperclip Control Plane

[Paperclip](https://paperclip.ai) is the local control plane for the agent fleet. It owns the **what**, **who**, and **when** — companies, agents, issues, schedules, approval queue. The Slack bridge owns the **how**.

OpenClaw bundled its own scheduler + agent runtime. The migration moved the scheduler to launchd ([Scheduled Jobs](./04-scheduled-jobs)) and the runtime to the Agent SDK, leaving Paperclip as the orchestration layer everyone agrees on.

## Install + start

```bash
brew install paperclipai     # or follow upstream install instructions
paperclipai onboard           # interactive setup wizard
```

Onboarding creates `~/.paperclip/instances/default/` with embedded postgres on `:54329` and the API on `:3100`.

LaunchAgent for boot:

```xml
<!-- ~/Library/LaunchAgents/ai.paperclip.run.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.paperclip.run</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/paperclipai</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>/Users/USERNAME/.paperclip/instances/default/logs/run.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/USERNAME/.paperclip/instances/default/logs/run.err.log</string>
</dict>
</plist>
```

Web UI: [http://127.0.0.1:3100](http://127.0.0.1:3100)

## Concepts

| Object       | What it is                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| Company      | A business unit. You can have many — [example-tenant-a], [your-app], etc. Each has issues, agents, budget, brand.      |
| Agent        | A named LLM persona scoped to a company. Has an org-chart role (CEO / engineering lead / QA / manager).            |
| Workspace    | A directory on disk where the agent operates (its `cwd`). Contains an `AGENTS.md` for context.                     |
| Issue        | A unit of work. Statuses: `backlog`, `open`, `in_progress`, `blocked`, `in_review`, `done`. Can have parents.      |
| Approval     | A blocker an agent throws when it needs human OK. Reason + decision note + status (`pending`/`approved`/`rejected`/`revision`). |
| Heartbeat    | A scheduled invocation of an agent. The agent wakes, reads its inbox of new comments + assigned issues, acts.       |

## Agent definition (per-workspace `AGENTS.md`)

```markdown
# Engineering Lead — [your-app]

You are the engineering lead for [your-app], the multi-tenant business platform.

## Your scope
- Triage and assign issues in the CON project
- Drive the QA agent for testing
- Escalate to the board when blocked

## Your toolbelt
- Paperclip MCP — issue management
- [your-app] MCP servers (per-domain) — read business data
- GitHub via gh CLI

## Decision rules
- Never deploy to production without board approval
- Never delete data without board approval
- File a bug for any production error you observe
- Update issue status as you work
```

The agent reads this on every heartbeat and uses it as guard rails.

## Heartbeat schedule

Set per-agent in the Paperclip UI (or via API). Cron-style with timezone:

| Agent                 | Schedule (America/Vancouver)            |
| --------------------- | --------------------------------------- |
| [example-tenant-a] Manager    | 8, 10, 12, 14, 16, 18 weekdays           |
| Engineering Lead      | 6, 12, 18 daily                          |
| [example-tenant-b] Manager     | 9, 15 weekdays                           |
| QA Agent              | on-demand (invoked by Engineering Lead) |

When a heartbeat fires, Paperclip POSTs to the agent's executor. Two executor flavours:

- **`claude_local`** — shells out to `claude -p` (or to `paperclip-dispatcher`) with the agent's `cwd`. This is the post-OpenClaw default.
- **`openclaw_gateway`** — legacy. Don't use.

## The approval loop — the killer feature

When an agent reaches a decision boundary it can't (or shouldn't) cross alone, it calls Paperclip's approval API instead of acting:

```ts
const approval = await paperclip.requestApproval({
  agentId: "engineering-lead",
  reason: "Deploy migration 0042 to [your-app] production",
  context: "Adds NOT NULL column to users table; backfill in same migration. Tested on staging Tue.",
  diff: "<rendered diff>",
});

// Execution pauses. The approval shows up in:
//   - Paperclip web UI
//   - #board Slack channel (via the board-alerts cron job)
//   - Slack bridge will accept "approve PAP-39 looks good" commands
```

You see it in Slack:

```
🚨 Approval requested: PAP-39
Agent: engineering-lead ([your-app])
Reason: Deploy migration 0042 to [your-app] production
Tested on staging Tuesday. NOT NULL with backfill.
[Open in UI] http://127.0.0.1:3100/approvals/PAP-39
```

You reply in the same Slack thread:

```
approve PAP-39 ship it
```

The Slack bridge's `board-handler.ts` parses that, POSTs to `${PAPERCLIP_API}/approvals/PAP-39/approve` with `decisionNote: "ship it"`, and Paperclip wakes the paused agent. **No LLM call needed for the approval action itself** — it's just an HTTP call.

## The board-handler in the Slack bridge

```ts
import type { WebClient } from "@slack/web-api";
import { PAPERCLIP_API, BOARD_CHANNEL_ID } from "./config.js";

interface BoardCommand {
  type: "approve" | "deny" | "revise";
  approvalId: string;
  note: string;
}

export function parseBoardCommand(text: string): BoardCommand | null {
  // Accepts: "approve PAP-39 looks good", "deny PAP-40 not now", "revise PAP-41 please add tests"
  const m = text.match(/^(approve|deny|revise)\s+([A-Z]{2,5}-\d+|[a-f0-9-]{8,})\s+(.+)/i);
  if (!m) return null;
  return { type: m[1].toLowerCase() as any, approvalId: m[2], note: m[3] };
}

export async function handleBoardCommand(
  client: WebClient,
  command: BoardCommand,
  threadTs: string,
): Promise<void> {
  let fullId = command.approvalId;
  if (command.approvalId.length <= 8) {
    fullId = await resolveShortId(command.approvalId);
  }

  const action = { approve: "approve", deny: "reject", revise: "request-revision" }[command.type];
  const url = `${PAPERCLIP_API}/approvals/${fullId}/${action}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisionNote: command.note }),
  });
  if (!r.ok) throw new Error(`Paperclip ${r.status}: ${await r.text()}`);

  const emoji = { approve: "✅", deny: "❌", revise: "📝" }[command.type];
  const verb = { approve: "Approved", deny: "Denied", revise: "Revision requested for" }[command.type];

  await client.chat.postMessage({
    channel: BOARD_CHANNEL_ID,
    thread_ts: threadTs,
    text: `${emoji} ${verb} ${command.approvalId} — agent will be notified.`,
  });
}

async function resolveShortId(shortId: string): Promise<string> {
  const r = await fetch(`${PAPERCLIP_API}/approvals?status=pending`);
  const all: any[] = await r.json();
  const m = all.find(a => a.id?.startsWith(shortId) || a.issueIdentifier?.includes(shortId.toUpperCase()));
  if (!m) throw new Error(`Approval not found: ${shortId}`);
  return m.id;
}
```

## board-alerts cron job

Paperclip posts new approvals to its API; you need to *push* them to Slack. The `net.iaminawe.clawd.board-alerts` plist runs every 30 min:

`prompts/board-alerts.md`:

```markdown
You are the alerting agent for the the board.

Use the `paperclip` MCP server to:
1. List all approvals with status = pending
2. For each one NOT already posted (you can track via a small JSON file at ~/Library/Application Support/clawd/board-alerts-posted.json), format:

   🚨 *Approval requested: {issueIdentifier}*
   *Agent:* {agentName} ({companyName})
   *Reason:* {reason}
   *Context:* {context, truncated to 200 chars}
   _Reply in this thread: `approve {issueIdentifier} <comment>` / `deny ...` / `revise ...`_

3. Post each one to the #board channel
4. Update the posted-tracking file
5. If no new approvals, output `NO_ALERT` (the wrapper will skip the Slack post)
```

## Issue-tracking via MCP

Paperclip ships an MCP server (per-instance) that gives agents the basic CRUD:

- `paperclip__list_issues`
- `paperclip__get_issue`
- `paperclip__create_issue`
- `paperclip__update_issue`
- `paperclip__add_comment`
- `paperclip__list_approvals`
- `paperclip__approve` / `paperclip__deny`
- `paperclip__get_company_dashboard`

Wire it into the Slack bridge by making it an `alwaysLoad: true` MCP in your bridge's `mcp_servers` config (see [Modernization Plan](./08-modernization) for the Tool Search optimisation).

## Cost & budget governance

Each company has a monthly budget cap (cents) and Paperclip tracks spend per agent. You can set:

- **`requireBoardApprovalForNewAgents: true`** — adding a new agent requires your approval first
- **`budgetMonthlyCents: 2000`** — soft cap, agents see warnings as they approach
- **Hard kill** — if spend exceeds the cap × 1.5, the agent's heartbeats are paused

This is the only enforced budget mechanism in the stack — `claude -p` and the SDK don't have one (yet — see Modernization plan, `taskBudget`).

## What about CRDT / multi-Mac sync

Paperclip is single-instance by design. If you want multi-Mac, run it on a server and point Slack bridge at the remote URL via `PAPERCLIP_API`. I haven't done this; the local instance is fine for one human + 6 agents.

## Common gotchas

- **`paperclip cron` doesn't fire** — Paperclip's internal scheduler is separate from launchd. If you booted Paperclip but agents aren't waking on schedule, check the heartbeat config in the UI (Settings → Agents → Heartbeat).
- **Approval thread doesn't update** — your reply needs to be in the **same thread** the alert was posted in. Replies in the channel root won't be parsed.
- **Short ID `PAP-39` not resolved** — your `parseBoardCommand` regex may not match the format. Confirm via `curl -s http://127.0.0.1:3100/api/approvals?status=pending | jq '.[].issueIdentifier'`.
- **Embedded postgres won't start** — port 54329 in use, or `~/.paperclip/instances/default/db/` corrupted from a hard kill. Stop Paperclip, wait, restart.

Next: [Teardown Checklist](./07-teardown) — exact commands I ran when removing OpenClaw, in order.
