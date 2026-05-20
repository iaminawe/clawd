/**
 * SupabaseSessionStore — SDK SessionStore adapter backed by Supabase Postgres.
 *
 * Implements the `SessionStore` contract exported by
 * `@anthropic-ai/claude-agent-sdk` (pinned to 0.3.142). See:
 *   node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts (search "SessionStore")
 *
 * Methods (per pinned SDK typings):
 *   - append(key, entries)         REQUIRED
 *   - load(key)                    REQUIRED, returns SessionStoreEntry[] | null
 *   - listSessions?(projectKey)    OPTIONAL
 *   - listSessionSummaries?(...)   OPTIONAL — not implemented (no summary col)
 *   - delete?(key)                 OPTIONAL — implemented (read-replace pattern)
 *   - listSubkeys?(key)            OPTIONAL — implemented (matches subpath rows)
 *
 * Storage model (from migrations/0001_slack_bridge_sessions.sql):
 *   table public.slack_bridge_sessions
 *     session_key text primary key   <- composite of projectKey/sessionId[/subpath]
 *     session_id  text not null
 *     data        jsonb              <- full entries array (append = read+append+write)
 *     updated_at  timestamptz default now()
 *
 * DEVIATION FROM SDK CONTRACT (documented for T06.3/T06.4):
 *   The SDK's `append()` is conceptually streaming: many small batches per
 *   turn at ~100ms cadence. The migration's `data jsonb` column collapses
 *   that into a single row per session — so this adapter implements append
 *   as a read-modify-write under the session_key. That is correct, but:
 *     - it serializes all appends for a session through one row
 *     - for very long transcripts the row grows linearly
 *   For Slack-bridge's traffic this is fine (low QPS, short turns). If a
 *   future workload needs true streaming appends, switch to a per-entry
 *   row layout with (session_key, uuid) primary key and adjust load()
 *   accordingly. The SDK's batched-flush default already coalesces frames
 *   to end-of-turn, which keeps write amplification low for now.
 *
 * Outage handling (per task contract):
 *   - load()      : on error, log warning and return `null` (treat as new
 *                   session). NEVER throw — a Supabase outage must not
 *                   take down the bridge or wedge a thread.
 *   - append()    : on error, log warning and resolve. The SDK retries
 *                   3x with backoff (per sdk.d.ts) and ultimately emits a
 *                   `mirror_error` system message; the subprocess continues
 *                   regardless. Failing soft here matches that contract.
 *   - delete()    : on error, log warning and resolve. Cleanup is
 *                   best-effort; orphan rows are tolerable.
 *   - listSubkeys : on error, log warning and return `[]`.
 *
 * Credentials:
 *   Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from process.env.
 *   Never hardcoded. If either is missing, the constructor throws — the
 *   bridge should fall back to in-memory storage rather than ship an
 *   adapter with no backend. Wiring (T06.3) decides that fallback.
 */

import type {
  SessionStore,
  SessionKey,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger.js";

const TABLE = "slack_bridge_sessions";

/**
 * Encode a SessionKey to the table's `session_key` text PK.
 *
 * The SDK guarantees `projectKey` and `sessionId` are non-empty strings, and
 * `subpath` (if present) is non-empty. We use ASCII unit separators (\x1f)
 * between components — they are forbidden in valid keys and require no
 * escaping. This keeps the encoding reversible should a future change need
 * to decode it (e.g., for listSubkeys filtering by prefix).
 */
function encodeSessionKey(key: SessionKey): string {
  const base = `${key.projectKey}\x1f${key.sessionId}`;
  return key.subpath ? `${base}\x1f${key.subpath}` : base;
}

/** Prefix used to match all subkey rows for a given (projectKey, sessionId). */
function subkeyPrefix(key: { projectKey: string; sessionId: string }): string {
  return `${key.projectKey}\x1f${key.sessionId}\x1f`;
}

/** Row shape persisted in `public.slack_bridge_sessions`. */
interface SessionRow {
  session_key: string;
  session_id: string;
  data: SessionStoreEntry[] | null;
  updated_at?: string;
}

export interface SupabaseSessionStoreOptions {
  /** Override the default `slack_bridge_sessions` table name (testing only). */
  table?: string;
  /** Inject a pre-built client (testing only). */
  client?: SupabaseClient;
}

/**
 * Build a SupabaseClient from env. Throws if either env var is missing —
 * callers should catch and decide whether to fall back to in-memory.
 */
function clientFromEnv(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SupabaseSessionStore: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY " +
        "must be set in the environment. Never hardcode these."
    );
  }
  return createClient(url, key, {
    auth: {
      // Service-role usage: no session persistence, no auto-refresh.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export class SupabaseSessionStore implements SessionStore {
  private readonly client: SupabaseClient;
  private readonly table: string;

  constructor(opts: SupabaseSessionStoreOptions = {}) {
    this.client = opts.client ?? clientFromEnv();
    this.table = opts.table ?? TABLE;
  }

  /**
   * Mirror a batch of transcript entries.
   *
   * The migration stores the full entries array in a single `data` jsonb
   * column, so we read the existing array, concat the new entries, and
   * write back. Idempotency: the SDK assigns most entries a stable `uuid`;
   * we de-dupe by uuid to make retries safe (per the SDK contract).
   *
   * On error: log + resolve. The SDK already retries 3x and surfaces
   * `mirror_error`; we don't need to amplify the failure.
   */
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const session_key = encodeSessionKey(key);

    try {
      const { data: existing, error: readErr } = await this.client
        .from(this.table)
        .select("data")
        .eq("session_key", session_key)
        .maybeSingle<Pick<SessionRow, "data">>();

      if (readErr) {
        throw readErr;
      }

      const prior = existing?.data ?? [];
      // Dedupe by uuid where present; entries without uuid (titles, tags,
      // mode markers) pass through unconditionally per SDK contract.
      const seen = new Set<string>();
      for (const e of prior) {
        if (e.uuid) seen.add(e.uuid);
      }
      const merged = [...prior];
      for (const e of entries) {
        if (e.uuid && seen.has(e.uuid)) continue;
        if (e.uuid) seen.add(e.uuid);
        merged.push(e);
      }

      const { error: writeErr } = await this.client.from(this.table).upsert(
        {
          session_key,
          session_id: key.sessionId,
          data: merged,
          updated_at: new Date().toISOString(),
        } satisfies SessionRow,
        { onConflict: "session_key" }
      );

      if (writeErr) {
        throw writeErr;
      }
    } catch (err) {
      logger.warn(
        { err, session_key, batchSize: entries.length },
        "SupabaseSessionStore.append failed; entries dropped for this batch " +
          "(SDK will retry per its mirror contract)"
      );
      // Soft-fail: do not throw. SDK contract permits a dropped batch.
    }
  }

  /**
   * Load a full session for resume.
   *
   * Returns the stored entries array, or `null` if the row was never
   * written OR if Supabase is unreachable. The task contract specifies
   * that an outage on read must be silent + return null so the thread
   * starts fresh — never throw.
   */
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const session_key = encodeSessionKey(key);

    try {
      const { data, error } = await this.client
        .from(this.table)
        .select("data")
        .eq("session_key", session_key)
        .maybeSingle<Pick<SessionRow, "data">>();

      if (error) {
        throw error;
      }
      if (!data) return null;
      return data.data ?? null;
    } catch (err) {
      // Per task contract: log warning, return null. Treat thread as new.
      logger.warn(
        { err, session_key },
        "SupabaseSessionStore.load failed; treating session as new " +
          "(Supabase outage tolerated)"
      );
      return null;
    }
  }

  /**
   * Delete a session row.
   *
   * Optional in the SDK contract; we implement it because the migration's
   * schema supports it cheaply (single-row DELETE). Best-effort: log on
   * failure but never throw.
   */
  async delete(key: SessionKey): Promise<void> {
    const session_key = encodeSessionKey(key);
    try {
      const { error } = await this.client
        .from(this.table)
        .delete()
        .eq("session_key", session_key);
      if (error) throw error;
    } catch (err) {
      logger.warn(
        { err, session_key },
        "SupabaseSessionStore.delete failed; row may be orphaned"
      );
    }
  }

  /**
   * List all subpath rows under a (projectKey, sessionId).
   *
   * Used by the SDK during resume to discover subagent transcripts. We
   * encode the key as `projectKey\x1fsessionId\x1f<subpath>`, so the
   * subkeys for a given session are exactly the rows whose `session_key`
   * starts with `projectKey\x1fsessionId\x1f`. The main transcript row
   * (no subpath) does NOT match this prefix and is correctly excluded.
   *
   * Best-effort on error: return `[]` so resume falls back to "main
   * transcript only" rather than crashing.
   */
  async listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]> {
    const prefix = subkeyPrefix(key);
    try {
      const { data, error } = await this.client
        .from(this.table)
        .select("session_key")
        .like("session_key", `${prefix}%`);
      if (error) throw error;
      if (!data) return [];
      const out: string[] = [];
      for (const row of data as Pick<SessionRow, "session_key">[]) {
        const sub = row.session_key.slice(prefix.length);
        if (sub) out.push(sub);
      }
      return out;
    } catch (err) {
      logger.warn(
        { err, projectKey: key.projectKey, sessionId: key.sessionId },
        "SupabaseSessionStore.listSubkeys failed; returning empty list"
      );
      return [];
    }
  }
}
