# slack-bridge Migrations

This directory contains SQL migrations for the Slack Bridge SDK's Supabase integration.

## Available Migrations

### 0001_slack_bridge_sessions.sql

Creates the `slack_bridge_sessions` table for session storage.

**Table:** `public.slack_bridge_sessions`

**Columns:**
- `session_key` (text, primary key): Unique session identifier
- `session_id` (text, not null): Reference to session
- `data` (jsonb, nullable): Arbitrary session state (e.g., context, metadata)
- `updated_at` (timestamptz, default: now()): Last update timestamp

**Access Control:**
- RLS is NOT enabled by default
- Table is accessible to authenticated service-role only
- Multi-tenant RLS policies can be added in a subsequent migration

## How to Apply Migrations

### Option 1: Supabase Studio (Easiest)

1. Open [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project
3. Navigate to **SQL Editor**
4. Open a new query tab
5. Copy the full contents of `0001_slack_bridge_sessions.sql`
6. Paste into the editor
7. Click **Run**
8. Verify in **Table Editor** that `slack_bridge_sessions` is created

### Option 2: Supabase CLI (Local Development)

```bash
# Copy migration to local supabase directory
cp migrations/0001_slack_bridge_sessions.sql ./supabase/migrations/

# Push to remote project
supabase db push --project-ref <project-id>
```

### Option 3: Direct psql (Advanced)

If you have direct database access:

```bash
psql postgresql://<user>:<password>@<host>/<database> < migrations/0001_slack_bridge_sessions.sql
```

## Verification

After applying the migration, verify the table exists and has the correct schema:

```sql
-- In Supabase Studio SQL Editor:
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'slack_bridge_sessions'
order by ordinal_position;
```

Expected output:
```
session_key  | text      | NO  | NULL
session_id   | text      | NO  | NULL
data         | jsonb     | YES | NULL
updated_at   | timestamp | YES | now()
```

## Notes

- **RLS (Row-Level Security):** Currently deferred. Enable in a follow-up migration if multi-tenant isolation is needed.
- **Indexes:** Optional index on `session_id` is commented out in the migration. Uncomment if frequent lookups by session_id are expected.
- **Auto-Update Trigger:** An optional `updated_at` trigger is provided. Enable if you want automatic timestamp updates on row modifications.

## Rollback (if needed)

To remove the table (destructive):

```sql
drop table public.slack_bridge_sessions;
```

This should only be done if the migration needs to be reverted.
