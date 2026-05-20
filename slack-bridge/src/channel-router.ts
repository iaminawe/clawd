import type { KnownEventFromType } from "@slack/bolt";
import type { AgentName } from "./config.js";
import {
  BOT_USER_ID,
  CHANNELS,
  DM_ROUTES,
  BOARD_CHANNEL_ID,
} from "./config.js";
import { logger } from "./logger.js";

export interface RouteResult {
  action: "process" | "skip" | "board_command";
  agent: AgentName;
  cleanText: string;
  boardCommand?: {
    type: "approve" | "deny" | "revise";
    approvalId: string;
    note: string;
  };
}

export function routeMessage(
  event: KnownEventFromType<"message">
): RouteResult {
  const channelId = event.channel;
  const text = ("text" in event && event.text) || "";
  const userId = ("user" in event && event.user) || "";
  const channelType = event.channel_type;

  // --- DM routing ---
  if (channelType === "im") {
    const dmRoute = DM_ROUTES[userId];
    if (dmRoute) {
      logger.info({ userId, agent: dmRoute.agent }, "DM routed");
      return { action: "process", agent: dmRoute.agent, cleanText: text };
    }
    // Default DMs go to main
    return { action: "process", agent: "main", cleanText: text };
  }

  // --- Channel routing ---
  const channelConfig = CHANNELS[channelId];
  if (!channelConfig) {
    logger.debug({ channelId }, "Message from unconfigured channel, skipping");
    return { action: "skip", agent: "main", cleanText: "" };
  }

  // Check requireMention
  if (channelConfig.requireMention) {
    if (!BOT_USER_ID || !text.includes(`<@${BOT_USER_ID}>`)) {
      return { action: "skip", agent: "main", cleanText: "" };
    }
  }

  // Strip bot mention from text
  const cleanText = text
    .replace(new RegExp(`<@${BOT_USER_ID}>`, "g"), "")
    .trim();

  // --- Board command parsing ---
  if (channelId === BOARD_CHANNEL_ID) {
    const boardCmd = parseBoardCommand(cleanText);
    if (boardCmd) {
      return {
        action: "board_command",
        agent: "main",
        cleanText,
        boardCommand: boardCmd,
      };
    }
  }

  return {
    action: "process",
    agent: channelConfig.agent,
    cleanText,
  };
}

function parseBoardCommand(
  text: string
): RouteResult["boardCommand"] | null {
  const approveMatch = text.match(
    /^approve\s+([a-zA-Z0-9-]+)\s*(.*)/i
  );
  if (approveMatch) {
    return {
      type: "approve",
      approvalId: approveMatch[1],
      note: approveMatch[2]?.trim() || "Approved via Slack",
    };
  }

  const denyMatch = text.match(/^deny\s+([a-zA-Z0-9-]+)\s*(.*)/i);
  if (denyMatch) {
    return {
      type: "deny",
      approvalId: denyMatch[1],
      note: denyMatch[2]?.trim() || "Denied via Slack",
    };
  }

  const reviseMatch = text.match(
    /^revise\s+([a-zA-Z0-9-]+)\s+(.*)/i
  );
  if (reviseMatch) {
    return {
      type: "revise",
      approvalId: reviseMatch[1],
      note: reviseMatch[2]?.trim(),
    };
  }

  return null;
}
