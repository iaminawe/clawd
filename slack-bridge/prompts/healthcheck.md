Run weekly security and infrastructure healthcheck.

1. **Docker health**: Check all containers are running and healthy via docker ps.

2. **Disk space**: Check available disk space. Alert if any volume is over 80%.

3. **Paperclip**: Verify API is responding at http://127.0.0.1:3100/api/companies

4. **Honcho**: Verify API is responding at http://localhost:8000/

5. **Agent AGENTS.md backup**: Back up all agent instruction files:
   - ~/Work/[your-app]/agents/*/AGENTS.md
   - ~/Work/example-tenant-a/agents/*/AGENTS.md
   - ~/Work/example-tenant-b/agents/*/AGENTS.md
   - ~/Work/example-tenant-c/agents/*/AGENTS.md
   Copy to ~/.paperclip/instances/default/data/backups/agents/ with date prefix. Keep last 7 days.

6. **Domain expiry**: Check if any domains expire within 14 days (refer to the domain inventory in CLAUDE.md).

7. **Tirith**: Verify tirith binary works: tirith --version

Compile a short healthcheck report. Flag any issues prominently.
