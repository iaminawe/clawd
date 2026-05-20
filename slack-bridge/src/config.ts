import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

// --- Slack tokens (from env or .env file) ---
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
export const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN!;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  throw new Error(
    "SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in environment"
  );
}

// --- Bot user ID (populated at startup) ---
export let BOT_USER_ID = "";
export function setBotUserId(id: string) {
  BOT_USER_ID = id;
}

// --- Channel configuration ---
//
// `AgentName` is the union of agent identifiers the bridge knows how to route
// to. The default install ships with a single `main` agent; add more entries
// here (and to the `AGENTS` map below) to support sub-personas — each gets
// their own `cwd`, `CLAUDE.md`, and MCP allowlist.
export type AgentName = "main";

export interface ChannelConfig {
  name: string;
  requireMention: boolean;
  agent: AgentName;
}

// Map Slack channel IDs to behaviour. `requireMention: true` makes the agent
// only respond when the bot is @-mentioned (useful in busy public channels).
// Replace the example IDs with your own from the Slack API
// (https://api.slack.com/methods/conversations.list).
export const CHANNELS: Record<string, ChannelConfig> = {
  // Example: an always-on general channel
  "<GENERAL_CHANNEL_ID>": { name: "general", requireMention: false, agent: "main" },
  // Example: a standup channel that only responds when mentioned
  "<STANDUP_CHANNEL_ID>": { name: "standup", requireMention: true, agent: "main" },
  // The board channel — referenced by board-handler.ts for approval routing
  "<BOARD_CHANNEL_ID>": { name: "board", requireMention: false, agent: "main" },
};

export const BOARD_CHANNEL_ID = "<BOARD_CHANNEL_ID>";

// --- DM routing ---
//
// Direct messages from these Slack user IDs route to a specific agent. Useful
// when sub-personas have dedicated humans. Leave empty if all DMs go to `main`.
export const DM_ROUTES: Record<string, { agent: AgentName }> = {};

// --- Agent configurations ---
export interface AgentConfig {
  cwd: string;
  systemPromptFile: string;
  maxTurns: number;
  /**
   * Optional MCP allowlist by name. If set, `buildMcpServers()` in the session
   * manager will only attach servers whose name appears here. Undefined =
   * no allowlist (all entries in MCP_SERVERS are considered).
   */
  allowedMcpServers?: string[];
  /**
   * If true, passes `strictMcpConfig: true` to the SDK so it ignores any MCP
   * servers inherited from the user-level `~/.claude/settings.json` and only
   * uses the ones we explicitly attach. Use for narrow-scope sub-agents that
   * shouldn't accidentally inherit dev tools from the main agent.
   */
  strictMcp?: boolean;
}

const HOME = homedir();

// `cwd` is where the Agent SDK reads `CLAUDE.md`, `memory/`, and `skills/`
// from. Point this at your install of the `workspace/` directory.
//
// To add a sub-agent (e.g. a household assistant), add it both to the
// `AgentName` union above and as a new key here with its own cwd:
//
//   secondary: {
//     cwd: resolve(HOME, "clawd-workspace/secondary"),
//     systemPromptFile: resolve(HOME, "clawd-workspace/secondary/CLAUDE.md"),
//     maxTurns: 15,
//     allowedMcpServers: ["paperclip"],   // narrow MCP scope
//     strictMcp: true,                    // don't inherit user-level MCPs
//   },
export const AGENTS: Record<AgentName, AgentConfig> = {
  main: {
    cwd: resolve(HOME, "clawd-workspace"),
    systemPromptFile: resolve(HOME, "clawd-workspace/CLAUDE.md"),
    maxTurns: 25,
  },
};

// --- System-prompt block types ---

/**
 * A plain text block for use in system-prompt assembly.
 */
export interface PromptBlock {
  text: string;
}

/**
 * The split system-prompt result used to support cache_control wiring.
 *
 * staticBlocks  — content that does NOT change per message (CLAUDE.md content,
 *                 skills bundle, other preset-adjacent text). Cached at the
 *                 Anthropic layer with a 1h TTL.
 *
 * dynamicBlocks — content that changes per session or message (cwd injection,
 *                 git status, per-session memory). Never cached.
 */
export interface SystemPromptBlocks {
  staticBlocks: PromptBlock[];
  dynamicBlocks: PromptBlock[];
}

/**
 * Load and split the system prompt for `agent` into static and dynamic blocks.
 *
 * Static:  CLAUDE.md file content — loaded once, identical across all messages
 *          in a session.  Safe to cache at the Anthropic layer.
 *
 * Dynamic: (currently empty) reserved for cwd, git status, and per-session
 *          memory that must not be cached.
 */
export function getSystemPromptBlocks(agent: AgentName): SystemPromptBlocks {
  let claudeMdContent = "";
  try {
    claudeMdContent = readFileSync(AGENTS[agent].systemPromptFile, "utf-8");
  } catch {
    // File missing or unreadable — static section stays empty; SDK preset
    // still runs so the agent is not prompt-less.
  }

  const staticBlocks: PromptBlock[] = claudeMdContent
    ? [{ text: claudeMdContent }]
    : [];

  const dynamicBlocks: PromptBlock[] = [];

  return { staticBlocks, dynamicBlocks };
}

// --- Concurrency ---
export const MAX_CONCURRENT_SESSIONS = 4;
export const MAX_QUEUE_SIZE = 10;

// --- Per-thread cost cap ---
//
// Hard cap on cumulative tokens (input + output, including cache reads) per
// Slack thread since bridge boot. Catches pathological runaway threads that
// would otherwise burn through the Anthropic quota silently.
//
// Default 5M tokens ≈ 25 full-context turns at the 200k window, which is far
// more than any normal Slack thread but small enough to clip a loop quickly.
// Override per-deployment with PER_THREAD_TOKEN_CAP env var. Set to 0 to
// disable the cap entirely.
export const PER_THREAD_TOKEN_CAP =
  parseInt(process.env.PER_THREAD_TOKEN_CAP ?? "", 10) || 5_000_000;

// --- MCP server registry ---
//
// Each entry describes one MCP server's load policy and (for multi-tenant
// servers) a mapping from Slack channel ID → active tenant key.
//
// alwaysLoad:true  → attach to every SDK call regardless of channel.
// alwaysLoad:false → deferred; the resolver in session-manager picks the right
//                    tenant per message using `channelDomains` before
//                    attaching.

export interface McpServerConfig {
  /** Human-readable label for logs / debug output */
  label: string;
  /** If true the MCP is always attached; if false it is channel-scoped */
  alwaysLoad: boolean;
  /**
   * Channel-to-tenant mapping.
   * Key  : Slack channel ID (matches CHANNELS keys above).
   * Value: tenant slug/domain passed to the MCP server.
   * Only populated for multi-tenant MCP servers. Channels that have no
   * active tenant are omitted.
   */
  channelDomains?: Record<string, string>;
}

/**
 * Central MCP server registry for the slack-bridge.
 *
 * `paperclip` is always loaded — it carries cross-context orchestration tools
 * that every message may need.
 *
 * Channel-scoped multi-tenant MCPs (e.g. a per-project tool server) use
 * `alwaysLoad: false` plus `channelDomains` to map channels to tenants.
 * Example:
 *
 *   myapp: {
 *     label: "MyApp (per-tenant)",
 *     alwaysLoad: false,
 *     channelDomains: {
 *       "<CHANNEL_ID_A>": "tenant-a",
 *       "<CHANNEL_ID_B>": "tenant-b",
 *     },
 *   },
 */
export const MCP_SERVERS: Record<string, McpServerConfig> = {
  paperclip: {
    label: "Paperclip Orchestrator",
    alwaysLoad: true,
  },
};

/** Convenience: the Paperclip REST API base URL. */
export const PAPERCLIP_API = "http://127.0.0.1:3100/api";
