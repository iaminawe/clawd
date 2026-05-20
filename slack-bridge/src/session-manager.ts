import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { SupabaseSessionStore } from "./session-store-supabase.js";
import type { AgentName } from "./config.js";
import {
  AGENTS,
  CHANNELS,
  getSystemPromptBlocks,
  MAX_CONCURRENT_SESSIONS,
  MAX_QUEUE_SIZE,
  MCP_SERVERS,
  PER_THREAD_TOKEN_CAP,
} from "./config.js";
import { logger } from "./logger.js";

const QUERY_TIMEOUT_MS = 300_000; // 5 minutes max per query

/**
 * The CLI writes per-session JSONL to ~/.claude/projects/<encoded-cwd>/<id>.jsonl
 * where <encoded-cwd> is the absolute cwd with `/` replaced by `-`. Used to
 * decide whether to claim a fresh sessionId or `resume:` an existing one.
 */
function sessionJsonlExists(cwd: string, sessionId: string): boolean {
  const encodedCwd = cwd.replace(/\//g, "-");
  return existsSync(join(homedir(), ".claude", "projects", encodedCwd, `${sessionId}.jsonl`));
}

// --- Tool Search / Programmatic Tool Calling beta wiring (T04.2) ---
//
// SDK 0.3.142's `SdkBeta` type only enumerates `'context-1m-2025-08-07'`,
// but the runtime accepts any beta header string. The advanced-tool-use
// beta (`advanced-tool-use-2025-11-20`) is what enables both Tool Search
// Tool deferral and Programmatic Tool Calling. Verified against the
// pinned SDK's assistant.mjs at task execution time (see proof artifact).
//
// If/when the SDK rotates this header, update the constant and re-run
// the T04.4 smoke test.
const ADVANCED_TOOL_USE_BETA = "advanced-tool-use-2025-11-20";

// --- Supabase SessionStore wiring (T06.3) ---------------------------------
//
// Instantiate once at module load. If the env vars are missing or the
// constructor throws for any reason, we fall back to NOT passing sessionStore
// to query() (the SDK then defaults to in-memory / local-JSONL storage).
// This keeps the bridge startable when Supabase creds are not yet configured.
//
// Per the adapter's own contract (session-store-supabase.ts):
//   - load()   soft-fails and returns null on outage  (thread treated as new)
//   - append() soft-fails and resolves on outage       (SDK retries 3x)
//   - delete() soft-fails and resolves on outage       (cleanup is best-effort)
// So runtime outages are already tolerated by the adapter; this catch only
// handles startup credential failures.
let sessionStore: SessionStore | undefined;
try {
  sessionStore = new SupabaseSessionStore();
  logger.info("SupabaseSessionStore initialised; sessions will be mirrored to Supabase");
} catch (err) {
  logger.warn(
    { err },
    "SupabaseSessionStore could not be instantiated (missing SUPABASE_URL / " +
      "SUPABASE_SERVICE_ROLE_KEY?); falling back to SDK-default in-memory " +
      "session storage. Set env vars to enable Supabase session persistence."
  );
  sessionStore = undefined;
}

// --- Thread-key → Session-ID mapping (T06.3) ------------------------------
//
// We derive a STABLE, deterministic UUID-format session ID from the Slack
// thread key ("<channelId>:<threadTs>"). This replaces the old in-memory
// Map<string, string> (threadSessions) which was lost on bridge restart.
//
// Approach: SHA-256(threadKey) → UUID v4-format string (version nibble=4,
// variant bits set). Not RFC 4122 v5 (no namespace UUID), but the output
// is a valid UUID string that the SDK accepts for `sessionId`. The mapping
// is bijective for all practical thread keys.
//
// Why not keep the Map?
//   The old Map only survived process restarts if in-memory state was
//   somehow persisted. With sessionStore providing cross-restart continuity,
//   the session KEY must be stable across restarts too. A deterministic ID
//   derived from the thread key achieves both:
//     1. Same thread → same UUID across restarts → SDK can resume from store
//     2. No Map state needed → simpler module, no memory leak concern
//
// We pass this as `sessionId:` (not `resume:`). The SDK will:
//   - call sessionStore.load({ projectKey, sessionId }) on each call
//   - if the store returns entries: resume the existing session
//   - if the store returns null (new thread or store unavailable): start fresh
// `resume:` is no longer needed; `sessionId:` + `sessionStore:` together
// provide the same continuity guarantee, plus cross-restart durability.
function threadKeyToSessionId(threadKey: string): string {
  const hash = createHash("sha256").update(threadKey).digest("hex");
  // Format: 8-4-4-4-12 groups, version nibble = 4, variant bits = 10xx
  const variantNibble = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "4" + hash.slice(13, 16),
    variantNibble + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join("-");
}

// --- MCP transport loader -------------------------------------------------
//
// config.ts intentionally holds only policy metadata (label, alwaysLoad,
// channelDomains). The actual stdio/HTTP transports live in the user-level
// Claude CLI config (~/.claude/settings.json), already managed by `claude
// mcp add ...`. We load them here so we can re-emit a merged shape to the
// SDK with policy applied — without duplicating secrets in source.
//
// The SDK merges these entries with the CLI's inherited config (additive
// per SDK source comment: "in addition to those in the .mcp.json").
// Same-named entries take precedence, which is exactly what we want so
// `alwaysLoad` policy is honored.
//
// Failure to load the transports file is logged but non-fatal: the query
// still runs and the CLI's inherited MCP config provides a safe fallback.
// In that fallback path, Tool Search will still be off for the un-policied
// servers — but paperclip stays attached because the CLI loads it by name.

interface RawMcpStdio {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface RawMcpHttp {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

type RawMcpEntry = RawMcpStdio | RawMcpHttp;

const CLAUDE_SETTINGS_PATH = resolve(
  homedir(),
  ".claude/settings.json"
);

function loadMcpTransports(): Record<string, RawMcpEntry> {
  try {
    const raw = readFileSync(CLAUDE_SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, RawMcpEntry>;
    };
    return parsed.mcpServers ?? {};
  } catch (err) {
    logger.warn(
      { err, path: CLAUDE_SETTINGS_PATH },
      "Could not load MCP transports from ~/.claude/settings.json; " +
        "relying on CLI-inherited MCP config (no alwaysLoad policy applied)"
    );
    return {};
  }
}

// Loaded once at module load — settings.json is owned by the user, not
// hot-reloaded by the bridge.
const MCP_TRANSPORTS: Record<string, RawMcpEntry> = loadMcpTransports();

/**
 * Build the SDK `mcpServers` map for a single message.
 *
 * For each entry in MCP_SERVERS:
 *   - alwaysLoad:true  -> attached unconditionally with alwaysLoad=true so
 *                         it bypasses Tool Search deferral (paperclip).
 *   - alwaysLoad:false -> only attached if the message's channel has a
 *                         configured tenant domain. The CONVERGEKIT_DOMAIN_ID
 *                         env var is overridden per-message so the same
 *                         transport script serves the right tenant. Attached
 *                         with alwaysLoad=false so the SDK defers its tools
 *                         behind the Tool Search Tool.
 *
 * Channel-scoped MCPs with no domain mapping for the current channel are
 * intentionally omitted — they neither load nor get deferred.
 *
 * IMPORTANT: paperclip is alwaysLoad:true in config.ts. If transport for it
 * is missing from ~/.claude/settings.json this function logs and omits the
 * paperclip entry, but the CLI-inherited config will still attach it (so
 * we degrade to "no policy" rather than "paperclip dropped").
 */
function buildMcpServers(
  channelId: string | undefined,
  agent: AgentName
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  const eagerLoaded: string[] = [];
  const deferred: string[] = [];
  const skipped: string[] = [];
  let resolvedDomain: string | undefined;

  const allowlist = AGENTS[agent].allowedMcpServers;

  for (const [name, policy] of Object.entries(MCP_SERVERS)) {
    // Per-agent allowlist: skip any MCP not in the agent's list (if defined).
    // No allowlist = all entries are eligible.
    if (allowlist && !allowlist.includes(name)) {
      skipped.push(name);
      continue;
    }

    const transport = MCP_TRANSPORTS[name];

    if (policy.alwaysLoad) {
      if (!transport) {
        logger.warn(
          { server: name },
          "alwaysLoad MCP has no transport entry in ~/.claude/settings.json; " +
            "falling back to CLI-inherited config for this server"
        );
        continue;
      }
      out[name] = { ...transport, alwaysLoad: true } as McpServerConfig;
      eagerLoaded.push(name);
      continue;
    }

    // Channel-scoped: resolve domain for this message
    const domain =
      channelId && policy.channelDomains
        ? policy.channelDomains[channelId]
        : undefined;

    if (!domain) {
      skipped.push(name);
      continue;
    }
    if (!transport) {
      logger.warn(
        { server: name, channelId },
        "Channel-scoped MCP resolved a domain but has no transport entry " +
          "in ~/.claude/settings.json; skipping"
      );
      skipped.push(name);
      continue;
    }

    // Stdio transports carry CONVERGEKIT_DOMAIN_ID in env; override it.
    // HTTP/SSE transports would need a different scheme, but the current
    // CK servers are all stdio so we narrow accordingly.
    if (!("command" in transport)) {
      logger.warn(
        { server: name },
        "Channel-scoped MCP transport is not stdio; per-channel domain " +
          "override not implemented for this transport type"
      );
      skipped.push(name);
      continue;
    }

    const env = { ...(transport.env ?? {}), CONVERGEKIT_DOMAIN_ID: domain };
    out[name] = {
      type: "stdio",
      command: transport.command,
      args: transport.args,
      env,
      alwaysLoad: false,
    } as McpServerConfig;
    deferred.push(name);
    // Track the first resolved domain for logging (typically just one per-message)
    if (!resolvedDomain) {
      resolvedDomain = domain;
    }
  }

  // T04.3: Emit debug log per spec with channel name and resolved domain
  const channelName = channelId ? CHANNELS[channelId]?.name ?? channelId : "(no channel)";
  const domainStr = resolvedDomain ? `, domain=${resolvedDomain}` : "";
  logger.debug(
    `mcp-load decision: channel=#${channelName}${domainStr}, eager=[${eagerLoaded.join(", ")}], deferred=[${deferred.join(", ")}]`
  );

  return out;
}

/** Extract the Slack channel ID from a threadKey of the form "<channel>:<ts>". */
function channelFromThreadKey(threadKey?: string): string | undefined {
  if (!threadKey) return undefined;
  const idx = threadKey.indexOf(":");
  return idx > 0 ? threadKey.slice(0, idx) : threadKey;
}

export type StreamCallback = (text: string) => void;

interface SessionRequest {
  agent: AgentName;
  prompt: string;
  /** Deterministic UUID derived from the thread key; used as `sessionId:` in query(). */
  deterministicSessionId?: string;
  onStream?: StreamCallback;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
}

let activeCount = 0;
const queue: SessionRequest[] = [];

// --- Per-thread token usage tracking (T07) -------------------------------
//
// Map<threadKey, totalTokens>. Accumulates input + output tokens reported by
// the SDK's `result` message across all turns of a given Slack thread since
// bridge boot. Reset on bridge restart (intentional — these are process-local
// guardrails, not durable accounting).
//
// We don't bound the Map size explicitly: each entry is ~24 bytes, and even
// thousands of stale threads (one per Slack thread the bridge has answered
// since boot) is well under any memory budget that matters here. If this
// becomes an issue, swap for an LRU.
const threadUsage = new Map<string, number>();

function getThreadUsage(threadKey: string | undefined): number {
  if (!threadKey) return 0;
  return threadUsage.get(threadKey) ?? 0;
}

function addThreadUsage(threadKey: string | undefined, tokens: number): void {
  if (!threadKey || tokens <= 0) return;
  threadUsage.set(threadKey, getThreadUsage(threadKey) + tokens);
}

export async function runQuery(
  agent: AgentName,
  prompt: string,
  threadKey?: string,
  onStream?: StreamCallback
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // T07: per-thread cost cap. Reject before queueing so a runaway thread
    // doesn't even consume a queue slot.
    if (PER_THREAD_TOKEN_CAP > 0 && threadKey) {
      const used = getThreadUsage(threadKey);
      if (used >= PER_THREAD_TOKEN_CAP) {
        logger.warn(
          { threadKey, used, cap: PER_THREAD_TOKEN_CAP },
          "Per-thread token cap hit; rejecting query"
        );
        resolve(
          `:no_entry: This thread has hit its token budget ` +
            `(${Math.round(used / 1000)}k of ${Math.round(
              PER_THREAD_TOKEN_CAP / 1000
            )}k). Start a new thread to continue — I'll pick up fresh context there.`
        );
        return;
      }
    }

    const req: SessionRequest = {
      agent,
      prompt,
      // Derive a stable UUID from the thread key so the SDK can resume the
      // same session across bridge restarts (sessionStore provides the data).
      deterministicSessionId: threadKey
        ? threadKeyToSessionId(threadKey)
        : undefined,
      onStream,
      resolve,
      reject,
    };

    if (activeCount < MAX_CONCURRENT_SESSIONS) {
      processRequest(req, threadKey);
    } else if (queue.length < MAX_QUEUE_SIZE) {
      logger.info(
        { agent, queueSize: queue.length + 1 },
        "Queueing request"
      );
      queue.push(req);
    } else {
      reject(
        new Error("Queue full — too many concurrent requests. Try again later.")
      );
    }
  });
}

async function processRequest(
  req: SessionRequest,
  threadKey?: string
): Promise<void> {
  activeCount++;
  const config = AGENTS[req.agent];

  // --- T05.2: Cache-aware system-prompt assembly ---------------------------
  //
  // The pinned SDK 0.3.142 typings (sdk.d.ts) expose two complementary cache
  // levers for the `claude_code` preset:
  //
  //   1. `append: string`              — static instructions concatenated to
  //                                      the preset prefix. The SDK includes
  //                                      this in the cacheable system-prompt
  //                                      prefix (no per-block cache_control
  //                                      field is exposed to callers in this
  //                                      pinned version).
  //   2. `excludeDynamicSections: true` — strips per-user dynamic sections
  //                                      (cwd, auto-memory path, git status)
  //                                      from the cached system prompt and
  //                                      re-injects them as the first user
  //                                      message. Without this flag, those
  //                                      sections poison the cache prefix
  //                                      because they vary per session.
  //
  // Together these are the SDK-supported equivalent of the spec's literal
  // "cache_control: { type: ephemeral, ttl: 1h } on each static block": the
  // 1h TTL is applied by the platform to the SDK's cacheable prefix, and
  // excludeDynamicSections is what keeps that prefix actually static.
  //
  // NOTE: The pinned SDK does NOT accept a raw array of blocks with
  // per-block cache_control on the preset path (`append` is `string` only,
  // and the `string[]` form of systemPrompt drops the preset). Casting
  // through `unknown` to force an unsupported shape would silently break
  // at runtime, so we use the typed preset form here. If a future SDK
  // surfaces per-block cache_control, revisit this assembly.
  const { staticBlocks, dynamicBlocks } = getSystemPromptBlocks(req.agent);
  const staticAppend = staticBlocks.map((b) => b.text).join("\n");

  // Dynamic blocks must NOT be cached. Today they are empty by construction
  // (see config.ts getSystemPromptBlocks), so this is a no-op guard. If a
  // future change starts emitting dynamic blocks, prepend them to the user
  // prompt so they bypass the cached system-prompt prefix entirely.
  const dynamicPrefix = dynamicBlocks.length
    ? dynamicBlocks.map((b) => b.text).join("\n") + "\n\n"
    : "";
  const userPrompt = dynamicPrefix + req.prompt;

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
    logger.warn({ agent: req.agent }, "Query timed out after 5 minutes");
  }, QUERY_TIMEOUT_MS);

  let accumulatedStreamText = "";

  // Resolve channel from threadKey ("<channelId>:<threadTs>") so the
  // channel-scoped MCP resolver picks the right tenant domain.
  const channelId = channelFromThreadKey(threadKey);
  const mcpServers = buildMcpServers(channelId, req.agent);
  const strictMcpConfigForAgent = AGENTS[req.agent].strictMcp ?? false;

  try {
    const result = query({
      prompt: userPrompt,
      options: {
        cwd: config.cwd,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(staticAppend ? { append: staticAppend } : {}),
          // T05.2: keep the cached system-prompt prefix static across calls.
          excludeDynamicSections: true,
        },
        maxTurns: config.maxTurns,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Deterministic sessionId (thread-key-derived UUID) + sessionStore.
        //
        // The CLI persists per-session JSONL transcripts to
        // ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl regardless of
        // sessionStore. If a JSONL with our deterministic UUID already exists
        // on disk and we pass `sessionId:` again, the CLI rejects with
        // "Session ID … is already in use." We have to switch to `resume:`
        // for the second-and-later turns so the CLI loads the prior transcript
        // instead of trying to claim a fresh ID.
        //
        // First turn for a thread → JSONL doesn't exist yet → use `sessionId:`
        // to claim that UUID. Subsequent turns → JSONL exists → use `resume:`.
        //
        // When sessionStore is undefined (Supabase creds missing), we omit
        // both so the SDK auto-generates an ID per call (no resume).
        ...(req.deterministicSessionId && sessionStore
          ? sessionJsonlExists(config.cwd, req.deterministicSessionId)
            ? { resume: req.deterministicSessionId }
            : { sessionId: req.deterministicSessionId }
          : {}),
        persistSession: true,
        ...(sessionStore ? { sessionStore } : {}),
        abortController,
        includePartialMessages: true,
        // T04.2: MCP policy + Tool Search + Programmatic Tool Calling.
        // The SDK's typed `SdkBeta` enumeration only includes the 1M
        // context beta in 0.3.142, but the runtime accepts arbitrary
        // beta header strings (see assistant.mjs). We pass our beta as
        // the typed union via a cast — runtime-validated by T04.4 smoke.
        mcpServers,
        // Per-agent narrow scope: when an agent has strictMcp=true,
        // don't inherit MCP servers from ~/.claude/settings.json.
        // Only the explicit `mcpServers` map above is in scope.
        ...(strictMcpConfigForAgent ? { strictMcpConfig: true } : {}),
        betas: [ADVANCED_TOOL_USE_BETA] as unknown as ("context-1m-2025-08-07")[],
        // Capture child stderr so when the SDK reports "Claude Code process
        // exited with code N" we have the actual cause in the log (auth
        // errors, session-resume failures, etc.) instead of just the exit code.
        stderr: (data: string) => {
          const trimmed = data?.trim();
          if (trimmed) logger.warn({ agent: req.agent, stderr: trimmed }, "claude stderr");
        },
      },
    });

    let lastAssistantText = "";

    for await (const message of result) {
      // Handle streaming deltas
      if (req.onStream) {
        const msg = message as any;
        if (msg.type === "stream_event") {
          const event = msg.event;
          if (
            event?.type === "content_block_delta" &&
            event?.delta?.type === "text_delta" &&
            event?.delta?.text
          ) {
            accumulatedStreamText += event.delta.text;
            try {
              req.onStream(accumulatedStreamText);
            } catch {
              // ignore callback errors
            }
          }
        }
      }

      if (
        message.type === "assistant" &&
        message.message?.content
      ) {
        // New assistant turn — reset stream accumulator
        accumulatedStreamText = "";

        let turnText = "";
        for (const block of message.message.content) {
          if ("text" in block && block.text) {
            turnText += block.text;
          }
        }
        if (turnText.trim()) {
          lastAssistantText = turnText;
        }
      }

      // T07: accumulate per-thread usage from the SDK's terminal `result`
      // message. SDKResultSuccess + SDKResultError both expose `usage`.
      if (message.type === "result") {
        const usage = (message as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
        if (usage) {
          const total =
            (usage.input_tokens ?? 0) +
            (usage.output_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
          addThreadUsage(threadKey, total);
          if (PER_THREAD_TOKEN_CAP > 0 && threadKey) {
            const cumulative = getThreadUsage(threadKey);
            if (cumulative >= PER_THREAD_TOKEN_CAP) {
              logger.warn(
                { threadKey, used: cumulative, cap: PER_THREAD_TOKEN_CAP },
                "Per-thread token cap reached on this turn; subsequent queries will be rejected"
              );
            }
          }
        }
      }
    }

    req.resolve(lastAssistantText || "(no response)");
  } catch (err) {
    if (abortController.signal.aborted) {
      // Return partial text on timeout instead of error
      const partial = accumulatedStreamText || lastAssistantTextFallback();
      req.resolve(
        partial
          ? partial + "\n\n_(timed out — partial response)_"
          : "(timed out — query took too long)"
      );
    } else {
      logger.error({ err, agent: req.agent }, "Query failed");
      req.reject(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    clearTimeout(timeout);
    activeCount--;
    if (queue.length > 0) {
      const next = queue.shift()!;
      processRequest(next, undefined);
    }
  }
}

function lastAssistantTextFallback(): string {
  return "";
}
