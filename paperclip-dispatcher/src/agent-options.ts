/**
 * Shared agent options builder for Paperclip Dispatcher.
 *
 * Centralises the SDK options object that was previously duplicated in
 * src/index.ts and src/worktree-dispatch.ts, and adds a typed taskBudget
 * field backed by environment variables.
 *
 * Usage:
 *   const options = buildAgentOptions({ cwd: worktreeDir, maxTurns: 50 });
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * Token budget for a single agent invocation.
 *
 * Pulled from environment variables at call time so that callers can override
 * via process.env before the first call, or supply explicit values via the
 * `overrides` argument of `buildAgentOptions`.
 */
export interface TaskBudget {
  /** Maximum input tokens. Default: TASK_BUDGET_INPUT env var (200_000). */
  inputTokens: number;
  /** Maximum output tokens. Default: TASK_BUDGET_OUTPUT env var (100_000). */
  outputTokens: number;
}

/**
 * Superset of the SDK Options that includes the dispatcher-level taskBudget.
 *
 * The base SDK `Options.taskBudget` field is `{ total: number }` and is used
 * for API-side pacing. This extended type carries the dispatcher's split-budget
 * (input + output) alongside the rest of the standard options.
 *
 * T03.2 and T03.3 will map `taskBudget.inputTokens + taskBudget.outputTokens`
 * to the SDK's `taskBudget.total` when wiring the options into actual queries.
 */
export interface AgentOptions extends Omit<Options, "taskBudget"> {
  taskBudget: TaskBudget;
}

const DEFAULT_ALLOWED_TOOLS: string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
];

/**
 * Build the options object for an agent query.
 *
 * Returns a fully-populated `AgentOptions` value. The `abortController` field
 * is intentionally left out of the return value — callers must supply their own
 * per-invocation controller via `overrides.abortController` so that each call
 * retains independent cancellation control.
 *
 * @param overrides - Partial options merged on top of the defaults. All fields
 *   are optional; supply only what differs from the defaults.
 *
 * @example
 * ```ts
 * const abortController = new AbortController();
 * const options = buildAgentOptions({
 *   abortController,
 *   cwd: worktreeDir,
 *   maxTurns: 50,
 * });
 * ```
 */
export function buildAgentOptions(overrides?: Partial<AgentOptions>): AgentOptions {
  const defaultInputTokens =
    parseInt(process.env["TASK_BUDGET_INPUT"] ?? "", 10) || 200_000;
  const defaultOutputTokens =
    parseInt(process.env["TASK_BUDGET_OUTPUT"] ?? "", 10) || 100_000;

  // Sandbox: opt-out only. Default to enabled so cron agents run jailed —
  // macOS Seatbelt filesystem confinement to `cwd` and proxied network. Set
  // PAPERCLIP_SANDBOX=0 to disable for a specific run (e.g. debugging).
  // failIfUnavailable: false means if the sandbox can't start (different OS,
  // missing deps), the agent runs unsandboxed with a warning rather than
  // failing outright — preserves availability while we ramp up usage.
  const sandboxEnabled =
    (process.env["PAPERCLIP_SANDBOX"] ?? "1").toLowerCase() !== "0" &&
    (process.env["PAPERCLIP_SANDBOX"] ?? "1").toLowerCase() !== "false";

  const defaults: AgentOptions = {
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 30,
    taskBudget: {
      inputTokens: defaultInputTokens,
      outputTokens: defaultOutputTokens,
    },
    sandbox: {
      enabled: sandboxEnabled,
      failIfUnavailable: false,
    },
  };

  if (!overrides) {
    return defaults;
  }

  const { taskBudget: budgetOverride, ...rest } = overrides;

  return {
    ...defaults,
    ...rest,
    taskBudget: {
      ...defaults.taskBudget,
      ...budgetOverride,
    },
  };
}
