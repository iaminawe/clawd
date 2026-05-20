# Clawd

An AI familiar that lives in Slack. Practical replacement for [OpenClaw](https://github.com/dleemiller/openclaw), built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) and Anthropic's Claude Code CLI.

You talk to Clawd in Slack — DMs, channels, threaded conversations. Behind the scenes each Slack thread is a long-running Claude Code session with persistent identity, skills, MCP tools, scheduled jobs, and the ability to spawn worktree-isolated coding agents.

📖 **[Read the full tutorial →](https://iaminawe.github.io/openclaw-to-claude-tutorial/)**

---

## What's in this repo

Four components that compose into one assistant. Each is independently runnable.

### [`slack-bridge/`](./slack-bridge) — the Slack ↔ Claude Code interface

The daemon that turns Slack into a Claude Code front-end. Runs as a `launchd` agent on macOS (or any always-on host).

- **Socket Mode**, so no public webhook endpoint required
- **Per-thread sessions** with deterministic UUIDs derived from the Slack thread key — each Slack thread is one continuous Claude Code conversation that survives bridge restarts
- **Supabase-backed session store** (`SessionStore` adapter) so transcripts persist across restarts and across machines
- **Streaming responses** edited into the original Slack message as the model generates tokens (no five-message spam)
- **Per-agent personas** — define one or more named agents in `slack-bridge/src/config.ts`. Each gets its own `cwd` (and therefore its own `CLAUDE.md`, memory, skills, MCP allowlist). Useful for splitting "work Clawd" from a "household Clawd" with different scopes
- **Channel ↔ tenant mapping** — incoming messages from a given Slack channel can route to a tenant-scoped MCP server set, so one bridge can drive many projects without context bleeding
- **Per-thread token budget** with a friendly "switch threads to continue" rejection
- **Cache-aware system-prompt assembly** with `excludeDynamicSections: true` for stable cache prefixes
- **Tool Search + Programmatic Tool Calling** (advanced-tool-use beta) so the model only pays attention to relevant MCP tools per turn
- **Friendly auth errors** — surfaces "run `claude /login` and bounce the bridge" when the CLI loses Keychain access after an upgrade

Built on `@slack/bolt` + `@anthropic-ai/claude-agent-sdk` + `pino`.

### [`paperclip-dispatcher/`](./paperclip-dispatcher) — concurrent coding agents in git worktrees

For when a Slack message — or a Paperclip issue (see below) — kicks off real code work. Spawns a Claude Code agent in an isolated git worktree so multiple jobs can edit the same repo concurrently without stepping on each other. The name reflects that it's the worker [Paperclip](https://paperclip.ing/) dispatches coding tasks to, but it's runnable standalone.

- Creates a temp worktree on a per-task branch
- Streams the Claude Code transcript back into Slack as it works
- Commits + pushes when done, opens a PR, posts the URL back to the thread
- Cleans up the worktree on success or failure
- Replaces the old `run-task.sh` shell wrapper with proper streaming, error recovery, and Slack delivery

Built on `@anthropic-ai/claude-agent-sdk` + `simple-git` semantics via `execSync`.

### [`workspace/`](./workspace) — Clawd's identity, skills, and tooling

This is Clawd's "home directory" — the `cwd` the Slack bridge runs queries from. The Agent SDK reads `CLAUDE.md`, `memory/`, and `skills/` from `cwd`, so anything in this directory shapes the assistant's behavior.

- **[`CLAUDE.md`](./workspace/CLAUDE.md)** — system prompt that establishes Clawd as a named AI familiar with opinions, boundaries, and a `#board`-channel approval protocol. Not a generic "you are a helpful assistant"
- **[`skills/`](./workspace/skills)** (27 skills) — markdown playbooks the model loads on-demand: Cloudflare Workers, Supabase, Next.js, Stripe, Tailwind, Vercel, etc. Each is a curated mini-doc with examples and gotchas
- **[`scripts/`](./workspace/scripts)** — secrets via Vaultwarden (`get-secret.sh`, `start-bw-serve.sh`), launchd service helpers, heartbeat parsing, ChatGPT export → Obsidian sync

Personal memory (`MEMORY.md`, `memory/`) is intentionally excluded — bring your own.

### [`tutorial/`](./tutorial) — the migration walkthrough (Docusaurus site)

End-to-end tutorial that walks through how this whole stack was built, originally as a migration off OpenClaw. The source markdown is in `tutorial/docs/`. The live site is published from the standalone [`iaminawe/openclaw-to-claude-tutorial`](https://github.com/iaminawe/openclaw-to-claude-tutorial) repo.

**🔗 [iaminawe.github.io/openclaw-to-claude-tutorial](https://iaminawe.github.io/openclaw-to-claude-tutorial/)**

Chapters:

1. [Overview](https://iaminawe.github.io/openclaw-to-claude-tutorial/00-overview) — what this stack is and why
2. [Architecture](https://iaminawe.github.io/openclaw-to-claude-tutorial/01-architecture) — the four-layer model
3. [Slack bridge](https://iaminawe.github.io/openclaw-to-claude-tutorial/02-slack-bridge) — Socket Mode + Agent SDK wiring
4. [Identity & memory](https://iaminawe.github.io/openclaw-to-claude-tutorial/03-identity-memory) — `CLAUDE.md`, skills, multi-persona
5. [Scheduled jobs](https://iaminawe.github.io/openclaw-to-claude-tutorial/04-scheduled-jobs) — `launchd` cron jobs that invoke `claude -p`
6. [Secrets](https://iaminawe.github.io/openclaw-to-claude-tutorial/05-secrets) — Vaultwarden + `bw serve`
7. [Paperclip](https://iaminawe.github.io/openclaw-to-claude-tutorial/06-paperclip) — the task daemon
8. [Teardown](https://iaminawe.github.io/openclaw-to-claude-tutorial/07-teardown) — actually migrating off OpenClaw
9. [Modernization](https://iaminawe.github.io/openclaw-to-claude-tutorial/08-modernization) — current SDK feature surface

---

## Paperclip — the orchestration plane Clawd talks to

Clawd is the *voice* in Slack. **[Paperclip](https://paperclip.ing/)** is the *system of record* underneath it.

> _"The human control plane for AI labor — hire AI employees, set goals, automate jobs and your business runs itself."_

Paperclip is an open-source orchestrator (MIT, Node.js + React, self-hosted) that gives a team of AI agents the structure a company gives human employees: an org chart, reporting lines, budgets, scoped responsibilities, issue queues, approval gates, and an activity log. Its tagline says it best: _"If OpenClaw is an employee, Paperclip is the company."_

Clawd integrates with it by talking to the Paperclip REST API on `http://127.0.0.1:3100`. Specifically, the bridge uses these endpoints throughout `slack-bridge/src/board-handler.ts` and the workspace prompts:

| Endpoint | Used for |
| --- | --- |
| `GET /api/companies/{companyId}/issues?status=blocked` | Heartbeat checks: find issues agents got stuck on so Clawd can alert in `#board` |
| `GET /api/companies/{companyId}/approvals?status=pending` | Surface pending governance approvals to the human |
| `POST /api/approvals/{id}/approve` | Wire up `approve <id>` Slack commands |
| `POST /api/approvals/{id}/reject` | Wire up `deny <id>` Slack commands |
| `POST /api/companies/{companyId}/approvals` | File a board approval when Clawd opens a PR that needs sign-off |
| `POST /api/companies/{companyId}/issues` | Create issues on behalf of a Slack user pinging a specialist agent |

**Why this matters for Clawd:** the Slack bridge doesn't try to be a task tracker, a memory store, or a governance system on its own. When Clawd needs to remember a decision, escalate a blocker, or get human approval on a risky action, it talks to Paperclip — which owns those concepts properly across multiple agents and "companies" (multi-tenant scopes).

**Links:**
- 🌐 [paperclip.ing](https://paperclip.ing/) — product page and overview
- 📦 [github.com/paperclipai/paperclip](https://github.com/paperclipai/paperclip) — source, install instructions, self-host (`npx paperclipai onboard --yes`)

---

## Related project — ConvergeKit

**[ConvergeKit](https://convergekit.io)** — _"Your Complete Business Kit, Converged."_

A multi-tenant SaaS platform from the same maintainer as this repo. ConvergeKit consolidates the fragmented stack a small business typically juggles — CRM with semantic search, AI-driven market research and lead gen, email campaigns, e-commerce (catalogs, orders, payments), content/media, social posting, analytics — into one converged system, with eight specialized in-app AI teammates running across the workflows.

Clawd and ConvergeKit are independent but were developed alongside each other: ConvergeKit's MCP servers are exactly the kind of tenant-scoped tool surface this bridge's `MCP_SERVERS.channelDomains` pattern was built to route. If you're looking for an example of a multi-tenant Next.js app that exposes per-domain MCP servers for a Slack-bridge like this one to consume, ConvergeKit is the reference implementation in this maintainer's stack. (Source is private; product is GA — see the site for plans starting at $29/mo.)

---

## Install

```bash
git clone https://github.com/iaminawe/clawd.git
cd clawd
```

### Prerequisites

- macOS or Linux (the bridge runs anywhere `launchd` or `systemd` can keep a daemon alive)
- Node.js 20+
- Claude Code CLI installed (`brew install --cask claude-code` or follow [Anthropic's instructions](https://docs.anthropic.com/en/docs/claude-code/quickstart))
- A Claude subscription (Pro or Max) — generate a long-lived OAuth token with `claude setup-token`
- A Slack app configured for Socket Mode with bot + app-level tokens
- (Optional) Supabase project for durable session storage
- (Optional) Vaultwarden / `bw` CLI for secret retrieval scripts

### slack-bridge

```bash
cd slack-bridge
npm install
cp .env.example .env   # fill in tokens
npm run build
node dist/index.js
```

For production, wire this into `launchd` — see [tutorial chapter 3](https://iaminawe.github.io/openclaw-to-claude-tutorial/02-slack-bridge) for the plist.

### paperclip-dispatcher

```bash
cd paperclip-dispatcher
npm install
cp .env.example .env
npm run build

# invoke from a Slack command, a launchd job, or directly:
node dist/worktree-dispatch.js --repo /path/to/your/repo --task "fix the failing test" --channel C0XXXXXXXXX
```

### workspace

Point the Slack bridge's per-agent `cwd` at this directory (the default `AGENTS.main.cwd` in `slack-bridge/src/config.ts`). Or `rsync` it somewhere persistent and update the config.

Add your own `MEMORY.md` and `memory/<date>.md` files — these are gitignored at the repo root and stay local to your install.

---

## License

MIT
