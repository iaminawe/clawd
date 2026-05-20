import type { WebClient } from "@slack/web-api";
import { PAPERCLIP_API, BOARD_CHANNEL_ID } from "./config.js";
import { logger } from "./logger.js";

interface BoardCommand {
  type: "approve" | "deny" | "revise";
  approvalId: string;
  note: string;
}

export async function handleBoardCommand(
  client: WebClient,
  command: BoardCommand,
  threadTs: string
): Promise<void> {
  try {
    // Resolve short IDs by looking up pending approvals
    let fullApprovalId = command.approvalId;

    if (command.approvalId.length <= 8) {
      fullApprovalId = await resolveShortId(command.approvalId);
    }

    const actionMap = {
      approve: "approve",
      deny: "reject",
      revise: "request-revision",
    } as const;

    const action = actionMap[command.type];
    const url = `${PAPERCLIP_API}/approvals/${fullApprovalId}/${action}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisionNote: command.note }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Paperclip API error ${response.status}: ${errorText}`);
    }

    const emoji = command.type === "approve" ? "✅" : command.type === "deny" ? "❌" : "📝";
    const verb = command.type === "approve" ? "Approved" : command.type === "deny" ? "Denied" : "Revision requested for";

    await client.chat.postMessage({
      channel: BOARD_CHANNEL_ID,
      thread_ts: threadTs,
      text: `${emoji} ${verb} ${command.approvalId} — agent will be notified.`,
    });

    logger.info(
      { action: command.type, approvalId: fullApprovalId },
      "Board command processed"
    );
  } catch (err) {
    logger.error({ err, command }, "Board command failed");
    await client.chat.postMessage({
      channel: BOARD_CHANNEL_ID,
      thread_ts: threadTs,
      text: `⚠️ Failed to process ${command.type} for ${command.approvalId}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function resolveShortId(shortId: string): Promise<string> {
  const response = await fetch(
    `${PAPERCLIP_API}/approvals?status=pending`
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch pending approvals: ${response.status}`);
  }

  const approvals: any[] = await response.json();
  const match = approvals.find(
    (a: any) =>
      a.id?.startsWith(shortId) ||
      a.issueIdentifier?.includes(shortId.toUpperCase())
  );

  if (!match) {
    throw new Error(
      `No pending approval found matching "${shortId}"`
    );
  }

  return match.id;
}
