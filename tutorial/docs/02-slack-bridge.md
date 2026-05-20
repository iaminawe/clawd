---
sidebar_position: 3
title: Building the Slack Bridge
description: "TypeScript bot using @slack/bolt + @anthropic-ai/claude-agent-sdk with per-thread session continuity and streaming."
slug: /02-slack-bridge
---

# Building the Slack Bridge

The bridge is a long-running Node service that listens to Slack via Socket Mode and answers via the Claude Agent SDK. It's ~600 lines of TypeScript across 7 files.

Result: a Slack bot named `@clawd` (your name) that:

- Replies in any configured channel
- Replies to DMs (routes by user-ID — the sub-agent's DMs go to a different agent than mine)
- Maintains per-thread session continuity
- Streams responses with throttled `chat.update` to feel responsive without thrash
- Adds `:eyes:` reaction on receipt, `:writing_hand:` while thinking, drops emoji on completion
- Handles `approve PAP-39 …` board commands without invoking an LLM

## 0. Slack app setup (~10 min)

You need **two tokens**:

- **Bot token** (`xoxb-…`) — for chat operations
- **App token** (`xapp-…`) — for Socket Mode

Steps in [api.slack.com/apps](https://api.slack.com/apps):

1. Create new app → "From scratch"
2. **Socket Mode** → enable it. Generate an app token with scope `connections:write`. Copy the `xapp-…`.
3. **OAuth & Permissions** → Bot Token Scopes:
   - `app_mentions:read`
   - `channels:history`, `groups:history`, `im:history`, `mpim:history`
   - `chat:write`
   - `reactions:write`
   - `users:read`
   - `im:read` (for DM listing if you use the poller fallback)
4. **Event Subscriptions** → enable. Subscribe to bot events: `message.channels`, `message.groups`, `message.im`, `message.mpim`, `app_mention`.
5. Install to workspace → copy the bot token (`xoxb-…`).
6. Invite the bot to every channel you want it in: `/invite @clawd`.

Save both tokens — they go in `.env` next.

## 1. Project skeleton

```bash
mkdir -p ~/conductor/slack-bridge
cd ~/conductor/slack-bridge
npm init -y
npm install @anthropic-ai/claude-agent-sdk @slack/bolt @slack/web-api pino
npm install -D typescript @types/node tsx
npx tsc --init
```

Edit `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Edit `package.json`:

```json
{
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts"
  }
}
```

Create `.env` (mode 600):

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
LOG_LEVEL=info
```

## 2. `src/config.ts` — channel routing & agent definitions

This is the only file you'll edit when adding a new channel or sub-agent.

```ts
import { readFileSync } from "fs";
import { resolve } from "path";

export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
export const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN!;
if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  throw new Error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set");
}

export let BOT_USER_ID = "";
export function setBotUserId(id: string) { BOT_USER_ID = id; }

export type AgentName = "main" | "secondary";

export interface ChannelConfig {
  name: string;
  requireMention: boolean;  // true → only respond when @-mentioned
  agent: AgentName;
}

// Find channel IDs via: curl -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
//   https://slack.com/api/conversations.list?types=public_channel,private_channel
export const CHANNELS: Record<string, ChannelConfig> = {
  C060NPNFMEZ: { name: "general",  requireMention: false, agent: "main" },
  C060RNLPJE7: { name: "standup",  requireMention: true,  agent: "main" },
  // ... add the rest
};

export const BOARD_CHANNEL_ID = "<BOARD_CHANNEL_ID>";

// DM routing — find user IDs via Slack profile URL
export const DM_ROUTES: Record<string, { agent: AgentName }> = {
  U0614AXJYKT: { agent: "secondary" },
};

const HOME = process.env.HOME || "";

export interface AgentConfig {
  cwd: string;             // working dir Claude operates from
  systemPromptFile: string; // CLAUDE.md to append after the Code preset
  maxTurns: number;
}

export const AGENTS: Record<AgentName, AgentConfig> = {
  main: {
    cwd: resolve(HOME, "Work/clawd-workspace"),
    systemPromptFile: resolve(HOME, "Work/clawd-workspace/CLAUDE.md"),
    maxTurns: 25,
  },
  secondary: {
    cwd: resolve(HOME, "Work/clawd-workspace/secondary"),
    systemPromptFile: resolve(HOME, "Work/clawd-workspace/secondary/CLAUDE.md"),
    maxTurns: 15,
  },
};

export function loadSystemPrompt(agent: AgentName): string {
  try { return readFileSync(AGENTS[agent].systemPromptFile, "utf-8"); }
  catch { return ""; }
}

export const MAX_CONCURRENT_SESSIONS = 4;
export const MAX_QUEUE_SIZE = 10;
export const PAPERCLIP_API = "http://127.0.0.1:3100/api";
```

## 3. `src/session-manager.ts` — Agent SDK + per-thread persistence

This is the heart. It maintains a `Map<threadKey, sessionId>` so replies in the same Slack thread continue the same Agent SDK session, gives each agent its own `cwd` + `CLAUDE.md`, and rate-limits concurrency.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentName } from "./config.js";
import { AGENTS, loadSystemPrompt, MAX_CONCURRENT_SESSIONS, MAX_QUEUE_SIZE } from "./config.js";

const QUERY_TIMEOUT_MS = 300_000;

export type StreamCallback = (text: string) => void;

interface SessionRequest {
  agent: AgentName;
  prompt: string;
  threadSessionId?: string;
  onStream?: StreamCallback;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
}

const threadSessions = new Map<string, string>();
let activeCount = 0;
const queue: SessionRequest[] = [];

export function getThreadSessionId(k: string) { return threadSessions.get(k); }
export function setThreadSessionId(k: string, id: string) { threadSessions.set(k, id); }

export async function runQuery(
  agent: AgentName,
  prompt: string,
  threadKey?: string,
  onStream?: StreamCallback,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req: SessionRequest = {
      agent, prompt,
      threadSessionId: threadKey ? getThreadSessionId(threadKey) : undefined,
      onStream, resolve, reject,
    };
    if (activeCount < MAX_CONCURRENT_SESSIONS) processRequest(req, threadKey);
    else if (queue.length < MAX_QUEUE_SIZE) queue.push(req);
    else reject(new Error("Queue full — try again later"));
  });
}

async function processRequest(req: SessionRequest, threadKey?: string) {
  activeCount++;
  const config = AGENTS[req.agent];
  const systemPrompt = loadSystemPrompt(req.agent);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), QUERY_TIMEOUT_MS);
  let accumulatedStreamText = "";

  try {
    const result = query({
      prompt: req.prompt,
      options: {
        cwd: config.cwd,
        systemPrompt: systemPrompt
          ? { type: "preset", preset: "claude_code", append: systemPrompt }
          : undefined,
        maxTurns: config.maxTurns,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        resume: req.threadSessionId,
        persistSession: true,
        abortController,
        includePartialMessages: true,
      },
    });

    let sessionId = "";
    let lastAssistantText = "";

    for await (const message of result) {
      // Stream deltas
      if (req.onStream) {
        const msg = message as any;
        if (msg.type === "stream_event") {
          const e = msg.event;
          if (e?.type === "content_block_delta" && e?.delta?.type === "text_delta" && e?.delta?.text) {
            accumulatedStreamText += e.delta.text;
            try { req.onStream(accumulatedStreamText); } catch {}
          }
        }
      }

      // Final assistant turn
      if (message.type === "assistant" && message.message?.content) {
        accumulatedStreamText = "";
        let turnText = "";
        for (const block of message.message.content) {
          if ("text" in block && block.text) turnText += block.text;
        }
        if (turnText.trim()) lastAssistantText = turnText;
        if (message.session_id) sessionId = message.session_id;
      }

      if (message.type === "result") {
        const r = message as any;
        if (r.session_id) sessionId = r.session_id;
      }
    }

    if (threadKey && sessionId) setThreadSessionId(threadKey, sessionId);
    req.resolve(lastAssistantText || "(no response)");
  } catch (err) {
    if (abortController.signal.aborted) {
      const partial = accumulatedStreamText;
      req.resolve(partial ? partial + "\n\n_(timed out — partial response)_" : "(timed out)");
    } else {
      req.reject(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    clearTimeout(timer);
    activeCount--;
    if (queue.length > 0) processRequest(queue.shift()!, undefined);
  }
}
```

Two non-obvious choices:

- **`systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt }`** — this gives you Claude Code's full preset (memory loading, CLAUDE.md handling, tool use defaults) **plus** your custom persona. If you set a raw `systemPrompt` string instead, you lose the preset behaviour and your bot will feel oddly stripped-down.

- **`resume: req.threadSessionId`** — the SDK takes either `undefined` (start fresh) or a previous `session_id`. Map your Slack thread `ts` to a session and replies feel like a real conversation across hours/days.

## 4. `src/index.ts` — Bolt event loop with throttled streaming

```ts
import { App } from "@slack/bolt";
import { SLACK_BOT_TOKEN, SLACK_APP_TOKEN, setBotUserId, CHANNELS, BOARD_CHANNEL_ID, DM_ROUTES, BOT_USER_ID } from "./config.js";
import { runQuery } from "./session-manager.js";
import { addReaction, removeReaction, markdownToSlack } from "./slack-responder.js";
import { handleBoardCommand, parseBoardCommand } from "./board-handler.js";
import { logger } from "./logger.js";

const STREAM_UPDATE_INTERVAL_MS = 1500;

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

app.message(async ({ message, client }) => {
  if (message.subtype) return;
  if (!("user" in message) || !message.user || !message.text || !("ts" in message)) return;

  const channelId = message.channel;
  const channelConfig = CHANNELS[channelId];
  const isDM = !channelConfig && (message as any).channel_type === "im";
  if (!channelConfig && !isDM) return;

  if (channelConfig?.requireMention) {
    if (!BOT_USER_ID || !message.text.includes(`<@${BOT_USER_ID}>`)) return;
  }

  const cleanText = BOT_USER_ID
    ? message.text.replace(new RegExp(`<@${BOT_USER_ID}>`, "g"), "").trim()
    : message.text.trim();
  if (!cleanText) return;

  const threadTs = ("thread_ts" in message ? message.thread_ts : undefined) || message.ts;
  const threadKey = `${channelId}:${threadTs}`;

  await addReaction(client, channelId, message.ts, "eyes");

  // Board commands short-circuit the LLM
  if (channelId === BOARD_CHANNEL_ID) {
    const cmd = parseBoardCommand(cleanText);
    if (cmd) {
      await handleBoardCommand(client, cmd, threadTs);
      await removeReaction(client, channelId, message.ts, "eyes");
      await addReaction(client, channelId, message.ts, "white_check_mark");
      return;
    }
  }

  const agent = (isDM && DM_ROUTES[message.user]?.agent) || "main";

  // Streaming state
  let streamMsgTs: string | undefined;
  let lastUpdateTime = 0;
  let lastUpdateText = "";
  let updatePending = false;
  let firstPostDone = false;

  const onStream = (text: string) => {
    const now = Date.now();
    if (now - lastUpdateTime < STREAM_UPDATE_INTERVAL_MS) return;
    if (text.length - lastUpdateText.length < 20) return;
    if (updatePending) return;
    lastUpdateTime = now;
    lastUpdateText = text;
    updatePending = true;
    const slackText = markdownToSlack(text).slice(0, 3900);

    if (!firstPostDone) {
      firstPostDone = true;
      client.chat.postMessage({
        channel: channelId, thread_ts: threadTs,
        text: slackText + " :writing_hand:",
      }).then(r => {
        streamMsgTs = r.ts;
        updatePending = false;
      }).catch(() => { updatePending = false; });
    } else if (streamMsgTs) {
      client.chat.update({
        channel: channelId, ts: streamMsgTs,
        text: slackText + " :writing_hand:",
      }).then(() => { updatePending = false; })
        .catch(() => { updatePending = false; });
    } else {
      updatePending = false;
    }
  };

  try {
    const reply = await runQuery(agent, cleanText, threadKey, onStream);
    const finalText = markdownToSlack(reply);

    if (streamMsgTs) {
      await client.chat.update({ channel: channelId, ts: streamMsgTs, text: finalText.slice(0, 3900) });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: finalText.slice(0, 3900) });
    }
    await removeReaction(client, channelId, message.ts, "eyes");
  } catch (err) {
    logger.error({ err }, "Query failed");
    await client.chat.postMessage({
      channel: channelId, thread_ts: threadTs,
      text: `:warning: Failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

(async () => {
  await app.start();
  // Discover bot user ID once
  const auth = await app.client.auth.test({ token: SLACK_BOT_TOKEN });
  if (auth.user_id) setBotUserId(auth.user_id);
  logger.info({ botUserId: auth.user_id }, "Bot user ID set");
  logger.info(
    { channels: Object.values(CHANNELS).map(c => `#${c.name}`).join(", ") },
    "Clawd Slack bridge started (Socket Mode)",
  );
})();
```

## 5. Helper modules (boilerplate)

`src/slack-responder.ts` — `addReaction`, `removeReaction`, `markdownToSlack` (`**bold**` → `*bold*`, `## h2` → `*h2*`, etc).

`src/logger.ts` — `pino({ level: process.env.LOG_LEVEL || "info" })`.

`src/board-handler.ts` — POSTs to `${PAPERCLIP_API}/approvals/<id>/{approve,reject,request-revision}` with the comment text. Resolves short IDs (`PAP-39`) by querying `${PAPERCLIP_API}/approvals?status=pending`.

(Source: see `~/conductor/slack-bridge/src/` for the full versions.)

## 6. Build + run + daemonise

```bash
cd ~/conductor/slack-bridge
npm run build
node dist/index.js   # foreground test — DM your bot in Slack
```

Once it works, daemonise via launchd. Create `~/Library/LaunchAgents/net.iaminawe.clawd.slack-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>net.iaminawe.clawd.slack-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/USERNAME/conductor/slack-bridge/scripts/start-bridge.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>/Users/USERNAME/Library/Logs/clawd-slack-bridge.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/USERNAME/Library/Logs/clawd-slack-bridge.stderr.log</string>
  <key>WorkingDirectory</key>
  <string>/Users/USERNAME/conductor/slack-bridge</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
```

`scripts/start-bridge.sh`:

```bash
#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; source .env; set +a; fi
exec node dist/index.js
```

Then:

```bash
chmod +x scripts/start-bridge.sh
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/net.iaminawe.clawd.slack-bridge.plist
launchctl list | grep slack-bridge   # should show a PID
```

## 7. Verification

```bash
tail -f ~/Library/Logs/clawd-slack-bridge.log
# DM the bot in Slack — log should show:
# {"botUserId":"U…","msg":"Bot user ID set"}
# {"channels":"…","msg":"Clawd Slack bridge started (Socket Mode)"}
# {"channel":"…","user":"…","text":"…","msg":"Message received"}
```

## Common gotchas

- **Bot doesn't respond in a channel** — make sure the bot is invited (`/invite @bot`) and the channel ID is in `CHANNELS`.
- **DMs go to the wrong agent** — `DM_ROUTES` keys are user IDs (`U…`), not display names. Find via `client.users.list` or the URL of a user's profile in Slack.
- **Streaming flickers** — the throttle interval is 1500 ms. Lower it if responses feel slow, but expect rate-limit warnings under load.
- **`auth.test` returns wrong user** — you used the app token instead of bot token. Bot replies are by `xoxb-…`; `xapp-…` is only for the WebSocket.
- **Pongs missing** — Slack Socket Mode reconnects every ~35 min. The `[WARN] socket-mode: A pong wasn't received` lines are normal. If you see continuous failure, check your network or the bot's app-token validity.

Next: [Identity and Memory](./03-identity-memory) for the `clawd-workspace` pattern that gives the bot a coherent persona across all entry points.
