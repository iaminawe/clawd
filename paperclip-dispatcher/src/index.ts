#!/usr/bin/env node

/**
 * Paperclip Dispatcher
 *
 * Replaces run-task.sh with Agent SDK-based task execution.
 * Supports: streaming, error recovery, Slack delivery, timeout control.
 *
 * Usage:
 *   paperclip-dispatch run <prompt> [--channel <slack-channel>] [--timeout <seconds>] [--cwd <dir>]
 *   paperclip-dispatch cron                # Run all enabled cron jobs on schedule
 *   paperclip-dispatch job <job-name>      # Run a specific job by name
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentOptions } from "./agent-options.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const LOG_DIR = join(process.env.HOME ?? "/tmp", "Library/Logs/paperclip-dispatcher");
const JOBS_FILE = join(process.env.HOME ?? "", "Library/Application Support/clawd/cron/jobs.json");
const SILENT_RESPONSES = new Set(["HEARTBEAT_OK", "NO_ALERT", "NO_REPLY"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  name: string;
  enabled: boolean;
  payload: {
    kind: string;
    message: string;
    timeoutSeconds?: number;
    model?: string;
  };
  delivery: {
    mode: string;
    channel?: string;
    to?: string;
  };
  schedule: {
    kind: string;
    expr?: string;
    tz?: string;
    everyMs?: number;
  };
}

interface JobsFile {
  version: number;
  jobs: Job[];
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function log(jobName: string, message: string) {
  ensureLogDir();
  const line = `${new Date().toISOString()} ${message}\n`;
  appendFileSync(join(LOG_DIR, `${jobName}.log`), line);
}

// ---------------------------------------------------------------------------
// Slack posting
// ---------------------------------------------------------------------------

async function postToSlack(channel: string, text: string): Promise<void> {
  if (!SLACK_BOT_TOKEN) {
    console.error("SLACK_BOT_TOKEN not set, skipping Slack post");
    return;
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text,
      unfurl_links: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`Slack API error: ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Run a prompt via Agent SDK
// ---------------------------------------------------------------------------

async function runPrompt(opts: {
  prompt: string;
  cwd?: string;
  timeoutSeconds?: number;
  model?: string;
}): Promise<string> {
  const { prompt, cwd, timeoutSeconds = 120 } = opts;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutSeconds * 1000);

  const agentOptions = buildAgentOptions({
    abortController,
    cwd: cwd ?? process.cwd(),
  });

  const { taskBudget } = agentOptions;
  console.log(
    `task budget: input=${taskBudget.inputTokens}, output=${taskBudget.outputTokens}`,
  );

  // Map the dispatcher split-budget to the SDK's total budget field.
  const sdkOptions = {
    ...agentOptions,
    taskBudget: {
      total: taskBudget.inputTokens + taskBudget.outputTokens,
    },
  };

  try {
    const result = query({ prompt, options: sdkOptions });

    const parts: string[] = [];

    for await (const message of result) {
      if (message.type === "assistant") {
        const msg = message as { type: string; content?: Array<{ type: string; text?: string }> };
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              parts.push(block.text);
            }
          }
        }
      } else if (message.type === "result") {
        // The SDK emits a final result message with accumulated usage.
        const resultMsg = message as {
          type: "result";
          subtype?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
          stop_reason?: string | null;
          terminal_reason?: string;
        };

        const consumedInput = resultMsg.usage?.input_tokens ?? 0;
        const consumedOutput = resultMsg.usage?.output_tokens ?? 0;

        // Detect budget-exceeded: terminal_reason === "blocking_limit" signals the
        // API-side task budget was hit. We also check stop_reason for completeness.
        const budgetExceeded =
          resultMsg.terminal_reason === "blocking_limit" ||
          resultMsg.stop_reason === "max_tokens";

        if (budgetExceeded) {
          console.error(
            `task budget exceeded: consumed input=${consumedInput}, output=${consumedOutput}` +
              ` (budget input=${taskBudget.inputTokens}, output=${taskBudget.outputTokens})`,
          );
          clearTimeout(timeout);
          process.exit(1);
        }

        console.log(
          `task complete: consumed input=${consumedInput}, output=${consumedOutput}`,
        );
      }
    }

    return parts.join("\n").trim();
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Run a specific job
// ---------------------------------------------------------------------------

async function runJob(job: Job): Promise<void> {
  const jobName = job.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  log(jobName, `Starting job: ${job.name}`);

  try {
    const result = await runPrompt({
      prompt: job.payload.message,
      timeoutSeconds: job.payload.timeoutSeconds ?? 120,
      model: job.payload.model,
    });

    log(jobName, `Completed (${result.length} chars)`);

    // Check for silent responses
    const trimmed = result.trim();
    if (SILENT_RESPONSES.has(trimmed)) {
      log(jobName, `Silent response: ${trimmed}`);
      return;
    }

    // Deliver to Slack if configured
    if (job.delivery.mode === "announce" && job.delivery.to) {
      const text = result.length > 3900 ? result.slice(0, 3900) + "... (truncated)" : result;
      await postToSlack(job.delivery.to, text);
      log(jobName, `Posted to Slack ${job.delivery.to}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(jobName, `ERROR: ${message}`);
    console.error(`Job ${job.name} failed:`, message);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "run": {
      // Direct prompt execution
      const prompt = args[1];
      if (!prompt) {
        console.error("Usage: paperclip-dispatch run <prompt> [--channel <ch>] [--timeout <s>]");
        process.exit(1);
      }
      const channelIdx = args.indexOf("--channel");
      const channel = channelIdx >= 0 ? args[channelIdx + 1] : undefined;
      const timeoutIdx = args.indexOf("--timeout");
      const timeout = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1], 10) : 120;

      const result = await runPrompt({ prompt, timeoutSeconds: timeout });

      if (!SILENT_RESPONSES.has(result.trim())) {
        if (channel) {
          await postToSlack(channel, result);
        } else {
          console.log(result);
        }
      }
      break;
    }

    case "job": {
      // Run a specific job by name
      const jobName = args.slice(1).join(" ");
      if (!jobName) {
        console.error("Usage: paperclip-dispatch job <job-name>");
        process.exit(1);
      }

      const jobsData: JobsFile = JSON.parse(readFileSync(JOBS_FILE, "utf-8"));
      const job = jobsData.jobs.find(
        (j) => j.name.toLowerCase() === jobName.toLowerCase() || j.id === jobName,
      );

      if (!job) {
        console.error(`Job not found: ${jobName}`);
        console.error("Available jobs:", jobsData.jobs.map((j) => j.name).join(", "));
        process.exit(1);
      }

      await runJob(job);
      break;
    }

    case "list": {
      // List all jobs
      const jobsData: JobsFile = JSON.parse(readFileSync(JOBS_FILE, "utf-8"));
      for (const job of jobsData.jobs) {
        const status = job.enabled ? "enabled" : "disabled";
        const schedule =
          job.schedule.kind === "cron"
            ? `cron: ${job.schedule.expr}`
            : `every ${(job.schedule.everyMs ?? 0) / 60000}min`;
        console.log(`  ${status === "enabled" ? "✓" : "✗"} ${job.name} (${schedule})`);
      }
      break;
    }

    default:
      console.log("Paperclip Dispatcher — Agent SDK task runner");
      console.log("");
      console.log("Commands:");
      console.log("  run <prompt>          Run a prompt directly");
      console.log("  job <name>            Run a specific job from jobs.json");
      console.log("  list                  List all configured jobs");
      console.log("");
      console.log("Options:");
      console.log("  --channel <id>        Post result to Slack channel");
      console.log("  --timeout <seconds>   Execution timeout (default: 120)");
      break;
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
