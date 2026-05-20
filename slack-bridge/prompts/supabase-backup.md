Run daily Supabase database backup.

1. Back up [your-app] Supabase (port 54322):
   docker exec supabase_db_example-tenant pg_dump -U postgres postgres | gzip > ~/Backups/supabase-example-tenant-$(date +%Y%m%d).sql.gz

2. Back up [example-tenant-c] Supabase (port 55322):
   docker exec supabase_db_example-tenant-c pg_dump -U postgres postgres | gzip > ~/Backups/supabase-example-tenant-c-$(date +%Y%m%d).sql.gz

3. Clean up backups older than 14 days:
   find ~/Backups -name "supabase-*.sql.gz" -mtime +14 -delete

4. Verify backup files exist and are > 1KB.

Make sure ~/Backups directory exists first. Report success with file sizes, or report any errors.
