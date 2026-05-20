-- Migration: slack_bridge_sessions table
-- Purpose: Create session storage table for Slack Bridge SDK
--
-- Table Schema:
-- - session_key: Primary identifier (text, unique)
-- - session_id: Reference to session (text, not null)
-- - data: Arbitrary session state (jsonb, nullable)
-- - updated_at: Last modified timestamp (timestamptz, auto-managed)
--
-- Access Control:
-- This migration does NOT enable RLS (Row-Level Security).
-- The table is accessible to service-role only (via Supabase SDK authentication).
-- RLS can be enabled in a subsequent migration if needed for multi-tenant scenarios.
--
-- How to Apply:
-- 1. Via Supabase Studio:
--    - Navigate to SQL Editor in Supabase Dashboard
--    - Paste the SQL below
--    - Click "Run"
--
-- 2. Via Supabase CLI (local dev):
--    - Copy this file to ./supabase/migrations/
--    - Run: supabase db push
--
-- 3. Via psql (direct database access):
--    - psql postgresql://<user>:<password>@<host>/<db>
--    - Paste the SQL below

create table public.slack_bridge_sessions (
  session_key text primary key,
  session_id text not null,
  data jsonb,
  updated_at timestamptz default now()
);

-- Optional: Index on session_id for fast lookups by session reference
-- (Uncomment if needed after initial deployment)
-- create index idx_slack_bridge_sessions_session_id on public.slack_bridge_sessions(session_id);

-- Optional: Add trigger to auto-update updated_at on row changes
-- (Uncomment if needed; requires plpgsql)
-- create or replace function update_slack_bridge_sessions_timestamp()
-- returns trigger as $$
-- begin
--   new.updated_at = now();
--   return new;
-- end;
-- $$ language plpgsql;
--
-- create trigger slack_bridge_sessions_updated_at before update on public.slack_bridge_sessions
--   for each row execute function update_slack_bridge_sessions_timestamp();

-- RLS Policy (deferred for now, to be added when sessionStore goes multi-tenant):
-- Once enabled, policies should enforce that:
-- - session_id-based rows are isolated per user/client
-- - Service role bypasses RLS for admin/cleanup operations
-- Example (when RLS is enabled):
-- alter table public.slack_bridge_sessions enable row level security;
-- create policy "service_role_full_access" on public.slack_bridge_sessions
--   as permissive for all using (true) with check (true) to public;
