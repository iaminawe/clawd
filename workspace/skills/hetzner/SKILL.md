---
name: hetzner
description: "Manage Hetzner Cloud infrastructure via hcloud CLI. Use for: listing/creating/deleting servers, managing SSH keys, networking, firewalls, volumes, and snapshots. Requires HCLOUD_TOKEN."
metadata:
  { "openclaw": { "emoji": "🟥", "requires": { "bins": ["hcloud"] } } }
---

# Hetzner Cloud

Manage Hetzner Cloud via `hcloud` CLI.

## Auth
```bash
hcloud context create iaminawe   # paste API token when prompted
hcloud context use iaminawe
hcloud context list
```

## Servers
```bash
hcloud server list
hcloud server describe <name>
hcloud server ssh <name>          # SSH into server
hcloud server reboot <name>
hcloud server poweroff <name>
hcloud server poweron <name>
hcloud server metrics --type cpu,disk,network <name>
```

## SSH Keys
```bash
hcloud ssh-key list
hcloud ssh-key create --name "clawd-mac" --public-key-from-file ~/.ssh/id_ed25519.pub
```

## Networking
```bash
hcloud network list
hcloud firewall list
hcloud firewall describe <name>
hcloud floating-ip list
```

## Snapshots & Volumes
```bash
hcloud image list --type snapshot
hcloud snapshot create --server <name> --description "pre-migration"
hcloud volume list
```

## Common Workflow: SSH into server
```bash
# Via hcloud (uses your local SSH key)
hcloud server ssh <server-name>

# Or via SSH alias (after ~/.ssh/config is set up)
ssh hetzner-coolify
```

## Migration workflow (Lightsail → Hetzner)
1. Snapshot source server on Lightsail
2. Export and transfer data
3. Set up services on Hetzner target
4. Update DNS (via Cloudflare) to point to new IPs
5. Verify, then decommission Lightsail instance
