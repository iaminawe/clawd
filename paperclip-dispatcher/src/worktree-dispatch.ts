#!/usr/bin/env node

/**
 * Worktree Dispatch
 *
 * Dispatches code tasks to Claude Code agents in isolated git worktrees.
 * Each agent gets its own branch, works independently, opens a PR, and
 * reports back to Slack.
 *
 * Usage:
 *   worktree-dispatch --repo <path> --task <description> [--branch <name>] [--channel <slack-ch>]
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAgentOptions } from "./agent-options.js";

interface DispatchOptions {
  repo: string;
  task: string;
  branch?: string;
  channel?: string;
  model?: string;
  timeoutSeconds?: number;
}

/**
 * Create an isolated git worktree, run an agent in it, then clean up.
 */
export async function dispatchToWorktree(opts: DispatchOptions): Promise<{
  branch: string;
  result: string;
  prUrl?: string;
}> {
  const { repo, task, timeoutSeconds = 300 } = opts;
  const branchName = opts.branch ?? `agent/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const worktreeDir = mkdtempSync(join(tmpdir(), "cc-worktree-"));

  try {
    // Create worktree with new branch
    console.error(`Creating worktree at ${worktreeDir} on branch ${branchName}...`);
    execSync(`git -C "${repo}" worktree add "${worktreeDir}" -b "${branchName}"`, {
      stdio: "pipe",
    });

    // Build the agent prompt
    const prompt = [
      `You are working in an isolated git worktree on branch \`${branchName}\`.`,
      `Your task: ${task}`,
      "",
      "Instructions:",
      "1. Understand the codebase and the task",
      "2. Make the necessary changes",
      "3. Run tests if they exist",
      "4. Commit your changes with a clear message",
      "5. When done, output a summary of what you changed and why",
      "",
      "Do NOT push or create PRs — that will be handled after you finish.",
    ].join("\n");

    // Run the agent
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutSeconds * 1000);

    const agentOptions = buildAgentOptions({
      abortController,
      cwd: worktreeDir,
      maxTurns: 50,
    });

    console.error(
      `[budget] start: input=${agentOptions.taskBudget.inputTokens} output=${agentOptions.taskBudget.outputTokens}`,
    );

    const parts: string[] = [];
    try {
      const { taskBudget, ...sdkOptions } = agentOptions;
      const result = query({
        prompt,
        options: {
          ...sdkOptions,
          taskBudget: { total: taskBudget.inputTokens + taskBudget.outputTokens },
        },
      });

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
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    console.error(
      `[budget] end: input=${agentOptions.taskBudget.inputTokens} output=${agentOptions.taskBudget.outputTokens}`,
    );

    const agentResult = parts.join("\n").trim();

    // Check if agent made commits
    const hasCommits = (() => {
      try {
        const mainBranch = execSync(`git -C "${worktreeDir}" rev-parse --abbrev-ref HEAD@{upstream} 2>/dev/null || echo main`, {
          encoding: "utf-8",
        }).trim();
        const log = execSync(`git -C "${worktreeDir}" log ${mainBranch}..HEAD --oneline 2>/dev/null`, {
          encoding: "utf-8",
        }).trim();
        return log.length > 0;
      } catch {
        return false;
      }
    })();

    let prUrl: string | undefined;

    if (hasCommits) {
      // Push branch and create PR
      try {
        execSync(`git -C "${worktreeDir}" push -u origin "${branchName}"`, { stdio: "pipe" });
        const prOutput = execSync(
          `cd "${worktreeDir}" && gh pr create --title "Agent: ${task.slice(0, 60)}" --body "Automated PR from worktree dispatch.\n\n${agentResult.slice(0, 500)}" 2>&1`,
          { encoding: "utf-8" },
        );
        prUrl = prOutput.trim().split("\n").pop();
      } catch (err) {
        console.error("Failed to create PR:", err);
      }
    }

    return { branch: branchName, result: agentResult, prUrl };
  } finally {
    // Clean up worktree
    try {
      execSync(`git -C "${repo}" worktree remove "${worktreeDir}" --force`, { stdio: "pipe" });
    } catch {
      // Force remove if git cleanup fails
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const repo = getArg("--repo");
  const task = getArg("--task");
  const branch = getArg("--branch");
  const channel = getArg("--channel");

  if (!repo || !task) {
    console.log("Worktree Dispatch — isolated agent task runner");
    console.log("");
    console.log("Usage:");
    console.log("  worktree-dispatch --repo <path> --task <description> [--branch <name>] [--channel <slack-ch>]");
    console.log("");
    console.log("Example:");
    console.log('  worktree-dispatch --repo ~/Work/example-tenant-a --task "Fix the broken image upload on product pages"');
    process.exit(1);
  }

  console.log(`Dispatching task to worktree...`);
  console.log(`  Repo: ${repo}`);
  console.log(`  Task: ${task}`);

  const { branch: usedBranch, result, prUrl } = await dispatchToWorktree({
    repo,
    task,
    branch,
    channel,
  });

  console.log(`\nBranch: ${usedBranch}`);
  if (prUrl) console.log(`PR: ${prUrl}`);
  console.log(`\nResult:\n${result}`);

  // Post to Slack if channel specified
  if (channel && process.env.SLACK_BOT_TOKEN) {
    const slackText = [
      `*🔧 Agent task completed*`,
      `> ${task}`,
      `Branch: \`${usedBranch}\``,
      prUrl ? `PR: ${prUrl}` : "No commits made.",
    ].join("\n");

    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, text: slackText, unfurl_links: false }),
    });
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
