---
name: coolify
description: "Manage Coolify self-hosted PaaS via REST API. Use for: checking deployment status, triggering deploys, managing apps/services/databases, and viewing logs. Requires COOLIFY_BASE_URL and COOLIFY_API_TOKEN."
metadata:
  { "openclaw": { "emoji": "🚀", "requires": { "env": ["COOLIFY_BASE_URL", "COOLIFY_API_TOKEN"] } } }
---

# Coolify

Manage Coolify via its REST API. All calls use:

```bash
BASE="$COOLIFY_BASE_URL/api/v1"
AUTH="Authorization: Bearer $COOLIFY_API_TOKEN"
```

## Health check

```bash
curl -s "$COOLIFY_BASE_URL/api/v1/healthcheck"
```

## Applications

```bash
# List all applications
curl -s -H "$AUTH" "$BASE/applications" | python3 -m json.tool

# Get specific app
curl -s -H "$AUTH" "$BASE/applications/<uuid>" | python3 -m json.tool

# Trigger deploy
curl -s -X POST -H "$AUTH" "$BASE/applications/<uuid>/deploy" | python3 -m json.tool

# Stop app
curl -s -X POST -H "$AUTH" "$BASE/applications/<uuid>/stop"

# Start app
curl -s -X POST -H "$AUTH" "$BASE/applications/<uuid>/start"

# Restart app
curl -s -X POST -H "$AUTH" "$BASE/applications/<uuid>/restart"
```

## Deployment Logs

```bash
# Recent deployments for an app
curl -s -H "$AUTH" "$BASE/deployments?applicationId=<uuid>" | python3 -m json.tool

# Specific deployment logs
curl -s -H "$AUTH" "$BASE/deployments/<deploy-uuid>/logs"
```

## Databases

```bash
curl -s -H "$AUTH" "$BASE/databases" | python3 -m json.tool
curl -s -X POST -H "$AUTH" "$BASE/databases/<uuid>/start"
curl -s -X POST -H "$AUTH" "$BASE/databases/<uuid>/stop"
```

## Services

```bash
curl -s -H "$AUTH" "$BASE/services" | python3 -m json.tool
curl -s -X POST -H "$AUTH" "$BASE/services/<uuid>/start"
curl -s -X POST -H "$AUTH" "$BASE/services/<uuid>/restart"
```

## Servers

```bash
curl -s -H "$AUTH" "$BASE/servers" | python3 -m json.tool
curl -s -H "$AUTH" "$BASE/servers/<uuid>/resources"
```

## Common Workflow: Check and Deploy

```bash
# 1. Find your app UUID
curl -s -H "$AUTH" "$BASE/applications" | python3 -c "
import json,sys
apps = json.load(sys.stdin)
for a in apps: print(a['uuid'], a.get('name',''))
"

# 2. Trigger deploy and watch
curl -s -X POST -H "$AUTH" "$BASE/applications/<uuid>/deploy"
sleep 3
curl -s -H "$AUTH" "$BASE/deployments?applicationId=<uuid>" | python3 -m json.tool
```

## Setup

Set in OpenClaw config or environment:
```bash
export COOLIFY_BASE_URL="https://coolify.yourdomain.com"
export COOLIFY_API_TOKEN="your-api-token"  # from Coolify UI → Keys & Tokens
```
