import { WebClient } from "@slack/web-api";
import { SLACK_BOT_TOKEN, CHANNELS, BOT_USER_ID } from "./config.js";
import { logger } from "./logger.js";

const client = new WebClient(SLACK_BOT_TOKEN);
const POLL_INTERVAL_MS = 3000;

// Track last seen timestamp per channel
const lastSeen = new Map<string, string>();
// Deduplicate — track processed message timestamps
const processed = new Set<string>();

export interface PollMessage {
  channel: string;
  channelName: string;
  user: string;
  text: string;
  ts: string;
  threadTs?: string;
}

type MessageHandler = (msg: PollMessage) => Promise<void>;
let handler: MessageHandler | null = null;

export function onMessage(fn: MessageHandler): void {
  handler = fn;
}

export async function startPolling(): Promise<void> {
  // Initialize lastSeen to now for all channels
  const now = (Date.now() / 1000).toString();
  for (const channelId of Object.keys(CHANNELS)) {
    lastSeen.set(channelId, now);
  }

  // Also poll DMs
  try {
    const convos = await client.conversations.list({
      types: "im",
      limit: 50,
    });
    for (const ch of convos.channels || []) {
      if (ch.is_member || (ch as any).is_open) {
        lastSeen.set(ch.id!, now);
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to list DM channels");
  }

  logger.info(
    { channelCount: lastSeen.size },
    "Polling started"
  );

  // Poll loop — sequential, wait for each cycle to finish
  const poll = async () => {
    while (true) {
      await pollAll();
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  };
  poll();
}

async function pollAll(): Promise<void> {
  for (const [channelId, oldest] of lastSeen.entries()) {
    try {
      const result = await client.conversations.history({
        channel: channelId,
        oldest,
        limit: 10,
        inclusive: false,
      });

      const messages = (result.messages || []).reverse();
      for (const msg of messages) {
        // Update lastSeen
        if (
          parseFloat(msg.ts!) > parseFloat(lastSeen.get(channelId) || "0")
        ) {
          lastSeen.set(channelId, msg.ts!);
        }

        // Skip bot messages, subtypes (joins, leaves, etc)
        if (msg.bot_id || msg.subtype) continue;
        if (msg.user === BOT_USER_ID) continue;
        if (!msg.user || !msg.text) continue;

        // Deduplicate
        if (processed.has(msg.ts!)) continue;
        processed.add(msg.ts!);
        // Keep set from growing unbounded
        if (processed.size > 500) {
          const entries = [...processed];
          entries.slice(0, 250).forEach((ts) => processed.delete(ts));
        }

        const channelConfig = CHANNELS[channelId];
        const channelName = channelConfig?.name || channelId;

        // Check requireMention
        if (channelConfig?.requireMention) {
          if (!BOT_USER_ID || !msg.text.includes(`<@${BOT_USER_ID}>`)) {
            continue;
          }
        }

        const pollMsg: PollMessage = {
          channel: channelId,
          channelName,
          user: msg.user,
          text: msg.text
            .replace(new RegExp(`<@${BOT_USER_ID}>`, "g"), "")
            .trim(),
          ts: msg.ts!,
          threadTs: (msg as any).thread_ts,
        };

        logger.info(
          {
            channel: channelName,
            user: msg.user,
            text: pollMsg.text.slice(0, 100),
          },
          "Message received"
        );

        if (handler) {
          handler(pollMsg).catch((err) => {
            logger.error({ err, channel: channelName }, "Handler error");
          });
        }
      }
    } catch (err: any) {
      // Rate limit — back off
      if (err?.data?.error === "ratelimited") {
        logger.warn({ channel: channelId }, "Rate limited, backing off");
        await new Promise((r) => setTimeout(r, 5000));
      } else if (err?.data?.error !== "channel_not_found") {
        logger.error({ err, channel: channelId }, "Poll error");
      }
    }
  }
}

// Also poll thread replies for active threads
// (can be added later if needed)
