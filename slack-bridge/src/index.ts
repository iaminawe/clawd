import { App } from "@slack/bolt";
import { startup } from "@anthropic-ai/claude-agent-sdk";
import {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  setBotUserId,
  CHANNELS,
  BOARD_CHANNEL_ID,
  DM_ROUTES,
  BOT_USER_ID,
  type AgentName,
} from "./config.js";
import { runQuery } from "./session-manager.js";
import {
  addReaction,
  removeReaction,
  postResponse,
  markdownToSlack,
} from "./slack-responder.js";
import { handleBoardCommand } from "./board-handler.js";
import { logger } from "./logger.js";

// Throttle interval for Slack message updates (ms)
const STREAM_UPDATE_INTERVAL_MS = 1500;

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
  // Prevent bolt from auto-acking with its own response
});

// Handle all messages (channels + DMs + threads)
app.message(async ({ message, client }) => {
  // Type guard for standard messages
  if (message.subtype) return;
  if (!("user" in message) || !message.user || !message.text) return;
  if (!("ts" in message)) return;

  const channelId = message.channel;
  const channelConfig = CHANNELS[channelId];
  const isDM = !channelConfig && (message as any).channel_type === "im";

  // Skip messages not in configured channels or DMs
  if (!channelConfig && !isDM) return;

  // Check requireMention for channels that need it
  if (channelConfig?.requireMention) {
    if (!BOT_USER_ID || !message.text.includes(`<@${BOT_USER_ID}>`)) {
      return;
    }
  }

  // Strip bot mention from text
  const cleanText = BOT_USER_ID
    ? message.text.replace(new RegExp(`<@${BOT_USER_ID}>`, "g"), "").trim()
    : message.text.trim();

  if (!cleanText) return;

  const threadTs = ("thread_ts" in message ? message.thread_ts : undefined) || message.ts;
  const threadKey = `${channelId}:${threadTs}`;
  const channelName = channelConfig?.name || channelId;

  logger.info(
    { channel: channelName, user: message.user, text: cleanText.slice(0, 100) },
    "Message received"
  );

  // Add eyes reaction
  await addReaction(client, channelId, message.ts, "eyes");

  // Check for board commands
  if (channelId === BOARD_CHANNEL_ID) {
    const boardCmd = parseBoardCommand(cleanText);
    if (boardCmd) {
      await handleBoardCommand(client, boardCmd, threadTs);
      await removeReaction(client, channelId, message.ts, "eyes");
      await addReaction(client, channelId, message.ts, "white_check_mark");
      return;
    }
  }

  // Determine agent
  let agent: AgentName = "main";
  const dmRoute = DM_ROUTES[message.user];
  if (dmRoute && isDM) {
    agent = dmRoute.agent;
  }

  try {
    // No "Thinking..." message — :eyes: reaction is the indicator.
    // First message posts only once real content arrives (single notification).
    // Subsequent stream updates use chat.update (no notification).
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

      const slackText = markdownToSlack(text);
      const displayText = slackText.length > 3900
        ? slackText.slice(0, 3900) + "..."
        : slackText;

      if (!firstPostDone) {
        // First post — this is the only notification the user gets
        firstPostDone = true;
        client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: displayText + " :writing_hand:",
        }).then((res) => {
          streamMsgTs = res.ts;
        }).catch(() => {}).finally(() => {
          updatePending = false;
        });
      } else if (streamMsgTs) {
        // Subsequent updates — chat.update doesn't trigger notifications
        client.chat.update({
          channel: channelId,
          ts: streamMsgTs,
          text: displayText + " :writing_hand:",
        }).catch(() => {}).finally(() => {
          updatePending = false;
        });
      } else {
        updatePending = false;
      }
    };

    // Run Claude query with streaming
    const response = await runQuery(agent, cleanText, threadKey, onStream);

    // Final update
    const rawResponse = response || "(no response)";
    const finalText = markdownToSlack(rawResponse);

    if (streamMsgTs) {
      // Update the existing stream message with final content (no new notification)
      try {
        if (finalText.length <= 3900) {
          await client.chat.update({
            channel: channelId,
            ts: streamMsgTs,
            text: finalText,
          });
        } else {
          await client.chat.update({
            channel: channelId,
            ts: streamMsgTs,
            text: finalText.slice(0, 3900) + "...",
          });
          await postResponse(client, channelId, threadTs, finalText.slice(3900));
        }
      } catch {
        await postResponse(client, channelId, threadTs, finalText);
      }
    } else {
      // No stream message was posted (very fast or empty response) — post final directly
      await postResponse(client, channelId, threadTs, finalText);
    }

    await removeReaction(client, channelId, message.ts, "eyes");
    await addReaction(client, channelId, message.ts, "white_check_mark");
  } catch (err) {
    logger.error({ err, channel: channelName }, "Message handling failed");
    await removeReaction(client, channelId, message.ts, "eyes");
    await addReaction(client, channelId, message.ts, "x");

    try {
      const rawMsg = err instanceof Error ? err.message : String(err);
      // The Agent SDK reports `Claude Code process exited with code N` when the
      // spawned `claude` CLI exits non-zero. The most common cause on this host
      // is a stale Keychain ACL after a cask upgrade — claude prints "Not
      // logged in" and bails. Surface an actionable hint instead of the raw.
      const friendly = /Claude Code process exited with code/i.test(rawMsg)
        ? `${rawMsg}\n\nThis usually means the \`claude\` CLI is no longer logged in (often after an upgrade). Run \`claude /login\` in a terminal, then restart the bridge with \`launchctl kickstart -k gui/$UID/net.iaminawe.clawd.slack-bridge\`.`
        : `Error: ${rawMsg}`;
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: friendly,
      });
    } catch {
      // ignore
    }
  }
});

function parseBoardCommand(text: string) {
  const approveMatch = text.match(/^approve\s+([a-zA-Z0-9-]+)\s*(.*)/i);
  if (approveMatch) {
    return {
      type: "approve" as const,
      approvalId: approveMatch[1],
      note: approveMatch[2]?.trim() || "Approved via Slack",
    };
  }
  const denyMatch = text.match(/^deny\s+([a-zA-Z0-9-]+)\s*(.*)/i);
  if (denyMatch) {
    return {
      type: "deny" as const,
      approvalId: denyMatch[1],
      note: denyMatch[2]?.trim() || "Denied via Slack",
    };
  }
  const reviseMatch = text.match(/^revise\s+([a-zA-Z0-9-]+)\s+(.*)/i);
  if (reviseMatch) {
    return {
      type: "revise" as const,
      approvalId: reviseMatch[1],
      note: reviseMatch[2]?.trim(),
    };
  }
  return null;
}

// --- Startup ---
async function main() {
  // Get bot user ID
  const authResult = await app.client.auth.test();
  if (authResult.user_id) {
    setBotUserId(authResult.user_id);
    logger.info({ botUserId: authResult.user_id }, "Bot user ID set");
  }

  await app.start();

  // Pre-warm the SDK runtime
  try {
    logger.info("pre-warm starting");
    const startMs = Date.now();
    await startup();
    const elapsedMs = Date.now() - startMs;
    logger.info(`pre-warm complete in ${elapsedMs}ms`);
  } catch (err) {
    logger.warn({ err }, "SDK pre-warm failed, bridge remains available");
  }

  const channelNames = Object.values(CHANNELS)
    .map((c) => `#${c.name}`)
    .join(", ");
  logger.info({ channels: channelNames }, "Clawd Slack bridge started (Socket Mode)");
  console.log(
    `🐾 Clawd Slack bridge running (Socket Mode) — watching ${channelNames}`
  );
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  console.error("Fatal:", err);
  process.exit(1);
});
