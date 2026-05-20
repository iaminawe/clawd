import type { WebClient } from "@slack/web-api";
import { logger } from "./logger.js";

const STREAM_INTERVAL_MS = 500;
const MAX_MESSAGE_LENGTH = 3900; // Slack limit is 4000, leave buffer

export async function addReaction(
  client: WebClient,
  channel: string,
  timestamp: string,
  emoji: string
): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp, name: emoji });
  } catch (err: any) {
    // "already_reacted" is fine
    if (err?.data?.error !== "already_reacted") {
      logger.warn({ err, emoji, channel }, "Failed to add reaction");
    }
  }
}

export async function removeReaction(
  client: WebClient,
  channel: string,
  timestamp: string,
  emoji: string
): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp, name: emoji });
  } catch {
    // ignore — reaction may not exist
  }
}

export async function postResponse(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string
): Promise<void> {
  // Split long messages
  const chunks = splitMessage(text);

  for (const chunk of chunks) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: chunk,
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}

export async function postStreamedResponse(
  client: WebClient,
  channel: string,
  threadTs: string,
  getResponse: () => Promise<string>
): Promise<void> {
  // Post initial "thinking..." message
  const initial = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: ":hourglass_flowing_sand: Thinking...",
  });

  const messageTs = initial.ts;
  if (!messageTs) {
    // Fallback: just wait and post
    const text = await getResponse();
    await postResponse(client, channel, threadTs, text);
    return;
  }

  // Wait for the full response
  const text = await getResponse();

  // Update the message with the final response
  const chunks = splitMessage(text);

  try {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: chunks[0],
    });
  } catch (err) {
    logger.warn({ err }, "Failed to update message, posting new one");
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: chunks[0],
    });
  }

  // Post additional chunks as separate messages
  for (let i = 1; i < chunks.length; i++) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: chunks[i],
    });
  }
}

/**
 * Convert GitHub-flavored Markdown to Slack mrkdwn format.
 */
export function markdownToSlack(text: string): string {
  let out = text;

  // Headers → bold text (### Header → *Header*)
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold: **text** or __text__ → *text*
  // Must handle before italic to avoid conflicts
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");
  out = out.replace(/__(.+?)__/g, "*$1*");

  // Italic: *text* (single) or _text_ → _text_
  // Skip if already converted bold (*text*)
  // Only convert _text_ that isn't inside a word (e.g. snake_case)
  out = out.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "_$1_");

  // Strikethrough: ~~text~~ → ~text~
  out = out.replace(/~~(.+?)~~/g, "~$1~");

  // Inline code: `text` stays as `text` (Slack supports this)

  // Code blocks: ```lang\n...\n``` → ```\n...\n```
  out = out.replace(/```[a-zA-Z]*\n/g, "```\n");

  // Links: [text](url) → <url|text>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Images: ![alt](url) → <url|alt>
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>");

  // Horizontal rules: --- or *** → ———
  out = out.replace(/^[-*]{3,}$/gm, "———");

  // Blockquotes: > text → > text (Slack supports this natively)

  return out;
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH / 2) {
      // No good newline, split at space
      splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    }
    if (splitAt < MAX_MESSAGE_LENGTH / 2) {
      // No good split point, just hard split
      splitAt = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
