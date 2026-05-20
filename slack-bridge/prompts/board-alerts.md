Check Paperclip for issues that need board attention. Post to Slack channel <BOARD_CHANNEL_ID> (#board) ONLY when action is needed.

## Data Collection

1. Check blocked issues: GET http://127.0.0.1:3100/api/issues?status=blocked
2. Check pending approvals: GET http://127.0.0.1:3100/api/approvals?status=pending
3. Check agent errors in the last 2 hours across all companies.

Read memory/heartbeat-state.json to avoid repeating alerts seen in the last 4 hours. Update it with any new alert IDs.

## Silence Rules

- Skip any alert IDs already in heartbeat-state.json within 4 hours
- No alerts between 22:00–08:00 Pacific unless priority is critical
- If nothing needs attention, reply with ONLY: HEARTBEAT_OK
- Do NOT post to Slack when nothing needs attention. No "all clear" messages. No status updates about silence windows or quiet hours. Just return HEARTBEAT_OK silently.

## Slack Format (only when posting)

Post the MAIN message as a clean summary using this format:

For pending approvals:
> 🔔 *Approval needed — [Company Name]*
> *Agent:* [agent name]
> *Request:* [clear, plain-language description of what the agent wants to do]
> `approve [full-id]` · `deny [full-id]`

For blocked issues:
> 🚧 *Blocked — [Company Name]*
> *Issue:* `[short-id]` — [title]
> *Needs:* [what's required to unblock]

Separate multiple items with a blank line. Keep it scannable — one glance should tell the human what needs attention.

If you include any raw API data, diagnostic info, or debug details, post those as a REPLY to the main message (threaded), wrapped in triple-backtick code blocks. The main channel message must stay clean.
