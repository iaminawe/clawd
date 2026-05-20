# Replacing OpenClaw with Claude — Tutorial

A 9-article migration playbook for moving a personal "AI familiar" setup off the OpenClaw third-party harness onto first-party Anthropic tooling: Claude Code CLI, the Claude Agent SDK, a hand-rolled Slack bot, scheduled `launchd` jobs, Paperclip orchestration, and `bw serve` secrets.

🔗 **Live site:** https://iaminawe.github.io/openclaw-to-claude-tutorial/

## Articles

| #   | Article                                            |
| --- | -------------------------------------------------- |
| 00  | [Overview](docs/00-overview.md)                    |
| 01  | [Architecture](docs/01-architecture.md)            |
| 02  | [Building the Slack Bridge](docs/02-slack-bridge.md) |
| 03  | [Identity and Memory](docs/03-identity-memory.md)  |
| 04  | [Scheduled Jobs](docs/04-scheduled-jobs.md)        |
| 05  | [Secrets via bw serve](docs/05-secrets.md)         |
| 06  | [Paperclip Control Plane](docs/06-paperclip.md)    |
| 07  | [Teardown Checklist](docs/07-teardown.md)          |
| 08  | [Modernization Plan](docs/08-modernization.md)     |

## Local development

```bash
npm install
npm start          # dev server on http://localhost:3000
npm run build      # production build into ./build
npm run serve      # serve the production build locally
```

## Deployment

The site auto-deploys to GitHub Pages on every push to `main` via the workflow at `.github/workflows/deploy.yml`.

**One-time setup** in your GitHub repo:

1. **Settings → Pages → Build and deployment → Source:** select **"GitHub Actions"**.
2. Push to `main`. The Action will build and publish.

If you fork or rename, update `ORG` and `REPO` constants at the top of `docusaurus.config.ts`.

## Editing

All articles live in `docs/`. Order is controlled by `sidebar_position` in each file's frontmatter. Cross-references use relative paths (e.g. `[Building the Slack Bridge](./02-slack-bridge)`).

## Stack

- [Docusaurus 3](https://docusaurus.io) (TypeScript classic preset)
- Static site, no backend
- Hosted on GitHub Pages

## License

The tutorial content is © Clawd contributors, 2026. Code snippets within the tutorial are MIT.
